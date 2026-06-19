/* ===================================================================
   MIRAGE Phase 1 — フロント側ロジック
   ・Supabase 認証(メールリンク)
   ・プロフィール作成
   ・アンランク/ランクの切替
   ・ポートフォリオ表示(純資産・損益)
   ・売買(サーバー関数 execute_trade を呼ぶだけ)
   ・取引履歴
   価格は prices テーブルを10秒ごとに読む(更新はサーバーの cron が担当)
=================================================================== */
const CFG = window.MIRAGE_CONFIG;
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

/* ---- state ---- */
let me = null;            // auth user
let profile = null;       // profiles row
let mode = "unranked";    // 'unranked' | 'ranked'
let account = null;       // accounts row (現在モードの財布)
let assets = [];          // assets 一覧
let prices = {};          // symbol -> {price, updated_at}
let holdings = {};        // symbol -> {qty, avg_cost}
let lastPrices = {};      // 価格フラッシュ判定用
let pollTimer = null;
let sheetSymbol = null, sheetSide = "buy";

/* ---- helpers ---- */
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");
const fmt = (n, d = 2) =>
  Number(n).toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });
function flash(elId, cls, txt) {
  const el = $(elId); el.className = "msg " + cls + " show"; el.textContent = txt;
}
function clearMsg(elId){ const el=$(elId); el.className="msg"; el.textContent=""; }

/* ===================================================================
   起動 / 認証状態
=================================================================== */
init();
async function init() {
  // PWA: service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  const { data } = await sb.auth.getSession();
  await onAuth(data.session);
  sb.auth.onAuthStateChange((_e, session) => onAuth(session));
  wireEvents();
  buildPrefectures();
}

async function onAuth(session) {
  me = session?.user || null;
  if (!me) { showOnly("view-auth"); return; }

  // プロフィール確認
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
  ["view-auth", "view-onboard", "view-app"].forEach((v) =>
    v === id ? show(v) : hide(v)
  );
}

/* ===================================================================
   認証アクション
=================================================================== */
function wireEvents() {
  $("send-link").onclick = async () => {
    const email = $("email").value.trim();
    if (!email) return flash("auth-msg", "err", "メールアドレスを入力してください");
    $("send-link").disabled = true;
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href.split("#")[0] },
    });
    $("send-link").disabled = false;
    if (error) return flash("auth-msg", "err", error.message);
    flash("auth-msg", "ok", "メールを送りました。届いたリンクを開いてください。");
  };

  $("save-profile").onclick = saveProfile;
  $("country").onchange = () =>
    $("country").value === "JP" ? show("pref-wrap") : hide("pref-wrap");

  $("signout").onclick = async () => { await sb.auth.signOut(); location.reload(); };

  document.querySelectorAll(".mode").forEach((b) =>
    (b.onclick = () => switchMode(b.dataset.mode))
  );

  $("reset-btn").onclick = async () => {
    if (!confirm("保有を全て手放し、初期資金100万に戻します。よろしいですか？")) return;
    const { error } = await sb.rpc("reset_account", { p_account_id: account.id });
    if (error) return alert(error.message);
    await loadAccount();
  };

  // trade sheet
  $("seg-buy").onclick = () => setSide("buy");
  $("seg-sell").onclick = () => setSide("sell");
  $("qty").oninput = updateEstimate;
  $("close-sheet").onclick = closeSheet;
  $("sheet-bg").onclick = (e) => { if (e.target.id === "sheet-bg") closeSheet(); };
  $("confirm-trade").onclick = confirmTrade;
}

async function saveProfile() {
  const username = $("username").value.trim();
  const country = $("country").value;
  const prefecture = country === "JP" ? $("prefecture").value : null;
  if (username.length < 2) return flash("onboard-msg", "err", "ユーザー名は2文字以上で");
  $("save-profile").disabled = true;
  const { error } = await sb.rpc("ensure_profile", {
    p_username: username, p_country: country, p_prefecture: prefecture,
  });
  $("save-profile").disabled = false;
  if (error) return flash("onboard-msg", "err", error.message);
  const { data: session } = await sb.auth.getSession();
  await onAuth(session.session);
}

/* ===================================================================
   データ読み込み
=================================================================== */
async function loadAssets() {
  const { data } = await sb.from("assets").select("*").order("sort_order");
  assets = data || [];
}

async function switchMode(m) {
  mode = m;
  document.querySelectorAll(".mode").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === m)
  );
  await loadAccount();
}

async function loadAccount() {
  const { data, error } = await sb.rpc("get_or_create_account", { p_mode: mode });
  if (error) { console.error(error); return; }
  account = Array.isArray(data) ? data[0] : data;
  await loadHoldings();
  await loadPrices();
  await loadHistory();
  render();
}

async function loadHoldings() {
  holdings = {};
  if (!account) return;
  const { data } = await sb.from("holdings").select("*").eq("account_id", account.id);
  (data || []).forEach((h) => (holdings[h.symbol] = h));
}

async function loadPrices() {
  const { data } = await sb.from("prices").select("*");
  lastPrices = { ...prices };
  prices = {};
  (data || []).forEach((p) => (prices[p.symbol] = p));
}

async function loadHistory() {
  if (!account) { $("history").innerHTML = ""; return; }
  const { data } = await sb
    .from("trades").select("*")
    .eq("account_id", account.id)
    .order("ts", { ascending: false })
    .limit(20);
  renderHistory(data || []);
}

