/* Player wallet. Account data and currency preferences live on the treasury. */
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icons = { ETH: 'eth', BNB: 'bnb', POL: 'matic', USDT: 'usdt', BTC: 'btc', SOL: 'sol', TRX: 'trx' };
function logo(symbol) {
  return icons[symbol] ? `<img class="currency-logo" src="/assets/wallet/${icons[symbol]}.svg" alt="">` : '';
}
function human(amount, decimals) {
  if (!Number.isInteger(decimals)) return '—';
  const n = BigInt(amount), digits = (n < 0n ? -n : n).toString().padStart(decimals + 1, '0');
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
  return (n < 0n ? '−' : '') + (decimals ? digits.slice(0, -decimals) : digits) + (fraction ? '.' + fraction : '');
}

let assets = [], routes = [], chains = [], denominations = [], user = null, balances = new Map();
let refreshId = 0, accountVersion = 0, currencySaving = null, walletFresh = false;
let catalogRequest, catalogLoaded = false, addressVersion = 0, historyVersion = 0;
let depositAsset = null, depositProvider = null, oxapayReady = false, depositsPaused = false;
let invoiceId = null, invoiceExpiry, view = 'deposit';
export let sessionState = 'checking';
const meta = id => assets.find(a => a.id === id) || routes.find(a=>a.id===id) || balances.get(id) || denominations.find(a=>a.id===id);
const current = () => assets.find(a => a.id === user?.display_ccy) || assets[0];
const network = id => chains.find(c => c.id === id)?.display_name || id;
const displayPlaces={USDT:3,ETH:5,POL:2,BNB:4};
export function displayAmount(amount,asset){
  if(!asset)return '—';
  const units=BigInt(amount),places=Math.min(asset.decimals,displayPlaces[asset.symbol]??asset.decimals);
  const scale=10n**BigInt(asset.decimals-places),absolute=units<0n?-units:units;
  const rounded=(absolute+scale/2n)/scale;
  return human(units<0n?-rounded:rounded,places);
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
    assets = d.currencies; routes = d.transferRoutes; chains = d.chains; denominations=d.denominations; catalogLoaded = true;
    depositProvider = ['direct','oxapay'].includes(d.deposit_provider) ? d.deposit_provider : null;
    oxapayReady = d.oxapay_ready === true; depositsPaused = d.deposits_paused === true;
  }).catch(err => { depositProvider=null; oxapayReady=false; throw err; }).finally(() => { catalogRequest = null; });
  return catalogRequest;
}

const header = $('.top .wallet');
header.insertAdjacentHTML('afterbegin', `<div id="ebwPill" hidden>
  <button type="button" id="ebwCcy" aria-haspopup="dialog" aria-expanded="false" aria-controls="ebwMenu"><span id="ebwIco"></span><b id="ebwBal">—</b><small id="ebwSym"></small><svg class="currency-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
  <button type="button" class="wallet-primary header-icon" id="ebwDep" aria-label="Deposit" title="Deposit"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div>
  <button type="button" class="header-icon" id="noticeBell" aria-label="Notifications" title="Notifications" aria-haspopup="dialog" aria-expanded="false" aria-controls="noticePopup"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 17c2-2 2-4 2-7a5 5 0 0 1 10 0c0 3 0 5 2 7zM10 20a2 2 0 0 0 4 0"/></svg></button>`);
document.body.insertAdjacentHTML('beforeend', `<dialog class="currency-menu" id="ebwMenu" hidden aria-labelledby="currencySheetTitle" aria-describedby="currencySheetHint">
    <header class="sheet-heading"><div><h2 id="currencySheetTitle"></h2><p id="currencySheetHint"></p></div><button type="button" data-close-sheet aria-label="Close currency selector"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header>
    <div class="sheet-columns" aria-hidden="true"><span>Asset</span><span id="sheetColumn"></span></div><div class="sheet-list"></div>
    <div class="sheet-feedback"><span role="status"></span><button type="button" data-retry-currencies hidden>Try again</button></div>
    <button type="button" class="menu-profile" data-profile>View profile &amp; balances <span aria-hidden="true">&rarr;</span></button></dialog>
  <dialog id="noticePopup" aria-labelledby="popupHeading"><header><div><div class="popup-title"><h2 id="popupHeading">Notifications</h2><span id="popupUnread" hidden></span></div><p>Recent account activity</p></div><button type="button" id="closeNotices" aria-label="Close notifications" autofocus>×</button></header>
  <div class="popup-feed"></div><p class="popup-status" role="status"></p><footer><button id="readPopup" class="wallet-link" disabled>Mark all as read</button><a href="/account/notifications" id="openInbox">View inbox <span aria-hidden="true">&rarr;</span></a></footer></dialog>
  <aside id="accountAlert" class="account-alert" hidden aria-live="polite"></aside>`);
$('.shell').insertAdjacentHTML('beforebegin',`<main id="accountPage" hidden aria-label="Player account">
  <div class="account-toolbar"><nav class="account-crumb" aria-label="Breadcrumb"><a href="/" id="walletClose">Lobby</a><span aria-hidden="true">/</span><span>My account</span></nav><div id="railActions"></div></div>
  <div class="account-layout"><aside class="account-rail" aria-label="Account navigation"><header class="rail-identity"><img src="/assets/bacon.png" alt=""><div><small>Player account</small><strong id="railName"></strong></div></header>
    <nav id="walletNav" aria-label="Account sections"></nav></aside>
    <section class="account-main" aria-labelledby="walletTitle"><header class="account-title"><h1 id="walletTitle" tabindex="-1"></h1></header></section></div></main>`);
const menu=$('#ebwMenu'),trigger=$('#ebwCcy'),accountPage=$('#accountPage'),pageScroll=$('#pageScroll');
const accountPath=mode=>'/account/'+mode;
function routeSection(){
  const match=/^\/account(?:\/([a-z]+))?\/?$/.exec(location.pathname);
  return match && (Object.hasOwn(accountSections,match[1])?match[1]:'profile');
}

function renderHeader() {
  header.hidden = !user;
  $('#noticeBell').hidden=!user;
  $('#ebwPill').hidden = !user;
  describePlus();
  const a = current();
  $('#ebwIco').innerHTML = a ? logo(a.symbol) : '';
  $('#ebwSym').textContent = a?.symbol || '';
  const amount=a && walletFresh?amountOf(a):null;
  $('#ebwBal').textContent=amount ?? '—';
  trigger.title=amount!==null?`${amount} ${a.symbol} available`:'Balance unavailable';
  trigger.setAttribute('aria-label', a ? `Choose currency, ${a.symbol} ${a.id==='USDT'?'balance':'on '+network(a.chain_id)}, ${trigger.title}` : 'Choose currency');
  if (menu.open) { if (sheetMode==='deposit' && depositProvider!=='direct') closeMenu(true); else renderMenu(); }
  const available=$('#withdrawAvailable'),asset=assets.find(a=>a.id===withdrawCurrency);
  if(available && asset)available.textContent=(walletFresh?amountOf(asset):'—')+' '+asset.symbol;
  window.dispatchEvent(new Event('eb-currency'));
}

function applyAccount(data) {
  sessionState = 'ready';
  if (history.state?.oxapayAttempt && history.state.oxapayAttempt.owner!==data?.user?.id) history.replaceState({...history.state,oxapayAttempt:null},'');
  if (user?.id !== data?.user?.id) {
    accountVersion++;
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
  if(changed)$('#vipLobby')?.replaceChildren();
  if(changed && $('#rewards')?.classList.contains('on'))void window.ebLobbyRewards?.();
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
    if (view === 'deposit') {
      const host=$('#walletContent');
      if (invoiceId!==null) { if ($('#invoiceReceipt')) void loadInvoice(true); }
      else if (host.dataset.provider!==(depositProvider||'unavailable')) { void renderSection(); return; }
      else if (depositProvider==='oxapay') updateHostedForm();
      else if (depositProvider==='direct' && $('#addressResult')) {
        if (!depositAsset || !routes.some(a=>a.id===depositAsset.id && a.enabled===depositAsset.enabled)) renderDeposit();
        else void loadAddress(depositAsset,true);
      }
    }
    if (!$('#walletHistory').hidden) void loadHistory();
  } catch (err) {
    if (seq !== refreshId) return;
    if (err.status === 401) applyAccount(null);
    else {
      walletFresh = false; renderHeader();
      if (user && !accountPage.hidden && view === 'profile') renderProfile();
      if (user && !accountPage.hidden && view === 'deposit') {
        const host=$('#walletContent');
        if(invoiceId!==null && $('#invoiceReceipt'))void loadInvoice(true);
        else if(host.dataset.provider!==(depositProvider||'unavailable'))void renderSection();
        else if($('#oxapayForm'))updateHostedForm();
        else if($('#addressResult')){
          ++addressVersion;
          $('#addressResult').removeAttribute('aria-busy');
          $('#addressResult').innerHTML = notice('Could not verify the deposit address.','address');
        }
      }
    }
  }
}
window.ebWalletRefresh = refresh;
window.ebCurrency = () => current()?.id;
window.ebCurrencyLabel = id => (id ? meta(id) : current())?.symbol || '';
window.ebFormat = (minor, id) => human(minor, (id ? meta(id) : current())?.decimals);
window.ebAsset = id => id ? meta(id) : current();
window.ebBalance = () => current() && walletFresh ? balances.get(current().id)?.amount || '0' : null;

