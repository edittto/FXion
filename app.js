/* FXion Phase 1 + チャート/損益 */
const CFG = window.FXION_CONFIG || window.MIRAGE_CONFIG;
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const YEN = "¥";

let me=null, profile=null, mode="unranked", account=null;
let assets=[], prices={}, holdings={}, lastPrices={};
let pollTimer=null, sheetSymbol=null, sheetSide="buy", chartPeriod="1H";
let authMode="login"; // login | signup

const $=(id)=>document.getElementById(id);
const show=(id)=>$(id).classList.remove("hidden");
const hide=(id)=>$(id).classList.add("hidden");
const fmt=(n,d=2)=>Number(n).toLocaleString("ja-JP",{minimumFractionDigits:d,maximumFractionDigits:d});
const pxDec=(p)=>(Number(p)<1?4:2);
const signed=(n,d=0)=>(n>=0?"+":"")+fmt(n,d);
function flash(id,cls,t){const e=$(id);e.className="msg "+cls+" show";e.textContent=t;}
function clearMsg(id){const e=$(id);e.className="msg";e.textContent="";}

init();
async function init(){
  if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
  const {data}=await sb.auth.getSession();
  await onAuth(data.session);
  sb.auth.onAuthStateChange((_e,s)=>onAuth(s));
  wireEvents(); buildPrefectures();
}
async function onAuth(session){
  me=session?.user||null;
  if(!me){showOnly("view-auth");return;}
  const {data:p}=await sb.from("profiles").select("*").eq("id",me.id).maybeSingle();
  profile=p||null;
  if(!profile){showOnly("view-onboard");return;}
  $("user-tag").textContent=profile.username+(profile.prefecture?" · "+profile.prefecture:"");
  showOnly("view-app");
  await loadAssets(); await switchMode("unranked"); startPolling();
}
function showOnly(id){["view-auth","view-onboard","view-app"].forEach(v=>v===id?show(v):hide(v));}

function wireEvents(){
  $("auth-btn").onclick=doAuth;
  $("toggle-auth").onclick=()=>{
    authMode = authMode==="login" ? "signup" : "login";
    $("auth-btn").textContent = authMode==="login" ? "ログイン" : "新規登録";
    $("toggle-auth").textContent = authMode==="login"
      ? "アカウントが無い方はこちら（新規登録）" : "既にアカウントがある方はこちら（ログイン）";
    $("password").setAttribute("autocomplete", authMode==="login"?"current-password":"new-password");
    $("auth-note").textContent = authMode==="login"
      ? "登録したメールとパスワードでログインできます。" : "メールとパスワード（6文字以上）で登録します。";
    clearMsg("auth-msg");
  };
  $("save-profile").onclick=saveProfile;
  $("country").onchange=()=>$("country").value==="JP"?show("pref-wrap"):hide("pref-wrap");
  $("signout").onclick=async()=>{await sb.auth.signOut();location.reload();};
  document.querySelectorAll(".mode").forEach(b=>b.onclick=()=>switchMode(b.dataset.mode));
  $("reset-btn").onclick=async()=>{
    if(!confirm("保有を全て手放し、初期資金¥1,000,000に戻します。よろしいですか？"))return;
    const {error}=await sb.rpc("reset_account",{p_account_id:account.id});
    if(error)return alert(error.message);
    await loadAccount();
  };
  $("seg-buy").onclick=()=>setSide("buy");
  $("seg-sell").onclick=()=>setSide("sell");
  $("qty").oninput=updateEstimate;
  $("close-sheet").onclick=closeSheet;
  $("sheet-bg").onclick=(e)=>{if(e.target.id==="sheet-bg")closeSheet();};
  $("confirm-trade").onclick=confirmTrade;
  document.querySelectorAll("#chart-tabs .tab").forEach(t=>t.onclick=()=>{
    chartPeriod=t.dataset.period;
    document.querySelectorAll("#chart-tabs .tab").forEach(x=>x.classList.toggle("on",x===t));
    loadChart();
  });
}
async function doAuth(){
  const email=$("email").value.trim();
  const password=$("password").value;
  if(!email)return flash("auth-msg","err","メールアドレスを入力してください");
  if(!password||password.length<6)return flash("auth-msg","err","パスワードは6文字以上で");
  $("auth-btn").disabled=true;
  let res;
  if(authMode==="signup") res=await sb.auth.signUp({email,password});
  else res=await sb.auth.signInWithPassword({email,password});
  $("auth-btn").disabled=false;
  if(res.error){
    let m=res.error.message;
    if(/already registered/i.test(m)) m="このメールは登録済みです。ログインに切り替えてください。";
    if(/invalid login credentials/i.test(m)) m="メールかパスワードが違います。";
    return flash("auth-msg","err",m);
  }
  // セッションが張られていれば onAuthStateChange が画面を進めます
  if(!res.data.session){
    const {data}=await sb.auth.signInWithPassword({email,password});
    if(data.session) onAuth(data.session);
  }
}
async function saveProfile(){
  const username=$("username").value.trim();
  const country=$("country").value;
  const prefecture=country==="JP"?$("prefecture").value:null;
  if(username.length<2)return flash("onboard-msg","err","ユーザー名は2文字以上で");
  $("save-profile").disabled=true;
  const {error}=await sb.rpc("ensure_profile",{p_username:username,p_country:country,p_prefecture:prefecture});
  $("save-profile").disabled=false;
  if(error)return flash("onboard-msg","err",error.message);
  const {data:session}=await sb.auth.getSession();
  await onAuth(session.session);
}

