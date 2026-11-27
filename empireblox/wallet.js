import { bindSoundToggle, playSound } from './assets/wallet/feedback.js';
import { mountConversion } from './assets/wallet/conversion.js';
/* Player wallet. Account data and currency preferences live on the treasury. */
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icons = { COINS: 'coin', USD: 'usd', ETH: 'eth', BNB: 'bnb', POL: 'matic', USDT: 'usdt', BTC: 'btc', SOL: 'sol', TRX: 'trx' };
function logo(symbol) {
  return icons[symbol] ? `<img class="currency-logo" src="/assets/wallet/${icons[symbol]}.svg" alt="">` : '';
}
function human(amount, decimals) {
  if (!Number.isInteger(decimals)) return '—';
  const n = BigInt(amount), digits = (n < 0n ? -n : n).toString().padStart(decimals + 1, '0');
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
  return (n < 0n ? '−' : '') + (decimals ? digits.slice(0, -decimals) : digits) + (fraction ? '.' + fraction : '');
}

// A withdrawal route is not proof that the same network can receive a deposit.
const directNetworks = {USDT:{ETH:'USDT.ERC20',BSC:'USDT.BEP20',POL:'USDT.POL'},ETH:{ETH:'ETH'},BNB:{BSC:'BNB'},POL:{POL:'POL'},SOL:{SOL:'SOL'}};
const currencyNames = {COINS:'BANDITBLOX coins',USDT:'Tether',ETH:'Ethereum',BNB:'BNB',POL:'Polygon',SOL:'Solana',BTC:'Bitcoin',TRX:'TRON'};
const directId=(symbol,chain)=>Object.hasOwn(directNetworks,symbol) && Object.hasOwn(directNetworks[symbol],chain)?directNetworks[symbol][chain]:null;
const intakeReady=r=>r?.enabled===true && r.available===true;
let assets = [], walletAssets = [], routes = [], directRoutes = [], chains = [], denominations = [], user = null, balances = new Map();
let refreshId = 0, accountVersion = 0, currencySaving = null, walletFresh = false;
let catalogRequest, catalogLoaded = false, addressVersion = 0, historyVersion = 0;
let depositAsset = null, directSymbol = '', directChain = '', depositsPaused = true;
let view = 'profile';
let balancePreview=false,coinRate={coins:6000n,usdt:10n};
export let sessionState = 'checking';
const meta = id => assets.find(a => a.id === id) || walletAssets.find(a=>a.id===id) || routes.find(a=>a.id===id) || balances.get(id) || denominations.find(a=>a.id===id);
const current = () => assets.find(a => a.id === user?.display_ccy) || assets[0];
const network = id => chains.find(c => c.id === id)?.display_name || id;
const displayPlaces={COINS:3,USDT:3,ETH:5,POL:2,BNB:4};
export function displayAmount(amount,asset){
  if(!asset)return '—';
  const units=BigInt(amount),places=Math.min(asset.decimals,displayPlaces[asset.symbol]??asset.decimals);
  const scale=10n**BigInt(asset.decimals-places),absolute=units<0n?-units:units;
  const rounded=(absolute+scale/2n)/scale;
  if(absolute>0n && rounded===0n)return human(units,asset.decimals);
  const value=human(units<0n?-rounded:rounded,places);
  if(asset.symbol!=='COINS')return value;
  const [whole,fraction]=value.split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');
}
const amountOf=a=>displayAmount(balances.get(a.id)?.amount||'0',a);

async function api(path, options = {}) {
  const response = await fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store', ...options });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Wallet service is unavailable.');
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Wallet service is unavailable.'), {status: response.status});
  return data;
}
function catalog() {
  if (!catalogRequest) catalogRequest = api('/assets').then(d => {
    assets = d.currencies; walletAssets = d.walletCurrencies || []; routes = d.transferRoutes; chains = d.chains; denominations=d.denominations; catalogLoaded = true;
    directRoutes = Array.isArray(d.directRoutes) ? d.directRoutes.filter(r=>typeof r?.id==='string' && directId(r.symbol,r.chain_id)===r.id && r.kind===(r.symbol==='USDT'?'token':'native')) : [];
    if(/^\d+$/.test(d.coinRate?.coins) && /^\d+$/.test(d.coinRate?.usdt) && BigInt(d.coinRate.coins)>0n && BigInt(d.coinRate.usdt)>0n)coinRate={coins:BigInt(d.coinRate.coins),usdt:BigInt(d.coinRate.usdt)};
    depositsPaused = d.deposits_paused !== false;
  }).catch(err => { directRoutes=[]; depositsPaused=true; throw err; }).finally(() => { catalogRequest = null; });
  return catalogRequest;
}

const header = $('.top .wallet');
header.insertAdjacentHTML('afterbegin', `<div id="ebwPill" hidden>
  <button type="button" id="ebwCcy" aria-haspopup="dialog" aria-expanded="false" aria-controls="ebwMenu"><span id="ebwIco"></span><b id="ebwBal">—</b><small id="ebwSym"></small><svg class="currency-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
  <button type="button" class="wallet-primary header-icon" id="ebwDep" aria-label="Wallet" title="Wallet"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 8H5a2 2 0 0 1 0-4h13v4M4 7v12a1 1 0 0 0 1 1h15V8m0 4h-5v4h5"/></svg><span>Wallet</span></button></div>
  <button type="button" class="header-icon" id="noticeBell" aria-label="Notifications" title="Notifications" aria-haspopup="dialog" aria-expanded="false" aria-controls="noticePopup"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 17c2-2 2-4 2-7a5 5 0 0 1 10 0c0 3 0 5 2 7zM10 20a2 2 0 0 0 4 0"/></svg></button>`);
document.body.insertAdjacentHTML('beforeend', `<dialog class="currency-menu" id="ebwMenu" hidden aria-labelledby="currencySheetTitle" aria-describedby="currencySheetHint">
    <header class="sheet-heading"><button type="button" data-wallet-back hidden aria-label="Back to wallet">‹</button><span class="wallet-sheet-emblem" aria-hidden="true"><img src="/assets/dice-gold.png" alt=""></span><div><span class="wallet-sheet-eyebrow">BANDITBLOX / MY WALLET</span><h2 id="currencySheetTitle" tabindex="-1"></h2><p id="currencySheetHint"></p></div><button type="button" data-close-sheet aria-label="Close currency selector"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header>
    <div id="walletPopupLoading" class="wallet-popup-loading" role="status" hidden><span class="wallet-loading-ring" aria-hidden="true"></span><span id="walletLoadingLabel">Loading wallet…</span></div>
    <div id="walletSummary" hidden><div class="wallet-pass"><svg class="pass-blocks" viewBox="0 0 108 92" aria-hidden="true" fill="none" stroke="currentColor"><path d="m10 51 21-12 21 12v24L31 87 10 75Zm0 0 21 12 21-12M31 63v24m21-36 21-12 21 12v24L73 87 52 75m0-24 21 12 21-12M73 63v24M31 15 52 3l21 12v24L52 51 31 39Zm0 0 21 12 21-12M52 27v24"/></svg>
      <div class="pass-topline"><span class="pass-label">Playing balance</span><span class="pass-tag">Your balance</span></div><div class="pass-amount"><strong id="walletSummaryBalance"></strong><span id="walletSummarySymbol"></span></div><p class="pass-context">All games use coins · 6,000 coins = 10 USDT</p></div>
      <div class="wallet-money-actions"><button type="button" id="makeDeposit" data-wallet-view="deposit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></svg><span>Deposit</span><span class="money-action-arrow" aria-hidden="true">↗</span></button><button type="button" id="makeWithdrawal" data-wallet-view="withdraw"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m-5 5 5-5 5 5M4 16v4h16v-4"/></svg><span>Withdraw</span></button></div><p class="wallet-overview-hint"><button type="button" class="wallet-link" data-open-conversion>Convert crypto ↔ coins</button> to play or withdraw.</p></div><div id="walletPopupPane" hidden></div>
    <label class="wallet-search"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="m12 12 5 5"/></svg><input type="search" id="walletSearch" aria-label="Search balances" placeholder="Search balances" autocomplete="off" spellcheck="false" aria-controls="playingCurrencyList"></label>
    <div class="sheet-columns" aria-hidden="true"><span>Currency</span><span>Available balance</span></div><div class="sheet-list" id="playingCurrencyList"></div>
    <div class="sheet-feedback"><span role="status"></span><button type="button" data-retry-currencies hidden>Try again</button></div>
    <div class="menu-profile coin-equivalent" data-coin-equivalent role="status" aria-live="polite" aria-atomic="true"><span>USD equivalent</span><strong id="coinEquivalentValue">—</strong><small>6,000 coins = $10.00 USD</small></div></dialog>
  <dialog id="noticePopup" aria-labelledby="popupHeading"><header><div><div class="popup-title"><h2 id="popupHeading">Notifications</h2><span id="popupUnread" hidden></span></div><p>Recent account activity</p></div><button type="button" id="closeNotices" aria-label="Close notifications" autofocus>×</button></header>
  <div class="notice-preferences"><span>Account alerts &amp; game audio</span><button id="noticeSound" class="sound-toggle" type="button"></button></div><div class="popup-feed"></div><p class="popup-status" role="status"></p><footer><button id="readPopup" class="wallet-link" disabled>Mark all as read</button><a href="/account/notifications" id="openInbox">View inbox <span aria-hidden="true">&rarr;</span></a></footer></dialog>
  <aside id="accountAlert" class="account-alert" hidden aria-live="polite"></aside>`);
$('.shell').insertAdjacentHTML('beforebegin',`<main id="accountPage" hidden aria-label="Player account">
  <div class="account-toolbar"><nav class="account-crumb" aria-label="Breadcrumb"><a href="/" id="walletClose">Lobby</a><span aria-hidden="true">/</span><span>My account</span></nav><div id="railActions"></div></div>
  <div class="account-layout"><aside class="account-rail" aria-label="Account navigation"><header class="rail-identity"><img src="/assets/bacon.png" alt=""><div><small>Player account</small><strong id="railName"></strong></div></header>
    <nav id="walletNav" aria-label="Account sections"></nav></aside>
    <section class="account-main" aria-labelledby="walletTitle"><header class="account-title"><h1 id="walletTitle" tabindex="-1"></h1><p id="walletDescription"></p></header></section></div></main>`);
const menu=$('#ebwMenu'),trigger=$('#ebwCcy'),accountPage=$('#accountPage'),pageScroll=$('#pageScroll');
const accountPath=mode=>'/account/'+mode;
function routeSection(){
  const match=/^\/account(?:\/([a-z]+))?\/?$/.exec(location.pathname);
  return match && (Object.hasOwn(accountSections,match[1])||['deposit','withdraw'].includes(match[1])?match[1]:'profile');
}

// Read-only USD display at the site's 1 USDT = $1 display rate.
function usdEquivalent(a=current()){
  if(!a||!walletFresh||a.id!=='COINS')return '—';
  const raw=BigInt(balances.get(a.id)?.amount||'0'),negative=raw<0n;
  const numerator=(negative?-raw:raw)*coinRate.usdt;
  const denominator=10n**BigInt(a.decimals)*coinRate.coins;
  const cents=(numerator*100n+denominator/2n)/denominator;
  return (negative?'−':'')+(numerator>0n&&cents===0n?'<$0.01':'$'+(cents/100n).toLocaleString('en-US')+'.'+(cents%100n).toString().padStart(2,'0'));
}
function renderBalanceDisplay(){
  const a=current(),equivalent=balancePreview&&a?.id==='COINS';
  const usd=usdEquivalent(a),amount=a&&walletFresh?(equivalent?usd:amountOf(a)):null;
  const icon=$('#ebwIco'),iconSymbol=a?.symbol||'COINS';
  if(icon.dataset.symbol!==iconSymbol||!icon.querySelector('img')){icon.innerHTML=logo(iconSymbol);icon.dataset.symbol=iconSymbol;}
  $('#ebwSym').textContent=equivalent?'USD':a?.symbol||'';
  $('#ebwBal').textContent=amount??'—';
  trigger.toggleAttribute('data-usd-preview',equivalent);
  trigger.title=amount===null?'Balance unavailable':equivalent?`${amount} USD equivalent · Release to show coins`:`${amount} ${a.symbol} available · Hold to preview USD · Open balance details`;
  trigger.setAttribute('aria-label',(equivalent?'USD equivalent, ':'Coin balance, ')+(amount??'unavailable')+(equivalent?'. Release to show coins':` ${a?.symbol||''}. Open balance details`));
  const detail=$('#coinEquivalentValue');if(detail&&detail.textContent!==usd)detail.textContent=usd;
  if(menu.open&&sheetMode==='play')positionMenu();
}
function startBalancePreview(){
  if(!walletFresh||current()?.id!=='COINS'||balancePreview)return;
  balancePreview=true;renderBalanceDisplay();
}
function resetBalancePreview(){
  if(!balancePreview)return;balancePreview=false;renderBalanceDisplay();
}

function renderHeader() {
  header.hidden = !user;
  $('#noticeBell').hidden=!user;
  $('#ebwPill').hidden = !user;
  describePlus();
  renderBalanceDisplay();
  if (menu.open) renderMenu();
  const available=$('#withdrawAvailable'),asset=walletAssets.find(a=>a.id===withdrawCurrency);
  if(available && asset)available.textContent=(walletFresh?amountOf(asset):'—')+' '+asset.symbol;
  const popupAvailable=$('#popupWithdrawAvailable'),popupAsset=walletAssets.find(a=>a.id===popupWithdraw)||walletAssets[0];
  if(popupAvailable && popupAsset)popupAvailable.textContent=(walletFresh?amountOf(popupAsset):'—')+' '+popupAsset.symbol;
  window.dispatchEvent(new Event('eb-currency'));
}