const phoneWallet=matchMedia('(max-width:740px)');
const sheetList=menu.querySelector('.sheet-list'), sheetStatus=menu.querySelector('[role=status]');
let sheetMode='play', sheetVersion=0, sheetError='';
function sheetTrigger(){return sheetMode==='deposit'?$('#ebwDep'):trigger;}
function closeMenu(focus=false){
  const opener=sheetTrigger();
  ++sheetVersion;
  if(menu.open)menu.close();menu.hidden=true;
  trigger.setAttribute('aria-expanded','false');describePlus();
  sheetList.replaceChildren();sheetStatus.textContent='';sheetError='';
  if(focus)opener.focus({preventScroll:true});
}
function positionMenu(){
  if(!menu.open)return;
  const r=sheetTrigger().getBoundingClientRect(),vv=window.visualViewport,edge=8,top=r.bottom+4;
  const x=vv?.offsetLeft||0,y=vv?.offsetTop||0,w=vv?.width||document.documentElement.clientWidth,h=vv?.height||innerHeight;
  const floor=y+h-edge,aboveTabs=Math.min(floor,pageScroll.getBoundingClientRect().bottom-4);
  const room=Math.max(0,(aboveTabs-top>=150?aboveTabs:floor)-top);
  const width=Math.min(w-2*edge,phoneWallet.matches?304:328);
  menu.style.width=width+'px';menu.style.maxHeight=Math.min(386,room)+'px';
  menu.style.left=Math.max(x+edge,Math.min(x+w-width-edge,r.right-width))+'px';menu.style.top=top+'px';
  menu.toggleAttribute('data-compact',room<270);
  menu.toggleAttribute('data-tight',room<140);
  menu.toggleAttribute('data-above',sheetList.scrollTop>2);
  menu.toggleAttribute('data-more',sheetList.scrollHeight-sheetList.clientHeight-sheetList.scrollTop>2);
}
function renderMenu(){
  const deposit=sheetMode==='deposit',chosen=current()?.id;
  // Update live balances in place so a refresh cannot discard a focused row or its scroll position.
  const rows=new Map(Array.from(sheetList.children,b=>[b.dataset.asset,b]));
  assets.forEach((a,i)=>{
    let b=rows.get(a.id);
    if(!b){
      b=document.createElement('button');b.type='button';b.dataset.asset=a.id;
      b.innerHTML=`${logo(a.symbol)}<span><strong>${esc(a.symbol)}</strong><small></small></span><b></b><i class="sheet-mark" aria-hidden="true"></i>`;
    }
    if(sheetList.children[i]!==b)sheetList.insertBefore(b,sheetList.children[i]||null);
    rows.delete(a.id);
    const count=routes.filter(r=>r.symbol===a.symbol && r.enabled).length;
    b.querySelector('small').textContent=a.id==='USDT'?'Tether':network(a.chain_id);
    b.querySelector('b').textContent=deposit?(count?`${count} network${count===1?'':'s'}`:'Unavailable'):(walletFresh?amountOf(a):'—');
    b.querySelector('.sheet-mark').textContent=deposit?(count?'›':''):a.id===chosen?'✓':'';
    b.disabled=deposit && !count;
    if(deposit)b.removeAttribute('aria-pressed');else b.setAttribute('aria-pressed',String(a.id===chosen));
    if(!deposit && currencySaving)b.setAttribute('aria-disabled','true');else b.removeAttribute('aria-disabled');
    b.toggleAttribute('data-saving',!deposit && a.id===currencySaving);
  });
  rows.forEach(b=>b.remove());
  const msg=sheetError || (!catalogLoaded?'Loading currencies…':!assets.length?'No currencies are available.':!deposit && currencySaving?`Saving ${meta(currencySaving)?.symbol || currencySaving} as your playing currency…`:'');
  if(sheetStatus.textContent!==msg)sheetStatus.textContent=msg;
  sheetStatus.parentElement.hidden=!msg;
  menu.querySelector('[data-retry-currencies]').hidden=catalogLoaded || !sheetError;
  positionMenu();
}
async function loadSheetCatalog(){
  const version=sheetVersion;
  sheetError='';renderMenu();
  try{await catalog();if(version===sheetVersion)renderHeader();}
  catch{if(version===sheetVersion){sheetError='Currencies could not be loaded.';renderMenu();}}
}
function openSheet(mode){
  if(menu.open && sheetMode===mode){closeMenu(true);return;}
  closeNoticePopup();closeMenu();sheetMode=mode;const opener=sheetTrigger(),deposit=mode==='deposit';
  menu.dataset.mode=mode;
  $('#currencySheetTitle').textContent=deposit?'Deposit currency':'Playing currency';
  $('#currencySheetHint').textContent=deposit?'Choose an asset, then its deposit network.':'Choose the balance to use for new bets.';
  $('#sheetColumn').textContent=deposit?'Deposit routes':'Available balance';
  menu.querySelector('[data-profile]').hidden=deposit;
  menu.hidden=false;renderMenu();
  if(phoneWallet.matches)menu.showModal();else menu.show();
  positionMenu();opener.setAttribute('aria-expanded','true');
  const active=menu.querySelector('[aria-pressed=true]')||menu.querySelector('[data-asset]:enabled')||menu.querySelector('[data-close-sheet]');
  active.focus({preventScroll:true});
  if(sheetList.contains(active)){
    const scroller=menu.hasAttribute('data-tight')?menu:sheetList,box=scroller.getBoundingClientRect(),row=active.getBoundingClientRect();
    scroller.scrollTop+=Math.min(0,row.top-box.top)+Math.max(0,row.bottom-box.bottom);
    positionMenu();
  }
  if(!catalogLoaded)void loadSheetCatalog();
}
trigger.onclick=()=>openSheet('play');
phoneWallet.addEventListener('change',()=>{if(menu.open)closeMenu(true);});
menu.addEventListener('cancel',e=>{e.preventDefault();closeMenu(true);});
menu.onclick = async e => {
  if(e.target===menu){
    const b=menu.getBoundingClientRect();
    if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)closeMenu(true);
    return;
  }
  const b=e.target.closest('button');
  if(!b)return;
  if(b.hasAttribute('data-close-sheet'))return closeMenu(true);
  if(b.hasAttribute('data-retry-currencies'))return loadSheetCatalog();
  if(b.hasAttribute('data-profile')){closeMenu();return open('profile');}
  if(!b.dataset.asset || b.disabled)return;
  if(sheetMode==='deposit'){
    closeMenu();return open('deposit',true,b.dataset.asset);
  }
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
  if (menu.hidden) return;
  if (e.key === 'Escape') {e.preventDefault();e.stopImmediatePropagation();return closeMenu(true);}
  if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
  e.preventDefault();
  const buttons=[...sheetList.querySelectorAll('button:enabled')],index=buttons.indexOf(document.activeElement);
  if(!buttons.length)return;
  const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:e.key==='ArrowDown'?(index+1)%buttons.length:((index<=0?buttons.length:index)-1);
  buttons[next]?.focus();
});
window.addEventListener('resize', positionMenu);
window.addEventListener('scroll', positionMenu, true);
window.visualViewport?.addEventListener('resize', positionMenu);
window.visualViewport?.addEventListener('scroll', positionMenu);

