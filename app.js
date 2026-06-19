/* ===================================================================
   FXion Phase 1 — フロント側ロジック
   ・Supabase 認証(メールリンク) / プロフィール作成
   ・アンランク/ランク切替 / ポートフォリオ(純資産・損益)
   ・売買(サーバー関数 execute_trade)/ 取引履歴
   通貨は本物の名前(USD/EUR…)、価格は「1単位＝何円か」。基準通貨=円(¥)。
   価格は prices テーブルを10秒ごとに読む(更新はサーバーの cron が担当)。
=================================================================== */
const CFG = window.FXION_CONFIG || window.MIRAGE_CONFIG;  // 旧名でも動くように
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

const YEN = "¥";

/* ---- state ---- */
let me = null, profile = null;
let mode = "unranked", account = null;
let assets = [], prices = {}, holdings = {}, lastPrices = {};
let pollTimer = null, sheetSymbol = null, sheetSide = "buy";

/* ---- helpers ---- */
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");
const fmt = (n, d = 2) =>
  Number(n).toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });
const pxDec = (p) => (Number(p) < 1 ? 4 : 2);   // 1円未満(ウォン等)は4桁表示
function flash(elId, cls, txt){ const el=$(elId); el.className="msg "+cls+" show"; el.textContent=txt; }
function clearMsg(elId){ const el=$(elId); el.className="msg"; el.textContent=""; }

/* ===================================================================
   起動 / 認証
=================================================================== */
init();
async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const { data } = await sb.auth.getSession();
  await onAuth(data.session);
  sb.auth.onAuthStateChange((_e, session) => onAuth(session));
  wireEvents();
  buildPrefectures();
}

async function onAuth(session) {
  me = session?.user || null;
  if (!me) { showOnly("view-auth"); return; }
  const { data: p } = await sb.from("profiles").select("*").eq("id", me.id).maybeSingle();
  profile = p || null;
  if (!profile) { showOnly("view-onboard"); return; }
  $("user-tag").textContent =
    profile.username + (profile.prefecture ? " · " + profile.prefecture : "");
  showOnly("view-app");
  await loadAssets();
  await switchMode("unranked");
  startPolling();
}

function showOnly(id) {
  ["view-auth","view-onboard","view-app"].forEach((v) => v===id ? show(v) : hide(v));
}

/* ===================================================================
   イベント
=================================================================== */
function wireEvents() {
  $("send-link").onclick = async () => {
    const email = $("email").value.trim();
    if (!email) return flash("auth-msg","err","メールアドレスを入力してください");
    $("send-link").disabled = true;
    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: window.location.href.split("#")[0] },
    });
    $("send-link").disabled = false;
    if (error) return flash("auth-msg","err",error.message);
    flash("auth-msg","ok","メールを送りました。届いたリンクを開いてください。");
  };
  $("save-profile").onclick = saveProfile;
  $("country").onchange = () => $("country").value==="JP" ? show("pref-wrap") : hide("pref-wrap");
  $("signout").onclick = async () => { await sb.auth.signOut(); location.reload(); };
  document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => switchMode(b.dataset.mode)));
  $("reset-btn").onclick = async () => {
    if (!confirm("保有を全て手放し、初期資金¥1,000,000に戻します。よろしいですか？")) return;
    const { error } = await sb.rpc("reset_account", { p_account_id: account.id });
    if (error) return alert(error.message);
    await loadAccount();
  };
  $("seg-buy").onclick = () => setSide("buy");
  $("seg-sell").onclick = () => setSide("sell");
  $("qty").oninput = updateEstimate;
  $("close-sheet").onclick = closeSheet;
  $("sheet-bg").onclick = (e) => { if (e.target.id==="sheet-bg") closeSheet(); };
  $("confirm-trade").onclick = confirmTrade;
}

async function saveProfile() {
  const username = $("username").value.trim();
  const country = $("country").value;
  const prefecture = country==="JP" ? $("prefecture").value : null;
  if (username.length < 2) return flash("onboard-msg","err","ユーザー名は2文字以上で");
  $("save-profile").disabled = true;
  const { error } = await sb.rpc("ensure_profile", {
    p_username: username, p_country: country, p_prefecture: prefecture,
  });
  $("save-profile").disabled = false;
  if (error) return flash("onboard-msg","err",error.message);
  const { data: session } = await sb.auth.getSession();
  await onAuth(session.session);
}

/* ===================================================================
   データ
=================================================================== */
async function loadAssets() {
  const { data } = await sb.from("assets").select("*").order("sort_order");
  assets = data || [];
}
async function switchMode(m) {
  mode = m;
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode===m));
  await loadAccount();
}
async function loadAccount() {
  const { data, error } = await sb.rpc("get_or_create_account", { p_mode: mode });
  if (error) { console.error(error); return; }
  account = Array.isArray(data) ? data[0] : data;
  await loadHoldings(); await loadPrices(); await loadHistory(); render();
}
async function loadHoldings() {
  holdings = {};
  if (!account) return;
  const { data } = await sb.from("holdings").select("*").eq("account_id", account.id);
  (data || []).forEach((h) => (holdings[h.symbol] = h));
}
async function loadPrices() {
  const { data } = await sb.from("prices").select("*");
  lastPrices = { ...prices }; prices = {};
  (data || []).forEach((p) => (prices[p.symbol] = p));
}
async function loadHistory() {
  if (!account) { $("history").innerHTML = ""; return; }
  const { data } = await sb.from("trades").select("*")
    .eq("account_id", account.id).order("ts", { ascending: false }).limit(20);
  renderHistory(data || []);
}
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => { await loadPrices(); renderMarket(); renderSummary(); }, 10000);
}

/* ===================================================================
   描画
=================================================================== */
function render() { renderSummary(); renderMarket(); }