async function loadAssets(){const {data}=await sb.from("assets").select("*").order("sort_order");assets=data||[];}
async function switchMode(m){
  mode=m;
  document.querySelectorAll(".mode").forEach(b=>b.classList.toggle("active",b.dataset.mode===m));
  await loadAccount();
}
async function loadAccount(){
  const {data,error}=await sb.rpc("get_or_create_account",{p_mode:mode});
  if(error){console.error(error);return;}
  account=Array.isArray(data)?data[0]:data;
  await loadHoldings(); await loadPrices(); await loadHistory(); render();
}
async function loadHoldings(){
  holdings={}; if(!account)return;
  const {data}=await sb.from("holdings").select("*").eq("account_id",account.id);
  (data||[]).forEach(h=>holdings[h.symbol]=h);
}
async function loadPrices(){
  const {data}=await sb.from("prices").select("*");
  lastPrices={...prices}; prices={};
  (data||[]).forEach(p=>prices[p.symbol]=p);
}
async function loadHistory(){
  if(!account){$("history").innerHTML="";return;}
  const {data}=await sb.from("trades").select("*").eq("account_id",account.id).order("ts",{ascending:false}).limit(20);
  renderHistory(data||[]);
}
function startPolling(){
  if(pollTimer)clearInterval(pollTimer);
  pollTimer=setInterval(async()=>{await loadPrices();renderMarket();renderPositions();renderSummary();
    if($("sheet-bg").classList.contains("show")){refreshSheetPx();renderPosbox();}},10000);
}