function placeholder(label,layout='list'){
  const blocks=layout==='stats'?'<i></i><i></i><i></i><i></i><i class="skeleton-chart"></i>':'<i></i><i></i><i></i>';
  return `<div class="wallet-skeleton skeleton-${layout}" role="status" aria-label="${esc(label)}"><span aria-hidden="true">${blocks}</span></div>`;
}
function loading(el,label,layout){
  if(el.contains(document.activeElement))$('#walletTitle').focus({preventScroll:true});
  el.setAttribute('aria-busy','true');
  el.innerHTML=placeholder(label,layout);
}
function notice(message, retry) {
  return `<div class="wallet-notice" role="status"><span>${esc(message)}</span>${retry ? `<button type="button" class="wallet-link" data-retry="${retry}">Try again</button>` : ''}</div>`;
}
export const accountSections = {
  profile: 'Profile', deposit: 'Deposit', withdraw: 'Withdraw',
  stats: 'Statistics', transactions: 'Transactions', bets: 'Bet history', rewards:'Rewards', notifications:'Notifications', security:'Security'
};
const paths = {
  profile: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4.5 21v-2a7.5 7.5 0 0 1 15 0v2',
  deposit: 'M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4',
  withdraw: 'M12 15V3m-5 5 5-5 5 5M4 16v4h16v-4',
  stats: 'M4 20h16M6 16v-4m6 4V5m6 11V9',
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
const invoiceAPI='/me/oxapay/invoices';
const uuid=value=>typeof value==='string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const invoicePath=id=>accountPath('deposit')+'?invoice='+encodeURIComponent(id);
const invoiceLabels={creating:'Preparing checkout',waiting:'Awaiting payment',paying:'Confirming payment',underpaid:'Underpaid',review:'Under review',expired:'Expired',failed:'Failed',credited:'Credited'};
const invoiceLink=(id,label='View invoice')=>uuid(id)?`<a class="section-link" data-invoice="${esc(id)}" href="${invoicePath(id)}">${label}</a>`:'';
const isInvoiceRef=ref=>typeof ref==='string' && ref.startsWith('oxapay:');
const noticeInvoice=n=>n.kind.startsWith('deposit.') && isInvoiceRef(n.reference) ? n.reference.slice(7) : null;
function transactionRef(b){
  if(b.provider==='oxapay' || isInvoiceRef(b.ref)){
    const id=uuid(b.invoice_id)?b.invoice_id:isInvoiceRef(b.ref)?b.ref.slice(7):null;
    return uuid(id)?`<div><dt>Invoice ID</dt><dd>${invoiceLink(id,esc(id))}</dd></div>`:'';
  }
  return b.ref?`<div><dt>Reference</dt><dd>${esc(b.ref)}</dd></div>`:'';
}
function flowName(kind){
  const [type,game]=kind.split(':');
  if(gameNames[game])return (gameNames[game]+' · '+({bet:'Stake',payout:'Payout',refund:'Refund'}[type]||type));
  return {level_bonus:'Level bonus',admin_credit:'Balance credit',admin_debit:'Balance deduction',deposit:'Deposit',withdrawal_hold:'Withdrawal reserved',withdrawal_refund:'Withdrawal returned',withdrawal_sent:'Withdrawal sent'}[kind]||kind.replaceAll('_',' ');
}
function amountText(amount,dec,symbol){return human(amount,dec)+' '+symbol;}
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
function currencyOptions(selected){
  return assets.map(a=>`<option value="${esc(a.id)}" ${a.id===selected?'selected':''}>${esc(a.symbol)}</option>`).join('');
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
  const color=net?(sum<0n?'#efa2a2':'#69dbb4'):'#e6bf71';
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
  const d=await api('/me/stats?asset='+encodeURIComponent(statsAsset||'USDT')+'&days='+statsDays);
  if(seq!==activitySeq)return;
  const t={stake:0n,payout:0n,bets:0,wins:0,usdt:0n,unpriced:0};
  for(const day of d.days){
    t.stake+=BigInt(day.stake);t.payout+=BigInt(day.payout);t.bets+=day.bets;t.wins+=day.wins;
    const [whole,fraction='']=day.wagered_usdt.split('.');t.usdt+=BigInt(whole+fraction.padEnd(18,'0'));t.unpriced+=day.unpriced_usdt;
  }
  const money=n=>gameAmount(n,d),net=t.payout-t.stake;
  $('#activityResults').innerHTML=`<dl class="stats-grid">${[['Net result',money(net),net>0n?'positive':net<0n?'negative':''],['Wagered',money(t.stake)],['Bets settled',t.bets],['Winning bets',t.wins]].map(([l,v,tone])=>`<div><dt>${l}</dt><dd class="${tone||''}">${esc(v)}</dd></div>`).join('')}</dl>`+
    (t.bets?`<p class="wallet-muted" id="wagerValuation">At bet placement: <strong>${human(t.usdt,18)} USDT</strong> wagered.${t.unpriced?` ${t.unpriced} historical ${t.unpriced===1?'bet has':'bets have'} an incomplete USDT valuation.`:''}</p>`+statChart(d.days,d.decimals,d.symbol):'<p class="wallet-empty">No settled bets in this period.</p>');
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
const transactionTypes={all:'All transactions',deposits:'Deposits',withdrawals:'Withdrawals',bets:'Bets',rewards:'Rewards',adjustments:'Balance adjustments'};
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
    `<details class="transaction-details"><summary class="activity-entry">${logo(b.symbol)}<span><strong>${esc(flowName(b.kind))}</strong><small>${receiptTime(b.created_at)}${b.provider!=='oxapay' && b.chain_id?' · '+esc(network(b.chain_id)):''}${b.withdrawal_status?' · '+esc(states[b.withdrawal_status]):''}</small></span><b class="${BigInt(b.delta)>0n?'positive':''}">${BigInt(b.delta)>0n?'+':''}${esc(amountText(b.delta,b.decimals,b.symbol))}</b></summary>
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
function renderWithdrawalHistory(d){
  const notes={requested:'Funds are reserved. You can cancel before review begins.',reviewing:'Your request is being reviewed and can no longer be cancelled.',approved:'Approved for transfer. A transaction ID will appear once payment is recorded.',sent:'This transfer has been recorded as sent.',cancelled:'The reserved amount was returned to your available balance.'};
  renderReceipts($('#withdrawalRecords'),d.rows.map(w=>[String(w.id),`<summary class="activity-entry">${logo(w.symbol)}<span><strong>${esc(amountText(w.amount,w.decimals,w.symbol))}</strong><small>${esc(network(w.chain_id))} · ${receiptTime(w.created_at)}</small></span><b class="wallet-status" data-state="${esc(w.status)}">${esc(states[w.status]||w.status)}</b></summary>
    ${notes[w.status]?`<p class="receipt-note">${notes[w.status]}</p>`:''}<dl class="bet-facts"><div><dt>Destination</dt><dd>${esc(w.destination)}</dd></div><div><dt>Request ID</dt><dd>${esc(w.id)}</dd></div>${w.txid?`<div><dt>Transaction ID</dt><dd>${explorerLink(w.chain_id,w.txid)}</dd></div>`:''}</dl>
    ${w.status==='requested'?`<button class="wallet-link" data-cancel-withdraw="${esc(w.id)}">Cancel withdrawal</button>`:''}`]),'No withdrawal requests yet.');
}
async function refreshWithdrawalHistory(){
  const seq=activitySeq;
  try{const d=await api('/me/withdrawals');if(seq===activitySeq && $('#withdrawalRecords'))renderWithdrawalHistory(d);}catch{}
}
async function showWithdraw(seq){
  const a=assets.find(a=>a.id===withdrawCurrency)||current(), options=routes.filter(r=>r.enabled && r.symbol===a?.symbol), d=await api('/me/withdrawals');
  if(seq!==activitySeq)return;
  const chooseCurrency=`<label>Currency<select id="withdrawCurrency">${currencyOptions(a?.id)}</select></label>`;
  const form=a&&options.length?`<div class="withdraw-balance">${logo(a.symbol)}<span>Available to withdraw</span><b id="withdrawAvailable">${esc(walletFresh?amountOf(a):'—')} ${esc(a.symbol)}</b></div>
    <form id="withdrawForm" class="withdraw-form"><div class="withdraw-fields"><div class="wallet-fields">${chooseCurrency}<label>Network<select name="route">${options.map(r=>`<option value="${esc(r.id)}">${esc(network(r.chain_id))}</option>`).join('')}</select></label></div>
    <label>Destination address<input name="destination" required maxlength="100" autocomplete="off" spellcheck="false"></label>
    <label>Amount in ${esc(a.symbol)}<input name="amount" required maxlength="60" inputmode="decimal" autocomplete="off" placeholder="0.00"></label>
    <p class="wallet-muted">Confirming reserves the amount for manual review. You can cancel until review begins.</p>
    </div><section id="withdrawReview" hidden aria-labelledby="reviewTitle"><h3 id="reviewTitle" tabindex="-1">Review withdrawal</h3><div id="reviewDetails"></div></section>
    <div class="withdraw-actions"><button class="secondary-action" type="button" id="withdrawEdit" hidden>Edit details</button><button class="wallet-primary" type="submit">Review withdrawal</button></div><p id="withdrawStatus" role="status"></p></form>`:`<div class="withdraw-form">${chooseCurrency}</div>`+notice('No withdrawal network is available for this currency.');
  $('#walletContent').innerHTML=form+'<div class="wallet-heading records-heading"><h3>Withdrawal history</h3></div><section id="withdrawalRecords" aria-label="Withdrawal receipts"></section>';
  renderWithdrawalHistory(d);
  $('#withdrawCurrency').onchange=e=>{withdrawCurrency=e.target.value;void activity('#withdrawCurrency');};
  const el=$('#withdrawForm');if(!el)return;
  let reviewed=null,withdrawalKey=null,busy=false;
  const inputs=el.querySelector('.withdraw-fields'),review=$('#withdrawReview'),edit=$('#withdrawEdit'),submit=el.querySelector('[type=submit]'),status=$('#withdrawStatus');
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
      $('#reviewDetails').innerHTML=`<div class="review-amount">${logo(a.symbol)}<strong>${esc(fields.amount)} ${esc(a.symbol)}</strong></div>
        <dl class="bet-facts"><div><dt>Network</dt><dd>${esc(network(route.chain_id))}</dd></div><div><dt>Destination</dt><dd class="review-address">${esc(fields.destination)}</dd></div><div><dt>Processing</dt><dd>Manual review</dd></div></dl>`;
      status.textContent='Confirm to reserve this amount for withdrawal.';submit.textContent='Confirm request';$('#reviewTitle').focus({preventScroll:true});return;
    }
    busy=true;submit.disabled=edit.disabled=true;status.textContent='Submitting request…';
    const version=accountVersion;
    try{
      withdrawalKey ||= makeId();
      await api('/me/withdrawals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...reviewed,request:withdrawalKey})});
      if(version===accountVersion){await refresh();if(seq===activitySeq&&!accountPage.hidden)await activity();}
    }catch(err){status.textContent=err.message;}finally{busy=false;submit.disabled=edit.disabled=false;}
  };
}
const rewardSymbol=l=>`<span class="level-symbol" aria-hidden="true">${esc(l.symbol)}</span>`;
const usd=n=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',maximumFractionDigits:2,minimumFractionDigits:0}).format(Number(n));
const levelName=l=>l?l.tier+' '+l.rank:'Unranked';
function levelPanel(data,account=false){
  const {levels}=data,total=Number(data.wagered_usd||0),currentLevel=levels.filter(l=>l.earned).at(-1);
  const next=levels.find(l=>!l.earned),claimable=levels.filter(l=>l.earned&&!l.claimed_at);
  const pct=next?Math.max(0,Math.min(100,100*(total-(currentLevel?.threshold_usd||0))/(next.threshold_usd-(currentLevel?.threshold_usd||0)))):100;
  const tiers=[...new Set(levels.map(l=>l.tier))];
  return `<section class="vip-summary"><div class="vip-heading"><span class="vip-medal" aria-hidden="true">${currentLevel?rewardSymbol(currentLevel):'◇'}</span>
    <div><small>Current level</small><h2>${levelName(currentLevel)}</h2></div></div><div class="vip-progress"><b>${usd(total)} wagered</b><span>${next?'Next · '+rewardSymbol(next)+' '+levelName(next):'Highest level reached'}</span></div>
    <progress max="100" value="${pct}" aria-label="Progress to next level"></progress>
    <p>${next?usd(Math.max(0,next.threshold_usd-total))+' to the next level · '+next.bonus_usdt+' USDT bonus':'All 45 levels earned.'}</p></section>
    ${data.unpriced?'<p class="wallet-muted">Historical wagers without a recorded exchange rate are excluded.</p>':''}
    ${claimable.length?`<section class="claims-list"><h3>Available to claim</h3>${claimable.map(l=>`<div><span>${rewardSymbol(l)} ${levelName(l)}</span><button class="wallet-primary" data-claim="${l.level}">Claim ${l.bonus_usdt} USDT</button></div>`).join('')}</section>`:''}
    <div role="status" class="claim-status"></div><div class="wallet-heading"><h3>Reward levels</h3></div>
    <div class="vip-tiers">${tiers.map(tier=>{const group=levels.filter(l=>l.tier===tier);return `<details ${tier===(next||currentLevel)?.tier?'open':''}><summary><span>${rewardSymbol(group[0])} ${esc(tier)}</span><small>${group.filter(l=>l.earned).length} / ${group.length}${account?' earned':''}</small></summary>
      ${group.map(l=>account?`<div class="vip-row"><strong>Rank ${esc(l.rank)}</strong><span>${usd(l.threshold_usd)} wagered</span><b>${esc(l.bonus_usdt)} USDT<small>${l.claimed_at?'Claimed':l.earned?'Ready to claim':l.level===next?.level?'Next level':''}</small></b></div>`:`<div class="vip-row"><strong>${rewardSymbol(l)} ${levelName(l)}</strong><span>${usd(l.threshold_usd)} wager</span><b>${l.claimed_at?'Claimed':l.bonus_usdt+' USDT'}</b></div>`).join('')}</details>`;}).join('')}</div>
    <p class="wallet-muted">Settled paid bets count toward lifetime wager. Each level bonus can be claimed once.</p>`;
}
async function showRewards(seq){
  const d=await api('/me/levels');if(seq!==activitySeq)return;
  $('#walletContent').innerHTML=d.levels.length?levelPanel(d,true):'<p class="wallet-empty">No reward levels are available.</p>';
}
let lobbyRewardsSeq=0;
window.ebLobbyRewards=async()=>{
  const el=$('#vipLobby');if(!el)return;
  const seq=++lobbyRewardsSeq,version=accountVersion;
  if(!el.childElementCount)el.innerHTML=placeholder('Loading reward levels');
  try{
    const d=await api(user?'/me/levels':'/reward-levels');
    if(seq!==lobbyRewardsSeq||version!==accountVersion)return;
    el.innerHTML=levelPanel(d)+(user?'':'<button class="wallet-primary" data-login>Sign in to track your progress</button>');
  }catch{if(seq===lobbyRewardsSeq)el.innerHTML='<button class="wallet-link" data-level-retry>Reload rewards</button>';}
};
document.addEventListener('click',async e=>{
  if(e.target.closest('#vipLobby [data-login]'))return window.dispatchEvent(new Event('eb-login'));
  if(e.target.closest('[data-level-retry]'))return window.ebLobbyRewards();
  const button=e.target.closest('[data-claim]');if(!button)return;
  const panel=button.closest('#walletContent,#vipLobby'),status=panel.querySelector('.claim-status'),version=accountVersion;
  button.disabled=true;
  try{
    await api('/me/levels/'+button.dataset.claim+'/claim',{method:'POST'});
    if(version!==accountVersion)return;
    await refresh();
    if(panel.id==='vipLobby')await window.ebLobbyRewards();else if(view==='rewards'&&!accountPage.hidden)await activity();
    panel.querySelector('.claim-status')?.replaceChildren('Bonus credited to your USDT balance.');
  }catch(err){status.textContent=err.message;button.disabled=false;}
});

const notificationNames={
  'deposit.pending':'Deposit detected','deposit.credited':'Deposit credited','deposit.orphaned':'Deposit removed from the chain',
  'withdrawal.requested':'Withdrawal requested','withdrawal.reviewing':'Withdrawal in review','withdrawal.approved':'Withdrawal approved',
  'withdrawal.sent':'Withdrawal sent','withdrawal.cancelled':'Withdrawal funds returned','reward.claimed':'Level bonus credited',
  'balance.credit':'Balance credited','balance.debit':'Balance deducted'
};
let noticeController=null,unread=0,noticeTimer;
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
function announceNotice(n,count){
  const alert=$('#accountAlert');
  alert.innerHTML=`<button type="button"><span>${accountIcon('notifications')}</span><span><strong>${esc(notificationNames[n.kind]||'Account update')}</strong><small>${esc(amountText(n.amount,n.decimals,n.symbol))}${count>1?' · '+count+' new updates':''}</small></span></button>`;
  alert.hidden=false;alert.querySelector('button').onclick=()=>{alert.hidden=true;open('notifications');};
  clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{alert.hidden=true;},6500);
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
        const count=BigInt(fresh.revision)-BigInt(revision);
        revision=fresh.revision;unread=fresh.unread;paintUnread();
        if($('#noticePopup').open)paintNoticePopup(fresh);
        else if(fresh.rows[0]&&count>0n)announceNotice(fresh.rows[0],Number(count));
        void refresh();
        if(!accountPage.hidden && view==='notifications')await updateInbox(fresh,signal);
        if(!accountPage.hidden && view==='transactions' && !pageIndex && !$('#walletContent details[open]'))void showList(activitySeq).catch(()=>{});
        if(!accountPage.hidden && view==='rewards' && fresh.rows[0]?.kind==='reward.claimed')void showRewards(activitySeq).catch(()=>{});
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
  return rows.map(n=>`<article class="notice-entry" data-revision="${esc(n.revision)}" data-unread="${!n.read_at}"><span class="notice-icon">${accountIcon(n.kind.startsWith('deposit')?'deposit':n.kind.startsWith('withdrawal')?'withdraw':n.kind==='reward.claimed'?'rewards':'transactions')}</span>
    <div><strong>${esc(notificationNames[n.kind]||'Account update')}</strong><p>${esc(amountText(n.amount,n.decimals,n.symbol))}${noticeInvoice(n)===null && n.chain_id?' · '+esc(network(n.chain_id)):''}</p>
    ${n.kind==='deposit.pending' && n.required_conf!=null?`<small>Awaiting ${esc(n.required_conf)} confirmations</small>`:''}${invoiceLink(noticeInvoice(n))}${n.txid?`<details><summary>Transaction ID</summary>${explorerLink(n.chain_id,n.txid)}</details>`:''}</div><time>${esc(timeOf(n.created_at))}</time></article>`).join('');
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
    if(!popupFeed.querySelector('.popup-empty'))popupFeed.innerHTML='<div class="popup-empty"><strong>No notifications yet.</strong><p>Deposits, withdrawals and account updates will appear here.</p></div>';
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
popup.addEventListener('click',e=>{if(e.target.closest('[data-retry=popup]'))void loadNoticePopup();else followInvoice(e);});
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
    const kind=n.kind.split('.')[0],section={withdrawal:'withdraw',reward:'rewards',balance:'transactions',deposit:'transactions'}[kind];
    const id=noticeInvoice(n),reference=id===null?n.reference:uuid(id)?id:null;
    const link=invoiceLink(id) || (section && (kind!=='deposit' || n.kind==='deposit.credited')?`<a class="section-link" href="${accountPath(section)}" data-view="${section}">${{withdraw:'View withdrawals',rewards:'View rewards',transactions:'View transactions'}[section]}</a>`:'');
    return `<article class="notice-entry inbox-entry" data-revision="${esc(n.revision)}" data-unread="${!n.read_at}"><details class="transaction-details"><summary class="activity-entry"><span class="notice-icon">${accountIcon({deposit:'deposit',withdrawal:'withdraw',reward:'rewards'}[kind]||'transactions')}</span>
      <span><strong>${esc(notificationNames[n.kind]||'Account update')}</strong><small>${receiptTime(n.created_at)} <span class="inbox-unread">Unread</span></small></span>
      <b>${esc(amountText(n.amount,n.decimals,n.symbol))}${id===null && n.chain_id?`<small>${esc(network(n.chain_id))}</small>`:''}</b></summary>
      <div class="inbox-receipt"><dl class="bet-facts">${n.kind==='deposit.pending'&&n.required_conf!=null?`<div><dt>Confirmations at detection</dt><dd>${esc(n.confirmations??'—')} / ${esc(n.required_conf)}</dd></div>`:''}${reference?`<div><dt>${id?'Invoice ID':kind==='withdrawal'?'Request ID':'Reference'}</dt><dd>${esc(reference)}</dd></div>`:''}${n.txid?`<div><dt>Transaction ID</dt><dd>${explorerLink(n.chain_id,n.txid)}</dd></div>`:''}</dl>${link}</div></details></article>`;
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
  ++activitySeq;++addressVersion;++historyVersion;clearTimeout(invoiceExpiry);
  accountPage.hidden=false;document.body.classList.add('account-open');
  title.textContent=heading;
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
function open(mode='profile',push=true,depositCurrency=null,receiptId=null){
  if(!Object.hasOwn(accountSections,mode))return;
  const requested=mode==='deposit'?(push?receiptId:new URLSearchParams(location.search).get('invoice')):null;
  const id=uuid(requested)?requested.toLowerCase():requested;
  const path=uuid(id)?invoicePath(id):accountPath(mode);
  if(push && location.pathname+location.search!==path)history.pushState(mode==='deposit'?{depositEntry:true}:null,'',path);
  else if(!push && uuid(id) && location.pathname+location.search+location.hash!==path)history.replaceState(history.state,'',path);
  if(!user)return showSignedOut();
  closeNoticePopup();closeMenu();
  if(!accountPage.hidden && $('#walletNav [aria-current]')?.dataset.view===mode && !depositCurrency && invoiceId===id && !expandedBet){
    revealActiveTab();
    if(!$('#walletNav').contains(document.activeElement)){
      if(mode==='profile')$('.account-rail').scrollTop=0;
      $('.account-main').scrollTop=0;pageScroll.scrollTop=0;$('#walletTitle').focus({preventScroll:true});
    }
    return;
  }
  view=mode;invoiceId=id;pageIndex=0;expandedBet=null;if(mode==='transactions')transactionType='all';
  document.title=accountSections[mode]+' · EmpireBlox';
  mountSection(mode==='profile'?'Account overview':accountSections[mode]);
  void renderSection(depositCurrency);
}
async function renderSection(depositCurrency=null,reloadCatalog=false){
  const mode=view,host=$('#walletContent');
  // A return link is a lookup, never a payment result. Old invoices remain readable after a provider switch.
  if(mode==='deposit' && invoiceId!==null){
    depositAsset=null;
    host.innerHTML='<section id="invoiceReceipt" aria-label="Deposit invoice"></section>';
    void loadInvoice();
  }else if(['stats','withdraw','deposit'].includes(mode) && (!catalogLoaded || reloadCatalog)){
    loading(host,'Loading currencies',mode==='stats'?'stats':'form');
    try{await catalog();}
    catch{if(host.isConnected)host.innerHTML=notice('Could not load currencies.', 'catalog');return;}
    finally{host.removeAttribute('aria-busy');}
    if(!host.isConnected)return;
  }
  if(mode==='profile'){renderProfile();void profileLevel();}
  else if(mode==='security'){renderSecurity();return;}
  else if(mode==='deposit'){
    host.dataset.provider=depositProvider||'unavailable';
    if(invoiceId===null){
      if(depositProvider==='direct'){
        const symbol=(meta(depositCurrency)||current())?.symbol,eligible=routes.filter(r=>r.symbol===symbol);
        depositAsset=eligible.find(r=>r.chain_id==='ETH'&&r.enabled)||eligible.find(r=>r.enabled)||eligible[0]||routes.find(r=>r.enabled);renderDeposit();
      }else{
        ++addressVersion;depositAsset=null;
        if(depositProvider==='oxapay')renderHostedForm(host,depositCurrency);
        else host.innerHTML=notice('Could not load deposits.','catalog');
      }
    }
  }else {
    if(mode==='stats')statsAsset=current()?.id;
    if(mode==='withdraw')withdrawCurrency=current()?.id;
    void activity();return;
  }
  $('#walletHistory').hidden=false;
  void loadHistory();
}
function renderHostedForm(host,preferred){
  const saved=history.state?.oxapayAttempt;
  const attempt=saved?.owner===user.id && uuid(saved.request) && assets.some(a=>a.id===saved.asset) && typeof saved.amount==='string'?saved:null;
  const initial=preferred || attempt?.asset || current()?.id;
  host.innerHTML=`<form id="oxapayForm" novalidate>
    <label class="amount-label" for="depositAmount">Enter your deposit amount</label>
    <div class="deposit-entry"><input id="depositAmount" name="amount" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="60" placeholder="0.00" aria-describedby="depositMinimum depositStatus" required>
      <div class="wallet-select"><span id="depositAssetLogo"></span><select name="asset" id="depositCurrency" aria-label="Deposit currency"></select></div></div>
    <small id="depositMinimum"></small>
    <p id="depositInstructions" hidden></p>
    <p id="depositAvailability" class="wallet-notice" role="status" hidden></p>
    <div class="deposit-actions"><button type="submit" class="wallet-primary" id="depositCheckout" aria-describedby="checkoutHint">Continue</button><button class="wallet-link" id="cancelDeposit" type="button">Cancel</button></div>
    <span id="checkoutHint" hidden>Opens the payment checkout.</span>
    <p id="depositStatus" class="checkout-feedback" role="status"></p></form>`;
  const form=$('#oxapayForm'),select=form.elements.asset,input=form.elements.amount,status=$('#depositStatus');
  updateHostedForm(initial);
  if(attempt && attempt.asset===select.value){
    input.value=attempt.amount;
    status.textContent='You already requested this amount. Continue to reopen the same invoice.';
  }
  select.onchange=()=>{input.value='';input.removeAttribute('aria-invalid');status.textContent='';updateHostedForm();};
  input.oninput=()=>{input.removeAttribute('aria-invalid');status.textContent='';};
  $('#cancelDeposit').onclick=()=>history.state?.depositEntry?history.back():leaveAccount();
  form.onsubmit=async event=>{
    event.preventDefault();
    if(form.getAttribute('aria-busy')==='true' || !walletFresh || depositProvider!=='oxapay' || !oxapayReady || depositsPaused)return;
    const asset=assets.find(a=>a.id===select.value),amount=input.value.trim();
    if(!asset)return;
    const [whole,fraction='']=amount.split('.');
    const units=amount.length<=60 && /^\d+(?:\.\d+)?$/.test(amount) && fraction.length<=asset.decimals?BigInt(whole+fraction.padEnd(asset.decimals,'0')):0n;
    const minimum=BigInt(asset.min_deposit||'0');
    if(units<=0n || units<minimum){
      status.textContent=units>0n?`The minimum deposit is ${amountText(minimum,asset.decimals,asset.symbol)}.`:`Enter a positive amount in ${asset.symbol} with up to ${asset.decimals} decimal places.`;
      input.setAttribute('aria-invalid','true');input.focus();return;
    }
    const version=accountVersion,previous=history.state?.oxapayAttempt;
    const request=previous?.owner===user.id && previous.asset===asset.id && previous.units===String(units) && uuid(previous.request)?previous.request:makeId();
    // Save only the intent on this session-history entry. A lost response or reload must not issue another invoice.
    history.replaceState({...history.state,oxapayAttempt:{owner:user.id,asset:asset.id,amount,units:String(units),request}},'');
    form.setAttribute('aria-busy','true');updateHostedForm();status.textContent='Preparing your checkout…';
    try{
      const d=await api(invoiceAPI,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({asset:asset.id,amount,request})});
      if(version!==accountVersion || !form.isConnected)return;
      if(!uuid(d?.id) || d.asset_id!==asset.id || d.decimals!==asset.decimals || d.amount!==String(units))throw new Error('Unexpected invoice details');
      // Back from the hosted page lands on an authenticated receipt, not on the creation form.
      history.replaceState({...history.state,oxapayAttempt:null},'',invoicePath(d.id));open('deposit',false);
      const url=checkoutURL(d);
      if(url)location.assign(url);
    }catch(err){
      if(version!==accountVersion || !form.isConnected)return;
      if(err.status===401)return applyAccount(null);
      if(err.status===400 && err.message==='Amount is below the deposit minimum' && minimum>0n)status.textContent=`Minimum deposit: ${amountText(minimum,asset.decimals,asset.symbol)}.`;
      else if(err.status===400 && err.message==='No checkout network accepts this deposit amount')status.textContent='This amount is not available at checkout. Try a different amount.';
      else if(err.status===400 && err.message==='This currency is unavailable at checkout')status.textContent='Choose a different deposit currency.';
      else if(err.status===400)status.textContent='Check the deposit amount and currency, then try again.';
      else if(err.status===409)status.textContent='Check your deposit history before starting another payment.';
      else if(err.status===429)status.textContent='Too many deposit requests. Try again later.';
      else status.textContent='Could not open checkout. Try again with the same amount to retrieve the same invoice.';
    }finally{
      if(form.isConnected){form.removeAttribute('aria-busy');updateHostedForm();}
    }
  };
}
function updateHostedForm(preferred){
  const form=$('#oxapayForm');if(!form)return;
  const select=form.elements.asset,input=form.elements.amount,ids=JSON.stringify(assets.map(a=>[a.id,a.symbol]));
  if(form.dataset.currencies!==ids){
    const old=select.value,keep=preferred || old || current()?.id;
    select.innerHTML=currencyOptions(keep);form.dataset.currencies=ids;
    if(old && old!==select.value){input.value='';$('#depositStatus').textContent='The deposit currency changed. Enter a new amount.';}
  }
  const a=assets.find(a=>a.id===select.value),symbol=a?.symbol||'',busy=form.getAttribute('aria-busy')==='true';
  const availability=depositsPaused?'New deposits are temporarily paused.':!oxapayReady?'Checkout is temporarily unavailable.':!walletFresh?'Could not verify your session.':!a?'No deposit currencies are available.':'';
  const warning=$('#depositAvailability');warning.hidden=!availability;
  if(warning.dataset.message!==availability){
    warning.innerHTML=availability?`${esc(availability)} <button class="wallet-link" type="button" data-retry="balance">Try again</button>`:'';
    warning.dataset.message=availability;
  }
  if(form.dataset.symbol!==symbol){$('#depositAssetLogo').innerHTML=logo(symbol);form.dataset.symbol=symbol;}
  const min=a?.min_deposit;
  $('#depositMinimum').textContent=min!=null && BigInt(min)>0n?'Minimum deposit: '+amountText(min,a.decimals,symbol):'';
  const noPayout=a && !routes.some(r=>r.enabled && r.symbol===symbol);
  const instructions=$('#depositInstructions');instructions.hidden=!noPayout;
  instructions.textContent=noPayout?`Withdrawals in ${symbol} are currently unavailable.`:'';
  select.disabled=busy || !assets.length;input.disabled=busy || !a;
  const button=$('#depositCheckout');button.disabled=busy || Boolean(availability);
}
function checkoutURL(d){
  if(d.status!=='waiting' || typeof d.payment_url!=='string' || d.payment_url.length>1024 || /[\s\\]/.test(d.payment_url) || !(Date.parse(d.expires_at)>Date.now()))return null;
  try{
    const u=new URL(d.payment_url);
    if(u.protocol!=='https:' || u.username || u.password || u.port || u.search || u.hash)return null;
    if((u.hostname==='pay.oxapay.com' && /^\/[\w-]+\/?$/.test(u.pathname)) || (u.hostname==='oxapay.com' && /^\/pay\/[\w-]+\/?$/.test(u.pathname)))return u.href;
  }catch{}
  return null;
}
function followInvoice(e){
  const link=e.target.closest('[data-invoice]');
  if(!link || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !uuid(link.dataset.invoice))return false;
  e.preventDefault();open('deposit',true,null,link.dataset.invoice);return true;
}
async function loadInvoice(quiet=false){
  const host=$('#invoiceReceipt'),id=invoiceId;
  if(!host || host.getAttribute('aria-busy')==='true')return;
  const newDeposit='<a href="/account/deposit" class="section-link" data-new-deposit data-view="deposit">New deposit</a>';
  const unavailable=()=>{host.innerHTML=notice('Invoice not found for this account.')+newDeposit;};
  if(!uuid(id))return unavailable();
  host.setAttribute('aria-busy','true');
  if(!quiet || !host.firstChild){
    if(!host.dataset.status)loading(host,'Checking invoice status','form');
    else if($('#invoiceFeedback'))$('#invoiceFeedback').textContent='Checking invoice status…';
  }
  try{
    const d=await api(invoiceAPI+'/'+encodeURIComponent(id));
    if(!host.isConnected)return;
    if(!uuid(d?.id) || d.id.toLowerCase()!==id || typeof d.amount!=='string' || !/^\d{1,78}$/.test(d.amount) || !Number.isInteger(d.decimals) || d.decimals<0 || d.decimals>78 || !d.symbol)throw new Error('Invalid invoice');
    const url=checkoutURL(d),notes={
      creating:'Your invoice is being prepared. Check its status before starting another deposit.',
      waiting:url?`Pay the exact amount in ${d.symbol} at checkout. Your balance updates after confirmation.`:
        d.expires_at && Date.parse(d.expires_at)<=Date.now()?'The checkout window has ended. Check the status before starting another deposit.':'Could not verify the checkout link. Do not send a payment.',
      paying:'Payment is awaiting confirmation. Do not pay this invoice again.',
      underpaid:'The payment was less than the invoice amount. Contact support with this invoice ID before paying more.',
      review:'This payment needs review. Keep the invoice ID for support and do not pay again.',
      expired:'This invoice has expired. Do not send a payment. If you already paid, keep the invoice ID for support.',
      failed:'Checkout could not be completed. If you sent a payment, contact support with this invoice ID.',
      credited:'This deposit has been credited to your wallet.'
    };
    const markup=`<header class="checkout-heading"><span class="wallet-label">Deposit invoice</span><b class="wallet-status" id="invoiceStatus" role="status" data-state="${esc(d.status)}">${esc(invoiceLabels[d.status]||'Status unavailable')}</b></header>
      <h2 class="invoice-amount">${logo(d.symbol)}${esc(amountText(d.amount,d.decimals,d.symbol))}</h2><p class="checkout-instructions">${esc(notes[d.status]||'Check the invoice status again before making a payment.')}</p>
      <dl class="bet-facts invoice-facts"><div><dt>Invoice ID</dt><dd>${esc(id)}</dd></div>${d.created_at?`<div><dt>Created</dt><dd>${receiptTime(d.created_at)}</dd></div>`:''}${d.status==='credited' && d.credited_at?`<div><dt>Credited</dt><dd>${receiptTime(d.credited_at)}</dd></div>`:d.expires_at?`<div><dt>Checkout expiry</dt><dd>${receiptTime(d.expires_at)}</dd></div>`:''}</dl>
      <div class="deposit-actions">${url?`<a class="wallet-primary" id="resumeCheckout" rel="noreferrer" href="${esc(url)}">Open checkout <span aria-hidden="true">&nearr;</span></a>`:''}<button class="secondary-action" type="button" id="refreshInvoice">Check status</button>${newDeposit}</div><p class="checkout-feedback" id="invoiceFeedback" role="status"></p>`;
    if(receiptMarkup.get(host)!==markup){
      const focus=host.contains(document.activeElement)?document.activeElement.id:null;
      host.innerHTML=markup;receiptMarkup.set(host,markup);
      if(focus)(document.getElementById(focus)||$('#refreshInvoice')).focus({preventScroll:true});
    }
    $('#invoiceFeedback').textContent='';
    clearTimeout(invoiceExpiry);
    if(url){
      const expire=()=>{if(host.isConnected){$('#resumeCheckout')?.remove();$('#invoiceFeedback').textContent='The checkout window has ended. Check status before making a payment.';}};
      invoiceExpiry=setTimeout(expire,Math.min(Math.max(0,Date.parse(d.expires_at)-Date.now()),2147483647));
      $('#resumeCheckout').onclick=e=>{if(!checkoutURL(d)){e.preventDefault();expire();}};
    }
    const newlyCredited=d.status==='credited' && host.dataset.status!=='credited';host.dataset.status=d.status;
    if(newlyCredited)void refresh();
  }catch(err){
    if(!host.isConnected)return;
    if(err.status===401)return applyAccount(null);
    clearTimeout(invoiceExpiry);receiptMarkup.delete(host);delete host.dataset.status;
    if(err.status===404)return unavailable();
    host.innerHTML=notice('Could not check this invoice. No payment status has been confirmed.','invoice')+newDeposit;
  }finally{host.removeAttribute('aria-busy');}
}
function renderDeposit() {
  const host = $('#walletContent');
  depositAsset = routes.find(a => a.id === depositAsset?.id) || routes.find(r=>r.enabled);
  if (!depositAsset) {
    host.innerHTML = '<div id="addressResult">' + notice(catalogLoaded ? 'No deposit currencies are available.' : 'Could not load currencies.', 'catalog') + '</div>';
    return;
  }
  const symbols = [...new Set(routes.filter(r=>r.enabled || assets.some(a=>a.symbol===r.symbol)).map(r=>r.symbol))];
  const choices = routes.filter(a => a.symbol === depositAsset.symbol);
  host.innerHTML = `<div class="wallet-fields"><label>Currency<div class="wallet-select">${logo(depositAsset.symbol)}<select id="depositSymbol" aria-label="Deposit currency">${symbols.map(s => `<option ${s === depositAsset.symbol ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div></label>
    <label>Network<div class="wallet-select"><select id="depositNetwork" aria-label="Deposit network">${choices.map(a => `<option value="${esc(a.id)}" ${a.id === depositAsset.id ? 'selected' : ''}>${esc(network(a.chain_id))}${a.enabled?'':' · unavailable'}</option>`).join('')}</select></div></label></div>
    <dl class="wallet-facts"><div><dt>Minimum deposit</dt><dd><strong>${esc(human(depositAsset.min_deposit, depositAsset.decimals))} ${esc(depositAsset.symbol)}</strong></dd></div>
    <div><dt>Required confirmations</dt><dd><strong>${esc(chains.find(c => c.id === depositAsset.chain_id)?.required_conf)}</strong></dd></div></dl><div id="addressResult" aria-live="polite"></div>`;
  $('#depositSymbol').onchange = e => {
    const options = routes.filter(a => a.symbol === e.target.value);
    depositAsset = options.find(a => a.chain_id === depositAsset.chain_id) || options[0]; renderDeposit(); void loadHistory();
    $('#depositSymbol')?.focus({preventScroll:true});
  };
  $('#depositNetwork').onchange = e => {
    depositAsset = meta(e.target.value); renderDeposit(); void loadHistory(); $('#depositNetwork')?.focus({preventScroll:true});
  };
  void loadAddress(depositAsset);
}
async function loadAddress(a, quiet = false) {
  const seq = ++addressVersion, result = $('#addressResult');
  if(!result || depositProvider!=='direct')return;
  if(depositsPaused){result.innerHTML=notice('New deposits are temporarily paused.');result.removeAttribute('aria-busy');return;}
  if (!a.enabled) {result.innerHTML=notice(network(a.chain_id)+' deposits are currently unavailable.');return;}
  if (!quiet) loading(result,'Loading deposit address','address');
  try {
    const d = await api('/me/address/' + encodeURIComponent(a.chain_id));
    if (seq !== addressVersion || !result.isConnected || depositProvider!=='direct' || depositsPaused) return;
    const supported = d.assets?.find(item => item.id === a.id);
    const patterns={evm:/^0x[0-9a-fA-F]{40}$/,btc:/^bc1q[0-9a-z]{38}$/,sol:/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,tron:/^T[1-9A-HJ-NP-Za-km-z]{33}$/};
    if (d.chain !== a.chain_id || !supported || !patterns[chains.find(c=>c.id===a.chain_id)?.kind]?.test(d.address)) throw new Error('This deposit route is unavailable.');
    const signature = JSON.stringify([a.id, d.address, d.required_conf, supported.min_deposit]);
    if (quiet && result.dataset.signature === signature && $('#depositAddress')) return;
    result.dataset.signature = signature;
    const facts = $('#walletContent .wallet-facts').querySelectorAll('strong');
    facts[0].textContent = human(supported.min_deposit, supported.decimals) + ' ' + a.symbol;
    facts[1].textContent = d.required_conf;
    result.innerHTML = `<div class="wallet-address"><div id="depositQr"></div><div class="address-fields"><label for="depositAddress">Your deposit address</label>
      <textarea readonly id="depositAddress" rows="2" spellcheck="false" aria-describedby="depositSafety">${esc(d.address)}</textarea>
      <div class="address-actions"><button type="button" class="wallet-primary" id="copyAddress">Copy address</button><span id="copyStatus" role="status"></span></div></div></div>
      <p class="network-warning" id="depositSafety">Send only <strong>${esc(a.symbol)}</strong> on <strong>${esc(d.display_name)}</strong>. Funds sent on another network may be lost.</p>`;
    if (window.qrcode) {
      const qr = window.qrcode(0, 'M'); qr.addData(d.address); qr.make();
      $('#depositQr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
      $('#depositQr').setAttribute('role','img');$('#depositQr').setAttribute('aria-label','Deposit address QR code');
    } else $('#depositQr').hidden = true;
    $('#copyAddress').onclick = () => copyAddress(d.address);
  } catch (err) {
    if (seq !== addressVersion || accountPage.hidden || view !== 'deposit') return;
    if (err.status === 401) return applyAccount(null);
    result.innerHTML = notice(err.status===503?'Deposit addresses are temporarily unavailable.':'Could not load this deposit address.', 'address');
  } finally { if(seq===addressVersion)result.removeAttribute('aria-busy'); }
}
async function copyAddress(address) {
  const field = $('#depositAddress'), status = $('#copyStatus');
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
    host.innerHTML=`<div class="profile-summary"><div class="wallet-identity"><span class="wallet-avatar" aria-hidden="true"></span>
      <div><h2></h2><p></p><div class="profile-member">Member since <strong></strong></div></div></div></div>
      <div class="profile-funds"><div><span class="balance-label">Available balance</span><div class="balance-value"></div></div>
      <div class="account-quick"><button type="button" class="wallet-primary" data-view="deposit">${accountIcon('deposit')}Deposit</button><button type="button" class="secondary-action" data-view="withdraw">${accountIcon('withdraw')}Withdraw</button></div></div>
      <div class="profile-ledger"><section aria-labelledby="balancesHeading"><div class="wallet-heading"><h3 id="balancesHeading">Wallet balances</h3></div><div id="profileBalanceStatus"></div><div class="wallet-balances"></div></section><aside id="profileLevel" aria-label="Reward progress"></aside></div>`;
  }
  host.querySelector('.wallet-avatar').textContent=user.username.slice(0,1).toUpperCase();
  host.querySelector('.wallet-identity h2').textContent=user.username;
  host.querySelector('.wallet-identity p').textContent=user.email;
  host.querySelector('.profile-member strong').textContent=dateOf(user.created_at);
  const all = new Map(assets.map(a => [a.id, a]));
  for (const b of balances.values()) if (!all.has(b.asset_id)) all.set(b.asset_id, { ...b, id: b.asset_id });
  const selected=current(),display=selected && walletFresh?amountOf(selected):'—';
  host.querySelector('.balance-value').innerHTML=`${selected?logo(selected.symbol):''}<strong>${esc(display)}</strong> <span>${esc(selected?.symbol)}</span>`;
  const status=$('#profileBalanceStatus'),list=host.querySelector('.wallet-balances');
  if(walletFresh)status.replaceChildren();
  else if(!status.firstChild)status.innerHTML=notice('Balance update unavailable.', 'balance');
  if(!all.size && !catalogLoaded && catalogRequest){loading(list,'Loading wallet balances');return;}
  list.removeAttribute('aria-busy');
  list.innerHTML=[...all.values()].map(a => `<div>${logo(a.symbol)}<span><strong>${esc(a.symbol)}</strong><small>${a.id==='USDT'?'Tether':esc(network(a.chain_id))}${a.id===selected?.id?' · Playing currency':''}</small></span><b>${esc(walletFresh ? amountOf(a) : '—')}</b></div>`).join('') ||
    (catalogLoaded?'<p class="wallet-muted">No currencies available.</p>':notice('Could not load currencies.', 'balance'));
}
async function profileLevel(){
  const el=$('#profileLevel');loading(el,'Loading level progress','level');
  try{
    const d=await api('/me/levels');if(!el.isConnected)return;
    if(!d.levels.length){el.innerHTML='<p class="wallet-empty">No reward levels are available.</p>';return;}
    const currentLevel=d.levels.filter(l=>l.earned).at(-1),next=d.levels.find(l=>!l.earned);
    const threshold=currentLevel?.threshold_usd||0,remaining=next?next.threshold_usd-threshold:1;
    const percent=next?Math.min(100,Math.max(0,100*(Number(d.wagered_usd)-threshold)/remaining)):100;
    const claims=d.levels.filter(l=>l.earned&&!l.claimed_at).length;
    el.innerHTML=`<a href="/account/rewards" data-view="rewards" class="profile-level"><div><span class="profile-level-name">${currentLevel?rewardSymbol(currentLevel):accountIcon('rewards')} ${currentLevel?levelName(currentLevel):'Level rewards'}</span><strong>${claims?claims+' to claim':'View rewards'} <span aria-hidden="true">›</span></strong></div>
      <progress max="100" value="${percent}" aria-label="Level progress"></progress><small>${next?usd(Math.max(0,next.threshold_usd-Number(d.wagered_usd)))+' in wagers to '+esc(levelName(next)):'Highest level reached'}</small></a>`;
  }catch(err){
    if(!el.isConnected)return;
    if(err.status===401)return applyAccount(null);
    el.innerHTML=notice('Could not load level progress.', 'level');
  }finally{el.removeAttribute('aria-busy');}
}
function renderSecurity(){
  $('#walletContent').innerHTML=`<div id="securitySettings"><section aria-labelledby="identityHeading"><h2 id="identityHeading">Account details</h2><dl class="bet-facts"><div><dt>Email</dt><dd>${esc(user.email)}</dd></div><div><dt>Account ID</dt><dd>${esc(user.id)}</dd></div></dl>
    <form id="changeName"><label>Username<input name="username" autocomplete="username" aria-describedby="usernameRules" value="${esc(user.username)}" pattern="[a-zA-Z0-9_]{2,20}" minlength="2" maxlength="20" required></label><small id="usernameRules">2 to 20 characters: letters, numbers and underscores.</small><button class="secondary-action">Save username</button><p role="status"></p></form></section>
    <section aria-labelledby="passwordHeading"><h2 id="passwordHeading">Change password</h2><form id="changePassword"><label>Current password<input name="current" type="password" autocomplete="current-password" required></label><label>New password<input name="password" type="password" aria-describedby="passwordRules" minlength="8" maxlength="200" autocomplete="new-password" required></label><small id="passwordRules">Use at least 8 characters. Changing your password signs out other sessions.</small><button class="wallet-primary">Change password</button><p role="status"></p></form></section></div>`;
}
function dateOf(value) {
  return value ? new Date(value).toLocaleDateString(undefined, {year:'numeric',month:'short',day:'numeric'}) : '—';
}
async function loadHistory(retry=false) {
  const seq = ++historyVersion, el = $('#walletHistory');
  const a = view==='deposit' && depositProvider==='direct' && invoiceId===null ? depositAsset : null;
  const title = view==='profile'?'<div class="wallet-heading"><h3>Recent deposits</h3><a href="/account/deposit" data-view="deposit">View deposits</a></div>':'<div class="wallet-heading"><h3>Deposit history</h3></div>';
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
    const labels={pending:'Pending',confirmed:'Confirmed',credited:'Credited',orphaned:'Removed from chain'};
    renderReceipts(records,rows.map(d=>d.provider==='oxapay'?['oxapay:'+d.id,`<summary class="activity-entry wallet-transaction">${logo(d.symbol)}<span><strong>${esc(amountText(d.amount,d.decimals,d.symbol))}</strong><small>${esc(dateOf(d.first_seen_at))}</small></span><b class="wallet-status" data-state="${esc(d.status)}">${esc(invoiceLabels[d.status]||'Status unavailable')}</b></summary>
      <dl class="bet-facts"><div><dt>Created</dt><dd>${receiptTime(d.first_seen_at)}</dd></div>${d.status==='credited' && d.credited_at?`<div><dt>Credited</dt><dd>${receiptTime(d.credited_at)}</dd></div>`:''}<div><dt>Invoice ID</dt><dd>${esc(d.id)}</dd></div></dl>${invoiceLink(d.id)}`]:[JSON.stringify([d.chain_id,d.asset_id,d.txid,d.amount,d.first_seen_at]),`<summary class="activity-entry wallet-transaction">${logo(d.symbol)}<span><strong>${esc(amountText(d.amount,d.decimals,d.symbol))}</strong><small>${esc(network(d.chain_id))} · ${esc(dateOf(d.first_seen_at))}</small></span>
      <b class="wallet-status" data-state="${esc(d.review_hold?'reviewing':d.status)}">${esc(d.review_hold?'Under review':labels[d.status]||d.status)}${d.status==='pending'&&!d.review_hold?`<small>${esc(d.confirmations)} / ${esc(d.required_conf)} conf.</small>`:''}</b></summary>
      <dl class="bet-facts"><div><dt>First seen</dt><dd>${receiptTime(d.first_seen_at)}</dd></div>${d.credited_at?`<div><dt>Credited</dt><dd>${receiptTime(d.credited_at)}</dd></div>`:''}<div><dt>Confirmations</dt><dd>${esc(d.confirmations)} / ${esc(d.required_conf)}</dd></div>${d.txid?`<div><dt>Transaction ID</dt><dd>${explorerLink(d.chain_id,d.txid)}</dd></div>`:''}</dl>`]),
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
  try{
    await api(name?'/auth/username':'/auth/password',{method:name?'PATCH':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    if(version!==accountVersion)return;
    if(name){user.username=form.elements.username.value;$('#railName').textContent=user.username;window.dispatchEvent(new CustomEvent('eb-username',{detail:user.username}));}
    else form.reset();
    status.dataset.state='saved';status.textContent=name?'Username saved.':'Password changed. Other sessions were signed out.';
  }catch(err){status.dataset.state='error';status.textContent=err.message;}finally{button.disabled=false;}
});
accountPage.onclick = async e => {
  if(e.target.closest('[data-signout]')){window.dispatchEvent(new Event('eb-signout'));return;}
  if(e.target.closest('[data-login]')){window.dispatchEvent(new Event('eb-login'));return;}
  if(followInvoice(e))return;
  if(e.target.closest('#refreshInvoice'))return loadInvoice();
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
  if (retry === 'invoice') void loadInvoice();
  if (retry === 'level') void profileLevel();
  if (retry === 'catalog') void renderSection(depositAsset?.id,true);
  if (retry === 'balance') {
    const button=e.target.closest('[data-retry]');button.disabled=true;button.textContent='Retrying…';
    try{await refresh();}finally{button.disabled=false;button.textContent='Try again';}
  }
};
const lobbyTitle=document.title;
function hideAccount(restoreFocus=false){
  if(accountPage.hidden)return;
  ++activitySeq;++addressVersion;++historyVersion;clearTimeout(invoiceExpiry);
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
  document.title='Your account · EmpireBlox';mountSection('Your account');
  if(sessionState==='unavailable')$('#walletContent').innerHTML=notice('Could not check your session.','session');
  else if(sessionState==='ready')$('#walletContent').innerHTML='<button type="button" class="wallet-primary" data-login>Sign in to your account</button>';
  else loading($('#walletContent'),'Checking your session');
}
$('#walletClose').onclick=e=>{if(!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey){e.preventDefault();leaveAccount();}};
window.ebLeaveAccount=()=>leaveAccount(false);
window.addEventListener('popstate',()=>{const section=routeSection();if(section)open(section,false);else hideAccount(true);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&!e.isComposing&&!accountPage.hidden&&!document.querySelector('dialog[open],.modal:not([hidden]),#gmenu:not([hidden])')&&menu.hidden)leaveAccount();});
$('#ebwDep').onclick=()=>depositProvider==='direct' && phoneWallet.matches?openSheet('deposit'):open('deposit',true,depositProvider==='oxapay'?current()?.id:null);
function describePlus(){
  const plus=$('#ebwDep'),sheet=depositProvider==='direct' && phoneWallet.matches;
  if(sheet){plus.setAttribute('aria-haspopup','dialog');plus.setAttribute('aria-expanded',String(menu.open && sheetMode==='deposit'));}
  else{plus.removeAttribute('aria-haspopup');plus.removeAttribute('aria-expanded');}
  plus.setAttribute('aria-controls',sheet?'ebwMenu':'accountPage');
}
describePlus();phoneWallet.addEventListener('change',describePlus);
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