function netWorth() {
  let nw = account ? Number(account.cash) : 0;
  for (const s in holdings) { const p = prices[s]; if (p) nw += Number(holdings[s].qty)*Number(p.price); }
  return nw;
}

function renderSummary() {
  if (!account) return;
  const nw = netWorth(), start = Number(account.starting_cash);
  const ret = ((nw - start) / start) * 100;
  $("networth").textContent = YEN + fmt(nw, 0);
  $("cash").textContent = YEN + fmt(account.cash, 0);
  const r = $("ret");
  r.textContent = (ret >= 0 ? "+" : "") + fmt(ret, 2) + "%";
  r.className = "mono ret " + (ret >= 0 ? "up" : "down");
  const bankrupt = account.status === "bankrupt";
  $("status-badge").innerHTML = bankrupt
    ? '<span class="badge bank">破産</span>'
    : '<span class="badge">' + (mode==="ranked" ? "ランク "+account.season : "練習中") + "</span>";
  $("reset-btn").classList.toggle("hidden", !(bankrupt && mode==="unranked"));
}

function renderMarket() {
  const host = $("market"); host.innerHTML = "";
  assets.forEach((a) => {
    const p = prices[a.symbol], prev = lastPrices[a.symbol];
    let cls = "";
    if (p && prev && Number(p.price) !== Number(prev.price))
      cls = Number(p.price) > Number(prev.price) ? "flash-up" : "flash-down";
    const own = holdings[a.symbol];
    const btn = document.createElement("button");
    btn.className = "asset";
    btn.innerHTML = `
      <div class="flag">${a.flag || "🏳️"}</div>
      <div class="who">
        <div class="c">${a.symbol}<em>${a.name}</em></div>
        <div class="n">${a.country || ""}${own ? " · "+fmt(own.qty,2)+" 保有" : ""}</div>
      </div>
      <div class="px">
        <div class="p ${cls}">${p ? YEN + fmt(p.price, pxDec(p.price)) : "—"}</div>
        <div class="h">タップで取引</div>
      </div>`;
    btn.onclick = () => openSheet(a.symbol);
    host.appendChild(btn);
  });
}

function renderHistory(rows) {
  const host = $("history");
  if (!rows.length) { host.innerHTML = '<div class="empty">まだ取引はありません</div>'; return; }
  host.innerHTML = "";
  rows.forEach((t) => {
    const d = new Date(t.ts);
    const when = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    const row = document.createElement("div"); row.className = "trow";
    row.innerHTML = `
      <div class="s mono">${t.symbol}</div>
      <div class="side ${t.side}">${t.side==="buy" ? "買" : "売"}</div>
      <div class="mono">${fmt(t.qty,2)} @ ${YEN}${fmt(t.price, pxDec(t.price))}</div>
      <div class="when">${when}</div>`;
    host.appendChild(row);
  });
}

/* ===================================================================
   取引シート
=================================================================== */
function openSheet(symbol) {
  sheetSymbol = symbol; sheetSide = "buy";
  const a = assets.find((x) => x.symbol === symbol);
  $("sheet-title").textContent = `${a.flag || ""} ${a.symbol} · ${a.name}`;
  $("qty").value = ""; clearMsg("trade-msg");
  setSide("buy"); refreshSheetPx();
  $("sheet-bg").classList.add("show");
}
function closeSheet() { $("sheet-bg").classList.remove("show"); }
function setSide(side) {
  sheetSide = side;
  $("seg-buy").classList.toggle("on", side==="buy");
  $("seg-sell").classList.toggle("on", side==="sell");
  $("est-label").textContent = side==="buy" ? "概算コスト" : "概算受取";
  renderChips(); updateEstimate();
}
function refreshSheetPx() {
  const p = prices[sheetSymbol];
  $("sheet-px").textContent = p ? "現在値  "+YEN+fmt(p.price, pxDec(p.price))+" / 単位" : "価格取得中…";
}
function renderChips() {
  const host = $("chips"); host.innerHTML = "";
  const p = prices[sheetSymbol]; if (!p) return;
  const mk = (pct, getVal) => {
    const c = document.createElement("button"); c.className="chip"; c.textContent = pct+"%";
    c.onclick = () => { $("qty").value = getVal(pct).toFixed(2); updateEstimate(); };
    host.appendChild(c);
  };
  if (sheetSide === "buy") {
    [25,50,100].forEach((pct) => mk(pct, (p2)=> (Number(account.cash)/Number(p.price))*p2/100));
  } else {
    const own = holdings[sheetSymbol];
    [25,50,100].forEach((pct) => mk(pct, (p2)=> (own ? Number(own.qty) : 0)*p2/100));
  }
}
function updateEstimate() {
  const p = prices[sheetSymbol], qty = parseFloat($("qty").value);
  if (!p || !qty || qty <= 0) { $("est-val").textContent = "—"; return; }
  $("est-val").textContent = YEN + fmt(qty * Number(p.price), 0);
}
async function confirmTrade() {
  const qty = parseFloat($("qty").value);
  if (!qty || qty <= 0) return flash("trade-msg","err","数量を入力してください");
  $("confirm-trade").disabled = true;
  const { error } = await sb.rpc("execute_trade", {
    p_account_id: account.id, p_symbol: sheetSymbol, p_side: sheetSide, p_qty: qty,
  });
  $("confirm-trade").disabled = false;
  if (error) return flash("trade-msg","err",error.message);
  closeSheet(); await loadAccount();
}

/* ===================================================================
   都道府県
=================================================================== */
function buildPrefectures() {
  const list = ["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県","鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"];
  const sel = $("prefecture");
  list.forEach((p) => { const o=document.createElement("option"); o.value=p; o.textContent=p; sel.appendChild(o); });
}