function applyAccount(data) {
  sessionState = 'ready';
  if (user?.id !== data?.user?.id) {
    accountVersion++;
    balancePreview=false;
    currencySaving = null;
    closeMenu();
    stopNotifications();
    if (!accountPage.hidden) hideAccount();
  }
  const changed=user?.id!==data?.user?.id;
  user = data?.user || null;
  balances = new Map((data?.balances || []).map(b => [b.asset_id, b]));
  walletFresh = Boolean(user);
  renderHeader();
  if(changed && $('#rewards')?.classList.contains('on'))void window.ebDailyRewards?.();
  if(changed && user){startNotifications();if(routeSection())open(routeSection(),false);}
  if(!user && routeSection())showSignedOut();
  if(changed && !user)window.dispatchEvent(new Event('eb-session-ended'));
}
export function walletSession(data, state='ready') {
  ++refreshId;
  if(state==='ready')return applyAccount(data);
  sessionState=state;
  if(!user && routeSection())showSignedOut();
}
async function refresh() {
  const seq = ++refreshId;
  try {
    const [data] = await Promise.all([api('/auth/me'), catalog().catch(() => {})]);
    if (seq !== refreshId || currencySaving) return;
    applyAccount(data);
    if (!user || accountPage.hidden) return;
    if (view === 'profile') renderProfile();
    if (!$('#walletHistory').hidden) void loadHistory();
  } catch (err) {
    if (seq !== refreshId) return;
    if (err.status === 401) applyAccount(null);
    else {
      walletFresh = false; renderHeader();
      if (user && !accountPage.hidden && view === 'profile') renderProfile();
    }
  }
}
window.ebWalletRefresh = refresh;
window.ebCurrency = () => current()?.id;
window.ebCurrencyLabel = id => (id ? meta(id) : current())?.symbol || '';
window.ebFormat = (minor, id) => human(minor, (id ? meta(id) : current())?.decimals);
window.ebAsset = id => id ? meta(id) : current();
window.ebBalance = id => (id || current()) && walletFresh ? balances.get(id || current().id)?.amount || '0' : null;

const phoneWallet=matchMedia('(max-width:740px)');
const sheetList=menu.querySelector('.sheet-list'), sheetStatus=menu.querySelector('.sheet-feedback [role=status]');
let sheetMode='play', sheetVersion=0, sheetError='';
let walletTab='balances', popupWithdraw='';
const moneyPane=$('#walletPopupPane');
function sheetTrigger(){return sheetMode==='wallet'?$('#ebwDep'):trigger;}
function closeMenu(focus=false){
  const opener=sheetTrigger();
  ++sheetVersion;
  if(menu.open)menu.close();menu.hidden=true;
  resetBalancePreview();trigger.setAttribute('aria-expanded','false');describePlus();
  sheetList.replaceChildren();$('#walletSearch').value='';sheetStatus.textContent='';sheetError='';
  walletTab='balances';moneyPane.replaceChildren();moneyPane.hidden=true;
  menu.removeAttribute('data-loading');menu.removeAttribute('aria-busy');$('#walletPopupLoading').hidden=true;
  if(focus)opener.focus({preventScroll:true});
}
function positionMenu(){
  if(!menu.open)return;
  const vv=window.visualViewport,edge=12,wallet=sheetMode==='wallet';
  const r=(wallet?sheetTrigger():$('#ebwPill')).getBoundingClientRect();
  const x=vv?.offsetLeft||0,y=vv?.offsetTop||0,w=vv?.width||document.documentElement.clientWidth,h=vv?.height||innerHeight;
  const top=r.bottom+(wallet?6:-1),floor=y+h-edge,aboveTabs=Math.min(floor,pageScroll.getBoundingClientRect().bottom-4);
  const room=Math.max(0,wallet?h-2*edge:(aboveTabs-top>=150?aboveTabs:floor)-top);
  const width=Math.min(w-2*edge,wallet?464:Math.max(236,r.width));
  menu.style.width=width+'px';menu.style.maxHeight=Math.min(wallet?720:386,room)+'px';
  const left=wallet?x+(w-width)/2:Math.max(x+edge,Math.min(r.left+(r.width-width)/2,x+w-width-edge));
  menu.style.left=left+'px';
  if(!wallet){
    menu.style.setProperty('--coin-join-left',Math.max(0,r.left-left)+'px');
    menu.style.setProperty('--coin-join-width',Math.max(0,Math.min(r.width-2,left+width-r.left-1))+'px');
  }
  menu.style.top=(wallet?y+Math.max(edge,(h-menu.getBoundingClientRect().height)/2):top)+'px';
  menu.toggleAttribute('data-compact',room<270);
  menu.toggleAttribute('data-tight',room<140);
  menu.toggleAttribute('data-above',sheetList.scrollTop>2);
  menu.toggleAttribute('data-more',sheetList.scrollHeight-sheetList.clientHeight-sheetList.scrollTop>2);
}
function renderMenu(){
  if(menu.hasAttribute('data-loading')){positionMenu();return;}
  const chosen=current();
  if(sheetMode==='wallet'){
    $('#walletSummaryBalance').textContent=chosen && walletFresh?amountOf(chosen):'—';
    $('#walletSummarySymbol').textContent=chosen?.symbol||'';
    if(walletTab!=='balances'){
      if(walletTab==='deposit' && moneyPane.querySelector('.direct-form'))renderDeposit(moneyPane);
      if(walletTab==='withdraw' && $('#popupWithdrawalRecords'))void refreshWithdrawalHistory();
      positionMenu();return;
    }
  }
  const filter=$('#walletSearch').value.trim().toLowerCase();
  let found=0;
  // Update live balances in place so a refresh cannot discard a focused row or its scroll position.
  const rows=new Map(Array.from(sheetList.children,b=>[b.dataset.asset,b]));
  const visibleAssets=sheetMode==='wallet'?[...assets,...walletAssets,...Array.from(balances.values()).filter(b=>![...assets,...walletAssets].some(a=>a.id===b.asset_id)&&BigInt(b.amount)>0n).map(b=>({id:b.asset_id,symbol:b.symbol,decimals:b.decimals,chain_id:b.chain_id}))]:assets;
  visibleAssets.forEach((a,i)=>{
    let b=rows.get(a.id);
    if(!b){
      b=document.createElement('button');b.type='button';b.dataset.asset=a.id;
      b.innerHTML=`${logo(a.symbol)}<span><strong>${esc(a.symbol)}</strong><small></small></span><b></b><i class="sheet-mark" aria-hidden="true"></i>`;
    }
    if(sheetList.children[i]!==b)sheetList.insertBefore(b,sheetList.children[i]||null);
    rows.delete(a.id);
    b.querySelector('small').textContent=a.id==='COINS'?'Playing balance':a.id==='USDT'?'Tether':network(a.chain_id);
    b.querySelector('b').textContent=walletFresh?amountOf(a):'—';
    b.querySelector('.sheet-mark').textContent=sheetMode==='wallet'?'›':a.id===chosen?.id?'✓':'';
    if(sheetMode==='wallet')b.removeAttribute('aria-pressed');else b.setAttribute('aria-pressed',String(a.id===chosen?.id));
    if(currencySaving)b.setAttribute('aria-disabled','true');else b.removeAttribute('aria-disabled');
    b.toggleAttribute('data-saving',a.id===currencySaving);
    b.hidden=![a.symbol,currencyNames[a.symbol],network(a.chain_id)].some(v=>v?.toLowerCase().includes(filter));
    if(!b.hidden)found++;
  });
  rows.forEach(b=>b.remove());
  const msg=sheetError || (!catalogLoaded?'Loading currencies…':!assets.length?'No currencies are available.':currencySaving?`Saving ${meta(currencySaving)?.symbol || currencySaving} as your playing currency…`:!found?'No matching currencies.':'');
  if(sheetStatus.textContent!==msg)sheetStatus.textContent=msg;
  sheetStatus.parentElement.hidden=!msg;
   menu.querySelector('[data-retry-currencies]').hidden=!sheetError;
  positionMenu();
}
async function loadSheetCatalog(){
  const version=sheetVersion;
  sheetError='';renderMenu();
  try{await catalog();if(version===sheetVersion)renderHeader();}
  catch{if(version===sheetVersion){sheetError='Currencies could not be loaded.';renderMenu();}}
}
function openSheet(mode,next,asset){
  window.ebCancelPageTransition?.();
  if(menu.open && sheetMode===mode && !next){closeMenu(true);return;}
  closeNoticePopup();closeMenu();sheetMode=mode;const opener=sheetTrigger(),wallet=mode==='wallet';
  menu.dataset.mode=mode;
  $('#currencySheetTitle').textContent=wallet?'Wallet':'Coin balance';
  $('#currencySheetHint').textContent=wallet?'':'All games use coins. Hold the arrow to preview USD.';
  menu.querySelector('[data-close-sheet]').setAttribute('aria-label',wallet?'Close wallet':'Close currency selector');
  $('#walletSummary').hidden=!wallet;
  for(const el of menu.querySelectorAll('.wallet-search,[data-coin-equivalent]'))el.hidden=wallet;
  menu.querySelector('[data-wallet-back]').hidden=true;menu.dataset.view='balances';sheetList.hidden=false;menu.querySelector('.sheet-columns').hidden=false;
  menu.hidden=false;
  if(wallet)startWalletLoading('Loading wallet…');else renderMenu();
  if(wallet)menu.showModal();else menu.show();
  positionMenu();opener.setAttribute('aria-expanded','true');
  const active=wallet?$('#currencySheetTitle'):menu.querySelector('[aria-pressed=true]')||$('#walletSearch');
  active.focus({preventScroll:true});
  if(sheetList.contains(active)){
    const scroller=menu.hasAttribute('data-tight')?menu:sheetList,box=scroller.getBoundingClientRect(),row=active.getBoundingClientRect();
    scroller.scrollTop+=Math.min(0,row.top-box.top)+Math.max(0,row.bottom-box.bottom);
    positionMenu();
  }
  if(wallet)void walletView(next||'balances',asset||current());
  else if(!catalogLoaded)void loadSheetCatalog();
}
function startWalletLoading(label){
  menu.setAttribute('data-loading','');menu.setAttribute('aria-busy','true');
  $('#walletPopupLoading').hidden=false;$('#walletLoadingLabel').textContent=label;
}
async function walletView(next,asset=current()){
  if(!menu.open||sheetMode!=='wallet'||!user)return;
  const seq=++sheetVersion;walletTab=next;menu.dataset.view=next;moneyPane.replaceChildren();
  const home=next==='balances';moneyPane.hidden=home;$('#walletSummary').hidden=!home;sheetList.hidden=!home;
  menu.querySelector('.sheet-columns').hidden=!home;sheetStatus.parentElement.hidden=true;menu.querySelector('[data-wallet-back]').hidden=home;
  $('#currencySheetTitle').textContent=home?'Wallet':next==='deposit'?'Deposit':'Withdraw';
  $('#currencySheetHint').textContent=home?'':next==='deposit'?'Choose the currency and network you will send.':'Review the network, address and amount before confirming.';menu.scrollTop=0;
  startWalletLoading(home?'Loading wallet…':next==='deposit'?'Preparing your deposit…':'Loading withdrawal options…');
  positionMenu();$('#currencySheetTitle').focus({preventScroll:true});
  try{
    await Promise.all([catalog(),new Promise(resolve=>setTimeout(resolve,matchMedia('(prefers-reduced-motion:reduce)').matches?0:260))]);
    if(seq!==sheetVersion||!menu.open)return;
    if(next==='deposit'){
      const symbol=asset?.id==='COINS'?'USDT':asset?.symbol||'USDT';moneyPane.dataset.currency=symbol;moneyPane.dataset.network=Object.keys(directNetworks[symbol]||{})[0]||'';
      renderDeposit(moneyPane);
    }else if(next==='withdraw'){popupWithdraw=asset?.id;await showWithdraw(seq,moneyPane);}
  }catch(err){
    if(seq!==sheetVersion)return;
    if(err.status===401)return applyAccount(null);
    if(home){sheetError='Could not refresh wallet currencies.';}else{
      moneyPane.innerHTML=notice('Could not load '+(next==='deposit'?'deposit':'withdrawal')+' options.','wallet-view');
    }
  }finally{
    if(seq===sheetVersion){menu.removeAttribute('data-loading');menu.removeAttribute('aria-busy');$('#walletPopupLoading').hidden=true;renderMenu();positionMenu();}
  }
}
async function popupWithdrawal(){
  return walletView('withdraw',meta(popupWithdraw)||current());
}
trigger.onclick=()=>openSheet('play');
trigger.onpointerdown=e=>{if(e.button===0)startBalancePreview();};
trigger.onpointerleave=trigger.onblur=resetBalancePreview;
trigger.onkeydown=e=>{if(!e.repeat&&(e.key===' '||e.key==='Enter'))startBalancePreview();};
trigger.onkeyup=e=>{if(e.key===' '||e.key==='Enter')resetBalancePreview();};
window.addEventListener('pointerup',resetBalancePreview,true);
window.addEventListener('pointercancel',resetBalancePreview,true);
window.addEventListener('blur',resetBalancePreview);
document.addEventListener('visibilitychange',()=>{if(document.hidden)resetBalancePreview();});
$('#walletSearch').oninput=()=>{sheetList.scrollTop=0;renderMenu();};
phoneWallet.addEventListener('change',positionMenu);
menu.addEventListener('cancel',e=>{e.preventDefault();closeMenu(true);});
menu.onclick = async e => {
  if(e.target===menu){
    const b=menu.getBoundingClientRect();
    if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)closeMenu(true);
    return;
  }
  const action=e.target.closest('[data-wallet-view]');
  if(action){
    if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    e.preventDefault();return walletView(action.dataset.walletView);
  }
  const b=e.target.closest('button');
  if(!b)return;
  if(b.hasAttribute('data-close-sheet'))return closeMenu(true);
  if(b.hasAttribute('data-wallet-back'))return walletView('balances');
  if(b.dataset.retry==='wallet-view')return walletView(walletTab,meta(moneyPane.dataset.currency)||current());
  if(b.dataset.retry==='wallet-withdraw')return popupWithdrawal();
  if(b.closest('#walletPopupPane')&&b.dataset.retry==='address'){delete moneyPane.querySelector('[id$="AddressResult"]').dataset.key;return renderDeposit(moneyPane);}
  if(b.closest('#walletPopupPane')&&b.dataset.retry==='balance')return refresh();
  if(b.hasAttribute('data-cancel-withdraw')){
    b.disabled=true;
    try{await api('/me/withdrawals/'+b.dataset.cancelWithdraw+'/cancel',{method:'POST'});await refresh();await refreshWithdrawalHistory();}
    catch(err){b.disabled=false;b.textContent=err.message;}return;
  }
  if(b.hasAttribute('data-retry-currencies'))return sheetMode==='wallet'?walletView('balances'):loadSheetCatalog();
  if(!b.dataset.asset || b.disabled)return;
  if(sheetMode==='wallet'){if(b.dataset.asset==='COINS'){closeMenu();return open('conversion');}return walletView('deposit',meta(b.dataset.asset));}
  if(currencySaving)return;
  if(b.dataset.asset===user.display_ccy)return closeMenu(true);
  const version=accountVersion,sheet=sheetVersion;
  currencySaving=b.dataset.asset;sheetError='';++refreshId;renderMenu();
  try {
    const d = await api('/me/currency', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({asset:b.dataset.asset}) });
    if (version !== accountVersion) return;
    ++refreshId;user.display_ccy=d.display_ccy;
    if(sheet===sheetVersion)closeMenu(true);
    renderHeader();if(!accountPage.hidden&&view==='profile')renderProfile();
  } catch (e) {
    if (version !== accountVersion) return;
    if (e.status === 401) applyAccount(null);
    else if(sheet===sheetVersion)sheetError='Currency was not changed. Select it again to retry.';
  } finally {
    if(version===accountVersion){currencySaving=null;if(menu.open)renderMenu();}
  }
};
document.addEventListener('pointerdown', e => { if (menu.open && !menu.contains(e.target) && !sheetTrigger().contains(e.target)) closeMenu(); });
document.addEventListener('focusin', e => { if (menu.open && !menu.contains(e.target) && !sheetTrigger().contains(e.target)) closeMenu(); });
document.addEventListener('keydown', e => {
  if (menu.hidden||e.defaultPrevented||e.target.closest('.eb-option-picker[open]')) return;
  if (e.key === 'Escape') {e.preventDefault();e.stopImmediatePropagation();return closeMenu(true);}
  if (sheetMode!=='play' || !['ArrowDown','ArrowUp','Home','End'].includes(e.key) || (e.target.id==='walletSearch' && !e.key.startsWith('Arrow'))) return;
  e.preventDefault();
  const buttons=[...sheetList.querySelectorAll('button:enabled:not([hidden])')],index=buttons.indexOf(document.activeElement);
  if(!buttons.length)return;
  const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:e.key==='ArrowDown'?(index+1)%buttons.length:((index<=0?buttons.length:index)-1);
  buttons[next]?.focus();
});
window.addEventListener('resize', positionMenu);
window.addEventListener('scroll', positionMenu, true);
window.visualViewport?.addEventListener('resize', positionMenu);
window.visualViewport?.addEventListener('scroll', positionMenu);
new ResizeObserver(()=>{if(menu.open)positionMenu();}).observe(menu);