function render(){renderSummary();renderPositions();renderMarket();}
function netWorth(){
  let nw=account?Number(account.cash):0;
  for(const s in holdings){const p=prices[s];if(p)nw+=Number(holdings[s].qty)*Number(p.price);}
  return nw;
}
function renderSummary(){
  if(!account)return;
  const nw=netWorth(), start=Number(account.starting_cash);
  const ret=((nw-start)/start)*100;
  $("networth").textContent=YEN+fmt(nw,0);
  $("cash").textContent=YEN+fmt(account.cash,0);
  const r=$("ret"); r.textContent=signed(ret,2)+"%"; r.className="mono "+(ret>=0?"up":"down");
  const bankrupt=account.status==="bankrupt";
  $("status-badge").innerHTML=bankrupt?'<span class="badge bank">破産</span>':
    '<span class="badge">'+(mode==="ranked"?"ランク "+account.season:"練習中")+'</span>';
  $("reset-btn").classList.toggle("hidden",!(bankrupt&&mode==="unranked"));
}
function renderPositions(){
  const host=$("positions"); const syms=Object.keys(holdings);
  $("pos-label").classList.toggle("hidden",syms.length===0);
  host.innerHTML="";
  syms.forEach(s=>{
    const h=holdings[s], a=assets.find(x=>x.symbol===s), p=prices[s];
    if(!a)return;
    const price=p?Number(p.price):Number(h.avg_cost);
    const value=Number(h.qty)*price, cost=Number(h.qty)*Number(h.avg_cost);
    const pnl=value-cost, pct=cost>0?(pnl/cost)*100:0, up=pnl>=0;
    const btn=document.createElement("button"); btn.className="pos";
    btn.innerHTML=`<div class="flag">${a.flag||"🏳️"}</div>
      <div class="info"><div class="t">${a.symbol}<em>${fmt(h.qty,2)}単位</em></div>
        <div class="d">買単価 ${YEN}${fmt(h.avg_cost,pxDec(h.avg_cost))} → 現在 ${YEN}${fmt(price,pxDec(price))}</div></div>
      <div class="pnl"><div class="v ${up?'up':'down'}">${(up?'+':'')+YEN+fmt(Math.abs(pnl),0).replace('-','')}</div>
        <div class="p ${up?'up':'down'}">${signed(pct,2)}%</div></div>`;
    btn.querySelector(".v").textContent=(up?"+":"-")+YEN+fmt(Math.abs(pnl),0);
    btn.onclick=()=>openSheet(s);
    host.appendChild(btn);
  });
}
function renderMarket(){
  const host=$("market"); host.innerHTML="";
  assets.forEach(a=>{
    const p=prices[a.symbol], prev=lastPrices[a.symbol]; let cls="";
    if(p&&prev&&Number(p.price)!==Number(prev.price))cls=Number(p.price)>Number(prev.price)?"flash-up":"flash-down";
    const own=holdings[a.symbol];
    const btn=document.createElement("button"); btn.className="asset";
    btn.innerHTML=`<div class="flag">${a.flag||"🏳️"}</div>
      <div class="who"><div class="c">${a.symbol}<em>${a.name}</em></div>
        <div class="n">${a.country||""}${own?" · 保有中":""}</div></div>
      <div class="px"><div class="p ${cls}">${p?YEN+fmt(p.price,pxDec(p.price)):"—"}</div>
        <div class="h">タップで取引</div></div>`;
    btn.onclick=()=>openSheet(a.symbol);
    host.appendChild(btn);
  });
}
function renderHistory(rows){
  const host=$("history");
  if(!rows.length){host.innerHTML='<div class="empty">まだ取引はありません</div>';return;}
  host.innerHTML="";
  rows.forEach(t=>{
    const d=new Date(t.ts);
    const when=`${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    const row=document.createElement("div"); row.className="trow";
    row.innerHTML=`<div class="s mono">${t.symbol}</div>
      <div class="side ${t.side}">${t.side==="buy"?"買":"売"}</div>
      <div class="mono">${fmt(t.qty,2)} @ ${YEN}${fmt(t.price,pxDec(t.price))}</div>
      <div class="when">${when}</div>`;
    host.appendChild(row);
  });
}

/* ---- 取引シート + チャート ---- */
function openSheet(symbol){
  sheetSymbol=symbol; sheetSide="buy";
  const a=assets.find(x=>x.symbol===symbol);
  $("sheet-title").textContent=`${a.flag||""} ${a.symbol} · ${a.name}`;
  $("qty").value=""; clearMsg("trade-msg");
  setSide("buy"); refreshSheetPx(); renderPosbox();
  $("sheet-bg").classList.add("show");
  loadChart();
}
function closeSheet(){$("sheet-bg").classList.remove("show");}
function setSide(side){
  sheetSide=side;
  $("seg-buy").classList.toggle("on",side==="buy");
  $("seg-sell").classList.toggle("on",side==="sell");
  $("est-label").textContent=side==="buy"?"概算コスト":"概算受取";
  renderChips(); updateEstimate();
}
function refreshSheetPx(){
  const p=prices[sheetSymbol];
  $("sheet-px").textContent=p?"現在値  "+YEN+fmt(p.price,pxDec(p.price))+" / 単位":"価格取得中…";
}
function renderPosbox(){
  const h=holdings[sheetSymbol], box=$("posbox");
  if(!h){box.classList.add("hidden");return;}
  const p=prices[sheetSymbol]; const price=p?Number(p.price):Number(h.avg_cost);
  const value=Number(h.qty)*price, cost=Number(h.qty)*Number(h.avg_cost);
  const pnl=value-cost, pct=cost>0?(pnl/cost)*100:0, up=pnl>=0, c=up?"up":"down";
  box.classList.remove("hidden");
  box.innerHTML=`
    <div class="row"><span>保有数量</span><b>${fmt(h.qty,2)} 単位</b></div>
    <div class="row"><span>平均買単価</span><b>${YEN}${fmt(h.avg_cost,pxDec(h.avg_cost))}</b></div>
    <div class="row"><span>今売ったら</span><b>${YEN}${fmt(value,0)}</b></div>
    <div class="row big"><span>損益</span><b class="${c}">${(up?"+":"-")+YEN+fmt(Math.abs(pnl),0)} (${signed(pct,2)}%)</b></div>`;
}
function renderChips(){
  const host=$("chips"); host.innerHTML="";
  const p=prices[sheetSymbol]; if(!p)return;
  const mk=(pct,getVal)=>{const c=document.createElement("button");c.className="chip";c.textContent=pct+"%";
    c.onclick=()=>{$("qty").value=getVal(pct).toFixed(2);updateEstimate();};host.appendChild(c);};
  if(sheetSide==="buy")[25,50,100].forEach(pct=>mk(pct,p2=>(Number(account.cash)/Number(p.price))*p2/100));
  else{const own=holdings[sheetSymbol];[25,50,100].forEach(pct=>mk(pct,p2=>(own?Number(own.qty):0)*p2/100));}
}
function updateEstimate(){
  const p=prices[sheetSymbol], qty=parseFloat($("qty").value);
  if(!p||!qty||qty<=0){$("est-val").textContent="—";return;}
  $("est-val").textContent=YEN+fmt(qty*Number(p.price),0);
}
async function confirmTrade(){
  const qty=parseFloat($("qty").value);
  if(!qty||qty<=0)return flash("trade-msg","err","数量を入力してください");
  $("confirm-trade").disabled=true;
  const {error}=await sb.rpc("execute_trade",{p_account_id:account.id,p_symbol:sheetSymbol,p_side:sheetSide,p_qty:qty});
  $("confirm-trade").disabled=false;
  if(error)return flash("trade-msg","err",error.message);
  closeSheet(); await loadAccount();
}

/* ---- チャート描画(外部ライブラリ無し・自前SVG) ---- */
async function loadChart(){
  const sym=sheetSymbol, per=chartPeriod;
  const svg=$("chart"); svg.innerHTML="";
  const {data,error}=await sb.rpc("get_chart",{p_symbol:sym,p_period:per});
  if(sym!==sheetSymbol)return; // 切り替え済みなら破棄
  if(error||!data||data.length<2){drawEmpty();return;}
  drawChart(data.map(d=>Number(d.price)));
}
function drawEmpty(){
  $("chart").innerHTML=`<text x="260" y="78" text-anchor="middle" fill="#5A626E" font-size="12" font-family="sans-serif">データを蓄積中… しばらくすると推移が表示されます</text>`;
}
function drawChart(vals){
  const W=520,H=150,pad=8;
  const min=Math.min(...vals), max=Math.max(...vals), range=(max-min)||1;
  const n=vals.length;
  const X=i=>pad+(i/(n-1))*(W-pad*2);
  const Y=v=>pad+(1-(v-min)/range)*(H-pad*2);
  let line=""; vals.forEach((v,i)=>line+=(i?"L":"M")+X(i).toFixed(1)+" "+Y(v).toFixed(1)+" ");
  const area=line+`L${(W-pad).toFixed(1)} ${(H-pad).toFixed(1)} L${pad.toFixed(1)} ${(H-pad).toFixed(1)} Z`;
  const up=vals[n-1]>=vals[0];
  const col=up?"#E2A33C":"#D9716E", fill=up?"rgba(226,163,60,.12)":"rgba(217,113,110,.12)";
  $("chart").innerHTML=
    `<path d="${area}" fill="${fill}" stroke="none"/>`+
    `<path d="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
}

function buildPrefectures(){
  const list=["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県","鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"];
  const sel=$("prefecture");
  list.forEach(p=>{const o=document.createElement("option");o.value=p;o.textContent=p;sel.appendChild(o);});
}