/* 10秒ごとに価格だけ更新 */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await loadPrices();
    renderMarket(); renderSummary();
  }, 10000);
}

/* ===================================================================
   描画
=================================================================== */
function render() { renderSummary(); renderMarket(); }

function netWorth() {
  let nw = account ? Number(account.cash) : 0;
  for (const s in holdings) {
    const p = prices[s]; if (p) nw += Number(holdings[s].qty) * Number(p.price);
  }
  return nw;
}

function renderSummary() {
  if (!account) return;
  const nw = netWorth();
  const start = Number(account.starting_cash);
  const ret = ((nw - start) / start) * 100;
  $("networth").textContent = "§ " + fmt(nw, 0);
  $("cash").textContent = "§ " + fmt(account.cash, 0);
  const r = $("ret");
  r.textContent = (ret >= 0 ? "+" : "") + fmt(ret, 2) + "%";
  r.className = "mono ret " + (ret >= 0 ? "up" : "down");

  const bankrupt = account.status === "bankrupt";
  $("status-badge").innerHTML = bankrupt
    ? '<span class="badge bank">破産</span>'
    : '<span class="badge">' + (mode === "ranked" ? "ランク " + account.season : "練習中") + "</span>";
  $("reset-btn").classList.toggle("hidden", !(bankrupt && mode === "unranked"));
}

function renderMarket() {
  const host = $("market");
  host.innerHTML = "";
  assets.forEach((a) => {
    const p = prices[a.symbol];
    const prev = lastPrices[a.symbol];
    let cls = "";
    if (p && prev && Number(p.price) !== Number(prev.price))
      cls = Number(p.price) > Number(prev.price) ? "flash-up" : "flash-down";
    const own = holdings[a.symbol];
    const btn = document.createElement("button");
    btn.className = "asset";
    btn.innerHTML = `
      <div class="sym"><div class="c">${a.symbol}</div><div class="n">${a.name}</div></div>
      <div class="own">${own ? own.qty + " 保有" : ""}</div>
      <div class="px">
        <div class="p ${cls}">${p ? "§ " + fmt(p.price, p.price < 10 ? 4 : 2) : "—"}</div>
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
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    const row = document.createElement("div");
    row.className = "trow";
    row.innerHTML = `
      <div class="s mono">${t.symbol}</div>
      <div class="side ${t.side}">${t.side === "buy" ? "買" : "売"}</div>
      <div class="mono">${fmt(t.qty, 4)} @ §${fmt(t.price, t.price < 10 ? 4 : 2)}</div>
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
  $("sheet-title").textContent = `${a.symbol} · ${a.name}`;
  $("qty").value = "";
  clearMsg("trade-msg");
  setSide("buy");
  refreshSheetPx();
  $("sheet-bg").classList.add("show");
}
function closeSheet() { $("sheet-bg").classList.remove("show"); }

function setSide(side) {
  sheetSide = side;
  $("seg-buy").classList.toggle("on", side === "buy");
  $("seg-sell").classList.toggle("on", side === "sell");
  $("est-label").textContent = side === "buy" ? "概算コスト" : "概算受取";
  renderChips();
  updateEstimate();
}

function refreshSheetPx() {
  const p = prices[sheetSymbol];
  $("sheet-px").textContent = p ? "現在値  §" + fmt(p.price, p.price < 10 ? 4 : 2) : "価格取得中…";
}

function renderChips() {
  const host = $("chips"); host.innerHTML = "";
  const p = prices[sheetSymbol]; if (!p) return;
  if (sheetSide === "buy") {
    [25, 50, 100].forEach((pct) => {
      const c = document.createElement("button");
      c.className = "chip"; c.textContent = pct + "%";
      c.onclick = () => {
        const max = Number(account.cash) / Number(p.price);
        $("qty").value = (max * pct / 100).toFixed(6); updateEstimate();
      };
      host.appendChild(c);
    });
  } else {
    const own = holdings[sheetSymbol];
    [25, 50, 100].forEach((pct) => {
      const c = document.createElement("button");
      c.className = "chip"; c.textContent = pct + "%";
      c.onclick = () => {
        const q = own ? Number(own.qty) * pct / 100 : 0;
        $("qty").value = q.toFixed(6); updateEstimate();
      };
      host.appendChild(c);
    });
  }
}

function updateEstimate() {
  const p = prices[sheetSymbol];
  const qty = parseFloat($("qty").value);
  if (!p || !qty || qty <= 0) { $("est-val").textContent = "—"; return; }
  $("est-val").textContent = "§ " + fmt(qty * Number(p.price), 0);
}

async function confirmTrade() {
  const qty = parseFloat($("qty").value);
  if (!qty || qty <= 0) return flash("trade-msg", "err", "数量を入力してください");
  $("confirm-trade").disabled = true;
  const { error } = await sb.rpc("execute_trade", {
    p_account_id: account.id, p_symbol: sheetSymbol, p_side: sheetSide, p_qty: qty,
  });
  $("confirm-trade").disabled = false;
  if (error) return flash("trade-msg", "err", error.message);
  closeSheet();
  await loadAccount();
}

/* ===================================================================
   都道府県リスト
=================================================================== */
function buildPrefectures() {
  const list = ["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県","鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"];
  const sel = $("prefecture");
  list.forEach((p) => { const o = document.createElement("option"); o.value = p; o.textContent = p; sel.appendChild(o); });
}