function placeholder(label,layout='list'){
  const blocks=layout==='stats'?'<i></i><i></i><i></i><i></i><i class="skeleton-chart"></i>':'<i></i><i></i><i></i>';
  return `<div class="wallet-skeleton skeleton-${layout}" role="status" aria-label="${esc(label)}"><span aria-hidden="true">${blocks}</span></div>`;
}
function loading(el,label,layout){
  if(el.contains(document.activeElement))(el.closest('#ebwMenu')?$('#currencySheetTitle'):$('#walletTitle')).focus({preventScroll:true});
  el.setAttribute('aria-busy','true');
  el.innerHTML=el.closest('#walletPopupPane')?`<div class="wallet-inline-loading" role="status"><span class="wallet-loading-ring" aria-hidden="true"></span><span>${esc(label)}</span></div>`:placeholder(label,layout);
}
function notice(message, retry) {
  return `<div class="wallet-notice" role="status"><span>${esc(message)}</span>${retry ? `<button type="button" class="wallet-link" data-retry="${retry}">Try again</button>` : ''}</div>`;
}
export const accountSections = {
  profile: 'Profile', conversion:'Conversion',
  stats: 'Statistics', transactions: 'Transactions', bets: 'Bet history', rewards:'Rewards', notifications:'Notifications', security:'Security'
};
const sectionDescriptions={
  profile:'Your coin balance, crypto wallet and account details.',
  conversion:'Convert crypto to coins, or coins back to crypto, at the same base rate.',
  stats:'Review your settled results in coins by time period.',
  transactions:'Deposits, wagers, payouts and balance adjustments.',
  bets:'Your bets, outcomes and individual round details.',
  rewards:'Your winter collection, daily packs and coin wager progress.',
  notifications:'Account updates and receipts in one place.',
  security:'Manage your authenticator, password and active sessions.'
};
const paths = {
  profile: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4.5 21v-2a7.5 7.5 0 0 1 15 0v2',
  deposit: 'M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4',
  withdraw: 'M12 15V3m-5 5 5-5 5 5M4 16v4h16v-4',
  copy: 'M9 9h11v12H9ZM5 16H3V3h12v2',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-5v5l3 2',
  pause: 'M9 5v14M15 5v14',
  stats: 'M4 20h16M6 16v-4m6 4V5m6 11V9',
  conversion: 'M3 8h16m-4-4 4 4-4 4M21 16H5m4-4-4 4 4 4',
  transactions: 'M3 8h16m-4-4 4 4-4 4M21 16H5m4-4-4 4 4 4',
  bets: 'M5 3h14v18l-3-2-4 2-4-2-3 2ZM8 8h8m-8 5h5',
  security:'M12 3 4 6v5c0 5 4 8 8 10 4-2 8-5 8-10V6ZM9 12l2 2 4-5',
  admin: 'M12 3 4 6v5c0 5 4 8 8 10 4-2 8-5 8-10V6Z',
  rewards:'M3 8h18v5H3zM5 13v8h14v-8M12 8v13M12 8C6 8 5 6 6 4s5-1 6 4c1-5 5-6 6-4s0 4-6 4',
  notifications:'M5 17c2-2 2-4 2-7a5 5 0 0 1 10 0c0 3 0 5 2 7zM10 20a2 2 0 0 0 4 0',
  out: 'M10 4H4v16h6m-1-8h12m-5-5 5 5-5 5'
};
export function accountIcon(key) {
  return `<svg class="account-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[key]}"/></svg>`;
}
let pageIndex=0, activitySeq=0, statsDays=7, statsMetric='net', statsAsset=null, betFilter='',transactionType='all', expandedBet=null, withdrawCurrency=null;
const gameNames={mines:'Mines',blackjack:'Blackjack',cases:'Cases',battles:'Case battle',upgrader:'Upgrader',rewards:'Reward pack'};
const states={active:'In play',playing:'In play',insurance:'In play',open:'Waiting',rolling:'Settled',cashed:'Cashed out',lost:'Lost',done:'Settled',cancelled:'Cancelled',requested:'Requested',reviewing:'In review',approved:'Approved',sent:'Sent'};
const timeOf=v=>new Date(v).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const receiptDate=new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const receiptTime=v=>v?`<time datetime="${esc(v)}">${esc(receiptDate.format(new Date(v)))}</time>`:'—';
function transactionRef(b){
  return b.ref?`<div><dt>Reference</dt><dd>${esc(b.ref)}</dd></div>`:'';
}
function flowName(kind){
  const [type,game]=kind.split(':');
  if(type==='conversion')return game==='crypto_to_coins'?'Converted to coins':'Converted to crypto';
  if(gameNames[game])return (gameNames[game]+' · '+({bet:'Stake',payout:'Payout',refund:'Refund'}[type]||type));
  return {leaderboard_prize:'Weekly leaderboard prize',level_bonus:'Level bonus',admin_credit:'Balance credit',admin_debit:'Balance deduction',deposit:'Deposit',withdrawal_hold:'Withdrawal reserved',withdrawal_refund:'Withdrawal returned',withdrawal_sent:'Withdrawal sent'}[kind]||kind.replaceAll('_',' ');
}
function amountText(amount,dec,symbol){return amount==null||symbol==null?'Account security':human(amount,dec)+' '+symbol;}
function tabs(){
  const nav=$('#walletNav'),actions=$('#railActions');
  $('#railName').textContent=user.username;
  if(!nav.firstElementChild){
    nav.innerHTML=Object.entries(accountSections).map(([key,label])=>`<a href="${accountPath(key)}" data-view="${key}">${accountIcon(key)}<span>${label}</span>${key==='notifications'?'<small class="unread-count" hidden></small>':''}</a>`).join('');
    paintUnread();
  }
  if(!actions.firstElementChild || Boolean(actions.querySelector('a'))!==Boolean(user.is_admin)){
    actions.innerHTML=(user.is_admin?`<a href="/admin">${accountIcon('admin')}Admin panel</a>`:'')+`<button type="button" data-signout>${accountIcon('out')}Sign out</button>`;
  }
  nav.querySelector('[aria-current]')?.removeAttribute('aria-current');
  nav.querySelector(`[data-view="${view}"]`).setAttribute('aria-current','page');
  revealActiveTab();
}
function revealActiveTab(){
  const nav=$('#walletNav'),active=nav.querySelector('[aria-current]');
  if(!active || accountPage.hidden)return;
  // Reveal only the clipped edge; never scroll the document or recenter a visible link.
  const scroller=phoneWallet.matches?nav:nav.closest('.account-rail');
  const link=active.getBoundingClientRect(),box=scroller.getBoundingClientRect();
  if(phoneWallet.matches)scroller.scrollLeft+=Math.min(0,link.left-box.left)+Math.max(0,link.right-box.right);
  else scroller.scrollTop+=Math.min(0,link.top-box.top)+Math.max(0,link.bottom-box.bottom);
}
function currencyOptions(selected,crypto=false){
  return (crypto?walletAssets:assets).map(a=>`<option value="${esc(a.id)}" ${a.id===selected?'selected':''}>${esc(a.symbol)}</option>`).join('');
}
function explorerLink(chain,txid){
  if(!txid)return '';
  const base={ETH:'https://etherscan.io/tx/',BSC:'https://bscscan.com/tx/',POL:'https://polygonscan.com/tx/',SOL:'https://explorer.solana.com/tx/',BTC:'https://mempool.space/tx/',TRON:'https://tronscan.org/#/transaction/'}[chain];
  return base?`<a href="${base}${encodeURIComponent(txid)}" target="_blank" rel="noopener noreferrer">${esc(txid)}</a>`:esc(txid);
}
window.addEventListener('resize',revealActiveTab);
function controlsForStats(){
  return `<div class="activity-tools"><label>Currency <select id="statsAsset">${currencyOptions(statsAsset)}</select></label><label>Period <select id="statsPeriod">${[7,30,90].map(n=>`<option value="${n}" ${n===statsDays?'selected':''}>${n} days</option>`).join('')}</select></label></div>`;
}
function statChart(days,dec,symbol){
  const net=statsMetric==='net';
  let sum=0n;
  const points=days.map(d=>{sum+=BigInt(d.payout)-BigInt(d.stake);return net?sum:BigInt(d.stake);});
  let high=0n,low=0n;
  for(const v of points){if(v>high)high=v;if(v<low)low=v;}
  const range=high-low||1n;
  const y=v=>96-Number((v-low)*7400n/range)/100;
  const x=i=>12+i*(476/Math.max(points.length-1,1));
  const line=points.map((v,i)=>(i?'L':'M')+x(i).toFixed(2)+' '+y(v).toFixed(2)).join(' ');
  const color=net?(sum<0n?'#d6a0a2':'#93c8b0'):'#c8ad7f';
  const money=v=>gameAmount(v,{symbol,decimals:dec});
  const pointTitle=(v,i)=>`<title>${esc(days[i].day+' · '+money(v))}</title>`;
  const title=net?'Cumulative net result':'Daily amount wagered';
  const marks=net?`<path d="${line}" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`+
    points.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="${i===points.length-1?4:2}" fill="${color}">${pointTitle(v,i)}</circle>`).join(''):
    points.map((v,i)=>{const w=Math.min(18,320/points.length);return `<rect x="${x(i)-w/2}" y="${y(v)}" width="${w}" height="${96-y(v)}" rx="1" fill="${color}">${pointTitle(v,i)}</rect>`;}).join('');
  return `<section class="chart-card"><div class="chart-heading"><div><h3>${title}</h3><small>By date placed · UTC</small></div><div class="chart-switch" role="group" aria-label="Chart metric">${[['net','Net result'],['stake','Wagered']].map(([key,label])=>`<button type="button" data-metric="${key}" aria-pressed="${statsMetric===key}">${label}</button>`).join('')}</div></div>
    <svg class="result-chart" viewBox="0 0 500 116" role="img" aria-label="${esc(title+' in '+symbol)}"><path d="M12 20H488 M12 58H488 M12 96H488" stroke="#323b46" stroke-dasharray="3 5" fill="none"/><path d="M12 ${y(0n)}H488" stroke="#505c65"/>${marks}</svg>
    <div class="chart-axis"><span>${esc(days[0]?.day)}</span><span>${esc(days.at(-1)?.day)}</span></div>
    <details><summary>Daily results</summary><table class="chart-table"><thead><tr><th>Date (UTC)</th><th>Bets</th><th>Wagered</th><th>Net result</th></tr></thead><tbody>${days.map(d=>`<tr><td>${esc(d.day)}</td><td>${d.bets}</td><td>${esc(displayAmount(d.stake,{symbol,decimals:dec}))}</td><td>${esc(displayAmount(BigInt(d.payout)-BigInt(d.stake),{symbol,decimals:dec}))}</td></tr>`).join('')}</tbody></table></details></section>`;
}
async function showStats(seq){
  const d=await api('/me/stats?asset='+encodeURIComponent(statsAsset||'COINS')+'&days='+statsDays);
  if(seq!==activitySeq)return;
  const t={stake:0n,payout:0n,bets:0,wins:0,usdt:0n,unpriced:0};
  for(const day of d.days){
    t.stake+=BigInt(day.stake);t.payout+=BigInt(day.payout);t.bets+=day.bets;t.wins+=day.wins;
    t.unpriced+=day.unpriced_usdt||0;
  }
  const money=n=>gameAmount(n,d),net=t.payout-t.stake;
  $('#activityResults').innerHTML=`<dl class="stats-grid">${[['Net result',money(net),net>0n?'positive':net<0n?'negative':''],['Wagered',money(t.stake)],['Bets settled',t.bets],['Winning bets',t.wins]].map(([l,v,tone])=>`<div><dt>${l}</dt><dd class="${tone||''}">${esc(v)}</dd></div>`).join('')}</dl>`+
    (t.bets?`<p class="wallet-muted" id="wagerValuation">Results in coins. Historical crypto bets use their recorded value at placement.</p>`+statChart(d.days,d.decimals,d.symbol):'<p class="wallet-empty">No settled bets in this period.</p>');
  if(!t.bets)return;
  const switchChart=e=>{
    const button=e.target.closest('[data-metric]');
    if(!button)return;
    statsMetric=button.dataset.metric;
    $('#walletContent .chart-card').outerHTML=statChart(d.days,d.decimals,d.symbol);
    $('.chart-switch').onclick=switchChart;
    $('.chart-switch [aria-pressed=true]').focus({preventScroll:true});
  };
  $('.chart-switch').onclick=switchChart;
}
function pager(more){
  return (more||pageIndex)?`<div class="activity-pager"><button data-page="-1" ${pageIndex?'':'disabled'}>Previous</button><small>Page ${pageIndex+1}</small><button data-page="1" ${more?'':'disabled'}>Next</button></div>`:'';
}
const gameAmount=(n,asset)=>displayAmount(n,asset)+' '+asset.symbol;
function detailValue(key,value,b){
  if(value==null)return '';
  if(key==='Hands')return value.map((h,i)=>`Hand ${i+1} · ${h.cards.map(cardFace).join(' ')}${h.result?' · '+h.result:''} · ${gameAmount(h.bet,b)}`).join(' / ');
  if(key==='Dealer cards')return value.map(cardFace).join(' ');
  if(key==='Insurance')return gameAmount(value,b);
  if(Array.isArray(value))return value.join(', ');
  if(typeof value==='boolean')return value?'Yes':'No';
  return String(value);
}
const cardFace=c=>['A','2','3','4','5','6','7','8','9','10','J','Q','K'][c%13]+['♠','♥','♦','♣'][Math.floor(c/13)];
async function showBet(seq){
  const {game,id}=expandedBet;
  const b=await api('/me/bets/'+encodeURIComponent(game)+'/'+encodeURIComponent(id));if(seq!==activitySeq)return;
  const settled=['done','cashed','lost','rolling','cancelled'].includes(b.status);
  const facts=[['Placed',receiptDate.format(new Date(b.created_at))],['Stake',gameAmount(b.stake,b)],
    ['Payout',settled?gameAmount(b.payout,b):'Pending'],['Net result',settled?gameAmount(BigInt(b.payout)-BigInt(b.stake),b):'Pending'],
    ...Object.entries(b.detail).filter(([,v])=>v!=null).map(([k,v])=>[k,detailValue(k,v,b)]),['Bet ID',b.id]];
  $('#walletContent').innerHTML=`<button class="wallet-link" data-back-bets>← Bet history</button><div class="wallet-heading bet-heading"><h2>${esc(gameNames[b.game])}</h2><b class="wallet-status" data-state="${esc(b.status)}">${esc(states[b.status]||b.status)}</b></div>
    <dl class="bet-facts">${facts.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
}
const transactionTypes={all:'All transactions',deposits:'Deposits',withdrawals:'Withdrawals',conversions:'Conversions',bets:'Bets',rewards:'Rewards',adjustments:'Balance adjustments'};
function transactionFilter(){
  return `<div class="transaction-toolbar"><label for="transactionType">Transaction type</label><select id="transactionType">${Object.entries(transactionTypes).map(([key,label])=>`<option value="${key}" ${key===transactionType?'selected':''}>${label}</option>`).join('')}</select></div>`;
}
async function showList(seq){
  const isBet=view==='bets',params=new URLSearchParams({page:String(pageIndex)});
  if(isBet&&betFilter)params.set('game',betFilter);
  if(!isBet)params.set('type',transactionType);
  const d=await api('/me/'+(isBet?'bets':'transactions')+'?'+params);if(seq!==activitySeq)return;
  const rows=d.rows.map(b=>isBet?`<button type="button" class="activity-entry" data-bet="${esc(b.id)}" data-game="${esc(b.game)}">
    ${logo(b.symbol)}<span><strong>${esc(gameNames[b.game])}</strong><small>${receiptTime(b.created_at)}</small></span><b>${esc(gameAmount(b.stake,b))}<small>Stake · ${esc(states[b.status]||b.status)}</small></b></button>`:
    `<details class="transaction-details"><summary class="activity-entry">${logo(b.symbol)}<span><strong>${esc(flowName(b.kind))}</strong><small>${receiptTime(b.created_at)}${b.chain_id?' · '+esc(network(b.chain_id)):''}${b.withdrawal_status?' · '+esc(states[b.withdrawal_status]):''}</small></span><b class="${BigInt(b.delta)>0n?'positive':''}">${BigInt(b.delta)>0n?'+':''}${esc(amountText(b.delta,b.decimals,b.symbol))}</b></summary>
      <dl class="bet-facts"><div><dt>Ledger entry</dt><dd>${esc(b.id)}</dd></div>${transactionRef(b)}${b.txid?`<div><dt>Transaction ID</dt><dd>${explorerLink(b.chain_id,b.txid)}</dd></div>`:''}</dl></details>`).join('');
  $('#activityResults').innerHTML=(rows||`<p class="wallet-empty">No ${isBet?'bets':transactionType==='all'?'transactions':transactionTypes[transactionType].toLowerCase()} to show.</p>`)+pager(d.more);
}
async function activity(focusAfter){
  const seq=++activitySeq,host=$('#walletContent');
  const filtered=view==='stats'||view==='transactions'||(view==='bets'&&!expandedBet);
  if(filtered && !$('#activityResults')){
    if(host.contains(document.activeElement))$('#walletTitle').focus({preventScroll:true});
    const filter=view==='stats'?controlsForStats():view==='transactions'?transactionFilter():`<div class="activity-tools"><label>Game <select id="betFilter"><option value="">All games</option>${Object.entries(gameNames).map(([k,v])=>`<option value="${k}" ${betFilter===k?'selected':''}>${v}</option>`).join('')}</select></label></div>`;
    host.innerHTML=filter+'<div id="activityResults"></div>';
  }
  const result=filtered?$('#activityResults'):host;
  loading(result,'Loading '+(expandedBet?'bet details':accountSections[view].toLowerCase()),view==='stats'?'stats':view==='withdraw'?'form':'list');
  try{
    if(view==='rewards')await showRewards(seq);
    else if(view==='notifications')await showNotifications(seq);
    else if(view==='stats')await showStats(seq);
    else if(view==='bets'&&expandedBet)await showBet(seq);
    else if(view==='withdraw')await showWithdraw(seq);
    else await showList(seq);
    if(seq===activitySeq && focusAfter && document.activeElement===$('#walletTitle'))host.querySelector(focusAfter)?.focus();
  }catch(err){if(seq===activitySeq){if(err.status===401)applyAccount(null);else result.innerHTML=notice('Could not load '+(expandedBet?'bet details':accountSections[view].toLowerCase())+'.', 'activity');}}
  finally{if(seq===activitySeq)result.removeAttribute('aria-busy');}
}
accountPage.addEventListener('change',e=>{
  const {id,value}=e.target;
  if(id==='statsAsset')statsAsset=value;
  else if(id==='statsPeriod')statsDays=Number(value);
  else if(id==='betFilter'){betFilter=value;pageIndex=0;}
  else if(id==='transactionType'){transactionType=value;pageIndex=0;}
  else return;
  void activity();
});
const receiptMarkup=new WeakMap();
function renderReceipts(host,rows,empty){
  if(!rows.length){if(!host.querySelector('.wallet-empty'))host.innerHTML=`<p class="wallet-empty">${esc(empty)}</p>`;return;}
  // Polls can update a status or add a receipt while someone is reading another one.
  const previous=new Map([...host.children].filter(el=>el.matches('details')).map(el=>[el.dataset.id,el]));
  rows.forEach(([id,markup],i)=>{
    const el=previous.get(id)||document.createElement('details');previous.delete(id);
    if(el!==host.children[i])host.insertBefore(el,host.children[i]||null);
    if(receiptMarkup.get(el)===markup)return;
    const focused=el.contains(document.activeElement)?document.activeElement.localName:null;
    el.className='transaction-details';el.dataset.id=id;el.innerHTML=markup;receiptMarkup.set(el,markup);
    if(focused)(el.querySelector(focused)||el.querySelector('summary')).focus({preventScroll:true});
  });
  while(host.children.length>rows.length)host.lastElementChild.remove();
}
function renderWithdrawalHistory(d,host=$('#withdrawalRecords')){
  const notes={requested:'Funds are reserved. You can cancel before review begins.',reviewing:'Your request is being reviewed and can no longer be cancelled.',approved:'Approved for transfer. A transaction ID will appear once payment is recorded.',sent:'This transfer has been recorded as sent.',cancelled:'The reserved amount was returned to your available balance.'};
  renderReceipts(host,d.rows.map(w=>[String(w.id),`<summary class="activity-entry">${logo(w.symbol)}<span><strong>${esc(amountText(w.amount,w.decimals,w.symbol))}</strong><small>${esc(network(w.chain_id))} · ${receiptTime(w.created_at)}</small></span><b class="wallet-status" data-state="${esc(w.status)}">${esc(states[w.status]||w.status)}</b></summary>
    ${notes[w.status]?`<p class="receipt-note">${notes[w.status]}</p>`:''}<dl class="bet-facts"><div><dt>Destination</dt><dd>${esc(w.destination)}</dd></div><div><dt>Request ID</dt><dd>${esc(w.id)}</dd></div>${w.txid?`<div><dt>Transaction ID</dt><dd>${explorerLink(w.chain_id,w.txid)}</dd></div>`:''}</dl>
    ${w.status==='requested'?`<button class="wallet-link" data-cancel-withdraw="${esc(w.id)}">Cancel withdrawal</button>`:''}`]),'No withdrawal requests yet.');
}
async function refreshWithdrawalHistory(){
  const seq=activitySeq,sheet=sheetVersion;
  try{
    const d=await api('/me/withdrawals');
    if(seq===activitySeq && $('#withdrawalRecords'))renderWithdrawalHistory(d);
    if(sheet===sheetVersion && $('#popupWithdrawalRecords'))renderWithdrawalHistory(d,$('#popupWithdrawalRecords'));
  }catch{}
}
async function showWithdraw(seq,host=$('#walletContent')){
  const pop=host===moneyPane, live=()=>pop?menu.open&&walletTab==='withdraw'&&seq===sheetVersion:seq===activitySeq&&host.isConnected;
  const elId=id=>pop?'popup'+id[0].toUpperCase()+id.slice(1):id,get=id=>host.querySelector('#'+elId(id));
  const a=walletAssets.find(a=>a.id===(pop?popupWithdraw:withdrawCurrency))||walletAssets[0],options=routes.filter(r=>r.enabled&&r.symbol===a?.symbol),d=await api('/me/withdrawals');
  if(!live())return;
  if(pop)popupWithdraw=a?.id;else withdrawCurrency=a?.id;
  const chooseCurrency=`<label>Currency<select id="${elId('withdrawCurrency')}">${currencyOptions(a?.id,true)}</select></label>`;
  const form=a&&options.length?`<div class="withdraw-balance">${logo(a.symbol)}<span>Available to withdraw</span><b id="${elId('withdrawAvailable')}">${esc(walletFresh?amountOf(a):'—')} ${esc(a.symbol)}</b></div>
    <form id="${elId('withdrawForm')}" class="withdraw-form"><div class="withdraw-fields"><div class="wallet-fields">${chooseCurrency}<label>Network<select name="route">${options.map(r=>`<option value="${esc(r.id)}">${esc(network(r.chain_id))}</option>`).join('')}</select></label></div>
    <label>Destination address<input name="destination" required maxlength="100" autocomplete="off" spellcheck="false"></label>
    <label>Amount in ${esc(a.symbol)}<input name="amount" required maxlength="60" inputmode="decimal" autocomplete="off" placeholder="0.00"></label>
    <p class="wallet-muted">Confirming reserves the amount for manual review. You can cancel until review begins.</p>
    </div><section id="${elId('withdrawReview')}" hidden aria-labelledby="${elId('reviewTitle')}"><h3 id="${elId('reviewTitle')}" tabindex="-1">Review withdrawal</h3><div id="${elId('reviewDetails')}"></div></section>
    <div class="withdraw-actions"><button class="secondary-action" type="button" id="${elId('withdrawEdit')}" hidden>Edit details</button><button class="wallet-primary" type="submit">Review withdrawal</button></div><p id="${elId('withdrawStatus')}" role="status"></p></form>`:`<div class="withdraw-form">${chooseCurrency}</div>`+notice('No withdrawal network is available for this currency.');
  host.innerHTML=`<p class="wallet-muted withdrawal-conversion-note">Convert coins back to crypto before withdrawing. <button type="button" class="wallet-link" data-open-conversion>Convert coins →</button></p>`+form+`<details class="popup-withdrawal-history"><summary>Withdrawal history</summary><section id="${elId('withdrawalRecords')}" aria-label="Withdrawal receipts"></section></details>`;
  renderWithdrawalHistory(d,get('withdrawalRecords'));
  get('withdrawCurrency').onchange=e=>{if(pop){popupWithdraw=e.target.value;void popupWithdrawal();}else{withdrawCurrency=e.target.value;void activity('#withdrawCurrency');}};
  const el=get('withdrawForm');if(!el)return;
  let reviewed=null,withdrawalKey=null,busy=false;
  const inputs=el.querySelector('.withdraw-fields'),review=get('withdrawReview'),edit=get('withdrawEdit'),submit=el.querySelector('[type=submit]'),status=get('withdrawStatus');
  edit.onclick=()=>{
    reviewed=null;withdrawalKey=null;inputs.hidden=false;review.hidden=edit.hidden=true;
    submit.textContent='Review withdrawal';status.textContent='';el.elements.destination.focus();
  };
  el.onsubmit=async event=>{
    event.preventDefault();if(busy)return;
    if(!reviewed){
      const fields=Object.fromEntries(new FormData(el)),route=options.find(r=>r.id===fields.route);
      fields.amount=fields.amount.trim();fields.destination=fields.destination.trim();
      const [whole,frac='']=fields.amount.split('.');
      if(!route || !/^\d+(?:\.\d+)?$/.test(fields.amount) || /^0+(?:\.0+)?$/.test(fields.amount) || frac.length>route.decimals){
        status.textContent='Enter a positive amount with up to '+(route?.decimals||0)+' decimal places on this network.';return;
      }
      if(!fields.destination){status.textContent='Enter the destination address.';return;}
      if(walletFresh && BigInt(whole+frac.padEnd(a.decimals,'0'))>BigInt(balances.get(a.id)?.amount||'0')){
        status.textContent='Insufficient available balance.';return;
      }
      reviewed=fields;inputs.hidden=true;review.hidden=edit.hidden=false;
      get('reviewDetails').innerHTML=`<div class="review-amount">${logo(a.symbol)}<strong>${esc(fields.amount)} ${esc(a.symbol)}</strong></div>
        <dl class="bet-facts"><div><dt>Network</dt><dd>${esc(network(route.chain_id))}</dd></div><div><dt>Destination</dt><dd class="review-address">${esc(fields.destination)}</dd></div><div><dt>Processing</dt><dd>Manual review</dd></div></dl>`;
      status.textContent='Confirm to reserve this amount for withdrawal.';submit.textContent='Confirm request';get('reviewTitle').focus({preventScroll:true});return;
    }
    busy=true;submit.disabled=edit.disabled=true;status.textContent='Submitting request…';
    const version=accountVersion;
    try{
      withdrawalKey ||= makeId();
      await api('/me/withdrawals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...reviewed,request:withdrawalKey})});
      if(version===accountVersion){await refresh();if(live()){
        if(pop){await showWithdraw(seq,host);if(live())get('withdrawStatus').textContent='Withdrawal requested. Your available balance reflects the reserved amount.';}
        else await activity();
      }}
    }catch(err){status.textContent=err.message;}finally{busy=false;submit.disabled=edit.disabled=false;}
  };
}
const coinCount=value=>String(value??'0').replace(/\B(?=(\d{3})+(?!\d))/g,',');
async function showRewards(seq){
  const d=await api('/me/rewards');if(seq!==activitySeq)return;
  const next=d.packs.find(p=>!p.earned),remaining=next?String(BigInt(next.wager_required)-BigInt(d.wagered)):'0';
  $('#walletContent').innerHTML=`<section class="account-reward-progress"><span class="pack-level-emblem">${d.level}</span><div><span class="eyebrow">Your winter collection</span><h2>Level ${d.level} <small>/ 100</small></h2><progress max="100" value="${d.progress}" aria-label="Progress to next player level"></progress><p>${next?coinCount(remaining)+' coins in settled wagers to your next pack':'Every pack unlocked. Your collection is complete.'}</p></div><strong>${d.ready_count}<small>packs ready</small></strong></section><div class="wallet-heading account-collection-title"><div><h2>Daily coin rewards</h2><p>One free pack every 10 levels. Open each unlocked pack once every 24 hours.</p></div><button type="button" class="secondary-action" data-open-reward-collection>Explore collection →</button></div><div class="account-pack-grid">${d.packs.map(p=>`<article class="account-pack" data-ready="${p.ready}" data-earned="${p.earned}"><span class="eyebrow">Level ${p.level}</span><span class="account-pack-emblem">${accountIcon(p.earned?'rewards':'security')}</span><h3>${esc(p.name)}</h3><p>${p.ready?'Ready to open':p.earned?'Opens '+esc(timeOf(p.next_at)):coinCount(p.wager_required)+' coins wagered to unlock'}</p><button type="button" class="${p.ready?'wallet-primary':'secondary-action'}" data-open-reward-pack="${p.level}">${p.ready?'Open pack':'Preview pack'}</button></article>`).join('')}</div><p class="wallet-muted">Pack rewards go straight to your server-stored coin balance. Free rewards and cancelled battles do not increase wager progress.</p>`;
}

const notificationNames={
  'deposit.pending':'Deposit detected','deposit.credited':'Deposit credited','deposit.orphaned':'Deposit removed from the chain',
  'withdrawal.requested':'Withdrawal requested','withdrawal.reviewing':'Withdrawal in review','withdrawal.approved':'Withdrawal approved',
  'withdrawal.sent':'Withdrawal sent','withdrawal.cancelled':'Withdrawal funds returned','reward.claimed':'Historical level bonus credited','reward.pack_claimed':'Daily pack credited',
  'conversion.completed':'Conversion completed','leaderboard.prize':'Weekly prize credited',
  'balance.credit':'Balance credited','balance.debit':'Balance deducted',
  'security.2fa_enabled':'Authenticator enabled','security.2fa_disabled':'Authenticator disabled',
  'security.password_changed':'Password changed','security.password_recovered':'Password recovered',
  'security.sessions_revoked':'Other sessions signed out'
};
let noticeController=null,unread=0,noticeTimer,noticeDeadline=0,noticeRemaining=8000;
const announcedNotices=new Set();
bindSoundToggle($('#noticeSound'));
export function paintUnread(){
  document.querySelectorAll('.unread-count').forEach(el=>{el.hidden=!unread;el.textContent=unread>99?'99+':String(unread);});
  const bell=$('#noticeBell');bell.classList.toggle('has-unread',unread>0);
  bell.setAttribute('aria-label',unread?'Notifications, '+unread+' unread':'Notifications');
  const badge=$('#popupUnread');badge.hidden=!unread;badge.textContent=unread?(unread>99?'99+':unread)+' unread':'';
}
function stopNotifications(){
  closeNoticePopup();noticeController?.abort();noticeController=null;clearTimeout(noticeTimer);
  popupReading=false;unread=0;paintUnread();$('#accountAlert').hidden=true;
}
function scheduleNoticeDismiss(){
  clearTimeout(noticeTimer);noticeDeadline=performance.now()+noticeRemaining;
  noticeTimer=setTimeout(()=>{$('#accountAlert').hidden=true;},noticeRemaining);
}
function pauseNoticeDismiss(){
  clearTimeout(noticeTimer);noticeRemaining=Math.max(0,noticeDeadline-performance.now());
}
function resumeNoticeDismiss(){if(!$('#accountAlert').matches(':hover,:focus-within'))scheduleNoticeDismiss();}
function announceNotice(n,count){
  const id=user?.id,revision=String(n.revision),key='banditblox.notice.'+id;
  if(!id||announcedNotices.has(id+':'+revision))return;
  // Share delivered revisions between tabs; initial unread history stays silent.
  try{const delivered=localStorage.getItem(key);if(delivered&&BigInt(delivered)>=BigInt(revision))return;localStorage.setItem(key,revision);}catch{}
  announcedNotices.add(id+':'+revision);
  if(announcedNotices.size>200)announcedNotices.delete(announcedNotices.values().next().value);
  const alert=$('#accountAlert'),credited=['deposit.credited','balance.credit','reward.claimed','conversion.completed','leaderboard.prize','reward.pack_claimed'].includes(n.kind);
  const pending=n.kind==='deposit.pending',deducted=n.kind==='balance.debit';
  const financial=n.amount!=null&&Number.isInteger(n.decimals)&&typeof n.symbol==='string';
  const flow=deducted?'debit':credited?'credit':pending?'pending':'update';
  const type=deducted?'Debit':credited?'Credit':pending?'Pending':n.kind.startsWith('security.')?'Security':'Update';
  alert.dataset.tone=credited?'success':pending?'pending':'info';alert.dataset.flow=flow;alert.dataset.financial=String(financial);
  const detail=pending&&n.required_conf!=null?'Awaiting '+n.required_conf+' confirmations':credited?'Available in your wallet':deducted?'Balance adjustment recorded':'View your account for details';
  const metadata=[n.chain_id?network(n.chain_id):financial?'Account balance':null,n.created_at?timeOf(n.created_at):null,count>1?count+' new updates':null].filter(Boolean).join(' · ');
  const value=financial?`${logo(n.symbol)}<span class="alert-value"><span class="alert-number">${credited&&BigInt(n.amount)>0n?'+':''}${esc(human(n.amount,n.decimals))}</span> <span class="alert-currency">${esc(n.symbol)}</span></span>`:esc(amountText(n.amount,n.decimals,n.symbol));
  alert.innerHTML=`<button type="button" class="notice-open" aria-label="${esc(notificationNames[n.kind]||'Account update')}. View notifications"><span class="alert-icon">${accountIcon(deducted?'withdraw':credited?'deposit':pending?'clock':'notifications')}</span><span class="alert-copy"><span class="alert-topline"><span class="alert-kicker">${financial?'Wallet activity':'Account activity'}</span><span class="alert-type">${type}</span></span><strong>${esc(notificationNames[n.kind]||'Account update')}</strong><span class="alert-amount">${value}</span><small class="alert-meta">${esc(metadata)}</small><span class="alert-bottomline"><span class="alert-detail">${esc(detail)}</span><span class="alert-action">View activity <span aria-hidden="true">→</span></span></span></span></button><button type="button" class="notice-dismiss" aria-label="Dismiss notification">×</button><span class="alert-timer" aria-hidden="true"></span>`;
  alert.hidden=false;alert.querySelector('.notice-open').onclick=()=>{alert.hidden=true;clearTimeout(noticeTimer);open(n.kind.startsWith('security.')?'security':'notifications');};
  alert.querySelector('.notice-dismiss').onclick=()=>{alert.hidden=true;clearTimeout(noticeTimer);};
  alert.onpointerenter=alert.onfocusin=pauseNoticeDismiss;alert.onpointerleave=alert.onfocusout=resumeNoticeDismiss;
  noticeRemaining=8000;scheduleNoticeDismiss();playSound(credited?'success':'info');
}
async function startNotifications(){
  stopNotifications();const controller=new AbortController();noticeController=controller;
  const {signal}=controller;let revision=null;
  while(!signal.aborted){
    try{
      const d=await api(revision===null?'/me/notifications':'/me/notifications/changes?after='+revision,{signal});
      if(signal.aborted)return;
      unread=d.unread;paintUnread();
      if(revision!==null && d.revision!==revision){
        const fresh=await api('/me/notifications',{signal});if(signal.aborted)return;
        const newNotices=fresh.rows.filter(n=>BigInt(n.revision)>BigInt(revision));
        revision=fresh.revision;unread=fresh.unread;paintUnread();
        if($('#noticePopup').open)paintNoticePopup(fresh);
        else if(newNotices.length)announceNotice(newNotices[0],newNotices.length);
        void refresh();
        if(!accountPage.hidden && view==='notifications')await updateInbox(fresh,signal);
        if(!accountPage.hidden && view==='transactions' && !pageIndex && !$('#walletContent details[open]'))void showList(activitySeq).catch(()=>{});
        if(!accountPage.hidden && view==='rewards' && fresh.rows[0]?.kind==='reward.pack_claimed')void showRewards(activitySeq).catch(()=>{});
        if(!accountPage.hidden && view==='withdraw')void refreshWithdrawalHistory();
      }else {revision=d.revision;if(popup.open && popupThrough!=='0'){
        $('#readPopup').disabled=popupReading || !unread;
        if(!unread)popup.querySelectorAll('[data-unread=true]').forEach(n=>n.dataset.unread='false');
      }if(view==='notifications'&&!accountPage.hidden && $('#markRead'))paintInboxCount();}
    }catch(err){
      if(signal.aborted)return;
      if(err.status===401){applyAccount(null);return;}
      await new Promise(r=>setTimeout(r,1800));
    }
  }
}
function notificationList(rows){
  return rows.map(n=>`<article class="notice-entry" data-kind="${esc(n.kind)}" data-revision="${esc(n.revision)}" data-unread="${!n.read_at}"><span class="notice-icon">${accountIcon(n.kind.startsWith('deposit')?'deposit':n.kind.startsWith('withdrawal')?'withdraw':n.kind.startsWith('security.')?'security':n.kind.startsWith('reward.')?'rewards':'transactions')}</span>
    <div><strong>${esc(notificationNames[n.kind]||'Account update')}</strong><p>${esc(amountText(n.amount,n.decimals,n.symbol))}${n.chain_id?' · '+esc(network(n.chain_id)):''}</p>
    ${n.kind==='deposit.pending' && n.required_conf!=null?`<small>Awaiting ${esc(n.required_conf)} confirmations</small>`:''}${n.txid?`<details><summary>Transaction ID</summary>${explorerLink(n.chain_id,n.txid)}</details>`:''}</div><time>${esc(timeOf(n.created_at))}</time></article>`).join('');
}
const popup=$('#noticePopup'),bell=$('#noticeBell'),popupFeed=popup.querySelector('.popup-feed'),popupStatus=popup.querySelector('.popup-status');
let popupRequest=0,popupThrough='0',popupReading=false;
function closeNoticePopup(){
  ++popupRequest;
  if(popup.open)popup.close();
  bell.setAttribute('aria-expanded','false');popupFeed.replaceChildren();popupStatus.textContent='';popupThrough='0';
}
function paintNoticePopup(d){
  if(!popup.open)return;
  ++popupRequest;popupThrough=d.revision;
  const rows=d.rows.slice(0,5),ids=new Set(rows.map(n=>String(n.revision))),hadFocus=popupFeed.contains(document.activeElement);
  if(!rows.length){
    if(!popupFeed.querySelector('.popup-empty'))popupFeed.innerHTML=`<div class="popup-empty"><span class="empty-notice-icon" aria-hidden="true">${accountIcon('notifications')}</span><strong>You’re all caught up.</strong><p>Deposits, withdrawals and account updates will appear here.</p></div>`;
  }else{
    // Receipts are immutable apart from read state. Keep any open transaction ID and its keyboard focus.
    for(const item of [...popupFeed.children])if(!ids.has(item.dataset.revision))item.remove();
    rows.forEach((n,i)=>{
      const item=popupFeed.children[i];
      if(item?.dataset.revision===String(n.revision))item.dataset.unread=String(!n.read_at);
      else if(item)item.insertAdjacentHTML('beforebegin',notificationList([n]));
      else popupFeed.insertAdjacentHTML('beforeend',notificationList([n]));
    });
  }
  if(hadFocus && !popupFeed.contains(document.activeElement))$('#closeNotices').focus({preventScroll:true});
  $('#readPopup').disabled=popupReading || !d.unread;
}
async function loadNoticePopup(){
  const seq=++popupRequest;
  popupStatus.textContent='';popupFeed.innerHTML=placeholder('Loading notifications');$('#readPopup').disabled=true;
  try{const d=await api('/me/notifications');if(seq===popupRequest && popup.open)paintNoticePopup(d);}
  catch{if(seq===popupRequest && popup.open)popupFeed.innerHTML=notice('Could not load notifications.','popup');}
}
function positionPopup(){
  if(!popup.open)return;
  const box=bell.getBoundingClientRect();
  popup.style.top=Math.max(6,box.bottom+9)+'px';popup.style.right=Math.max(8,innerWidth-box.right)+'px';
  if(popup.getBoundingClientRect().left<8)popup.style.right='8px';
}
bell.onclick=()=>{
  if(popup.open){closeNoticePopup();return;}
  closeMenu();$('#accountAlert').hidden=true;popup.show();bell.setAttribute('aria-expanded','true');positionPopup();void loadNoticePopup();
};
$('#closeNotices').onclick=()=>{closeNoticePopup();bell.focus();};
$('#openInbox').onclick=e=>{if(e.ctrlKey||e.metaKey||e.shiftKey)return;e.preventDefault();closeNoticePopup();open('notifications');};
popup.addEventListener('click',e=>{if(e.target.closest('[data-retry=popup]'))void loadNoticePopup();});
$('#readPopup').onclick=async e=>{
  const button=e.currentTarget,version=accountVersion,through=popupThrough;
  if(popupReading || through==='0')return;
  popupReading=true;button.disabled=true;popupStatus.textContent='';
  try{
    const d=await api('/me/notifications/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({through})});
    if(version!==accountVersion)return;
    if(BigInt(d.revision)>=BigInt(popupThrough)){unread=d.unread;paintUnread();}
    popupFeed.querySelectorAll('[data-revision]').forEach(n=>{if(BigInt(n.dataset.revision)<=BigInt(through))n.dataset.unread='false';});
    if(view==='notifications' && $('#markRead'))paintInboxCount();
  }catch{if(version===accountVersion && popup.open)popupStatus.textContent='Could not mark notifications as read. Try again.';}
  finally{if(version===accountVersion){popupReading=false;button.disabled=popupThrough==='0'||!unread;}}
};
document.addEventListener('pointerdown',e=>{if(popup.open&&!popup.contains(e.target)&&!bell.contains(e.target))closeNoticePopup();});
document.addEventListener('focusin',e=>{if(popup.open&&!popup.contains(e.target)&&e.target!==bell)closeNoticePopup();});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&popup.open){e.preventDefault();e.stopImmediatePropagation();closeNoticePopup();bell.focus();}
},true);
window.addEventListener('resize',positionPopup);
function inboxReceipts(rows){
  return rows.map(n=>{
    const kind=n.kind.split('.')[0],section={withdrawal:'withdraw',reward:'rewards',balance:'transactions',deposit:'transactions',security:'security'}[kind];
    const reference=n.reference;
    const link=section && (kind!=='deposit' || n.kind==='deposit.credited')?`<a class="section-link" href="${accountPath(section)}" data-view="${section}">${{withdraw:'View withdrawals',rewards:'View rewards',transactions:'View transactions',security:'Review security'}[section]}</a>`:'';
    return `<article class="notice-entry inbox-entry" data-revision="${esc(n.revision)}" data-unread="${!n.read_at}"><details class="transaction-details"><summary class="activity-entry"><span class="notice-icon">${accountIcon({deposit:'deposit',withdrawal:'withdraw',reward:'rewards',security:'security'}[kind]||'transactions')}</span>
      <span><strong>${esc(notificationNames[n.kind]||'Account update')}</strong><small>${receiptTime(n.created_at)} <span class="inbox-unread">Unread</span></small></span>
      <b>${esc(amountText(n.amount,n.decimals,n.symbol))}${n.chain_id?`<small>${esc(network(n.chain_id))}</small>`:''}</b></summary>
      <div class="inbox-receipt"><dl class="bet-facts">${n.kind==='deposit.pending'&&n.required_conf!=null?`<div><dt>Confirmations at detection</dt><dd>${esc(n.confirmations??'—')} / ${esc(n.required_conf)}</dd></div>`:''}${reference?`<div><dt>${kind==='withdrawal'?'Request ID':'Reference'}</dt><dd>${esc(reference)}</dd></div>`:''}${n.txid?`<div><dt>Transaction ID</dt><dd>${explorerLink(n.chain_id,n.txid)}</dd></div>`:''}</dl>${link}</div></details></article>`;
  }).join('');
}
function paintInboxCount(){
  const button=$('#markRead');if(!button)return;
  $('.notice-tools strong').textContent=unread+' unread';button.disabled=!unread || button.getAttribute('aria-busy')==='true';
  if(!unread)document.querySelectorAll('#noticeList [data-unread=true]').forEach(n=>{n.dataset.unread='false';});
}
async function updateInbox(fresh,signal){
  const list=$('#noticeList');if(!list)return;
  const latest=BigInt(list.dataset.revision);
  if(BigInt(fresh.revision)<=latest){paintInboxCount();return;}
  let page=fresh;
  const added=[];
  while(true){
    added.push(...page.rows.filter(n=>BigInt(n.revision)>latest));
    const tail=page.rows.at(-1);
    if(!page.more || !tail || BigInt(tail.revision)<=latest)break;
    page=await api('/me/notifications?before='+tail.revision,{signal});
    if(!list.isConnected||signal.aborted)return;
  }
  list.querySelector('.wallet-empty')?.remove();
  list.insertAdjacentHTML('afterbegin',inboxReceipts(added));list.dataset.revision=fresh.revision;paintInboxCount();
}
async function showNotifications(seq){
  const d=await api('/me/notifications');if(seq!==activitySeq)return;
  $('#walletContent').innerHTML=`<div class="notice-tools"><strong aria-live="polite">${d.unread} unread</strong><button type="button" class="wallet-link" id="markRead" ${d.unread?'':'disabled'}>Mark all as read</button></div>
    <div id="noticeList" data-revision="${d.revision}">${inboxReceipts(d.rows)||'<p class="wallet-empty">No account notifications yet.</p>'}</div><button type="button" class="wallet-link" id="olderNotices" ${d.more?'':'hidden'}>Load older notifications</button><p id="inboxStatus" role="status"></p>`;
  let before=d.rows.at(-1)?.revision;
  const status=$('#inboxStatus');
  $('#markRead').onclick=async e=>{
    const b=e.currentTarget,list=$('#noticeList'),through=list.dataset.revision;b.disabled=true;b.setAttribute('aria-busy','true');status.textContent='';
    try{
      const r=await api('/me/notifications/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({through})});
      if(!list.isConnected)return;
      list.querySelectorAll('[data-revision]').forEach(n=>{if(BigInt(n.dataset.revision)<=BigInt(through))n.dataset.unread='false';});
      if(BigInt(r.revision)>=BigInt(list.dataset.revision)){unread=r.unread;paintUnread();}
    }catch{status.textContent='Could not mark notifications as read. Try again.';}
    finally{b.removeAttribute('aria-busy');if(list.isConnected)paintInboxCount();}
  };
  $('#olderNotices').onclick=async e=>{
    const b=e.currentTarget,list=$('#noticeList'),hadFocus=document.activeElement===b;b.disabled=true;b.textContent='Loading older notifications…';status.textContent='';
    try{
      const next=await api('/me/notifications?before='+before);if(seq!==activitySeq)return;
      const previous=list.lastElementChild;list.insertAdjacentHTML('beforeend',inboxReceipts(next.rows));before=next.rows.at(-1)?.revision;b.hidden=!next.more;
      if(hadFocus && (document.activeElement===b || document.activeElement===document.body))previous?.nextElementSibling?.querySelector('summary')?.focus();
    }catch{status.textContent='Could not load older notifications. Try again.';}
    finally{b.disabled=false;b.textContent='Load older notifications';}
  };
}
function makeId(){
  if(crypto.randomUUID)return crypto.randomUUID();
  const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
  const hex=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
let accountOpener=null,lobbyScroll=0;
function mountSection(heading){
  const main=$('.account-main'),rail=$('.account-rail'),title=$('#walletTitle');
  const fromOutside=accountPage.hidden || !accountPage.contains(document.activeElement);
  const previousY=!fromOutside && phoneWallet.matches?pageScroll.scrollTop:0;
  if(accountPage.hidden){accountOpener=document.activeElement?.closest('button,a,input,select');lobbyScroll=pageScroll.scrollTop;}
  ++activitySeq;++addressVersion;++historyVersion;
  accountPage.hidden=false;document.body.classList.add('account-open');
  accountPage.dataset.section=user?view:'session';
  title.textContent=heading;
  $('#walletDescription').textContent=user?sectionDescriptions[view]||'':'Sign in to view your account and wallet.';
  main.querySelector('.wallet-body')?.remove();
  main.insertAdjacentHTML('beforeend','<div class="wallet-body"><div id="walletContent"></div><section id="walletHistory" hidden></section></div>');
  rail.hidden=!user;
  if(user){if(fromOutside)rail.scrollTop=0;tabs();}
  else {$('#walletNav').replaceChildren();$('#railActions').replaceChildren();$('#railName').textContent='';}
  main.scrollTop=0;
  // A pinned phone rail stays pinned, but the new section always starts at its heading.
  const pinAt=previousY?pageScroll.scrollTop+$('.account-layout').getBoundingClientRect().top-pageScroll.getBoundingClientRect().top:0;
  pageScroll.scrollTop=Math.max(0,Math.min(previousY,pinAt));
  if(!document.activeElement?.closest('dialog[open],.modal:not([hidden])'))title.focus({preventScroll:true});
}
function open(mode='profile',push=true,depositCurrency=null){
  window.ebCancelPageTransition?.();
  if(mode==='deposit'||mode==='withdraw'){
    if(!user)return showSignedOut();
    if(/^\/account\/(deposit|withdraw)\/?$/.test(location.pathname)){
      history.replaceState(null,'','/');hideAccount();
    }
    closeNoticePopup();openSheet('wallet',mode,meta(depositCurrency)||current());return;
  }
  if(!Object.hasOwn(accountSections,mode))return;
  const path=accountPath(mode);
  if(push && location.pathname+location.search!==path)history.pushState(null,'',path);
  if(!user)return showSignedOut();
  closeNoticePopup();closeMenu();
  if(!accountPage.hidden && $('#walletNav [aria-current]')?.dataset.view===mode && !expandedBet){
    revealActiveTab();
    if(!$('#walletNav').contains(document.activeElement)){
      if(mode==='profile')$('.account-rail').scrollTop=0;
      $('.account-main').scrollTop=0;pageScroll.scrollTop=0;$('#walletTitle').focus({preventScroll:true});
    }
    return;
  }
  view=mode;pageIndex=0;expandedBet=null;if(mode==='transactions')transactionType='all';
  document.title=accountSections[mode]+' · BANDITBLOX';
  mountSection(mode==='profile'?'Account overview':accountSections[mode]);
  void renderSection();
}
async function renderSection(reloadCatalog=false){
  const mode=view,host=$('#walletContent');
  if((mode==='stats' && !catalogLoaded) || reloadCatalog){
    loading(host,'Loading currencies',mode==='stats'?'stats':'form');
    try{await catalog();}
    catch{if(host.isConnected)host.innerHTML=notice('Could not load currencies.', 'catalog');return;}
    finally{host.removeAttribute('aria-busy');}
    if(!host.isConnected)return;
  }
  if(mode==='profile'){renderProfile();void profileLevel();}
  else if(mode==='security'){renderSecurity();return;}
  else if(mode==='conversion'){
    if(!catalogLoaded){await catalog();if(!host.isConnected)return;}
    const owner=accountVersion;
    mountConversion(host,{api,esc,logo,assets:walletAssets,balance:id=>balances.get(id)?.amount||'0',fresh:()=>walletFresh,refresh,userId:user.id,
      live:()=>host.isConnected&&accountVersion===owner,onWithdraw:id=>open('withdraw',true,id)});return;
  }
  else {
    if(mode==='stats')statsAsset=current()?.id;
    if(mode==='withdraw')withdrawCurrency=current()?.id;
    void activity();return;
  }
  $('#walletHistory').hidden=false;
  void loadHistory();
}
function renderDeposit(host=$('#walletContent')) {
  const popup=host===moneyPane,sym=popup?host.dataset.currency:directSymbol,cid=popup?host.dataset.network:directChain;
  const elem=name=>popup?'popup'+name[0].toUpperCase()+name.slice(1):name,get=name=>host.querySelector('#'+elem(name));
  if(!get('directDeposit')){
    host.innerHTML=`<section id="${elem('directDeposit')}" class="direct-form" aria-label="Deposit details">${popup?'':`<header class="direct-heading"><span class="direct-emblem">${accountIcon('deposit')}</span><h2>Deposit</h2></header>`}
      <div class="wallet-fields"><label><span class="deposit-field-label"><span class="deposit-step" aria-hidden="true">1</span>Currency</span><span class="wallet-select"><span id="${elem('directCurrencyIcon')}"></span><select id="${elem('depositSymbol')}" data-searchable aria-label="Deposit currency"></select></span></label>
      <label><span class="deposit-field-label"><span class="deposit-step" aria-hidden="true">2</span>Network</span><span class="wallet-select"><select id="${elem('depositNetwork')}" aria-label="Deposit network"></select></span></label></div>
      <p class="deposit-selection-note">${accountIcon('transactions')}Crypto deposits credit your crypto balance. Convert to coins to play.</p>
      <div id="${elem('addressResult')}" aria-live="polite"></div></section>`;
  }
  const select=(symbol,chain)=>{
    if(popup){host.dataset.currency=symbol;host.dataset.network=chain;}else{directSymbol=symbol;directChain=chain;}
    renderDeposit(host);if(!popup)void loadHistory();
  };
  const saved=history.state?.directSelection;
  if(!popup && (saved?.owner!==user.id || saved.symbol!==sym || saved.chain!==cid)){
    history.replaceState({...history.state,directSelection:{owner:user.id,symbol:sym,chain:cid}},'');
  }
  const scoped=Object.hasOwn(directNetworks,sym),pairs=scoped?Object.entries(directNetworks[sym]):[],id=directId(sym,cid),asset=directRoutes.find(r=>r.id===id)||null;
  if(!popup)depositAsset=asset;
  const symbol=get('depositSymbol'),chain=get('depositNetwork');
  symbol.onchange=()=>{const nets=Object.keys(directNetworks[symbol.value]||{});select(symbol.value,nets.includes(cid)?cid:nets[0]||'');};
  chain.onchange=()=>select(sym,pairs.find(([,k])=>k===chain.value)?.[0]||'');
  const symbols=(scoped?'':`<option value="${esc(sym)}" disabled>${esc(sym||'Select currency')} · unavailable</option>`)+Object.keys(directNetworks).map(s=>{
    const detail=currencyNames[s]+(directRoutes.some(r=>r.symbol===s && intakeReady(r))?'':' · unavailable');
    return `<option value="${s}" data-detail="${esc(detail)}" data-icon="/assets/wallet/${icons[s]}.svg">${s}</option>`;
  }).join('');
  const networks=(id?'':`<option value="" disabled>${scoped?'Choose a network':'Not available'}</option>`)+pairs.map(([n,key])=>`<option value="${key}">${esc(network(n))}${intakeReady(directRoutes.find(r=>r.id===key))?'':' · unavailable'}</option>`).join('');
  // Polling balances must not replace an open picker or discard the player's choice.
  if(symbol.dataset.options!==symbols){symbol.innerHTML=symbols;symbol.dataset.options=symbols;}
  if(chain.dataset.options!==networks){chain.innerHTML=networks;chain.dataset.options=networks;}
  symbol.value=sym;chain.value=id||'';chain.disabled=!scoped;
  const icon=get('directCurrencyIcon');if(icon.dataset.symbol!==sym){icon.innerHTML=logo(sym);icon.dataset.symbol=sym;}
  const state=!walletFresh?'session':depositsPaused?'paused':!scoped?'currency':!cid?'choose':!intakeReady(asset)?'network':'ready';
  const result=get('addressResult'),key=JSON.stringify([sym,cid,state,asset?.min_deposit,asset?.decimals,chains.find(c=>c.id===cid)?.required_conf]);
  get('directDeposit').dataset.state=state;
  if(result.dataset.key===key)return;
  result.dataset.key=key;result.removeAttribute('aria-busy');
  if(state==='ready'){void loadAddress(asset,result,elem);return;}
  const [heading,detail]=({session:['Session unavailable','Verify your session before sending a deposit.'],paused:['Deposits paused','Receiving is temporarily paused. Do not send a transfer.'],currency:[(sym||'This currency')+' deposits are not available','Choose a supported currency above.'],choose:['Select a network','Match the network in your sending wallet.'],network:[`${sym} on ${network(cid)} is unavailable`,'Do not send funds until a permanent address appears here.']})[state];
  result.innerHTML=`<div class="direct-unavailable" data-state="${state}"><div class="receive-state-heading"><span class="deposit-step" aria-hidden="true">3</span><span>Receive address</span><span class="receive-state">Do not send</span></div><span class="unavailable-emblem" aria-hidden="true">${accountIcon(state==='paused'?'pause':'clock')}</span><div><h3>${esc(heading)}</h3><p>${esc(detail)}</p></div><button type="button" class="wallet-link" data-retry="balance">Check availability</button></div>`;
}
async function loadAddress(a,result=$('#addressResult'),elem=name=>name) {
  if(!result || depositsPaused || !walletFresh || !intakeReady(a))return;
  const version=accountVersion,key=result.dataset.key,token=Symbol();result.requestToken=token;
  const live=()=>result.isConnected&&key===result.dataset.key&&result.requestToken===token&&accountVersion===version;
  loading(result,'Loading permanent deposit address','address');
  try {
    const d = await api('/me/address/' + encodeURIComponent(a.chain_id));
    if (!live() || depositsPaused || !walletFresh || !intakeReady(directRoutes.find(r=>r.id===a.id))) return;
    const supported=d.assets?.find(item=>item.id===a.id && item.symbol===a.symbol && item.kind===a.kind && item.decimals===a.decimals);
    const pattern=a.chain_id==='SOL'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/:/^0x[0-9a-fA-F]{40}$/;
    if(d.chain!==a.chain_id || !supported || !/^\d+$/.test(supported.min_deposit) || !Number.isSafeInteger(d.required_conf) || d.required_conf<1 || !pattern.test(d.address))throw new Error('Unavailable route');
    const name=network(a.chain_id),route=`${a.symbol} on ${name}`;
    result.innerHTML=`<div class="receive-card"><div class="receive-details"><span class="deposit-step" aria-hidden="true">3</span><div><label for="${elem('depositAddress')}">Permanent deposit address</label><p>Reuse this address for ${esc(route)}.</p></div></div>
      <div class="deposit-qr" id="${elem('depositQr')}" role="img" aria-label="${esc(route)} deposit address QR code" hidden></div>
      <textarea readonly id="${elem('depositAddress')}" rows="2" spellcheck="false" aria-describedby="${elem('depositSafety')}">${esc(d.address)}</textarea>
      <div class="address-actions"><button type="button" id="${elem('copyAddress')}" class="copy-deposit-address">${accountIcon('copy')}Copy address</button><span role="status"></span></div></div>
      <dl class="wallet-facts"><div><dt>Minimum deposit</dt><dd><strong>${esc(amountText(supported.min_deposit,supported.decimals,a.symbol))}</strong></dd></div>
      <div><dt>Required confirmations</dt><dd><strong>${esc(d.required_conf)}</strong></dd></div></dl>
      <p class="network-warning" id="${elem('depositSafety')}">${accountIcon('security')}<span>Send only <strong>${esc(a.symbol)}</strong> on <strong>${esc(name)}</strong>. Other currencies or networks may result in lost funds.</span></p>`;
    result.querySelector('.copy-deposit-address').onclick = () => copyAddress(d.address,result);
    if(window.qrcode){
      const qr=window.qrcode(0,'M');qr.addData(d.address);qr.make();
      const image=result.querySelector('.deposit-qr');image.innerHTML=qr.createSvgTag({cellSize:4,margin:16,scalable:true});image.hidden=false;
    }
  } catch (err) {
    if (!live())return;
    if (err.status === 401) return applyAccount(null);
    result.innerHTML = `<div class="direct-unavailable" data-state="error" role="status"><div class="receive-state-heading"><span class="deposit-step" aria-hidden="true">3</span><span>Receive address</span><span class="receive-state">Do not send</span></div><span class="unavailable-emblem" aria-hidden="true">${accountIcon('clock')}</span><div><h3>${err.status===503?'Deposit addresses are temporarily unavailable.':'Could not load this deposit address.'}</h3><p>Do not send funds until a permanent address appears here.</p></div><button type="button" class="wallet-link" data-retry="address">Try again</button></div>`;
  } finally { if(live())result.removeAttribute('aria-busy'); }
}
async function copyAddress(address,result) {
  const field=result.querySelector('textarea'),status=result.querySelector('.address-actions [role=status]');
  try {
    if (!navigator.clipboard?.writeText) throw new Error();
    await navigator.clipboard.writeText(address); status.textContent = 'Copied';
  } catch {
    if(!field.isConnected)return;
    field.focus(); field.select();
    status.textContent = document.execCommand('copy') ? 'Copied' : 'Select and copy the address.';
  }
}
function renderProfile() {
  const host=$('#walletContent');
  if(!$('#profileLevel')){
    host.innerHTML=`<div class="profile-dashboard"><div class="profile-summary"><div class="wallet-identity"><span class="wallet-avatar" aria-hidden="true"></span>
      <div><span class="profile-eyebrow">Player account</span><h2></h2><p></p></div></div>
      <div class="profile-reference"><div class="profile-member"><small>Member since</small><strong></strong></div><div class="profile-account-id"><small>Account ID</small><code></code></div></div><a href="/account/security" data-view="security" class="profile-security"></a></div>
      <section class="profile-funds" aria-label="Playing balance"><div><span class="balance-label">Available balance</span><div class="balance-value"></div><p class="profile-balance-context"></p></div>
      <div class="account-quick"><a class="secondary-action" href="/account/conversion" data-view="conversion">${accountIcon('conversion')}Convert coins</a><button type="button" class="wallet-primary" data-open-wallet>${accountIcon('deposit')}Open wallet</button></div></section>
      <section class="profile-ledger" aria-labelledby="balancesHeading"><div class="wallet-heading"><div><h3 id="balancesHeading">Wallet balances</h3><p class="profile-panel-description">Each currency is shown separately.</p></div><span class="profile-currency-count"></span></div>
      <div id="profileBalanceStatus"></div><div class="profile-balance-columns" aria-hidden="true"><span>Currency</span><span>Available</span></div><div class="wallet-balances" role="list" aria-labelledby="balancesHeading"></div></section>
      <aside id="profileLevel" aria-label="Reward progress"></aside></div>`;
  }
  host.querySelector('.wallet-avatar').textContent=user.username.slice(0,1).toUpperCase();
  host.querySelector('.wallet-identity h2').textContent=user.username;
  host.querySelector('.wallet-identity p').textContent=user.email;
  host.querySelector('.profile-member strong').textContent=dateOf(user.created_at);
  host.querySelector('.profile-account-id code').textContent=user.id;
  const security=host.querySelector('.profile-security');security.dataset.protected=String(Boolean(user.totp_enabled));
  security.innerHTML=`${accountIcon('security')}<span><strong>${user.totp_enabled?'Authenticator enabled':'Protect your account'}</strong><small>${user.totp_enabled?'Review security & sessions':'Set up two-factor authentication'}</small></span><span aria-hidden="true">↗</span>`;
  const all = new Map([...assets,...walletAssets].map(a => [a.id, a]));
  for (const b of balances.values()) if (!all.has(b.asset_id)) all.set(b.asset_id, { ...b, id: b.asset_id });
  const selected=current(),display=selected && walletFresh?amountOf(selected):'—';
  host.querySelector('.balance-value').innerHTML=`${selected?logo(selected.symbol):''}<strong>${esc(display)}</strong> <span>${esc(selected?.symbol)}</span>`;
  host.querySelector('.profile-balance-context').textContent=selected?'All games use coins · 6,000 coins = 10 USDT':'Coin balance unavailable.';
  host.querySelector('.profile-currency-count').textContent=all.size+' '+(all.size===1?'currency':'currencies');
  const status=$('#profileBalanceStatus'),list=host.querySelector('.wallet-balances');
  if(walletFresh)status.replaceChildren();
  else if(!status.firstChild)status.innerHTML=notice('Balance update unavailable.', 'balance');
  if(!all.size && !catalogLoaded && catalogRequest){loading(list,'Loading wallet balances');return;}
  list.removeAttribute('aria-busy');
  list.innerHTML=[...all.values()].map(a => `<div role="listitem"${a.id===selected?.id?' data-playing="true"':''}>${logo(a.symbol)}<span><strong>${esc(a.symbol)}</strong><small>${a.id==='COINS'?'Site currency':a.id==='USDT'?'Tether':esc(network(a.chain_id))}${a.id===selected?.id?' <span class="profile-playing-badge">Playing balance</span>':''}</small></span><b>${esc(walletFresh ? amountOf(a) : '—')}</b></div>`).join('') ||
    (catalogLoaded?'<p class="wallet-muted">No currencies available.</p>':notice('Could not load currencies.', 'balance'));
}
async function profileLevel(){
  const el=$('#profileLevel');loading(el,'Loading level progress','level');
  try{
    const d=await api('/me/rewards');if(!el.isConnected)return;
    el.innerHTML=`<a href="/account/rewards" data-view="rewards" class="profile-level"><span class="profile-eyebrow">Daily coin rewards</span><div><span class="profile-level-name">${accountIcon('rewards')} Level ${d.level} / 100</span><strong>${d.ready_count?d.ready_count+' packs ready':'View collection'} <span aria-hidden="true">›</span></strong></div><progress max="100" value="${d.progress}" aria-label="Level progress"></progress><small>${d.next_level?coinCount(d.to_next)+' coins to level '+d.next_level:'Highest player level reached'}</small></a>`;
  }catch(err){
    if(!el.isConnected)return;
    if(err.status===401)return applyAccount(null);
    el.innerHTML=notice('Could not load level progress.', 'level');
  }finally{el.removeAttribute('aria-busy');}
}
function renderSecurity(){
  $('#walletContent').innerHTML=`<div id="securitySettings"><section aria-labelledby="identityHeading"><header class="security-heading"><span>${accountIcon('profile')}</span><div><h2 id="identityHeading">Account details</h2><p>Your account identity and username.</p></div></header><dl class="bet-facts"><div><dt>Email</dt><dd>${esc(user.email)}</dd></div><div><dt>Account ID</dt><dd>${esc(user.id)}</dd></div></dl>
    <form id="changeName"><label>Username<input name="username" autocomplete="username" aria-describedby="usernameRules" value="${esc(user.username)}" pattern="[a-zA-Z0-9_]{2,20}" minlength="2" maxlength="20" required></label><small id="usernameRules">2 to 20 characters: letters, numbers and underscores.</small><button class="secondary-action">Save username</button><p role="status"></p></form></section>
    <section aria-labelledby="passwordHeading"><header class="security-heading"><span>${accountIcon('security')}</span><div><h2 id="passwordHeading">Change password</h2><p>Update the password used to sign in.</p></div></header><form id="changePassword"><label>Current password<input name="current" type="password" autocomplete="current-password" required></label><label>New password<input name="password" type="password" aria-describedby="passwordRules" minlength="8" maxlength="200" autocomplete="new-password" required></label><label data-password-factor${user.totp_enabled?'':' hidden'}>Authenticator or recovery code<input name="totp" autocomplete="one-time-code" maxlength="64"${user.totp_enabled?' required':''}></label><small id="passwordRules">Use at least 8 characters. Changing your password signs out other sessions.</small><button class="wallet-primary">Change password</button><p role="status"></p></form></section>
    <section class="authenticator-panel" aria-labelledby="authenticatorHeading"><header class="security-heading"><span>${accountIcon('security')}</span><div><h2 id="authenticatorHeading">Authenticator</h2><p>Protect sign-in and recover your password with your authenticator app.</p></div></header><div id="authenticatorContent" aria-live="polite"></div></section>
    <section aria-labelledby="sessionsHeading"><header class="security-heading"><span>${accountIcon('clock')}</span><div><h2 id="sessionsHeading">Active sessions</h2><p>Review sign-ins and end access on other sessions.</p></div></header><div id="securitySessions"></div></section></div>`;
  void mountSecurity();
}
async function mountSecurity(){
  const host=$('#authenticatorContent'),sessions=$('#securitySessions'),version=accountVersion;
  const live=()=>host.isConnected&&version===accountVersion;
  const passwordField='<label>Current password<input name="password" type="password" autocomplete="current-password" maxlength="200" required></label>';
  const factorField='<label>Authenticator or recovery code<input name="totp" autocomplete="one-time-code" maxlength="64" required></label>';
  const request=(path,data)=>api('/auth/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  function protection(enabled){
    user.totp_enabled=enabled;
    const field=$('[data-password-factor]');if(field){field.hidden=!enabled;field.querySelector('input').required=enabled;field.querySelector('input').value='';}
  }
  function bind(form,action){
    form.onsubmit=async e=>{
      e.preventDefault();const button=form.querySelector('button[type=submit]'),status=form.querySelector('[role=status]');
      if(button.disabled)return;button.disabled=true;status.textContent='';
      try{await action(Object.fromEntries(new FormData(form)));}
      catch(err){if(live()&&form.isConnected){status.textContent=err.message;status.dataset.state='error';}}
      finally{if(form.isConnected){button.disabled=false;form.querySelectorAll('input[type=password]').forEach(input=>input.value='');}}
    };
  }
  async function load(){
    loading(host,'Loading account security');loading(sessions,'Loading sessions');
    try{
      const d=await api('/auth/security');if(!live())return;protection(d.totp_enabled);
      host.removeAttribute('aria-busy');sessions.removeAttribute('aria-busy');
      host.innerHTML=`<div class="security-state" data-enabled="${d.totp_enabled}"><span class="security-state-dot"></span><div><strong>${d.totp_enabled?'Two-factor authentication is on':'Two-factor authentication is off'}</strong><p>${d.totp_enabled?'Enabled '+dateOf(d.enabled_at)+' · '+d.recovery_codes_remaining+' recovery codes remaining':'Use Google Authenticator, Authy, 1Password or another compatible app.'}</p></div></div>`;
      if(d.totp_enabled){
        host.insertAdjacentHTML('beforeend',`<details class="security-manage"><summary>Disable authenticator</summary><p>Confirm your password and a fresh code to remove two-factor protection.</p><form id="disableAuthenticator">${passwordField}${factorField}<button type="submit" class="secondary-action">Disable authenticator</button><p role="status"></p></form></details>`);
        bind(host.querySelector('form'),async values=>{await request('2fa/disable',values);if(live())await load();});
      }else if(d.setup_available){
        host.insertAdjacentHTML('beforeend',`<form id="setupAuthenticator">${passwordField}<button type="submit" class="wallet-primary">Set up authenticator</button><p role="status"></p></form>`);
        bind(host.querySelector('form'),async values=>{
          const setup=await request('2fa/setup',values);if(!live())return;
          host.innerHTML=`<ol class="authenticator-steps"><li>Scan this QR code in your authenticator app.</li><li>Or enter the setup key shown below.</li><li>Confirm with a code from the app. Setup expires in 10 minutes.</li></ol><div class="authenticator-enrollment"><div id="authenticatorQr" role="img" aria-label="Authenticator setup QR code"></div><div><label>Manual setup key</label><code id="authenticatorKey" class="authenticator-key">${esc(setup.secret)}</code><button type="button" class="secondary-action" id="copyAuthenticatorKey">Copy setup key</button><p class="wallet-muted">Keep this key private. Anyone with it can generate your codes.</p></div></div><form id="enableAuthenticator">${passwordField}<label>Six-digit authenticator code<input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required></label><div class="security-actions"><button type="submit" class="wallet-primary">Enable authenticator</button><button type="button" class="secondary-action" id="cancelAuthenticator">Cancel setup</button></div><p role="status"></p></form>`;
          if(window.qrcode){const qr=window.qrcode(0,'M');qr.addData(setup.uri);qr.make();$('#authenticatorQr').innerHTML=qr.createSvgTag({cellSize:4,margin:4,scalable:true});}
          $('#copyAuthenticatorKey').onclick=async e=>{try{await navigator.clipboard.writeText(setup.secret);if(live()&&e.target.isConnected)e.target.textContent='Key copied';}catch{if(live())e.target.textContent='Select the key to copy';}};
          $('#cancelAuthenticator').onclick=()=>{setup.secret='';setup.uri='';void load();};
          bind(host.querySelector('form'),async values=>{
            const result=await request('2fa/enable',values);setup.secret='';setup.uri='';if(!live())return;protection(true);
            host.innerHTML=`<div class="security-state" data-enabled="true"><span class="security-state-dot"></span><div><strong>Authenticator enabled</strong><p>Save your recovery codes before leaving this page.</p></div></div><p class="recovery-intro">Each code works once in place of an authenticator code, including password recovery. These codes are shown only once. Store them somewhere private, separate from this account.</p><ul class="recovery-codes">${result.recovery_codes.map(code=>`<li><code>${esc(code)}</code></li>`).join('')}</ul><div class="security-actions"><button type="button" id="copyRecoveryCodes" class="secondary-action">Copy recovery codes</button><button type="button" id="downloadRecoveryCodes" class="secondary-action">Download codes</button><button type="button" id="savedRecoveryCodes" class="wallet-primary">I saved my recovery codes</button></div><p id="recoveryStatus" role="status"></p>`;
            $('#copyRecoveryCodes').onclick=async()=>{try{await navigator.clipboard.writeText(result.recovery_codes.join('\n'));if(live()&&$('#recoveryStatus'))$('#recoveryStatus').textContent='Recovery codes copied.';}catch{if(live()&&$('#recoveryStatus'))$('#recoveryStatus').textContent='Select the codes to copy them.';}};
            $('#downloadRecoveryCodes').onclick=()=>{const url=URL.createObjectURL(new Blob(['BANDITBLOX recovery codes\nEach code can be used once. Keep these private.\n\n'+result.recovery_codes.join('\n')],{type:'text/plain'})),a=document.createElement('a');a.href=url;a.download='banditblox-recovery-codes.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
            $('#savedRecoveryCodes').onclick=()=>{result.recovery_codes.fill('');void load();};
          });
        });
      }else host.insertAdjacentHTML('beforeend','<p class="wallet-muted">Authenticator setup is temporarily unavailable. Please try again shortly.</p>');
      sessions.innerHTML=`<div class="security-session-list">${d.sessions.map(s=>`<article><div><strong>${s.current?'This session':'Other session'}</strong><small>Signed in ${esc(receiptTime(s.created_at))}</small><small>Last active ${esc(receiptTime(s.last_seen_at))}</small></div><span class="security-session-badge">${s.current?'Current':'Active'}</span></article>`).join('')}</div>${d.sessions.some(s=>!s.current)?`<form id="revokeSessions">${passwordField}${d.totp_enabled?factorField:''}<button type="submit" class="secondary-action">Sign out other sessions</button><p role="status"></p></form>`:'<p class="wallet-muted">You are signed in only in this session.</p>'}`;
      const revoke=sessions.querySelector('form');if(revoke)bind(revoke,async values=>{await request('sessions/revoke',values);if(live())await load();});
    }catch(err){if(!live())return;if(err.status===401)return applyAccount(null);host.removeAttribute('aria-busy');host.innerHTML='<p class="wallet-muted">Could not load security settings.</p><button type="button" class="secondary-action">Try again</button>';host.querySelector('button').onclick=()=>void load();sessions.replaceChildren();}
  }
  await load();
}
function dateOf(value) {
  return value ? new Date(value).toLocaleDateString(undefined, {year:'numeric',month:'short',day:'numeric'}) : '—';
}
async function loadHistory(retry=false) {
  const seq = ++historyVersion, el = $('#walletHistory');
  const a = view==='deposit' ? depositAsset : null;
  const title = view==='profile'?'<div class="wallet-heading"><h3>Recent deposits</h3><a href="/account/transactions" data-view="transactions">View transactions</a></div>':'<div class="wallet-heading"><h3>Deposit history</h3></div>';
  const scope = user?.id + '/' + view + '/' + (a?.id || '');
  const changed=el.dataset.scope!==scope;
  if (changed) { el.dataset.scope = scope; el.innerHTML = title+'<div class="deposit-records"></div>'; }
  const records=el.lastElementChild;
  if(changed || retry)loading(records,'Loading deposits');
  try {
    const data = await api('/me/deposits' + (a ? '?asset=' + encodeURIComponent(a.id) : ''));
    if (seq !== historyVersion || accountPage.hidden) return;
    const filtered=data.deposits.filter(d=>!a || d.asset_id===a.id);
    const rows=view==='profile'?filtered.slice(0,3):filtered;
    const labels={pending:'Pending',confirmed:'Confirmed',credited:'Credited',orphaned:'Removed from chain',creating:'Archived',waiting:'Unpaid',paying:'Unresolved',underpaid:'Underpaid',review:'Under review',expired:'Expired',failed:'Failed'};
    renderReceipts(records,rows.map(d=>[String(d.id),`<summary class="activity-entry wallet-transaction">${logo(d.symbol)}<span><strong>${esc(amountText(d.amount,d.decimals,d.symbol))}</strong><small>${esc(d.chain_id?network(d.chain_id):'Archived payment')} · ${esc(dateOf(d.first_seen_at))}</small></span>
      <b class="wallet-status" data-state="${esc(d.review_hold?'reviewing':d.status)}">${esc(d.review_hold?'Under review':labels[d.status]||d.status)}${d.status==='pending'&&!d.review_hold?`<small>${esc(d.confirmations)} / ${esc(d.required_conf)} conf.</small>`:''}</b></summary>
      <dl class="bet-facts"><div><dt>First seen</dt><dd>${receiptTime(d.first_seen_at)}</dd></div>${d.credited_at?`<div><dt>Credited</dt><dd>${receiptTime(d.credited_at)}</dd></div>`:''}${d.required_conf!=null?`<div><dt>Confirmations</dt><dd>${esc(d.confirmations)} / ${esc(d.required_conf)}</dd></div>`:''}${d.txid?`<div><dt>Transaction ID</dt><dd>${explorerLink(d.chain_id,d.txid)}</dd></div>`:''}${d.provider==='archived'?`<div><dt>Archived reference</dt><dd>${esc(d.track_id||d.id)}</dd></div>`:''}</dl>`]),
      'No deposits'+(a?' in '+a.symbol+' on '+network(a.chain_id):'')+' yet.');
  } catch (err) {
    if (seq !== historyVersion || accountPage.hidden) return;
    if (err.status === 401) return applyAccount(null);
    records.innerHTML = notice('Could not load deposit history.', 'history');
  }finally{if(seq===historyVersion)records.removeAttribute('aria-busy');}
}
accountPage.addEventListener('submit',async event=>{
  const form=event.target;
  if(form.id!=='changeName' && form.id!=='changePassword')return;
  event.preventDefault(); const button=form.querySelector('button'),status=form.querySelector('[role=status]'),version=accountVersion;
  const name=form.id==='changeName';
  button.disabled=true;status.textContent='';
  // The old long poll rechecks its session when it wakes. Stop it before the
  // password response rotates that cookie so an old 401 cannot end the new session.
  if(!name){stopNotifications();++refreshId;}
  try{
    await api(name?'/auth/username':'/auth/password',{method:name?'PATCH':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    if(version!==accountVersion)return;
    if(name){user.username=form.elements.username.value;$('#railName').textContent=user.username;window.dispatchEvent(new CustomEvent('eb-username',{detail:user.username}));}
    else form.reset();
    status.dataset.state='saved';status.textContent=name?'Username saved.':'Password changed. Other sessions were signed out.';
  }catch(err){status.dataset.state='error';status.textContent=err.message;}finally{button.disabled=false;if(!name&&version===accountVersion&&user)void startNotifications();}
});
accountPage.onclick = async e => {
  if(e.target.closest('[data-open-wallet]'))return openSheet('wallet');
  if(e.target.closest('[data-signout]')){window.dispatchEvent(new Event('eb-signout'));return;}
  if(e.target.closest('[data-login]')){window.dispatchEvent(new Event('eb-login'));return;}
  const tab=e.target.closest('[data-view]');if(tab){if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();return open(tab.dataset.view);}
  const turn=e.target.closest('[data-page]');if(turn){pageIndex+=Number(turn.dataset.page);return activity();}
  const bet=e.target.closest('[data-bet]');if(bet){expandedBet={id:bet.dataset.bet,game:bet.dataset.game};return activity('[data-back-bets]');}
  if(e.target.closest('[data-back-bets]')){const {id}=expandedBet;expandedBet=null;return activity(`[data-bet="${CSS.escape(id)}"]`);}
  const cancel=e.target.closest('[data-cancel-withdraw]');if(cancel){
    cancel.disabled=true;
    try{await api('/me/withdrawals/'+cancel.dataset.cancelWithdraw+'/cancel',{method:'POST'});await refresh();if(view==='withdraw')await refreshWithdrawalHistory();}
    catch(err){cancel.textContent=err.message;}return;
  }
  if (e.target.closest('[data-deposit]')) open('deposit');
  const retry = e.target.closest('[data-retry]')?.dataset.retry;
  if (retry === 'session') window.dispatchEvent(new Event('eb-retry-session'));
  if (retry === 'address' && depositAsset) void loadAddress(depositAsset);
  if (retry === 'activity')void activity();
  if (retry === 'history') void loadHistory(true);
  if (retry === 'level') void profileLevel();
  if (retry === 'catalog') void renderSection(true);
  if (retry === 'balance') {
    const button=e.target.closest('[data-retry]');button.disabled=true;button.textContent='Retrying…';
    try{await refresh();}finally{button.disabled=false;button.textContent='Try again';}
  }
};
const lobbyTitle=document.title;
function hideAccount(restoreFocus=false){
  if(accountPage.hidden)return;
  ++activitySeq;++addressVersion;++historyVersion;
  accountPage.hidden=true;document.body.classList.remove('account-open');document.title=lobbyTitle;
  $('.account-main .wallet-body')?.remove();$('#walletNav').replaceChildren();$('#railActions').replaceChildren();$('#railName').textContent='';
  pageScroll.scrollTop=lobbyScroll;
  if(restoreFocus){
    const target=accountOpener?.isConnected && accountOpener.getClientRects().length?accountOpener:$('#meChip')||$('#signBtn')||$('.top .logo');
    target?.focus({preventScroll:true});
  }
  accountOpener=null;
}
function leaveAccount(restoreFocus=true){
  if(accountPage.hidden && !routeSection())return;
  history.pushState(null,'','/');hideAccount(restoreFocus);
}
function showSignedOut(){
  document.title='Your account · BANDITBLOX';mountSection('Your account');
  if(sessionState==='unavailable')$('#walletContent').innerHTML=notice('Could not check your session.','session');
  else if(sessionState==='ready')$('#walletContent').innerHTML='<button type="button" class="wallet-primary" data-login>Sign in to your account</button>';
  else loading($('#walletContent'),'Checking your session');
}
$('#walletClose').onclick=e=>{if(!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey){e.preventDefault();leaveAccount();}};
window.ebLeaveAccount=()=>leaveAccount(false);
window.addEventListener('popstate',()=>{window.ebCancelPageTransition?.();const section=routeSection();if(section)open(section,false);else hideAccount(true);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&!e.isComposing&&!accountPage.hidden&&!document.querySelector('dialog[open],.modal:not([hidden]),#gmenu:not([hidden])')&&menu.hidden)leaveAccount();});
$('#ebwDep').onclick=()=>openSheet('wallet');
function describePlus(){
  const plus=$('#ebwDep');plus.title='Wallet';plus.setAttribute('aria-label','Wallet');plus.setAttribute('aria-haspopup','dialog');
  plus.setAttribute('aria-expanded',String(menu.open && sheetMode==='wallet'));plus.setAttribute('aria-controls','ebwMenu');
}
describePlus();phoneWallet.addEventListener('change',describePlus);
document.addEventListener('click',e=>{
  if(e.target.closest('[data-open-conversion]')){e.preventDefault();closeMenu();open('conversion');}
  const pack=e.target.closest('[data-open-reward-pack]');
  if(pack)window.ebOpenDailyRewards?.(Number(pack.dataset.openRewardPack));
  else if(e.target.closest('[data-open-reward-collection]'))window.ebOpenDailyRewards?.();
});
window.ebOpenWallet = open;
window.ebOpenDeposit = () => open('deposit');
window.addEventListener('focus', () => { if (user) void refresh(); });
window.addEventListener('pageshow',e=>{if(e.persisted && user && view==='deposit')void refresh();});
setInterval(() => { if (user && !document.hidden) void refresh(); }, 15000);
export const walletCatalog=catalog().catch(()=>{}).then(()=>{
  renderHeader();
  if(user && !accountPage.hidden && view==='profile')renderProfile();
});
if(routeSection())showSignedOut();
