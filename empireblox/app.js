/* Treasury owns accounts, balances and crypto games. */
import { walletSession, sessionState, walletCatalog, paintUnread, displayAmount } from './wallet.js';
/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const fmt = v => Math.round(+v || 0).toLocaleString();
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COIN = '<svg class="coin" viewBox="0 0 20 20" aria-hidden="true"><ellipse cx="10" cy="15.2" rx="7.4" ry="2.6" fill="#b97a07"/><rect x="2.6" y="12.6" width="14.8" height="2.6" fill="#d9960f"/><ellipse cx="10" cy="12.6" rx="7.4" ry="2.6" fill="#f7c948"/><ellipse cx="9.4" cy="10.4" rx="7.4" ry="2.6" fill="#b97a07"/><rect x="2" y="7.8" width="14.8" height="2.6" fill="#d9960f"/><ellipse cx="9.4" cy="7.8" rx="7.4" ry="2.6" fill="#f7c948"/><ellipse cx="10.4" cy="5.6" rx="7.4" ry="2.6" fill="#b97a07"/><rect x="3" y="3" width="14.8" height="2.6" fill="#d9960f"/><ellipse cx="10.4" cy="3" rx="7.4" ry="2.6" fill="#ffd95e"/><ellipse cx="8.6" cy="2.5" rx="3.2" ry=".9" fill="#fff3b8" opacity=".75"/></svg>';
const fmtS = v => { v = Number(v) || 0; const A = Math.abs(v); return A >= 1e9 ? +(v / 1e9).toFixed(2) + 'B' : A >= 1e6 ? +(v / 1e6).toFixed(2) + 'M' : A >= 1e5 ? +(v / 1e3).toFixed(1) + 'K' : fmt(v); };
let quote = null, quoteRequest = 0, lastAsset = null;
function catalogMoney(value, price = quote, positive = false) {
  const units = Math.round(Number(value) || 0);
  const amount = price ? currencyText(BigInt(units)*BigInt(price.unit),price.asset_id) : '—';
  return `<span class="cv">${positive ? '+' : ''}${esc(amount)}</span>`;
}
const cv = catalogMoney;
const cvS = cv;
const IC = {
  mines: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="14" r="7" fill="currentColor"/><path d="M14.5 8.5l3-3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="19.5" cy="3.8" r="1.8" fill="currentColor"/></svg>',
  cases: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 8.5l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8.5l9 5 9-5M12 13.5v8"/></svg>',
  swords: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 17.5L21 6V3h-3L6.5 14.5M11 19l-6-6M8 16l-4 4M5 21l-2-2"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M3 11.5L21 4l-7.5 18-2.5-7.5z" fill="currentColor"/></svg>',
  cards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"><rect x="3" y="6" width="11" height="15" rx="2" transform="rotate(-10 8.5 13.5)"/><rect x="10" y="4" width="11" height="15" rx="2" fill="currentColor" fill-opacity=".25"/></svg>',
  hit: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="3" width="12" height="17" rx="2.5" transform="rotate(-12 11 11.5)"/><path d="M14 15h7M17.5 11.5v7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  stand: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V10V4a1.5 1.5 0 0 1 3 0v6V5a1.5 1.5 0 0 1 3 0v6.5V8a1.5 1.5 0 0 1 3 0v7c0 4-3 7-7 7h-1c-2.5 0-4-1-5.5-3L3.6 14.4a1.6 1.6 0 0 1 2.5-2z"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="2.5" y="5" width="9" height="14" rx="2" opacity=".55"/><rect x="12.5" y="5" width="9" height="14" rx="2"/></svg>',
  dbl: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><text x="12" y="16" text-anchor="middle" font-size="10" font-weight="900" fill="#0d0f13" font-family="Inter,Arial">×2</text></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 3h10v3h3.5v2.5A4.5 4.5 0 0 1 16.4 13 5.5 5.5 0 0 1 13 15.8V18h3v3H8v-3h3v-2.2A5.5 5.5 0 0 1 7.6 13 4.5 4.5 0 0 1 3.5 8.5V6H7zm10 5v3a2.4 2.4 0 0 0 1.5-2.2V8zM7 8H5.5v.8A2.4 2.4 0 0 0 7 11z"/></svg>',
  crown: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 11H5z"/></svg>',
  gift: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="9" width="18" height="4" rx="1"/><rect x="4.5" y="13" width="15" height="8" rx="1"/><rect x="11" y="9" width="2" height="12" fill="#0d0f13"/><path d="M12 9C10 5 6.5 4.5 6.2 6.6 6 8.2 9 8.8 12 9zM12 9c2-4 5.5-4.5 5.8-2.4.2 1.6-2.8 2.2-5.8 2.4z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" stroke-width="2.4" fill="none"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16V8M8.5 11.5L12 8l3.5 3.5"/></svg>',
  pad: '<svg viewBox="0 0 24 24"><path d="M7 6.5h10a5 5 0 0 1 4.9 6l-.8 3.6a2.6 2.6 0 0 1-4.4 1.2L14.4 15H9.6l-2.3 2.3a2.6 2.6 0 0 1-4.4-1.2l-.8-3.6A5 5 0 0 1 7 6.5z" fill="currentColor"/><path d="M7.3 9.6v4.2M5.2 11.7h4.2" stroke="#0d0f13" stroke-width="1.9" stroke-linecap="round"/><circle cx="16.2" cy="10.4" r="1.3" fill="#0d0f13"/><circle cx="18.4" cy="12.8" r="1.3" fill="#0d0f13"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bot: '<svg viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="4" fill="currentColor"/><circle cx="9.5" cy="14" r="1.7" fill="#0d0f13"/><circle cx="14.5" cy="14" r="1.7" fill="#0d0f13"/><path d="M12 3.5V8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="3.5" r="1.6" fill="currentColor"/></svg>'
};
/* every player's character: a blocky avatar with bacon-style hair (an original drawing) */
const BACON = '<img src="/assets/bacon.png" alt="" draggable="false">';
document.querySelectorAll('[data-coin]').forEach(e => e.outerHTML = COIN);

document.querySelectorAll('[data-ic]').forEach(e => e.outerHTML = IC[e.dataset.ic]);
$('authAv').innerHTML = BACON;
let toastT;
/* ---------- sound effects (synthesised in the browser, no files) ---------- */
const SFX = (() => {
  let ctx = null, out = null, verb = null;
  function ac() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 4; comp.connect(ctx.destination);
      out = ctx.createGain(); out.gain.value = .55; out.connect(comp);
      verb = ctx.createGain(); verb.gain.value = .22;   // small room tail
      [0.031, 0.047].forEach((t, k) => { const d = ctx.createDelay(); d.delayTime.value = t; const fb = ctx.createGain(); fb.gain.value = .35; const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200 - k * 800; verb.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(out); });
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(f, d, { type = 'sine', vol = .2, at = 0, to = null, attack = .005, wet = .3 } = {}) {
    const c = ac(); if (!c) return;
    const t = c.currentTime + at, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + d);
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(.0001, t + d);
    o.connect(g); g.connect(out); if (wet) { const w = c.createGain(); w.gain.value = wet; g.connect(w); w.connect(verb); }
    o.start(t); o.stop(t + d + .05);
  }
  function noise(d, { vol = .15, at = 0, f = 1400, type = 'lowpass', q = .7, to = null } = {}) {
    const c = ac(); if (!c) return;
    const b = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * d)), c.sampleRate), x = b.getChannelData(0); for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1;
    const s = c.createBufferSource(), g = c.createGain(), fl = c.createBiquadFilter(), t = c.currentTime + at;
    fl.type = type; fl.Q.value = q; fl.frequency.setValueAtTime(f, t); if (to) fl.frequency.exponentialRampToValueAtTime(to, t + d);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + d);
    s.buffer = b; s.connect(fl); fl.connect(g); g.connect(out); s.start(t);
  }
  const chord = (fs, d, o = {}) => fs.forEach((f, i) => tone(f, d, { ...o, at: (o.at || 0) + i * (o.step || 0) }));
  let spinT = [];
  const clear = () => { spinT.forEach(clearTimeout); spinT = []; };
  return {
    tick(p = 1) { noise(.03, { vol: .22, f: 2600 * p, type: 'bandpass', q: 6 }); tone(1900 * p, .025, { type: 'triangle', vol: .05, wet: 0 }); },
    spin(ms) {
      clear(); if (ms < 300) return;
      let t = 0, gap = 42; while (t < ms - 120) { const r = t / ms; spinT.push(setTimeout(() => this.tick(1 - r * .25), t)); t += gap; gap = Math.min(420, gap * 1.07); }
      spinT.push(setTimeout(() => this.land(), ms));
    },
    land() { noise(.08, { vol: .25, f: 900, q: 2 }); tone(220, .12, { vol: .1, wet: .2 }); },
    stop: clear,
    upgrade(ms) {   // rising whoosh + tension hum, electric ticks, heartbeat at the end
      clear(); if (!ac()) return;
      noise(ms / 1000 * .55, { vol: .12, f: 400, to: 3500, type: 'bandpass', q: 1.2 });
      tone(90, ms / 1000, { type: 'sawtooth', vol: .05, to: 300, attack: .3, wet: .1 });
      tone(180, ms / 1000, { vol: .07, to: 720, attack: .3, wet: .2 });
      let t = 0, gap = 70; while (t < ms - 200) { const r = t / ms; spinT.push(setTimeout(() => tone(700 + r * 900, .04, { type: 'square', vol: .03, wet: 0 }), t)); t += gap; gap = Math.min(520, gap * 1.11); }
      [ms - 900, ms - 450].forEach(at => at > 0 && spinT.push(setTimeout(() => { tone(70, .18, { vol: .3, to: 45, wet: 0 }); tone(70, .14, { vol: .2, to: 45, at: .16, wet: 0 }); }, at)));
    },
    upWin() { clear(); tone(300, .5, { type: 'sawtooth', vol: .06, to: 1500 }); chord([784, 988, 1175, 1568], .7, { type: 'triangle', vol: .12, step: .06, at: .3 }); noise(.6, { vol: .08, f: 6000, type: 'highpass', at: .3 }); },
    upLose() { clear(); tone(440, .5, { type: 'triangle', vol: .12, to: 110, wet: .25 }); noise(.25, { vol: .12, f: 3000, to: 300, type: 'bandpass', q: 2 }); },
    win() { chord([659, 784, 988, 1319], .45, { type: 'triangle', vol: .11, step: .07 }); tone(2637, .5, { vol: .03, at: .28 }); },
    big() { chord([523, 659, 784, 1047, 1319, 1568], .6, { type: 'triangle', vol: .12, step: .07 }); chord([1047, 1319, 1568], 1.2, { vol: .05, at: .45 }); noise(1, { vol: .06, f: 7000, type: 'highpass', at: .4 }); },
    lose() { tone(392, .22, { type: 'triangle', vol: .1 }); tone(294, .38, { type: 'triangle', vol: .1, at: .14 }); },
    gem() { tone(1568, .25, { type: 'triangle', vol: .11 }); tone(2349, .35, { vol: .06, at: .05 }); },
    boom() { noise(.9, { vol: .5, f: 1800, to: 120 }); tone(110, .7, { vol: .45, to: 35, wet: .1 }); },
    card() { noise(.06, { vol: .3, f: 3500, to: 1200, type: 'bandpass', q: 1.5 }); },
    flip() { noise(.09, { vol: .25, f: 2500, to: 5000, type: 'bandpass', q: 1.2 }); },
    dice() { noise(1.1, { vol: .12, f: 300, to: 6000, type: 'bandpass', q: 1 }); tone(220, 1.1, { type: 'sawtooth', vol: .05, to: 880, attack: .2 }); chord([1047, 1319, 1568, 2093], .7, { type: 'triangle', vol: .1, step: .07, at: 1 }); },
  };
})();

/* winnings show as +amount next to your balance instead of a pop-up */
function toast(html, kind = '') {
  if (kind === 'lose') SFX.lose();
 const t = $('toast'); t.innerHTML = html; t.className = 'show ' + kind; clearTimeout(toastT); toastT = setTimeout(() => { t.className = kind; }, 3000); }
function gamesMenu(open) { $('gmenu').hidden = !open; $('gamesBtn').setAttribute('aria-expanded', open); }
const GAME_PAGES = ['mines', 'cases', 'battles', 'upgrader', 'blackjack'];
const pageTransition=$('pageTransition'),navigationMotion=matchMedia('(prefers-reduced-motion: reduce)');
const pageNames={home:'lobby',mines:'Mines',blackjack:'Blackjack',cases:'Cases',battles:'Case battles',upgrader:'Upgrader',rewards:'Rewards',leaderboard:'Leaderboard'};
let navigationVersion=0,navigationTimer,transitionExitTimer;
function cancelPageTransition(){
  ++navigationVersion;clearTimeout(navigationTimer);clearTimeout(transitionExitTimer);
  pageTransition.hidden=true;pageTransition.classList.remove('is-running','is-leaving');
  $('pageScroll').inert=false;$('pageScroll').removeAttribute('aria-busy');
}
window.ebCancelPageTransition=cancelPageTransition;
function showPage(p) {
  window.ebLeaveAccount?.();
  if(p==='battles') void loadBattles();
  document.querySelectorAll('#gmenu [data-p]').forEach(x => x.classList.toggle('on', x.dataset.p === p));
  $('gamesBtn').classList.toggle('on', GAME_PAGES.includes(p)); $('rewardsBtn').classList.toggle('on', p === 'rewards'); $('lbBtn').classList.toggle('on', p === 'leaderboard');
  if (p === 'leaderboard' && typeof loadLb === 'function') loadLb();
  if(p==='rewards')void window.ebLobbyRewards?.();
  document.querySelectorAll('.page').forEach(x => x.classList.toggle('on', x.id === p));
  $('pageScroll').scrollTop=0;
  gamesMenu(false);
}
function nav(p){
  if(!Object.hasOwn(pageNames,p))return;
  const unchanged=$(p).classList.contains('on')&&!document.body.classList.contains('account-open');
  cancelPageTransition();gamesMenu(false);
  if(unchanged)return;
  if(navigationMotion.matches){showPage(p);return;}
  const version=navigationVersion;
  $('pageTransitionLabel').textContent='Opening '+pageNames[p];
  pageTransition.hidden=false;void pageTransition.offsetWidth;pageTransition.classList.add('is-running');
  $('pageScroll').inert=true;$('pageScroll').setAttribute('aria-busy','true');
  navigationTimer=setTimeout(()=>{
    if(version!==navigationVersion)return;
    showPage(p);$('pageScroll').inert=false;pageTransition.classList.add('is-leaving');
    transitionExitTimer=setTimeout(()=>{if(version===navigationVersion)cancelPageTransition();},100);
  },420);
}
$('home').onclick=e=>{
  const item=e.target.closest('[data-game-page]');if(item)return nav(item.dataset.gamePage);
  if(e.target.closest('[data-lobby-wallet]')){if(requireAuth())$('ebwDep').click();return;}
  if(e.target.closest('[data-explore-games]')){
    $('lobbyGamesTitle').scrollIntoView({behavior:navigationMotion.matches?'instant':'smooth',block:'start'});
    $('lobbyGamesTitle').focus({preventScroll:true});return;
  }
  const filter=e.target.closest('[data-game-filter]');if(!filter)return;
  document.querySelectorAll('[data-game-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===filter)));
  let count=0;document.querySelectorAll('#home .lobby-game').forEach(card=>{
    card.hidden=filter.dataset.gameFilter!=='all'&&card.dataset.gameCategory!==filter.dataset.gameFilter;
    if(!card.hidden)count++;
  });
  $('lobbyGameCount').textContent=count+' '+(count===1?'game':'games');
};
document.querySelector('.top .logo').onclick=e=>{
  if(e.button!==0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)return;
  e.preventDefault();$('chat').classList.remove('open');nav('home');
};
$('lbBtn').onclick = e => { e.stopPropagation(); nav('leaderboard'); };
$('rewardsBtn').onclick = e => { e.stopPropagation(); nav('rewards'); };
$('gamesBtn').onclick = e => { e.stopPropagation(); gamesMenu($('gmenu').hidden); };
document.querySelectorAll('#gmenu [data-p]').forEach(b => b.onclick = e => { e.stopPropagation(); nav(b.dataset.p); });
document.addEventListener('click', e => { if (!e.target.closest('.games')) gamesMenu(false); });
addEventListener('keydown', e => { if (e.key === 'Escape') gamesMenu(false); });

const niceErr = e => {
  const m = String((e && e.message) || e || 'Something went wrong');
  if (/duplicate key|already registered|already been registered/i.test(m)) return /username/i.test(m) ? 'That username is taken' : 'An account with that email already exists';
  if (/Database error saving new user/i.test(m)) return 'That username is taken or not allowed';
  if (/Failed to fetch|NetworkError/i.test(m)) return "Can't reach the server. Check your connection";
  return m.replace(/^.*?ERROR:\s*/, '');
};
// Our own server (replacing Supabase). Session is an httpOnly cookie.
async function api(path, method = 'GET', body) {
  const r = await fetch(path, {
    method, credentials: 'include',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw Object.assign(new Error(d.error || ('Error ' + r.status)), {status:r.status});
  return d;
}
// Currency helpers backed by the wallet module (selected real currency).
const ccySym = id => window.ebCurrencyLabel(id);
const fmtMinor = (minor, id) => window.ebFormat(minor, id);
const currencyText = (minor,id) => displayAmount(minor,window.ebAsset(id))+' '+ccySym(id);
function minorInput(value, id) {
  const decimals = window.ebAsset(id)?.decimals;
  if (decimals == null || !/^\d+(\.\d+)?$/.test(value)) return null;
  const [integer, fraction = ''] = value.split('.');
  if (fraction.length > decimals) return null;
  return BigInt(integer + fraction.padEnd(decimals, '0'));
}
function adjustStake(input, op) {
  const amount = minorInput(input.value || '0');
  if (op === 'max') input.value = fmtMinor(window.ebBalance() || '0');
  else if (amount != null) input.value = fmtMinor(op === '2' ? amount * 2n : amount / 2n);
}
function mineReturn(stake, k, m, n) {
  if (!k) return stake;
  let num=95n, den=100n;
  for (let i=0;i<k;i++) { num*=BigInt(n-i); den*=BigInt(n-m-i); }
  return stake*num/den;
}
function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

/* ---------- account ---------- */
let me = null, authRead = 0;
let bal = 0;
function resetLobbyAccount() {
  PF = {tab:'seeds',state:null,bets:[],v:null};
  $('fairModal').hidden = $('profModal').hidden = true;
}
async function refreshMe() {
  const seq=++authRead;
  if(!me && sessionState!=='checking'){walletSession(null,'checking');renderAuth();}
  try {
    const d = await api('/api/auth/me');
    if(seq!==authRead)return;
    if(!d.user?.id)throw new Error('Account unavailable');
    me = { id: d.user.id, username: d.user.username, email: d.user.email, admin: d.user.is_admin };
    walletSession(d);
  } catch (e) {
    if(seq!==authRead)return;
    if(e.status===401){me=null;walletSession(null);}
    else if(!me)walletSession(null,'unavailable');
  }
  renderAuth(); renderChatInput(); lobbySig = ''; if (vs) vs.sig = '';
}
window.addEventListener('eb-username',e=>{if(me){me.username=e.detail;PN[me.id]=e.detail;renderAuth();}});
function requireAuth() { if (me) return true; if(sessionState==='ready')openAuth('signup');else if(sessionState==='unavailable')void retrySession();return false; }
async function retrySession(){
  if(sessionState!=='unavailable')return;
  const fromHeader=document.activeElement?.id==='sessionAction';
  await refreshMe();
  if(me){void resumeMines();void resumeBj();}
  if(fromHeader && document.activeElement===document.body)($('meChip')||$('signBtn')||$('sessionAction'))?.focus();
}
window.addEventListener('eb-retry-session',retrySession);
window.addEventListener('eb-signout',async()=>{
  try { await api('/api/auth/logout', 'POST'); }
  catch { toast('Sign-out failed. Try again.', 'lose'); return; }
  ++authRead;me = null; walletSession(null); bjBusy = false; resetLobbyAccount(); U.running = false;
  MN.on = MN.running = false; MN.rev.clear(); drawBoard(); bjRender(null);
  renderAuth(); renderChatInput(); toast('Signed out'); $('signBtn')?.focus();
});
function renderAuth(){
  const a=$('auth');
  if(!me){
    if(sessionState!=='ready'){
      const checking=sessionState==='checking';
      a.innerHTML=`<button class="btn dark signin" id="sessionAction" ${checking?'disabled':''}>${checking?'Checking account…':'Retry account'}</button>`;
      $('sessionAction').onclick=retrySession;return;
    }
    a.innerHTML='<button class="btn gold signin" id="signBtn">Sign in</button>';
    $('signBtn').onclick=()=>openAuth('login');return;
  }
  a.innerHTML=`<a class="me-chip" id="meChip" href="/account/profile" aria-label="Open your profile"><span class="av bacon">${BACON}</span><span class="nm">${esc(me.username)}</span></a>`;
  paintUnread();
  $('meChip').onclick=e=>{if(e.ctrlKey||e.metaKey||e.shiftKey)return;e.preventDefault();window.ebOpenWallet('profile');};
}
window.addEventListener('eb-login',()=>openAuth('login'));
window.addEventListener('eb-session-ended',()=>{++authRead;if(me){me=null;resetLobbyAccount();renderAuth();renderChatInput();}});
const VIEWS = { signup: 'fSignup', login: 'fLogin', forgot: 'fForgot', reset: 'fReset', sent: 'fSent' };
const TITLES = { signup: 'Create your account', login: 'Welcome back', forgot: 'Reset your password', reset: 'Set a new password', sent: 'Check your email' };
let lastEmail = '';
function openAuth(view) {
  cancelPageTransition();
  view = view || 'signup';
  Object.entries(VIEWS).forEach(([k, id]) => $(id).hidden = k !== view);
  $('authTabs').hidden = !(view === 'signup' || view === 'login');
  document.querySelectorAll('#authTabs button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
  $('authTitle').textContent = TITLES[view]; $('authErr').textContent = '';
  $('authModal').hidden = false;
  const first = $(VIEWS[view]).querySelector('input'); if (first) first.focus();
}
function closeAuth() { $('authModal').hidden = true; }
function sent(msg, canResend) { openAuth('sent'); $('sentMsg').textContent = msg; $('resend').hidden = !canResend; }
const authErr = m => { $('authErr').textContent = m; };
function busyBtn(btn, on, label) { btn.disabled = on; if (label) btn.textContent = on ? 'Please wait…' : label; }
$('authTabs').onclick = e => { const b = e.target.closest('[data-v]'); if (b) openAuth(b.dataset.v); };
$('authClose').onclick = closeAuth;
$('authModal').onclick = e => { if (e.target === $('authModal')) closeAuth(); };
$('toForgot').onclick = () => { openAuth('forgot'); $('fpEmail').value = $('liEmail').value; };
$('backLogin').onclick = () => openAuth('login');
$('sentOk').onclick = closeAuth;
addEventListener('keydown', e => { if (e.key === 'Escape') { closeAuth(); $('nameModal').hidden = true; } });
const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

$('fSignup').onsubmit = async e => {
  e.preventDefault(); authErr('');
  const name = $('suName').value.trim(), email = $('suEmail').value.trim(), pass = $('suPass').value;
  if (!/^[A-Za-z0-9_]{2,20}$/.test(name)) return authErr('Username: 2 to 20 letters, numbers or underscores.');
  if (!emailOk(email)) return authErr('Enter a valid email address.');
  if (pass.length < 8) return authErr('Password must be at least 8 characters.');
  if (!$('suAge').checked) return authErr('Please confirm that you meet the legal age requirement.');
  busyBtn($('suGo'), true, 'Create account');
  try {
    await api('/api/auth/register', 'POST', { email, username: name, password: pass });
    closeAuth(); toast(`Welcome, <b>${esc(name)}</b>!`, 'win');
    await refreshMe(); if (me) { void resumeMines(); void resumeBj(); }
  } catch (err) { authErr(niceErr(err)); }
  busyBtn($('suGo'), false, 'Create account');
};
$('fLogin').onsubmit = async e => {
  e.preventDefault(); authErr('');
  const email = $('liEmail').value.trim(), pass = $('liPass').value;
  if (!emailOk(email) || !pass) return authErr('Enter your email and password.');
  busyBtn($('liGo'), true, 'Log in');
  try {
    await api('/api/auth/login', 'POST', { email, password: pass });
    busyBtn($('liGo'), false, 'Log in');
    closeAuth(); $('liPass').value = '';
    await refreshMe(); if (me) { void resumeMines(); void resumeBj(); }
  } catch (err) {
    busyBtn($('liGo'), false, 'Log in');
    return authErr('Wrong email or password.');
  }
};
$('fForgot').onsubmit = async e => {
  e.preventDefault();
  authErr('Password reset by email isn’t available yet — contact support.');
};
$('fReset').onsubmit = async e => { e.preventDefault(); closeAuth(); };
$('resend').onclick = () => {};
/* ---------- item art: original SVG icons drawn in-page ---------- */
const SV=b=>`<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><ellipse cx="32" cy="59" rx="20" ry="3.5" fill="#000" opacity=".3"/>${b}</svg>`;
const MIR=b=>`${b}<g transform="matrix(-1 0 0 1 64 0)">${b}</g>`;
const star=(x,y,r,c)=>`<path d="M${x} ${y-r}Q${x} ${y} ${x+r} ${y}Q${x} ${y} ${x} ${y+r}Q${x} ${y} ${x-r} ${y}Q${x} ${y} ${x} ${y-r}Z" fill="${c}"/>`;
const shine=(d)=>`<path d="${d}" stroke="#fff" stroke-opacity=".45" stroke-width="3" fill="none" stroke-linecap="round"/>`;
const ART={
 coins:()=>SV(`<ellipse cx="32" cy="50" rx="22" ry="7" fill="#9a6a06"/><ellipse cx="32" cy="46" rx="22" ry="7" fill="#e0a412"/><ellipse cx="32" cy="45" rx="22" ry="7" fill="#f7c948"/>
  <ellipse cx="25" cy="37" rx="16" ry="5.5" fill="#9a6a06"/><ellipse cx="25" cy="33" rx="16" ry="5.5" fill="#e0a412"/><ellipse cx="25" cy="32" rx="16" ry="5.5" fill="#ffd95e"/>
  <ellipse cx="38" cy="24" rx="13" ry="4.5" fill="#9a6a06"/><ellipse cx="38" cy="21" rx="13" ry="4.5" fill="#e0a412"/><ellipse cx="38" cy="20" rx="13" ry="4.5" fill="#ffe27a"/>
  <path d="M48 8l1.4 3.4 3.6 1.4-3.6 1.4L48 18l-1.4-3.8-3.6-1.4 3.6-1.4z" fill="#fff"/>`),
 pumpkin:c=>SV(`<path d="M31 16c0-5 3-9 8-10" stroke="#3d7a2a" stroke-width="4" fill="none" stroke-linecap="round"/>
  <ellipse cx="21" cy="37" rx="13" ry="18" fill="${c}"/><ellipse cx="43" cy="37" rx="13" ry="18" fill="${c}"/>
  <ellipse cx="32" cy="37" rx="12" ry="19" fill="${c}"/><ellipse cx="32" cy="37" rx="12" ry="19" fill="#fff" opacity=".12"/>
  <path d="M19 33l6-7 5 7zM34 33l5-7 6 7zM18 41q14 13 28 0q-14 5-28 0z" fill="#2a1200"/>`),
 helm:(c,w)=>SV(`${w?MIR(`<path d="M15 38C5 32 2 18 6 8c3 9 8 14 15 17z" fill="${w}"/><path d="M8 14c2 6 5 10 10 13" stroke="#000" stroke-opacity=".15" stroke-width="2" fill="none"/>`):''}
  <path d="M12 46a20 24 0 0 1 40 0v8H12z" fill="${c}"/>${shine('M18 32a16 16 0 0 1 13-10')}
  <rect x="17" y="40" width="30" height="6" rx="3" fill="#0c0f1c" opacity=".75"/>
  <rect x="12" y="50" width="40" height="4" rx="2" fill="#000" opacity=".22"/>`),
 crown:(c,g)=>SV(`<path d="M10 50L8 20l12 12 12-18 12 18 12-12-2 30z" fill="${c}"/>
  <rect x="9" y="44" width="46" height="8" rx="2" fill="${c}"/><rect x="9" y="48" width="46" height="4" rx="2" fill="#000" opacity=".2"/>
  <circle cx="8" cy="19" r="3" fill="${g}"/><circle cx="32" cy="13" r="3.5" fill="${g}"/><circle cx="56" cy="19" r="3" fill="${g}"/>
  <circle cx="32" cy="38" r="4" fill="${g}"/><circle cx="20" cy="40" r="2.5" fill="${g}"/><circle cx="44" cy="40" r="2.5" fill="${g}"/>`),
 shades:(c,l)=>SV(`<path d="M4 27h56" stroke="${c}" stroke-width="4" stroke-linecap="round"/>
  ${MIR(`<path d="M7 25h22v6c0 8-4 11-11 11S7 38 7 31z" fill="${l}" stroke="${c}" stroke-width="2.5"/><path d="M12 29l5-3" stroke="#fff" stroke-opacity=".6" stroke-width="2.5" stroke-linecap="round"/>`)}`),
 phones:(c,p)=>SV(`<path d="M14 40V30a18 18 0 0 1 36 0v10" stroke="${c}" stroke-width="6" fill="none"/>
  ${MIR(`<rect x="7" y="32" width="15" height="22" rx="6" fill="${c}"/><rect x="18" y="35" width="5" height="16" rx="2" fill="${p}"/><circle cx="14" cy="43" r="4.5" fill="none" stroke="${p}" stroke-width="3" stroke-dasharray="2.2 1.6"/>`)}
  ${shine('M20 22a16 16 0 0 1 10-5')}`),
 face:c=>SV(`<circle cx="32" cy="32" r="24" fill="${c}"/><path d="M8 34a24 24 0 0 0 48 0a24 20 0 0 1-48 0z" fill="#000" opacity=".1"/>
  <path d="M19 26q4-5 8 0M37 26q4-5 8 0" stroke="#2a1d00" stroke-width="3.5" fill="none" stroke-linecap="round"/>
  <path d="M15 34h34q-2 16-17 16T15 34z" fill="#2a1d00"/><path d="M20 35h24v4H20z" fill="#fff"/><path d="M25 46q7 4 14 0q-7-5-14 0z" fill="#ff6b7a"/>
  ${shine('M16 22a18 18 0 0 1 10-9')}`),
 bighead:c=>SV(`<rect x="27" y="46" width="10" height="10" rx="3" fill="${c}"/><circle cx="32" cy="27" r="23" fill="${c}"/><path d="M9 29a23 23 0 0 0 46 0a23 19 0 0 1-46 0z" fill="#000" opacity=".1"/>
  <ellipse cx="24" cy="25" rx="3" ry="4" fill="#1d1d24"/><ellipse cx="40" cy="25" rx="3" ry="4" fill="#1d1d24"/>
  <path d="M25 35q7 5 14 0" stroke="#1d1d24" stroke-width="3" fill="none" stroke-linecap="round"/>${shine('M16 18a20 20 0 0 1 10-10')}`),
 antlers:c=>SV(`${MIR(`<path d="M27 52C24 40 18 30 12 12M17 27L7 23M14 19l5-10M21 36l-12 2" stroke="${c}" stroke-width="5" fill="none" stroke-linecap="round"/>`)}
  <rect x="20" y="48" width="24" height="7" rx="3.5" fill="#5a3a20"/>`),
 fedora:(c,b,s)=>SV(`<ellipse cx="32" cy="46" rx="28" ry="8" fill="${c}"/><ellipse cx="32" cy="48" rx="28" ry="6" fill="#000" opacity=".2"/>
  <path d="M16 46c0-18 4-28 16-28s16 10 16 28z" fill="${c}"/><path d="M25 19q7 7 14 0" stroke="#000" stroke-opacity=".25" stroke-width="3" fill="none"/>
  <rect x="16" y="37" width="32" height="6" fill="${b}"/>${shine('M21 33c0-6 2-10 6-12')}
  ${s?star(12,16,6,s)+star(52,24,4.5,s)+star(46,9,3,s):''}`),
 tophat:(c,b)=>SV(`<ellipse cx="32" cy="48" rx="27" ry="7" fill="${c}"/><rect x="17" y="10" width="30" height="38" rx="3" fill="${c}"/>
  <ellipse cx="32" cy="10" rx="15" ry="3" fill="#fff" opacity=".12"/><rect x="17" y="36" width="30" height="7" fill="${b}"/>
  <rect x="41" y="10" width="6" height="38" fill="#000" opacity=".2"/>${shine('M22 16v14')}`),
 vampire:()=>SV(`${MIR(`<path d="M32 56L4 56 8 30l14 12z" fill="#b3122e"/>`)}<path d="M18 54h28l-4-10H22z" fill="#25131f"/>
  <ellipse cx="32" cy="30" rx="15" ry="18" fill="#efe3f2"/>
  <path d="M17 28c-2-14 6-20 15-20s17 6 15 20c-4-4-8-9-15-5-7-4-11 1-15 5z" fill="#25131f"/>
  <ellipse cx="26" cy="30" rx="2.8" ry="3.2" fill="#d4183a"/><ellipse cx="38" cy="30" rx="2.8" ry="3.2" fill="#d4183a"/>
  <path d="M25 39q7 5 14 0" stroke="#25131f" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <path d="M28 40l1.5 5 1.5-4zM33 41l1.5 4 1.5-5z" fill="#fff"/>`),
 horns:(c,g)=>SV(`<ellipse cx="32" cy="44" rx="26" ry="14" fill="${g}" opacity=".25"/>
  ${MIR(`<path d="M27 50C14 47 5 34 9 10c4 15 10 23 21 28z" fill="${c}"/><path d="M12 22c2 9 6 15 13 19" stroke="#fff" stroke-opacity=".4" stroke-width="2.5" fill="none" stroke-linecap="round"/>`)}
  <rect x="17" y="46" width="30" height="8" rx="4" fill="#2a2d3d"/>${star(10,8,4,g)+star(54,8,4,g)}`),
 hood:(c,t,e)=>SV(`<path d="M32 5C14 9 8 30 10 56h44c2-26-4-47-22-51z" fill="${c}"/>
  <path d="M32 5C20 8 14 22 13 40" stroke="#fff" stroke-opacity=".3" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M54 56c1-20-3-40-16-48 8 12 10 28 9 48z" fill="#000" opacity=".2"/>
  <path d="M32 19c-10 2-12 14-10 30h20c2-16 0-28-10-30z" fill="#07080f" stroke="${t}" stroke-width="3"/>
  <ellipse cx="27" cy="32" rx="3" ry="2" fill="${e}"/><ellipse cx="37" cy="32" rx="3" ry="2" fill="${e}"/>
  <ellipse cx="32" cy="32" rx="10" ry="5" fill="${e}" opacity=".15"/>`)
};


/* ---------- cases & items (loaded from the database) ---------- */
const RC = { common: '#9aa3b8', uncommon: '#3ee8a8', rare: '#5b8cff', epic: '#a66bff', legendary: '#f7c948' };
let CASES = [];
const artFrom = spec => { const [fn, ...args] = String(spec).split(':'); return (ART[fn] || ART.bighead)(...(fn in ART ? args : ['#9aa3b8'])); };
const caseById = id => CASES.find(c => c.id === id);
function pick(c) { let t = Math.random() * c.tot; for (const it of c.items) { t -= it.w; if (t <= 0) return it; } return c.items[c.items.length - 1]; }
const pic = it => it.img ? `<img src="${esc(it.img)}" alt="">` : it.art;
/* a case's own picture (falls back to its best item) */
const cpic = c => c.image ? `<img src="${esc(c.image)}" alt="" class="cimg">` : pic(c.top);
const onSale = () => CASES.filter(c => c.active);
/* gold dice: the case's top pulls hide behind it on the spinner */
const DICE = { dice: true, n: 'Top pull', r: 'legendary', v: 0 };
const DICE_ART = '<img src="/assets/dice-top.webp" alt="" class="dicei">';
const shown = it => it && it.top ? DICE : it;
function pickTop(c) { let t = Math.random() * c.ttot; for (const it of c.tops) { t -= it.w; if (t <= 0) return it; } return c.tops[c.tops.length - 1]; }
const reelSet = c => { const s = c.items.filter(it => !it.top); if (c.tops && c.tops.length) s.splice(Math.floor(s.length / 2), 0, DICE); return s; };
function loadCases(data) {
  CASES = data.cases.map(x => {
    const items = data.items.filter(y => y.case_id === x.id).sort((a, b) => a.idx - b.idx)
      .map(y => ({ idx: y.idx, n: y.name, v: Number(y.value), r: y.rarity, w: y.weight, id: Number(y.catalog_id) || 0, art: artFrom(y.art), img: null, top: !!y.top }));
    const tops = items.filter(it => it.top), best = items.reduce((m, it) => it.v > m.v ? it : m, items[0]);
    return { id: x.id, name: x.name, price: Number(x.price), items, tot: items.reduce((s, it) => s + it.w, 0), top: best, tops, ttot: tops.reduce((s, it) => s + it.w, 0), image: x.image?.startsWith('assets/') ? '/'+x.image : x.image || null, active: x.active !== false };
  });
  renderCaseGrid(); loadThumbs();
}
/* real item pictures by Roblox catalog ID; falls back to the drawings if unavailable */
async function loadThumbs() {
  const all = CASES.flatMap(c => c.items).filter(i => i.id > 0);
  if (!all.length) return;
  await thumbsFor(all);
  renderCaseGrid(); if (cur && !spinning && !$('caseView').hidden) openCase(cur.id);
  if (vs && BT[vs.id]) { vs.sig = ''; tickView(true); }
}

/* ---------- cases page ---------- */
const hcard = it => it.dice ? `<div class="hc dice" style="--rc:${RC.legendary}"><span class="art">${DICE_ART}</span><span>Top pull</span><em>Gold dice</em></div>`
  : `<div class="hc ${it.top ? 'tp' : ''}" style="--rc:${RC[it.r]}"><span class="art">${pic(it)}</span><span>${esc(it.n)}</span>${cv(it.v)}</div>`;
let cur = null, spinning = false;
function renderCaseGrid() {
  $('caseGrid').innerHTML = CASES.length ? onSale().map(c => `<button class="ccard" data-case="${c.id}" style="--g:${RC[c.top.r]}"><span class="art">${cpic(c)}</span><b>${esc(c.name)}</b><span class="meta">${c.items.length} items · top ${cv(c.top.v)}</span><span class="price">${cv(c.price)}</span>${volBar(c)}</button>`).join('')
    : `<div class="loading">Loading cases…</div>`;
}
$('caseGrid').onclick = e => { const t = e.target.closest('[data-case]'); if (t) openCase(t.dataset.case); };
function idleH(reel, c) { reel.style.transition = 'none'; reel.style.transform = 'translateX(0)'; reel.parentElement.classList.remove('goldmode'); const s = reelSet(c); reel.innerHTML = s.concat(s, s).map(hcard).join(''); }
async function hspin(reel, c, winner, dur) {
  const box = reel.parentElement; box.classList.remove('goldmode');box.dataset.phase='spinning';
  if(navigationMotion.matches){
    await hroll(reel,()=>shown(pick(c)),winner,120);
    if(winner.top){box.classList.add('goldmode');reel.children[50].classList.add('jack');}
    box.dataset.phase='landed';
    return;
  }
  if (!winner.top){await hroll(reel, () => shown(pick(c)), winner, dur);box.dataset.phase='landed';return;}
  await hroll(reel, () => shown(pick(c)), DICE, dur - 900);
  box.dataset.phase=$('caseView').dataset.phase='bonus';
  await flare(reel.children[50], box);
  box.classList.add('goldmode');
  await hroll(reel, () => pickTop(c), winner, 3800);
  reel.children[50].classList.add('jack');box.dataset.phase='landed';confetti(false);
}
function hroll(reel, fill, winner, dur) {
  const N = 60, W = 50; let h = ''; for (let i = 0; i < N; i++) h += hcard(i === W ? winner : fill()); reel.innerHTML = h;
  reel.style.transition = 'none'; reel.style.transform = 'translateX(0)'; void reel.offsetWidth;
  const box = reel.parentElement.clientWidth, x0 = 12 + W * 162 + 75 - box / 2, off = (Math.random() < .5 ? -1 : 1) * (20 + Math.random() * 45), run = dur - 500;
  if(navigationMotion.matches){reel.style.transform=`translateX(${-x0}px)`;reel.children[W].classList.add('won');return sleep(120);}
  SFX.spin(dur - 450);
  reel.style.transition = `transform ${run}ms cubic-bezier(.1,.75,.15,1)`; reel.style.transform = `translateX(${-(x0 + off)}px)`;
  setTimeout(() => { reel.style.transition = 'transform .45s cubic-bezier(.3,1.35,.5,1)'; reel.style.transform = `translateX(${-x0}px)`; reel.children[W].classList.add('won'); }, run + 40);
  return sleep(dur + 150);
}
/* the gold dice bursts and spins before the top-pull respin */
function flare(card, box, ms = 1500) {
  if (!card) return sleep(ms);
  card.classList.add('flare'); box.classList.add('flaring'); if (!box.querySelector('#vr1') || box.querySelector('#vr0')) SFX.dice();
  const fx = document.createElement('div'); fx.className = 'dflare'; fx.innerHTML = '<i class="rays"></i><i class="dfr"></i><i class="dfr r2"></i>' + Array.from({ length: 14 }, (_, k) => `<b style="--a:${k * 360 / 14}deg;--d:${(k % 3) * 60}ms"></b>`).join('') + DICE_ART;
  card.appendChild(fx);
  return sleep(ms).then(() => { box.classList.remove('flaring'); });
}
function openCase(id) {
  cur = caseById(id); if (!cur) return;
  $('caseView').dataset.phase='idle';$('cvReel').parentElement.dataset.phase='idle';
  $('caseList').hidden = true; $('caseView').hidden = false;
  $('pageScroll').scrollTop=0;
  $('cvIcon').innerHTML = cpic(cur); $('cvName').textContent = cur.name;
  $('cvMeta').textContent = `${cur.items.length} items` + (cur.tops.length ? ` · gold dice ${(cur.ttot / cur.tot * 100).toFixed(2)}%` : '');
  $('cvOpen').innerHTML = `Open for ${cv(cur.price)}`;
  $('cvItems').innerHTML = cur.items.slice().sort((a, b) => b.v - a.v).map(i => `<div class="ic2 ${i.top ? 'tp' : ''}" style="--rc:${RC[i.r]}">${i.top ? '<span class="tpb" title="Behind the gold dice">' + DICE_ART + '</span>' : ''}<span class="odds">${(i.w / cur.tot * 100).toFixed(2)}%</span><span class="art">${pic(i)}</span><b>${esc(i.n)}</b>${cv(i.v)}</div>`).join('');
  idleH($('cvReel'), cur);
}
$('cvBack').onclick = () => { if (spinning) return; $('caseView').hidden = true; $('caseList').hidden = false; };
$('cvOpen').onclick = async () => {
  if (spinning || !requireAuth()) return;
  if (!requireQuote()) return;
  spinning = true; $('cvOpen').disabled = true; $('cvBack').disabled = true;
  $('caseView').setAttribute('aria-busy','true');
  $('caseView').dataset.phase=$('cvReel').parentElement.dataset.phase='requesting';
  try {
    const r = await api('/api/games/instant','POST',{ ...pricedBet(),game:'cases',case:cur.id });
    void window.ebWalletRefresh();
    const w = cur.items.find(i => i.idx === r.idx) || cur.items[0];
    $('caseView').dataset.phase='spinning';
    await hspin($('cvReel'), cur, w, 4600);
    $('caseView').dataset.phase='landed';
    toast(`You unboxed <b>${esc(w.n)}</b> · ${currencyText(r.payout,r.asset_id)}`);
  } catch (e) { $('caseView').dataset.phase=$('cvReel').parentElement.dataset.phase='error';toast(esc(niceErr(e)), 'lose'); }
  spinning = false; $('cvOpen').disabled = false; $('cvBack').disabled = false;
  $('caseView').setAttribute('aria-busy','false');
};

/* ---------- mines (the server decides where mines are) ---------- */
const MARK = '<span class="mark" aria-hidden="true"></span>';
const GEM = '<svg class="ic" viewBox="0 0 64 64"><path d="M6 26L18 13H46L58 26L32 57Z" fill="#c98a0c"/><path d="M6 26L18 13L22 26Z" fill="#ffd955"/><path d="M18 13H32L22 26Z" fill="#fff0a6"/><path d="M32 13L22 26H42Z" fill="#ffe170"/><path d="M32 13H46L42 26Z" fill="#ffeb94"/><path d="M46 13L58 26H42Z" fill="#f6c432"/><path d="M6 26H22L32 57Z" fill="#f0b21c"/><path d="M22 26H42L32 57Z" fill="url(#gemMid)"/><path d="M42 26H58L32 57Z" fill="#d6950b"/><path d="M6 26L18 13H46L58 26L32 57Z" fill="none" stroke="#a56f05" stroke-width="1.6" stroke-linejoin="round"/><path d="M21 17l-5 6" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".85"/><path d="M50 9l1.3 3 3 1.3-3 1.3L50 18l-1.3-3.4-3-1.3 3-1.3z" fill="#fff"/></svg>';
const BOMB = '<svg class="ic" viewBox="0 0 64 64"><path d="M40 16c4-6 9-8 13-5" stroke="#8a5a2b" stroke-width="3.2" fill="none" stroke-linecap="round"/><path d="M53 3c4 3 5 7 2 11-2 2-6 2-7-1-1-2 1-3 1-5 2 1 3 0 4-5z" fill="#ff4b2b"/><path d="M53 8c2 2 2 4 1 6-1 1-3 1-3-1 0-1 1-2 2-5z" fill="#ffc53a"/><g transform="rotate(40 41 20)"><rect x="34" y="14" width="14" height="10" rx="3" fill="#3b3f9e"/><rect x="34" y="14" width="14" height="4" rx="2" fill="#6b70e0"/></g><circle cx="29" cy="38" r="21" fill="url(#bombG)"/><circle cx="29" cy="38" r="21" fill="none" stroke="#1d1e5c" stroke-width="2"/><image href="/assets/dice-white.png" x="18" y="27" width="22" height="22" opacity=".92" transform="rotate(-12 29 38)"/><ellipse cx="20" cy="28" rx="7" ry="4.5" fill="#fff" opacity=".45" transform="rotate(-35 20 28)"/></svg>';
const MN = { size: 25, m: 3, on: false, id: null, bet: 0, rev: new Set(), mode: 'manual', running: false, busy: false, tiles: [] };
function mult(k, m, N) { if (k === 0) return 1; let x = .95; for (let i = 0; i < k; i++) x *= (N - i) / (N - m - i); return x; }
function setRange(el) { el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min || 1) * 100) + '%'); }
function drawBoard() {
  const b = $('board'); b.style.setProperty('--n', Math.sqrt(MN.size)); b.innerHTML = ''; MN.tiles = [];
  for (let i = 0; i < MN.size; i++) { const t = document.createElement('button'); t.className = 'tile'; t.innerHTML = MARK; t.setAttribute('aria-label', 'Tile ' + (i + 1)); t.onclick = () => tap(i); b.appendChild(t); MN.tiles.push(t); }
  updM();
}
function readBet() {
  const v = ($('mBet').value || '').trim();
  if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) { toast('Enter a bet amount', 'lose'); return null; }
  if (!(window.ebCurrency && window.ebCurrency())) { toast('Deposit a currency first', 'lose'); return null; }
  return v;
}
async function startRound(bet) {
  MN.busy = true; updM();
  try {
    const asset = window.ebCurrency();
    const r = await api('/api/games/mines/start', 'POST', { asset, bet, size: MN.size, mines: MN.m, request:requestId() });
    Object.assign(MN, { on: true, id: r.id, bet: r.bet, asset, rev: new Set() });
    MN.tiles.forEach(t => { t.className = 'tile'; t.innerHTML = MARK; });
    if (window.ebWalletRefresh) window.ebWalletRefresh();
  } catch (e) { toast(esc(niceErr(e)), 'lose'); }
  MN.busy = false; updM(); return MN.on;
}
async function tap(i) {
  if (!MN.on || MN.busy || MN.rev.has(i)) return;
  const t = MN.tiles[i]; MN.busy = true; t.classList.add('pending');
  try {
    const r = await api('/api/games/mines/reveal', 'POST', { tile:i, id:String(MN.id) });
    t.classList.remove('pending');
    if (r.result === 'mine') { SFX.boom(); t.className = 'tile bomb hit'; t.innerHTML = BOMB; endMines(r.mine_positions); if (window.ebWalletRefresh) window.ebWalletRefresh(); toast('Boom! Lost your bet', 'lose'); }
    else {
      MN.rev = new Set(r.revealed); t.className = 'tile gem pop'; t.innerHTML = GEM; SFX.gem();
      if (r.result === 'cashed') { endMines(r.mine_positions); if (window.ebWalletRefresh) window.ebWalletRefresh(); toast(`Board cleared! +${currencyText(r.payout, r.asset_id)}`, 'win'); }
    }
  } catch (e) { t.classList.remove('pending'); toast(esc(niceErr(e)), 'lose'); if (/No active game/.test(String(e.message))) { MN.on = false; } }
  MN.busy = false; updM();
}
function endMines(mines) {
  const set = new Set(mines || []);
  MN.on = false;
  MN.tiles.forEach((t, i) => { if (!MN.rev.has(i) && !t.classList.contains('hit')) { const b = set.has(i); t.className = 'tile dim ' + (b ? 'bomb' : 'gem'); t.innerHTML = b ? BOMB : GEM; } });
  updM();
}
async function cashMines() {
  if (!MN.on || MN.rev.size === 0 || MN.busy) return;
  MN.busy = true; updM();
  try { const r = await api('/api/games/mines/cashout', 'POST', {id:String(MN.id)}); MN.busy = false; endMines(r.mine_positions); if (window.ebWalletRefresh) window.ebWalletRefresh(); toast(`Cashed out +${currencyText(r.payout, r.asset_id)} <span class="mut">(${r.multiplier}×)</span>`, 'win'); }
  catch (e) { MN.busy = false; toast(esc(niceErr(e)), 'lose'); }
  updM();
}
function updM() {
  const N = MN.size, k = MN.rev.size, x = mult(k, MN.m, N), nx = k < N - MN.m ? mult(k + 1, MN.m, N) : null;
  const lock = MN.on || MN.running, asset = MN.on ? MN.asset : window.ebCurrency();
  const bet = MN.on ? BigInt(MN.bet) : minorInput($('mBet').value, asset) || 0n;
  $('minesCurrency').textContent = ccySym(asset);
  $('board').classList.toggle('live', MN.on && !MN.busy);
  $('sMult').textContent = x.toFixed(2) + '×';
  $('sNext').textContent = nx ? nx.toFixed(2) + '×' : '0.00×';
  $('sProfitL').textContent = MN.on && k > 0 ? 'Profit if you cash out' : 'Profit on first gem';
  $('sProfit').textContent = currencyText(mineReturn(bet, MN.on && k ? k : 1, MN.m, N) - bet, asset);
  ['mBet', 'mCount', 'aTiles', 'aCount'].forEach(id => $(id).disabled = lock);
  document.querySelectorAll('#mGrid button,#mMode button,.amt [data-b]').forEach(b => b.disabled = lock);
  const p = $('mPlay');
  if (MN.mode === 'auto') { p.className = 'btn big ' + (MN.running ? 'redb' : 'gold'); p.textContent = MN.running ? 'Stop autobet' : 'Start autobet'; p.disabled = false; }
  else if (MN.on) { p.className = 'btn big mint'; p.textContent = k ? `Cash out ${currencyText(mineReturn(bet,k,MN.m,N), asset)}` : 'Pick a tile'; p.disabled = k === 0 || MN.busy; }
  else { p.className = 'btn big gold'; p.textContent = 'Play'; p.disabled = MN.busy; }
  $('mRand').hidden = !(MN.mode === 'manual' && MN.on);
}
$('mPlay').onclick = async () => {
  if (!requireAuth()) return;
  if (MN.mode === 'auto') { if (MN.running) { MN.running = false; updM(); } else autoRun(); return; }
  if (MN.on) return cashMines();
  const bet = readBet(); if (bet !== null) startRound(bet);
};
$('mRand').onclick = () => { const free = [...Array(MN.size).keys()].filter(i => !MN.rev.has(i)); if (free.length) tap(free[Math.floor(Math.random() * free.length)]); };
async function autoRun() {
  let left = Math.max(0, Math.floor(+$('aCount').value || 0)); const inf = left === 0;
  MN.running = true; updM();
  while (MN.running && (inf || left > 0)) {
    const bet = readBet(); if (bet === null) break;
    if (!await startRound(bet)) break;
    const want = Math.min(+$('aTiles').value, MN.size - MN.m);
    const picks = [...Array(MN.size).keys()].sort(() => Math.random() - .5).slice(0, want);
    for (const i of picks) { await sleep(120); if (!MN.on) break; await tap(i); }
    if (MN.on) await cashMines();
    if (!inf) left--;
    await sleep(650);
  }
  MN.running = false; updM();
}
function syncRanges() {
  const mc = $('mCount'); mc.max = MN.size - 1; if (MN.m > MN.size - 1) MN.m = MN.size - 1; mc.value = MN.m; $('mCountV').textContent = MN.m; setRange(mc);
  const at = $('aTiles'); at.max = MN.size - MN.m; if (+at.value > MN.size - MN.m) at.value = MN.size - MN.m; $('aTilesV').textContent = at.value; setRange(at);
}
$('mCount').oninput = e => { MN.m = +e.target.value; syncRanges(); updM(); };
$('aTiles').oninput = e => { $('aTilesV').textContent = e.target.value; setRange(e.target); };
$('mGrid').onclick = e => { const b = e.target.closest('[data-g]'); if (!b || MN.on || MN.running) return; MN.size = +b.dataset.g; document.querySelectorAll('#mGrid button').forEach(x => x.classList.toggle('on', x === b)); syncRanges(); drawBoard(); };
$('mMode').onclick = e => { const b = e.target.closest('[data-m]'); if (!b || MN.on || MN.running) return; MN.mode = b.dataset.m; document.querySelectorAll('#mMode button').forEach(x => x.classList.toggle('on', x === b)); $('autoOpts').hidden = MN.mode !== 'auto'; updM(); };
document.querySelectorAll('.amt [data-b]').forEach(b => b.onclick = () => { if (MN.on || MN.running) return; const el = $('mBet'); adjustStake(el, b.dataset.b); updM(); });
$('mBet').oninput = updM;
async function resumeMines() {
  if (!me) return;
  try {
    const d = await api('/api/games/mines/active'); const g = d.round; if (!g) return;
    MN.size = g.size; MN.m = g.mines;
    document.querySelectorAll('#mGrid button').forEach(x => x.classList.toggle('on', +x.dataset.g === g.size));
    syncRanges(); drawBoard();
    Object.assign(MN, { on: true, id: g.id, bet: g.bet, asset: g.asset_id, rev: new Set(g.revealed || []) });
    $('mBet').value = fmtMinor(g.bet,g.asset_id);
    MN.rev.forEach(i => { MN.tiles[i].className = 'tile gem'; MN.tiles[i].innerHTML = GEM; });
    updM(); toast('Your unfinished Mines round is back');
  } catch (e) { /* nothing to resume */ }
}
syncRanges(); drawBoard();

/* ---------- case battles ---------- */
const MODES = { '1v1': [[0], [1]], '3way': [[0], [1], [2]], '4way': [[0], [1], [2], [3]], '2v2': [[0, 1], [2, 3]], '3v3': [[0, 1, 2], [3, 4, 5]], '2v2v2': [[0, 1], [2, 3], [4, 5]], g2: [[0, 1]], g3: [[0, 1, 2]], g4: [[0, 1, 2, 3]] };
const MODE_NAME = { '1v1': '1v1', '3way': '3 way', '4way': '4 way', '2v2': '2v2', '3v3': '3v3', '2v2v2': '2v2v2', g2: 'Group 2p', g3: 'Group 3p', g4: 'Group 4p' };
const isGroup = m => /^g/.test(m);
const TEAM_COL = ['#5b8cff', '#ff5a6e', '#3ee8a8', '#a66bff'];
const JP_SPIN = 5200, JP_MS = 7200;
const modeTags = b => (b.crazy ? '<span class="mtag crazy" title="Crazy: lowest total wins">Crazy</span>' : '') + (b.jackpot ? '<span class="mtag jp" title="Jackpot: winner drawn by chance">Jackpot</span>' : '') + (b.borrow && b.borrow.some(x => x > 0) ? '<span class="mtag bw" title="Someone borrowed: they paid less and win less">Borrow</span>' : '');
const ROUND_MS = 6600, SPIN_MS = 5400, MAX_ROUNDS = 20, PITCH = 140, FLARE_MS = 1500, TOP_SPIN = 4200, BONUS_MS = FLARE_MS + TOP_SPIN;
const BT = {}, PN = {}, PW = {}, announced = new Set();
let namesVer = 0, draft = { mode: '1v1', cases: [], crazy: false, jackpot: false, borrow: 0 }, vs = null, busy = false, lobbySig = '';
const ME = () => me ? me.id : '__nobody__';
function norm(row) {
  if (!row || !MODES[row.mode]) return null;
  const cases = (row.case_ids || []).map(caseById).filter(Boolean);
  if (!cases.length || cases.length !== (row.case_ids || []).length) return null;
  const n = MODES[row.mode].flat().length;
  const seats = Array.from({ length: n }, (_, i) => (row.seats && typeof row.seats[i] === 'string' && row.seats[i]) || null);
  const results = row.status === 'rolling' && Array.isArray(row.results)
    ? seats.map((_, i) => cases.map((c, r) => { const k = +(row.results[i] || [])[r]; return c.items.find(it => it.idx === k) || c.items[0]; })) : null;
  const payouts = Array.isArray(row.payouts) ? row.payouts.map(Number) : seats.map(() => 0);
  /* a round where anyone hits the gold dice runs longer for the respin */
  const bonus = cases.map((_, r) => results && results.some(s => s[r].top) ? BONUS_MS : 0), rs = []; let acc = 0;
  bonus.forEach((x, r) => { rs[r] = acc; acc += ROUND_MS + x; });
  const roundsEnd = acc, jackpot = !!row.jackpot && !isGroup(row.mode); if (jackpot && results) acc += JP_MS;
  return { unit:row.unit,asset_id:row.asset_id,pfHash: row.pf_hash || null, pfSeed: row.pf_seed || null, crazy: !!row.crazy, jackpot, borrow: Array.isArray(row.borrow) ? row.borrow.map(Number) : [], jp: row.jp || null, roundsEnd, id: row.id, mode: row.mode, cases, seats, status: row.status, results, payouts, creator: row.creator, cost: Number(row.cost),
    createdAt: Date.parse(row.created_at) || 0, startedAt: Date.parse(row.started_at) || 0, bonus, rs, total: acc };
}
function ingest(row) { const b = norm(row); if (b) BT[b.id] = b; lobbySig = ''; if (vs && vs.id === row.id) vs.sig = ''; }
function prog(b, now = Date.now()) {
  if (b.status === 'cancelled') return { ph: 'cancelled', revealed: 0, spinning: -1 };
  if (b.status !== 'rolling' || !b.results) return { ph: 'open', revealed: 0, spinning: -1 };
  const t = now - b.startedAt, n = b.cases.length;
  if (t < 0) return { ph: 'starting', revealed: 0, spinning: -1, count: Math.ceil(-t / 1000) };
  if (t >= b.total) return { ph: 'done', revealed: n, spinning: -1 };
  if (t >= b.roundsEnd) return { ph: 'jackpot', revealed: n, spinning: -1, jpLeft: b.total - t };
  let r = 0; while (r < n - 1 && t >= b.rs[r + 1]) r++;
  const inSpin = (t - b.rs[r]) < SPIN_MS + b.bonus[r];
  return { ph: 'rolling', revealed: inSpin ? r : r + 1, spinning: inSpin ? r : -1 };
}
const totals = (b, upto) => b.seats.map((_, i) => b.results ? b.results[i].slice(0, upto).reduce((s, it) => s + it.v, 0) : 0);
function winners(b) { const seats = b.payouts.map((p, i) => p > 0 ? i : -1).filter(i => i >= 0); return { seats, share: Math.max(0, ...b.payouts), pot: totals(b, b.cases.length).reduce((a, c) => a + c, 0) }; }

const baseName = s => (me && s === me.id) ? me.username : (PN[s] || 'Player');
/* bots: seat "bot:1" … "bot:5" */
const BOTS = [
  { n: 'Guest', img: '/assets/bots/guest666.png' },
  { n: 'John', img: '/assets/bots/johndoe.png' },
  { n: 'Baddie', img: '/assets/bots/baddie.png' },
  { n: 'Bacon', img: '/assets/bacon.png' },
  { n: 'Emperor', img: '/assets/dice-top.webp' },
];
const botOf = s => BOTS[(Math.max(1, +s.slice(4) || 1) - 1) % BOTS.length];
const nameOf = s => !s ? '' : s.startsWith('bot:') ? botOf(s).n : baseName(s) + (me && s === me.id ? ' (you)' : '');
const avatar = (s, lg) => s.startsWith('bot:') ? `<span class="av bot ${lg ? 'lg' : ''}" title="${esc(botOf(s).n)} (bot)">${botOf(s).img ? `<img src="${botOf(s).img}" alt="">` : botOf(s).svg}</span>` : `<span class="av bacon ${lg ? 'lg' : ''}" data-uid="${esc(s)}" title="View profile">${BACON}</span>`;
async function resolveNames(ids) {
  ids = [...new Set(ids)].filter(x => x && !x.startsWith('bot:') && !(x in PN));
  await Promise.all(ids.map(async id => {
    try { PN[id] = (await api('/api/players/'+id)).username; } catch { /* Player unavailable */ }
  }));
  if (ids.length) { namesVer++; lobbySig=''; if(vs) vs.sig=''; renderChat(); }
}
async function act(path, body) {
  if(!requireAuth() || busy) return null;
  busy=true;
  try { const result=await api(path,'POST',body);void window.ebWalletRefresh();return result; }
  catch(e){toast(esc(niceErr(e)),'lose');return null;}
  finally {busy=false;lobbySig='';if(vs)vs.sig='';}
}
async function createBattle() {
  if (!requireAuth()) return;
  const cases = draft.cases.map(caseById).filter(Boolean);
  if (!cases.length) return toast('Add at least one case', 'lose');
  
  if (!requireQuote()) return;
  const r = await act('/api/games/battles',{...pricedBet(),mode:draft.mode,cases:cases.map(c=>c.id),crazy:draft.crazy,jackpot:draft.jackpot,borrow:draft.borrow});
  if (!r) return renderCreate();
  await loadBattles(); draft.cases = []; draft.borrow = 0; openBattle(r.id);
}
async function joinSeat(id, i, pct = 0) {
  const b = BT[id]; if (!b || !requireAuth()) return;
  if (b.seats.includes(ME())) return toast("You're already in this battle");
  await act('/api/games/battles/'+id,{action:'join',seat:i,borrow:pct,asset:window.ebCurrency()}); await loadBattles();
}
async function addBots(id,seat=null) { await act('/api/games/battles/'+id,{action:'bots',seat}); await loadBattles(); }
async function cancelBattle(id) {
  const r=await act('/api/games/battles/'+id,{action:'cancel'});
  if(r)toast('Battle cancelled and entries refunded');
  await loadBattles();showB('bLobby');
}

/* when a battle you're in finishes, pick up your new balance */
async function settleSeen() {
  if (!me) return;
  const now = Date.now();
  for (const b of Object.values(BT)) {
    if (announced.has(b.id) || !b.seats.includes(me.id) || prog(b, now).ph !== 'done') continue;
    announced.add(b.id);
    const mine = b.payouts[b.seats.indexOf(me.id)] || 0;
    if (Date.now() - (b.startedAt + b.total) < 60000) {
      void window.ebWalletRefresh();
      if(mine>0) toast(`Battle payout · ${currencyText(BigInt(mine)*BigInt(b.unit),b.asset_id)}`);
    }
  }
}

function showB(which) { ['bLobby', 'bCreate', 'bView'].forEach(id => $(id).hidden = id !== which); if (which !== 'bView') vs = null; lobbySig = ''; }
const LF = { tab: 'all', afford: false, sort: 'high' };
function renderLobby(force) {
  const now = Date.now();
  const list = Object.values(BT).filter(b => {
    if (b.status === 'cancelled') return false;
    const ph = prog(b, now).ph;
    if (LF.tab === 'open' && ph !== 'open') return false;
    if (LF.tab === 'progress' && ph !== 'starting' && ph !== 'rolling') return false;
    if (LF.tab === 'mine' && !b.seats.includes(ME())) return false;
    if (LF.afford && BigInt(b.cost)*BigInt(b.unit)>BigInt(window.ebBalance() || 0)) return false;
    return true;
  }).sort((a, b) => {
    if (LF.tab !== 'mine') { const pa = prog(a, now).ph === 'done', pb = prog(b, now).ph === 'done'; if (pa !== pb) return pa - pb; }
    return LF.sort === 'new' ? b.createdAt - a.createdAt : LF.sort === 'low' ? a.cost - b.cost || b.createdAt - a.createdAt : b.cost - a.cost || b.createdAt - a.createdAt;
  }).slice(0, 60);
  const sig = list.map(b => { const p = prog(b, now); return b.id + p.ph + p.revealed + p.spinning + b.seats.join(); }).join('|') + busy + namesVer + LF.tab + LF.afford + LF.sort + (me ? me.id : '') + (LF.afford ? Math.floor(bal) : '');
  if (!force && sig === lobbySig) return; lobbySig = sig;
  $('bHead').hidden = !list.length;
  if (!list.length) { $('bList').innerHTML = `<div class="bempty"><h3>No battles found</h3><p>Create a battle or check another tab.</p><button class="btn gold" data-create="1">Create Battle</button></div>`; return; }
  $('bList').innerHTML = list.map(b => {
    const p = prog(b, now), n = b.seats.length, filled = b.seats.filter(Boolean).length, mine = b.seats.includes(ME());
    const st = p.ph === 'open' ? `Waiting ${filled}/${n}` : p.ph === 'starting' ? 'Starting' : p.ph === 'jackpot' ? 'Jackpot spin' : p.ph === 'rolling' ? `Round ${p.spinning >= 0 ? p.spinning + 1 : p.revealed}/${b.cases.length}` : 'Finished';
    const join = p.ph === 'open' && !mine;
    const btn = join ? `<button class="btn mint" data-open="${esc(b.id)}" data-join="1">Join ${cv(b.cost,b)}</button>` : `<button class="btn dark" data-open="${esc(b.id)}">${mine && p.ph === 'open' ? 'Open' : 'Watch'}</button>`;
    const players = MODES[b.mode].map(t => t.map(i => b.seats[i] ? avatar(b.seats[i]) : '<span class="av slot"></span>').join('')).join('<i class="sep">VS</i>');
    const ptag = p.ph === 'jackpot' ? 'rolling' : p.ph;
    return `<div class="brow ${ptag}"><div class="bm"><b>${MODE_NAME[b.mode]}</b><small>${b.cases.length} round${b.cases.length > 1 ? 's' : ''}</small>${modeTags(b) ? `<span class="mtags">${modeTags(b)}</span>` : ''}</div><div class="bc">${b.cases.slice(0, 7).map(c => `<span class="mini" title="${esc(c.name)}">${cpic(c)}</span>`).join('')}${b.cases.length > 7 ? `<span class="more">+${b.cases.length - 7}</span>` : ''}</div><div class="bp">${players}</div><div class="bk">${cv(b.cost,b)}</div><div class="bs"><span class="pill ${ptag}">${st}</span></div><div class="ba">${btn}</div></div>`;
  }).join('');
}
function renderCreate() {
  const g = isGroup(draft.mode); if (g) { draft.crazy = false; draft.jackpot = false; }
  document.querySelectorAll('#bCreate [data-tg]').forEach(t => { const k = t.dataset.tg; t.classList.toggle('on', !!draft[k]); t.classList.toggle('off', g && k !== 'borrow'); t.setAttribute('aria-pressed',!!draft[k]); t.setAttribute('aria-disabled',g && k !== 'borrow'); });
  document.querySelectorAll('#bCreate [data-mode]').forEach(x => { const selected=x.dataset.mode === draft.mode; x.classList.toggle('on',selected); x.setAttribute('aria-pressed',selected); });
  document.querySelectorAll('#bCreate .cbtype').forEach(x => x.classList.toggle('on', !!x.querySelector(`[data-mode="${draft.mode}"]`)));
  const counts = new Map(); draft.cases.forEach(id => counts.set(id, (counts.get(id) || 0) + 1));
  $('bRounds').innerHTML = '<button class="cbadd" data-pick="1"><b>+</b>Add a case</button>' + [...counts].map(([id, q]) => { const c = caseById(id); return `<div class="cbcase"><span class="art">${cpic(c)}</span><b>${esc(c.name)}</b>${cv(c.price)}<span class="qty"><button data-dec="${id}" aria-label="One less">−</button><em>${q}</em><button data-inc="${id}" aria-label="One more">+</button></span></div>`; }).join('');
  const cost = draft.cases.reduce((s, id) => s + caseById(id).price, 0), pay = Math.ceil(cost * (100 - draft.borrow) / 100);
  $('bFoot').innerHTML = `${draft.cases.length} case${draft.cases.length === 1 ? '' : 's'} · ${cv(cost)}${draft.borrow ? ` <span class="mut">· you pay ${cv(pay)}</span>` : ''}`;
  $('bBorrow').hidden = !draft.borrow; if (draft.borrow) borrowPanel($('bBorrow'), cost, draft.borrow, v => { draft.borrow = v; renderCreate(); });
  $('bMake').disabled = !draft.cases.length || busy;
  $('bMake').textContent = 'Create battle';
}
/* volatility = how spread out a case's pulls are (0 calm … 1 wild) */
const caseVol = c => { if (c._vol != null) return c._vol; const t = c.tot, m = c.items.reduce((s, i) => s + i.v * i.w, 0) / t, sd = Math.sqrt(c.items.reduce((s, i) => s + i.w * (i.v - m) ** 2, 0) / t); return c._vol = sd / c.price; };
function volBar(c) {
  const all = onSale().map(caseVol).sort((x, y) => x - y), r = all.length > 1 ? all.indexOf(caseVol(c)) / (all.length - 1) : .5;
  const col = r < .25 ? '#3ee8a8' : r < .5 ? '#5b8cff' : r < .75 ? '#f7a23b' : '#ff4d6a';
  return `<span class="vol" style="--vc:${col};--vx:calc(${(r * 100).toFixed(1)}% - 1.5px)" title="Volatility">${[0, 1, 2, 3].map(k => `<i class="${k <= Math.floor(r * 3.999) ? 'f' : ''}"></i>`).join('')}<em></em></span>`;
}
let PK = { sel: [], sort: 'new' };
function openPicker() { PK.sel = []; $('pkQ').value = ''; $('pickModal').hidden = false; renderPicker(); setTimeout(() => $('pkQ').focus(), 30); }
function renderPicker() {
  const q = $('pkQ').value.trim().toLowerCase(), counts = {}; PK.sel.forEach(id => counts[id] = (counts[id] || 0) + 1);
  let list = onSale().filter(c => !q || c.name.toLowerCase().includes(q));
  const S = { new: (x, y) => y.sort - x.sort || 0, asc: (x, y) => x.price - y.price, desc: (x, y) => y.price - x.price, vlo: (x, y) => caseVol(x) - caseVol(y), vhi: (x, y) => caseVol(y) - caseVol(x) };
  if (PK.sort === 'new') list = list.slice().reverse(); else list = list.slice().sort(S[PK.sort]);
  $('pkGrid').innerHTML = list.length ? list.map(c => `<button class="pkc ${counts[c.id] ? 'sel' : ''}" data-add="${c.id}" aria-label="Add ${esc(c.name)}${counts[c.id] ? ', '+counts[c.id]+' selected' : ''}">${counts[c.id] ? `<span class="cnt">${counts[c.id]}</span>` : ''}<span class="art">${cpic(c)}</span><b>${esc(c.name)}</b><span class="pp">${cv(c.price)}</span>${volBar(c)}</button>`).join('') : '<div class="lbempty" style="grid-column:1/-1">No cases match.</div>';
  const cost = PK.sel.reduce((s, id) => s + caseById(id).price, 0);
  $('pkCount').innerHTML = `${PK.sel.length} Case${PK.sel.length === 1 ? '' : 's'} - ${cv(cost)}`;
  $('pkAdd').disabled = !PK.sel.length;
  document.querySelectorAll('#pkSortMenu [data-sort]').forEach(b => b.classList.toggle('on', b.dataset.sort === PK.sort));
}
/* borrow slider panel, used when creating and when joining */
function borrowPanel(el, cost, pct, onChange, price = quote) {
  const cv = v => catalogMoney(v,price);
  const pay = Math.ceil(cost * (100 - pct) / 100);
  el.innerHTML = `<div><h4>Borrow Tokens</h4><input type="range" min="1" max="90" value="${pct}" style="--p:${((pct - 1) / 89 * 100).toFixed(1)}%" aria-label="Borrow percentage"><div class="bwq">${[1, 20, 40, 60].map(v => `<button data-bq="${v}" class="${pct === v ? 'on' : ''}">${v}%</button>`).join('')}<button data-bq="90" class="${pct === 90 ? 'on' : ''}">MAX</button></div></div>
    <div class="bwr"><div>Battle cost:<b>${cv(cost)}</b></div><div>Borrow amount:<span class="ac">${pct}% → ${cv(cost - pay)}</span></div><hr><div class="big">You pay:<span>${cv(pay)}</span></div><div>You receive on win:<b>${100 - pct}%</b></div></div>`;
  el.querySelector('input').oninput = e => onChange(+e.target.value);
  el.querySelectorAll('[data-bq]').forEach(b => b.onclick = () => onChange(+b.dataset.bq));
}
let BW = null;
function openBorrowJoin(id, seat) {
  if (!requireAuth()) return; const b = BT[id]; if (!b) return;
  BW = { id, seat, pct: 20 }; $('borrowModal').hidden = false;
  const draw = () => borrowPanel($('bwPanel'), b.cost, BW.pct, v => { BW.pct = v; draw(); }, b); draw();
}
$('borrowModal').onclick = e => { if (e.target === $('borrowModal') || e.target.closest('[data-bwclose]')) $('borrowModal').hidden = true; };
$('bwJoin').onclick = () => { if (!BW) return; $('borrowModal').hidden = true; joinSeat(BW.id, BW.seat, BW.pct); };
const vcard = (it,price) => it.dice ? `<div class="vc dice" style="--rc:${RC.legendary}"><span class="art">${DICE_ART}</span></div>`
  : `<div class="vc ${it.top ? 'tp' : ''}" style="--rc:${RC[it.r]}"><span class="art">${pic(it)}</span><span>${esc(it.n)}</span>${catalogMoney(it.v,price)}</div>`;
/* battle reel: lands the item, or the gold dice → flare → respin between the top pulls */
function vspin(reel, c, winner, dur, price) {
  const token = reel.dataset.spin = String(Math.random()), box = reel.parentElement;
  box.classList.remove('goldmode', 'flaring');reel.style.visibility='';
  if(navigationMotion.matches)return vroll(reel,()=>shown(pick(c)),winner,dur,token,price);
  if (!winner.top) return vroll(reel, () => shown(pick(c)), winner, dur, token, price);
  if (dur <= 0) { box.classList.add('goldmode'); vroll(reel, () => pickTop(c), winner, 0, token, price); reel.children[30].classList.add('jack'); return; }
  const d2 = Math.min(TOP_SPIN, dur), d1 = dur - d2 - FLARE_MS;
  const respin = () => { if (reel.dataset.spin !== token) return; box.classList.add('goldmode'); vroll(reel, () => pickTop(c), winner, d2, token, price); setTimeout(() => { if (reel.dataset.spin === token) reel.children[30].classList.add('jack'); }, d2); };
  if (d1 < 900) return respin();
  vroll(reel, () => shown(pick(c)), DICE, d1, token, price);
  setTimeout(() => { if (reel.dataset.spin !== token) return; flare(reel.children[30], box, FLARE_MS); setTimeout(respin, FLARE_MS); }, d1);
}
function vroll(reel, fill, winner, dur, token, price) {
  if (reel.id === 'vr0' && dur > 0 && !navigationMotion.matches) SFX.spin(dur - 450);
  const N = 36, W = 30; let h = ''; for (let i = 0; i < N; i++) h += vcard(i === W ? winner : fill(),price); reel.innerHTML = h;
  reel.style.transition = 'none'; reel.style.transform = 'translateY(0)'; void reel.offsetHeight;
  const H = reel.parentElement.clientHeight, y0 = 10 + W * PITCH + 65 - H / 2, card = reel.children[W];
  if (dur <= 0) { reel.style.transform = `translateY(${-y0}px)`; card.classList.add('won'); return; }
  if(navigationMotion.matches){
    // Keep shared battle reveal times while omitting the travelling reel.
    reel.style.visibility='hidden';
    setTimeout(()=>{if(reel.dataset.spin!==token)return;reel.style.visibility='';reel.style.transform=`translateY(${-y0}px)`;card.classList.add('won');},dur);
    return;
  }
  const run = Math.max(300, dur - 450), off = (Math.random() < .5 ? -1 : 1) * (18 + Math.random() * 34);
  reel.style.transition = `transform ${run}ms cubic-bezier(.12,.8,.18,1)`; reel.style.transform = `translateY(${-(y0 + off)}px)`;
  setTimeout(() => { if (reel.dataset.spin !== token) return; reel.style.transition = 'transform .42s cubic-bezier(.3,1.35,.5,1)'; reel.style.transform = `translateY(${-y0}px)`; card.classList.add('won'); }, run + 40);
}
function idleV(reel, c, price) { reel.style.transition = 'none'; reel.parentElement.classList.remove('goldmode'); const s = reelSet(c); reel.innerHTML = s.concat(s, s).map(it=>vcard(it,price)).join(''); const H = reel.parentElement.clientHeight; reel.style.transform = `translateY(${-(10 + PITCH + 65 - H / 2)}px)`; }
function openBattle(id, join) {
  const b = BT[id]; if (!b) return;
  nav('battles'); showB('bView'); vs = { id, spinning: -1, sig: '' };
  const teams = MODES[b.mode], n = b.seats.length, tStart = new Set(teams.slice(1).map(t => t[0])), tEnd = new Set(teams.map(t => t[t.length - 1]));
  const teamOf = i => teams.findIndex(t => t.includes(i));
  $('vMode').innerHTML = esc(MODE_NAME[b.mode]) + modeTags(b);
  const g = $('vGrid'); g.style.setProperty('--n', n);
  let h = `<div class="ccol" id="vCases">${b.cases.map((c, r) => `<div class="cc" id="cc${r}" title="${esc(c.name)}">${cpic(c)}</div>`).join('')}</div>`;
  h += b.seats.map((_, i) => `<div class="seat ${tStart.has(i) ? 'tb' : ''} ${i === n - 1 ? 'last' : ''}" id="seat${i}">${tStart.has(i) ? `<span class="xs">${IC.swords}</span>` : ''}<div class="vbox"><div class="vreel" id="vr${i}"></div></div><div class="wait" id="wt${i}"></div></div>`).join('');
  h += '<div class="gsp"></div>' + b.seats.map((_, i) => `<div class="pc t${teamOf(i)} ${i === 0 ? 'first' : ''} ${tStart.has(i) ? 'tb' : ''} ${tEnd.has(i) ? 'te' : ''}" id="pc${i}"></div>`).join('');
  h += '<div class="gsp"></div>' + b.seats.map((_, i) => `<div class="rd ${tStart.has(i) ? 'tb' : ''}" id="rd${i}"></div>`).join('');
  g.innerHTML = h;
  b.seats.forEach((_, i) => idleV($('vr' + i), b.cases[0],b));
  tickView(true);
  if (join) { const i = b.seats.indexOf(null); if (i >= 0) joinSeat(id, i); }
}
/* jackpot: a striped bar (one colour per side, sized by chance) spins to the server's roll */
function renderJackpot(b, p) {
  const cv = v => catalogMoney(v,b);
  const el = $('vJack'), show = b.jackpot && b.jp && (p.ph === 'jackpot' || p.ph === 'done');
  el.hidden = !show; if (!show) return;
  const teams = MODES[b.mode], tot = totals(b, b.cases.length), tt = teams.map(t => t.reduce((s, i) => s + tot[i], 0)), pot = tt.reduce((x, y) => x + y, 0);
  const ch = tt.map(x => !pot ? 1 / teams.length : b.crazy ? (pot - x) / (pot * (teams.length - 1)) : x / pot), wt = b.jp.team, roll = Number(b.jp.roll);
  if (!vs.jp) {
    const W = el.clientWidth || 900, S = Math.max(W * 1.1, 760), R = 9;
    const seg = teams.map((t, k) => `<div class="jseg" style="--tc:${TEAM_COL[k % 4]};width:${Math.max(0, ch[k] * S - 4)}px">${ch[k] * S > 60 ? t.map(i => b.seats[i] ? avatar(b.seats[i]) : '').join('') : ''}${ch[k] * S > 150 ? `<span>${(ch[k] * 100).toFixed(2)}%</span>` : ''}</div>`).join('');
    el.innerHTML = `<h3>JACKPOT MODE</h3><div class="pot">${cv(pot)}</div><div class="jtrack"><div class="jstrip" id="jStrip">${seg.repeat(R)}</div></div><div class="jres" id="jRes"></div>`;
    vs.jp = { W, S, x: W / 2 - (6 * S + roll * S) };
    const strip = $('jStrip'), start = W / 2 - S * 0.5, elapsed = p.ph === 'jackpot' ? JP_MS - p.jpLeft : JP_MS;
    if(navigationMotion.matches&&p.ph!=='done')strip.style.transform=`translateX(${start}px)`;
    else if (elapsed < JP_SPIN - 300) {
      strip.style.transform = `translateX(${start}px)`; void strip.offsetWidth;
      strip.style.transition = `transform ${JP_SPIN - elapsed}ms cubic-bezier(.1,.7,.1,1)`; strip.style.transform = `translateX(${vs.jp.x}px)`;
    } else strip.style.transform = `translateX(${vs.jp.x}px)`;
  }
  if(navigationMotion.matches&&p.ph==='done'){$('jStrip').style.transition='none';$('jStrip').style.transform=`translateX(${vs.jp.x}px)`;}
  const res = $('jRes');
  if (p.ph === 'done' && !res.innerHTML) {
    const ws = teams[wt].filter(i => b.seats[i]);
    res.innerHTML = `<span class="lbl2">Battle complete</span><div class="jwho">${ws.map(i => avatar(b.seats[i])).join('')}</div><span><b class="wn"></b> won with a <em>${(ch[wt] * 100).toFixed(2)}%</em> chance</span>`;
    res.querySelector('.wn').textContent = ws.map(i => nameOf(b.seats[i])).join(' & ');
  }
}
function confetti(big) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas'); c.className = 'confetti'; document.body.appendChild(c);
  const ctx = c.getContext('2d'), dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  c.width = W * dpr; c.height = H * dpr; ctx.scale(dpr, dpr);
  const cols = ['#f7c948', '#3ee8a8', '#5b8cff', '#a66bff', '#ff4d6a', '#ffffff'], P = [], per = big ? 130 : 50;
  [[0.04, -Math.PI / 3], [0.96, -2 * Math.PI / 3]].forEach(([sx, ang]) => { for (let i = 0; i < per; i++) { const a = ang + (Math.random() - .5) * .9, v = 12 + Math.random() * 12; P.push({ x: W * sx, y: H * .98, vx: Math.cos(a) * v, vy: Math.sin(a) * v, w: 6 + Math.random() * 6, h: 9 + Math.random() * 9, r: Math.random() * 6, vr: (Math.random() - .5) * .35, c: cols[i % cols.length] }); } });
  const t0 = performance.now();
  (function f(now) {
    const t = now - t0; ctx.clearRect(0, 0, W, H);
    for (const p of P) { p.vy += .32; p.vx *= .985; p.vy *= .985; p.x += p.vx; p.y += p.vy; p.r += p.vr; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - 2200) / 1400); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, Math.max(1, p.h * Math.abs(Math.cos(p.r * 1.7)))); ctx.restore(); }
    if (t < 3600) requestAnimationFrame(f); else c.remove();
  })(t0);
}
function tickView(force) {
  if (!vs) return;
  const b = BT[vs.id]; const cv = v => catalogMoney(v,b), cvS = (v,positive) => catalogMoney(v,b,positive); if (!b) { showB('bLobby'); return; }
  const now = Date.now(), p = prog(b, now), n = b.cases.length;
  $('vGrid').dataset.phase=p.ph;
  const want = p.spinning >= 0 ? p.spinning : p.revealed - 1;
  if (want >= 0 && vs.spinning !== want) {
    vs.spinning = want;
    const left = p.spinning >= 0 ? b.startedAt + b.rs[want] + SPIN_MS + b.bonus[want] - now : 0;
    b.seats.forEach((_, i) => { const it = b.results[i][want], l = it.top ? left : left - b.bonus[want]; vspin($('vr' + i), b.cases[want], it, l > 500 ? l : 0,b); });
  }
  if (vs.ph && vs.ph !== 'done' && p.ph === 'done') { const w0 = winners(b), mi = b.seats.indexOf(ME()); confetti(mi < 0 || w0.seats.includes(mi)); }
  vs.ph = p.ph;
  renderJackpot(b, p);
  const sig = [p.ph, p.revealed, p.spinning, p.count, b.seats.join(), busy, namesVer, me ? me.id : ''].join('|');
  if (!force && sig === vs.sig) return; vs.sig = sig;
  const mine = b.seats.includes(ME()), filled = b.seats.filter(Boolean).length, isCreator = me && b.creator === me.id;
  const cur = p.ph === 'open' || p.ph === 'starting' ? 0 : p.spinning >= 0 ? p.spinning : Math.min(p.revealed, n - 1);
  const shown = p.ph === 'done' ? n : p.ph === 'open' || p.ph === 'starting' ? 0 : p.spinning >= 0 ? p.spinning + 1 : p.revealed;
  $('vRoundsTop').textContent = `Rounds ${shown}/${n}`;
  $('vCost').innerHTML = cv(b.cost,b);
  const cc = b.cases[cur];
  $('vCase').innerHTML = `<span class="art">${cpic(cc)}</span><div><b>${esc(cc.name)}</b>${cv(cc.price)}</div>`;
  b.cases.forEach((_, r) => { $('cc' + r).className = 'cc' + (p.ph !== 'done' && r === cur ? ' on' : '') + (r < p.revealed && !(p.ph !== 'done' && r === cur) ? ' done' : ''); });
  const col = $('vCases'), on = $('cc' + cur); if (on) col.scrollTop = on.offsetTop - col.clientHeight / 2 + on.offsetHeight / 2;
  const t = totals(b, p.revealed), w = p.ph === 'done' ? winners(b) : null;
  let stat;
  if (p.ph === 'open') stat = `Waiting for players <b>${filled}/${b.seats.length}</b>`;
  else if (p.ph === 'starting') stat = `Starting in <b>${p.count}</b>`;
  else if (p.ph === 'rolling') stat = `Rolling round <b>${shown}</b>`;
  else if (p.ph === 'cancelled') stat = 'Cancelled';
  else if (p.ph === 'jackpot') stat = 'Jackpot spin…';
  else if (mine) { const mi = b.seats.indexOf(ME()), won = w.seats.includes(mi); stat = `<span class="bvstat ${won ? 'win' : 'lose'}">${won ? (isGroup(b.mode) ? 'Your share ' : 'You won ') + cv(b.payouts[mi]) : 'You lost'}</span>`; }
  else stat = `Finished · pot ${cv(w.pot)}`;
  $('vStat').innerHTML = stat;
  $('vFair').innerHTML = b.pfHash ? `<span>Seed hash <code>${esc(b.pfHash.slice(0, 16))}…</code></span>${b.pfSeed && p.ph === 'done' ? `<button class="pfbtn" data-vb="${esc(b.id)}">Verify battle</button>` : '<span class="mut">seed revealed when it ends</span>'}` : '';
  b.seats.forEach((s, i) => {
    const seat = $('seat' + i), won = w && w.seats.includes(i);
    seat.classList.toggle('rolling', p.ph === 'rolling' || p.ph === 'done' || p.ph === 'jackpot');
    seat.classList.toggle('win', !!won);
    let wh = '';
    if (p.ph === 'open' || p.ph === 'starting' || p.ph === 'cancelled') {
      if (s) wh = `${avatar(s, true)}<b class="nm"></b><span class="ok">${IC.check}${p.ph === 'starting' ? 'Starting…' : 'Ready'}</span>`;
      else {
        wh = '<span class="ring"></span><b>Waiting for players</b>';
        if (p.ph === 'open' && !mine) wh += `<button class="btn mint" data-join="${i}" ${busy ? 'disabled' : ''}>Join ${cv(b.cost,b)}</button><button class="btn dark sm" data-borrow="${i}" ${busy ? 'disabled' : ''} title="Pay less to enter, win less">Borrow</button>`;
        if (p.ph === 'open' && isCreator) wh += `<button class="btn dark" data-bot="${i}" ${busy ? 'disabled' : ''}>${IC.bot}Add bot</button>`;
      }
    }
    $('wt' + i).innerHTML = wh;
    const nm = $('wt' + i).querySelector('.nm'); if (nm) nm.textContent = nameOf(s);
    const pc = $('pc' + i);
    pc.classList.toggle('win', !!won); pc.classList.toggle('lose', !!(w && !won));
    if (s) { const amount=won ? b.payouts[i] : t[i]; pc.innerHTML = `${avatar(s)}<span class="pcm"><span class="nm" ${s.startsWith('bot:') ? '' : `data-uid="${esc(s)}"`}></span><span class="pcs">${s.startsWith('bot:') ? '<span class="lvl bt">BOT</span>' : lvlBadge(levelInfo(PW[s] || 0).level)}<span class="tt">${cvS(amount,won)}</span></span></span>`; pc.querySelector('.nm').textContent = nameOf(s); pc.title = nameOf(s) + ': ' + fmtMinor(BigInt(amount)*BigInt(b.unit),b.asset_id) + ' ' + ccySym(b.asset_id); }
    else pc.innerHTML = '<span class="wt">Waiting for player</span>';
    $('rd' + i).innerHTML = b.cases.map((c, r) => { if (b.results && r < p.revealed) { const it = b.results[i][r]; return `<div class="rb got" style="--rc:${RC[it.r]}"><span class="art">${pic(it)}</span>${cv(it.v)}<em>Round ${r + 1}</em></div>`; } return `<div class="rb"><em>Round ${r + 1}</em></div>`; }).join('');
  });
  let ctl = '';
  if (p.ph === 'open' && isCreator) ctl = `<button class="btn dark" data-act="bots" ${busy ? 'disabled' : ''}>${IC.bot}Fill with bots</button><button class="btn dark" data-act="cancel" ${busy ? 'disabled' : ''}>Cancel &amp; refund</button>`;
  else if (p.ph === 'done') ctl = `<button class="btn gold" data-act="new">${IC.plus}New battle</button>`;
  $('vCtl').innerHTML = ctl;
}
$('bNew').onclick = () => { if (!requireAuth()) return; showB('bCreate'); renderCreate(); };
$('bCreateBack').onclick = () => showB('bLobby');
$('bBack').onclick = () => showB('bLobby');
$('bMake').onclick = createBattle;
$('bList').onclick = e => { const u = e.target.closest('[data-uid]'); if (u) return openProfile(u.dataset.uid); if (e.target.closest('[data-create]')) return $('bNew').click(); const t = e.target.closest('[data-open]'); if (t) openBattle(t.dataset.open, !!t.dataset.join); };
$('bTabs').onclick = e => { const b = e.target.closest('[data-t]'); if (!b) return; LF.tab = b.dataset.t; document.querySelectorAll('#bTabs button').forEach(x => x.classList.toggle('on', x === b)); renderLobby(true); };
$('bAfford').onclick = () => { LF.afford = !LF.afford; $('bAfford').setAttribute('aria-pressed', LF.afford); renderLobby(true); };
$('bSort').onchange = e => { LF.sort = e.target.value; renderLobby(true); };
$('bCreate').onclick = e => {
  const m = e.target.closest('[data-mode]'), tg = e.target.closest('[data-tg]'), inc = e.target.closest('[data-inc]'), dec = e.target.closest('[data-dec]');
  if (e.target.closest('[data-pick]')) return openPicker();
  if (m) draft.mode = m.dataset.mode;
  else if (tg) {
    const k = tg.dataset.tg; if (isGroup(draft.mode) && k !== 'borrow') return toast('Group Unbox splits everything, so Crazy and Jackpot don’t apply');
    if (k === 'borrow') draft.borrow = draft.borrow ? 0 : 20; else draft[k] = !draft[k];
  }
  else if (inc) { if (draft.cases.length >= MAX_ROUNDS) return toast(`That’s the ${MAX_ROUNDS}-round maximum`); draft.cases.splice(draft.cases.lastIndexOf(inc.dataset.inc) + 1, 0, inc.dataset.inc); }
  else if (dec) draft.cases.splice(draft.cases.lastIndexOf(dec.dataset.dec), 1);
  else return;
  renderCreate();
};
$('pickModal').onclick = e => {
  if (e.target === $('pickModal') || e.target.closest('[data-pkcancel]')) { $('pickModal').hidden = true; return; }
  const sb2 = e.target.closest('#pkSortBtn'); if (sb2) { const m = $('pkSortMenu'); m.hidden = !m.hidden; sb2.setAttribute('aria-expanded', !m.hidden); return; }
  const so = e.target.closest('[data-sort]'); if (so) { PK.sort = so.dataset.sort; $('pkSortLbl').textContent = so.textContent; $('pkSortMenu').hidden = true; $('pkSortBtn').setAttribute('aria-expanded', false); renderPicker(); return; }
  if (!e.target.closest('.pksort')) { $('pkSortMenu').hidden = true; $('pkSortBtn').setAttribute('aria-expanded', false); }
  const a2 = e.target.closest('[data-add]'); if (!a2) return;
  if (draft.cases.length + PK.sel.length >= MAX_ROUNDS) return toast(`That’s the ${MAX_ROUNDS}-round maximum`);
  PK.sel.push(a2.dataset.add); renderPicker();
};
$('pkAdd').onclick = () => { draft.cases.push(...PK.sel); PK.sel = []; $('pickModal').hidden = true; renderCreate(); };
$('pkQ').oninput = renderPicker;
$('bView').onclick = e => {
  if (!vs) return;
  const u = e.target.closest('[data-uid]'); if (u) return openProfile(u.dataset.uid);
  const vb = e.target.closest('[data-vb]'); if (vb) return verifyBattle(vb.dataset.vb);
  const j = e.target.closest('[data-join]'), bt = e.target.closest('[data-bot]'), a = e.target.closest('[data-act]');
  const bw = e.target.closest('[data-borrow]'); if (bw) return openBorrowJoin(vs.id, +bw.dataset.borrow);
  if (j) joinSeat(vs.id, +j.dataset.join);
  else if (bt) addBots(vs.id, +bt.dataset.bot);
  else if (a && a.dataset.act === 'bots') addBots(vs.id);
  else if (a && a.dataset.act === 'cancel') cancelBattle(vs.id);
  else if (a && a.dataset.act === 'new') { const b = BT[vs.id]; draft = { mode: b.mode, cases: b.cases.filter(c => c.active).map(c => c.id), crazy: b.crazy, jackpot: b.jackpot, borrow: 0 }; showB('bCreate'); renderCreate(); }
};
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (vs) openBattle(vs.id); }, 300); });
async function loadBattles() {
  const asset=window.ebCurrency(); if(!asset) return;
  const account=me?.id;
  try {
    const d=await api((account?'/api/me/battles/':'/api/battles/')+encodeURIComponent(asset));
    if(asset!==window.ebCurrency() || me?.id!==account) return;
    d.battles.forEach(ingest);
    void resolveNames(d.battles.flatMap(b=>b.seats.filter(Boolean)));
    $('bNote').textContent='Entry and payout use the currency and price fixed when the battle opens.';
    renderLobby(true);
  } catch { $('bNote').textContent='Could not refresh battles.'; }
}
setInterval(() => { tickView(false); if (!$('bLobby').hidden) renderLobby(false); }, 250);
setInterval(settleSeen, 1000);

/* ---------- live chat ---------- */
let msgs = [];
const hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function renderChat() {
  const box = $('msgs'), near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (!msgs.length) { box.innerHTML = '<div class="chat-empty">No messages yet. Say hi!</div>'; return; }
  box.innerHTML = msgs.map((m, i) => `<div class="msg ${me && m.user_id === me.id ? 'mine' : ''}" data-i="${i}"><span class="av bacon" data-uid="${esc(m.user_id)}" title="View profile">${BACON}</span><div><div class="who"><span class="n" data-uid="${esc(m.user_id)}"></span>${lvlBadge(levelInfo(PW[m.user_id] || 0).level)}<time>${hhmm(m.created_at)}</time>${me && me.admin ? `<button class="del" data-del="${m.id}" title="Delete message" aria-label="Delete message">✕</button>` : ''}</div><div class="bub"></div></div></div>`).join('');
  box.querySelectorAll('.msg').forEach(el => { const m = msgs[+el.dataset.i]; const n = el.querySelector('.n'); n.textContent = PN[m.user_id] || m.username; if (me && m.user_id === me.id) n.classList.add('me'); el.querySelector('.bub').textContent = m.body; });
  if (near || (me && msgs[msgs.length - 1].user_id === me.id)) box.scrollTop = box.scrollHeight;
}
function renderChatInput() {
  $('chatIn').placeholder = me ? 'Type message…' : 'Sign in to chat';
  $('chatIn').readOnly = !me; $('chatSend').disabled = !me;
}
$('chatIn').onfocus = () => { if (!me) openAuth('signup'); };
let lastSend = 0;
$('chatForm').onsubmit = async e => {
  e.preventDefault();
  if (!requireAuth()) return;
  const t = $('chatIn').value.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!t) return;
  const wait = 3000 - (Date.now() - lastSend);
  if (wait > 0) return toast(`Slowmode: wait ${Math.ceil(wait / 1000)}s`);
  lastSend = Date.now(); $('chatIn').value = '';
  try { await api('/api/chat','POST',{body:t}); await loadChat(); } catch (err) { $('chatIn').value = t; toast(esc(niceErr(err)), 'lose'); }
};
$('msgs').onclick = async e => {
  const d = e.target.closest('[data-del]');
  if (d) { try { await api('/api/chat/'+encodeURIComponent(d.dataset.del),'DELETE'); msgs = msgs.filter(m => m.id !== +d.dataset.del); renderChat(); } catch (err) { toast(esc(niceErr(err)), 'lose'); } return; }
  const u = e.target.closest('[data-uid]'); if (u) openProfile(u.dataset.uid);
};
$('chatRules').onclick = () => toast('Be kind, no spam, no personal info, and never share passwords or trade real money.');
$('chatOpen').onclick = () => {window.ebLeaveAccount?.();$('chat').classList.add('open');};
$('chatClose').onclick = () => $('chat').classList.remove('open');
async function loadChat() {
  try { msgs=(await api('/api/chat')).messages; msgs.forEach(m=>PN[m.user_id]=m.username);renderChat(); }
  catch { if (!msgs.length) $('msgs').textContent='Chat is temporarily unavailable.'; }
}

/* ---------- upgrader ---------- */
const TIER = v => v >= 20e6 ? 'legendary' : v >= 2e6 ? 'epic' : v >= 2e5 ? 'rare' : v >= 2e4 ? 'uncommon' : 'common';
function guessArt(name, r) {
  const c = RC[r], n = name.toLowerCase();
  if (/dominus/.test(n)) return ART.hood(c, '#f7c948', '#9be7ff');
  if (/valk|helm|viking|centurion|knightmare|warhelm/.test(n)) return ART.helm(c, /valk/.test(n) ? '#e5e9f2' : '');
  if (/fedora|sombrero|beret|capotain|cap\b|witch hat/.test(n)) return ART.fedora(c, '#20232b', /sparkle/.test(n) ? '#fff' : '');
  if (/top hat|hat\b/.test(n)) return ART.tophat(c, '#f7c948');
  if (/headphones/.test(n)) return ART.phones(c, '#3a2a14');
  if (/shades|glasses|eyes|visor|goggles|spectacles|oculus|stunnas|gaze/.test(n)) return ART.shades('#15172a', c);
  if (/horns|antlers/.test(n)) return ART.horns(c, '#ffc13c');
  if (/face|smile|grin|happy/.test(n)) return ART.face(c === RC.common ? '#ffd23f' : c);
  if (/pumpkin/.test(n)) return ART.pumpkin('#ff8a1f');
  if (/vamp/.test(n)) return ART.vampire();
  if (/head|cone|bucket/.test(n)) return ART.bighead(c);
  return ART.crown(c, '#fff');
}
let UPI = [], uSel = null, uShow = 70, uSpinning = false, uRot = 0;
const U = { mode: 'manual', over: false, running: false };
function loadUpgradeItems(data) {
  UPI = (data || []).map(x => { const v = Number(x.value), r = TIER(v); return { id: Number(x.id), n: x.name, v, r, art: guessArt(x.name, r), img: null }; });
  renderUGrid(); renderUpg(); thumbsFor(UPI).then(() => { renderUGrid(); renderUpg(); });
}
async function thumbsFor(list) {
  const ids = [...new Set(list.filter(i => i.id > 0 && !i.img).map(i => i.id))];
  for (let k = 0; k < ids.length; k += 100) {
    try {
      const j = await (await fetch(`https://thumbnails.roproxy.com/v1/assets?assetIds=${ids.slice(k, k + 100).join(',')}&size=150x150&format=Png&isCircular=false`)).json();
      (j.data || []).forEach(d => { if (d.state === 'Completed' && /^https:\/\//.test(d.imageUrl)) list.filter(i => i.id === d.targetId).forEach(i => i.img = d.imageUrl); });
    } catch (e) { return; }
  }
}
const uBet = () => quote ? Number(minorInput($('uBet').value) || 0n) / Number(quote.unit) : 0;
const uChance = () => uSel && uBet() > 0 && uBet() < uSel.v ? Math.min(80, uBet() / uSel.v * 95) : 0;
function uFiltered() {
  const q = $('uSearch').value.trim().toLowerCase(), mn = +$('uMin').value || 0, mx = +$('uMax').value || Infinity;
  const l = UPI.filter(i => (!q || i.n.toLowerCase().includes(q)) && i.v >= mn && i.v <= mx);
  return $('uSort').value === 'asc' ? l.slice().sort((a, b) => a.v - b.v) : l;
}
function renderUGrid() {
  if (!UPI.length) return;
  const l = uFiltered(), b = uBet();
  $('uGrid').innerHTML = l.length ? l.slice(0, uShow).map(i => `<button class="ucard ${uSel && uSel.id === i.id ? 'sel' : ''} ${i.v <= b ? 'too' : ''}" data-u="${i.id}" aria-pressed="${!!uSel && uSel.id === i.id}" style="--rc:${RC[i.r]}"><span class="tag">${i.r}</span><span class="art">${pic(i)}</span><b>${esc(i.n)}</b>${cv(i.v)}</button>`).join('')
    : '<div class="loading">No items match. Try a different search or price range.</div>';
  $('uMore').hidden = l.length <= uShow;
}
function renderUpg(result) {
  const ch = uChance(), C = 2 * Math.PI * 178;
  $('uWheel').setAttribute('aria-busy',uSpinning);
  document.querySelectorAll('#uMode button,#uDir button,#uMult button').forEach(b=>b.setAttribute('aria-pressed',b.classList.contains('on')));
  $('uArc').setAttribute('stroke-dasharray', `${C * ch / 100} ${C}`);
  $('uArc').setAttribute('transform', `rotate(${-90 + (U.over ? 360 * (1 - ch / 100) : 0)} 200 200)`);
  if (!result) {
    $('uWheel').classList.remove('win', 'lose');
    $('uPct').textContent = ch ? (ch < 0.01 ? ch.toFixed(4) : ch.toFixed(2)) + '%' : '0.00%';
    $('uLab').textContent = 'Upgrade chance';
    const lo = U.over ? (100 - ch) : 0, hi = U.over ? 99.9999 : Math.max(0, ch - 0.0001);
    $('uRng').innerHTML = !uSel ? 'Pick an item below' : uBet() >= uSel.v ? 'Pick an item worth more than your bet' : `<em>ROLL</em> ${lo.toFixed(4)} to ${hi.toFixed(4)} <em>TO WIN</em>`;
  }
  $('uStatChance').textContent = ch ? ch.toFixed(4) + '%' : '0%';
  $('uFlow').innerHTML = `<span class="fb"><small>Your bet</small>${esc(currencyText(minorInput($('uBet').value) || 0n))}</span><span class="fa">${IC.chev}</span><span class="fb t"><small>${uSel ? 'You could win' : 'Pick an item'}</small>${uSel ? cv(uSel.v) : cv(0)}</span>`;
  $('uStatPay').innerHTML = uSel ? cv(uSel.v) : cv(0);
  const t = $('uTarget');
  if (!uSel) t.innerHTML = '<div class="h">Select an item to upgrade</div><div class="empty-t">Pick a limited from the list below.<br>The pricier the item, the lower your chance.</div><div></div>';
  else {
    const m = uBet() ? uSel.v / uBet() : 0;
    t.innerHTML = `<button class="x" id="uClear" aria-label="Clear item">✕</button><div class="h">Upgrading to</div><span class="tart" style="--rc:${RC[uSel.r]}"><span class="rar">${uSel.r}</span>${pic(uSel)}</span><div class="tn"></div><div class="tv">${cv(uSel.v)}</div><div class="tpills"><span>Multiplier<b>${m ? m.toFixed(2) + '×' : '0.00×'}</b></span><span>Chance<b>${ch ? ch.toFixed(2) + '%' : '0%'}</b></span></div>`;
    t.querySelector('.tn').textContent = uSel.n;
    $('uClear').onclick = () => { if (uSpinning || U.running) return; uSel = null; renderUpg(); renderUGrid(); };
  }
  const p = $('uPlay');
  if (U.mode === 'auto') { p.className = 'btn big ' + (U.running ? 'redb' : 'gold'); p.textContent = U.running ? 'Stop autobet' : 'Start autobet'; p.disabled = false; }
  else { p.className = 'btn big gold'; p.textContent = uSpinning ? 'Rolling…' : 'Play'; p.disabled = uSpinning; }
  const lock = uSpinning || U.running;
  ['uBet', 'uCustom', 'uCount'].forEach(id => $(id).disabled = lock);
  document.querySelectorAll('#uMult button,#uDir button,#uMode button,[data-ub]').forEach(b => b.disabled = lock);
}
function pickForMult(m) {
  const b = uBet(); if (!b) return toast('Enter a bet amount first', 'lose');
  const want = b * m, l = UPI.slice().sort((x, y) => x.v - y.v);
  uSel = l.find(i => i.v >= want) || l[l.length - 1];
  renderUpg(); renderUGrid();
}
async function upgradeOnce(spinMs) {
  const b = uBet();
  if (!uSel) { toast('Pick an item to upgrade to', 'lose'); return false; }
  if (!(b > 0)) { toast('Enter a bet amount', 'lose'); return false; }
  if (b >= uSel.v) { toast('Pick an item worth more than your bet', 'lose'); return false; }
  if (!requireQuote()) return false;
  uSpinning = true; renderUpg();
  let r;
  try { r = await api('/api/games/instant','POST',{...pricedBet(),game:'upgrader',bet:$('uBet').value,item:uSel.id,over:U.over}); }
  catch (e) { uSpinning = false; renderUpg(); toast(esc(niceErr(e)), 'lose'); return false; }
  void window.ebWalletRefresh();
  const target = Number(r.roll) / 100 * 360, base = uRot - (uRot % 360);
  uRot = base + 360 * (spinMs > 3000 ? 7 : 4) + target;
  const ptr = $('uPtr');
  const reduced=navigationMotion.matches,duration=reduced&&U.mode!=='auto'?160:spinMs;
  ptr.style.transition=reduced?'none':`transform ${spinMs}ms cubic-bezier(.08,.6,.06,1)`;
  if(!reduced){SFX.upgrade(spinMs);$('uWheel').classList.add('spin');ptr.style.transform=`rotate(${uRot}deg)`;}
  $('uLab').textContent = 'Rolling…'; $('uRng').textContent = '';
  // Autobet retains its original cadence under either motion preference.
  await sleep(duration + 80);if(reduced)ptr.style.transform=`rotate(${uRot}deg)`;
  const w = $('uWheel'); w.classList.remove('spin'); w.classList.toggle('win', r.win); w.classList.toggle('lose', !r.win);
  if (r.win) { SFX.upWin(); } else SFX.upLose();
  if (r.win) confetti(r.chance < 25); else { w.classList.remove('shake'); void w.offsetWidth; w.classList.add('shake'); }
  $('uPct').textContent = Number(r.roll).toFixed(4); $('uLab').textContent = r.win ? 'You won!' : 'Not this time';
  $('uRng').innerHTML = r.win ? `+${cv(r.value)}` : `Needed ${U.over ? 'over ' + (100 - r.chance).toFixed(4) : 'under ' + Number(r.chance).toFixed(4)}`;
  if (r.win) toast(`Upgraded to <b>${esc(r.name)}</b>! +${cv(r.value)}`, 'win');
  uSpinning = false; renderUpg(true);
  return true;
}
$('uPlay').onclick = async () => {
  if (!requireAuth()) return;
  if (U.mode === 'auto') {
    if (U.running) { U.running = false; renderUpg(true); return; }
    let left = Math.max(0, Math.floor(+$('uCount').value || 0)); const inf = left === 0;
    U.running = true; renderUpg(true);
    while (U.running && (inf || left > 0)) { if (!await upgradeOnce(2800)) break; if (!inf) left--; await sleep(900); }
    U.running = false; renderUpg(true); return;
  }
  if (!uSpinning) upgradeOnce(6000);
};
$('uGrid').onclick = e => { const c = e.target.closest('[data-u]'); if (!c || uSpinning || U.running) return; uSel = UPI.find(i => i.id === +c.dataset.u); renderUpg(); renderUGrid(); $('pageScroll').scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}); };
$('uMore').onclick = () => { uShow += 70; renderUGrid(); };
['uSearch', 'uMin', 'uMax'].forEach(id => $(id).oninput = () => { uShow = 70; renderUGrid(); });
$('uSort').onchange = () => { uShow = 70; renderUGrid(); };
$('uBet').oninput = () => { renderUpg(); renderUGrid(); };
document.querySelectorAll('[data-ub]').forEach(b => b.onclick = () => { const el = $('uBet'); adjustStake(el,b.dataset.ub); renderUpg(); renderUGrid(); });
$('uMult').onclick = e => { const b = e.target.closest('[data-x]'); if (!b) return; document.querySelectorAll('#uMult button').forEach(x => x.classList.toggle('on', x === b)); const custom = b.dataset.x === 'custom'; $('uCustomRow').hidden = !custom; pickForMult(custom ? Math.max(1.2, +$('uCustom').value || 2) : +b.dataset.x); };
$('uCustom').oninput = () => { const m = +$('uCustom').value; if (m >= 1.2) pickForMult(m); };
$('uDir').onclick = e => { const b = e.target.closest('[data-d]'); if (!b) return; U.over = b.dataset.d === 'over'; document.querySelectorAll('#uDir button').forEach(x => x.classList.toggle('on', x === b)); renderUpg(); };
$('uMode').onclick = e => { const b = e.target.closest('[data-m]'); if (!b || U.running) return; U.mode = b.dataset.m; document.querySelectorAll('#uMode button').forEach(x => x.classList.toggle('on', x === b)); $('uAutoOpts').hidden = U.mode !== 'auto'; renderUpg(); };
/* tick marks around the wheel */
$('uTicks').innerHTML = Array.from({ length: 100 }, (_, k) => { const big = k % 10 === 0, r1 = big ? 152 : 156, r2 = 162, an = (k / 100) * 2 * Math.PI - Math.PI / 2; return `<line x1="${200 + r1 * Math.cos(an)}" y1="${200 + r1 * Math.sin(an)}" x2="${200 + r2 * Math.cos(an)}" y2="${200 + r2 * Math.sin(an)}" stroke="${big ? '#ffffff55' : '#ffffff1c'}" stroke-width="${big ? 2.4 : 1.4}"/>`; }).join('');
renderUpg();

/* ---------- blackjack (the server deals; the deck never reaches the browser) ---------- */
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], SUITS = ['♠', '♥', '♦', '♣'];
const BACK = '<span class="back"><img src="/assets/dice-gold.png" alt=""></span>';
const cardHTML = (c, cls = '') => c < 0 ? `<span class="pcard hidden ${cls}" data-c="-1">${BACK}<span class="face"></span></span>`
  : `<span class="pcard ${cls}" data-c="${c}"><span class="face ${[1, 2].includes(Math.floor(c / 13)) ? 'red' : ''}"><span class="r">${RANKS[c % 13]}</span><span class="s">${SUITS[Math.floor(c / 13)]}</span></span>${BACK}</span>`;
let BJ = null, bjBusy = false, bjShown = { dealer: 0, hands: [] }, bjAnim = 0;
const BJ_GAP = 170, BJ_DEAL = 420, BJ_FLIP = 360;
$('bjTable').style.setProperty('--bj-deal-ms',BJ_DEAL+'ms');
$('bjTable').style.setProperty('--bj-flip-ms',BJ_FLIP+'ms');
/* blackjack total of the cards a player can currently see */
function bjCount(cardsEl) {
  let t = 0, aces = 0;
  cardsEl.querySelectorAll('.pcard').forEach(p => { const c = +p.dataset.c; if (c < 0 || p.dataset.wait) return; const r = c % 13; if (r === 0) { aces++; t += 11; } else t += Math.min(10, r + 1); });
  while (t > 21 && aces) { t -= 10; aces--; }
  return t;
}
function bjShowTot(cardsEl) { const tot = cardsEl.querySelector('.bjtot'); if (tot) tot.textContent = cardsEl.querySelector('.pcard:not([data-wait])') ? bjCount(cardsEl) : ''; }
/* first deal goes player, dealer, player, dealer like a real table */
const bjOrder = c => { const inD = !!c.closest('#bjDealer'), k = [...c.parentElement.querySelectorAll('.pcard')].indexOf(c); return k < 2 && BJ && BJ.dealer.length + BJ.hands[0].cards.length === 4 ? k * 2 + (inD ? 1 : 0) : 10 + k + (inD ? 100 : 0); };
const RES_TXT = { win: 'Win', blackjack: 'Blackjack!', lose: 'Lose', bust: 'Bust', push: 'Push' };
function bjCards(box, cards, already) {
  const el = box.querySelector('.bjcards');
  const have = el.children.length;
  for (let i = have; i < cards.length; i++) el.insertAdjacentHTML('beforeend', cardHTML(cards[i], i >= already ? 'deal' : ''));
}
function bjRender(st, animateDealer) {
  BJ = st;
  const reduced=navigationMotion.matches;
  const hasGame = !!st, live = st && st.status !== 'done';
  $('bjCurrency').textContent = ccySym(live ? st.asset_id : undefined);
  $('bjTotal').textContent = currencyText(st ? st.hands.reduce((sum,h) => sum + BigInt(h.bet), BigInt(st.insurance)) : 0n, st?.asset_id);
  if (!st) { $('bjDealer').innerHTML = '<div class="bjempty">Dealer</div>'; $('bjHands').innerHTML = '<div class="bjempty">Place a bet and press Deal</div>'; }
  else {
    if (!$('bjDealer').querySelector('.bjcards')) $('bjDealer').innerHTML = '<div class="bjcards"><span class="bjtot" id="bjDTot"></span></div><div class="bjres"></div>';
    const dEl = $('bjDealer').querySelector('.bjcards');
    // dealer: first two slots, then extras
    const shownD = [...dEl.querySelectorAll('.pcard')]; var flipped = false;
    st.dealer.forEach((c, i) => {
      if (i < shownD.length) {
        if (c >= 0 && shownD[i].classList.contains('hidden')) {           // reveal the hole card
          const fresh = document.createElement('div'); fresh.innerHTML = cardHTML(c); const nc = fresh.firstChild;
          shownD[i].replaceWith(nc);
          if(!reduced){nc.classList.add('hidden','flip');nc.dataset.wait=1;SFX.flip();flipped=true;setTimeout(()=>{delete nc.dataset.wait;bjShowTot(dEl);},BJ_FLIP*.6);requestAnimationFrame(()=>requestAnimationFrame(()=>nc.classList.remove('hidden')));}
        }
      } else dEl.insertAdjacentHTML('beforeend', cardHTML(c, 'deal'));
    });
    
    const hb = $('bjHands');
    if (hb.children.length !== st.hands.length || hb.querySelector('.bjempty')) {
      hb.innerHTML = st.hands.map((_, i) => `<div class="bjhand" data-h="${i}"><div class="bjcards"><span class="bjtot"></span></div><div class="bjres"></div></div>`).join('');
      bjShown.hands = st.hands.map(() => 0);
    }
    st.hands.forEach((h, i) => {
      const box = hb.children[i];
      const cardsEl = box.querySelector('.bjcards'), cur = cardsEl.querySelectorAll('.pcard').length;
      if (cur > h.cards.length) { cardsEl.querySelectorAll('.pcard').forEach(x => x.remove()); }
      h.cards.forEach((c, k) => { if (k >= cardsEl.querySelectorAll('.pcard').length) cardsEl.insertAdjacentHTML('beforeend', cardHTML(c, 'deal')); });
      box.className = 'bjhand' + (live && st.hands.length > 1 && st.active === i + 1 ? ' active' : '') + (h.result ? ' res-' + h.result : '');
      const r = box.querySelector('.bjres');
      r.className = 'bjres ' + (h.result || ''); r.innerHTML = h.result ? RES_TXT[h.result] : (st.hands.length > 1 && live && st.active === i + 1 ? 'Your turn' : '');
    });
    // stagger newly dealt cards
    const fresh = [...document.querySelectorAll('#bjTable .pcard.deal:not([data-d])')], base = flipped ? BJ_FLIP : 0;
    if(reduced){fresh.forEach(c=>{c.classList.remove('deal');c.style.animationDelay='';delete c.dataset.wait;delete c.dataset.d;});bjAnim=0;}
    else{
      fresh.forEach(c => c.dataset.wait = 1);
      fresh.sort((x, y) => bjOrder(x) - bjOrder(y)).forEach((c, i) => { const delay=base+i*BJ_GAP;c.dataset.d=1;c.style.animationDelay=delay+'ms';
        const finish=()=>{c.classList.remove('deal');c.style.animationDelay='';delete c.dataset.d;};
        setTimeout(()=>SFX.card(),delay);
        setTimeout(()=>{delete c.dataset.wait;if(c.isConnected)bjShowTot(c.parentElement);},delay+BJ_DEAL*.7);
        c.addEventListener('animationend',finish,{once:true});setTimeout(finish,delay+BJ_DEAL+60);
      });
      bjAnim=fresh.length?base+(fresh.length-1)*BJ_GAP+BJ_DEAL:base;
    }
    document.querySelectorAll('#bjTable .bjcards').forEach(bjShowTot);
  }
  $('bjIns').hidden = !(st && st.status === 'insurance');
  if (st && st.status === 'insurance') $('bjInsTxt').innerHTML = `The dealer shows an ace. Insure for ${currencyText(BigInt(st.bet) / 2n, st.asset_id)}? It pays 2 to 1 if the dealer has blackjack.`;
  const playing = st && st.status === 'playing';
  $('bjHit').disabled = $('bjStand').disabled = !playing || bjBusy;
  $('bjDouble').disabled = !playing || bjBusy || !st.can_double;
  $('bjSplit').disabled = !playing || bjBusy || !st.can_split;
  $('bjDeal').disabled = bjBusy || !!live;
  $('bjDeal').textContent = live ? 'Hand in play' : hasGame ? 'Deal again' : 'Deal';
  ['bjBet'].forEach(id => $(id).disabled = !!live || bjBusy);
  document.querySelectorAll('[data-bb]').forEach(b => b.disabled = !!live || bjBusy);
}
function bjFinishMsg(st) {
  const total = st.hands.reduce((sum, h) => sum + BigInt(h.bet), BigInt(st.insurance)), net = BigInt(st.payout) - total;
  const res = st.hands.map(h => RES_TXT[h.result]).join(' · ');
  if (net > 0) { toast(`${res}: +${currencyText(net, st.asset_id)}`, 'win'); if (st.hands.some(h => h.result === 'blackjack')) confetti(false); }
  else if (net === 0n) toast(`${res}: your bet is back`);
  else toast(`${res}: ${currencyText(-net, st.asset_id)} lost`, 'lose');
}
async function bjSend(endpoint, args) {
  const owner = me?.id;
  if (bjBusy) return; bjBusy = true; bjRender(BJ);
  try {
    const st = await api('/api/games/blackjack/' + endpoint,'POST',args);
    if (owner !== me?.id) return;
    void window.ebWalletRefresh();
    // show the cards arriving first; results only once the last card lands
    const pre = st.status === 'done' ? { ...st, status: 'dealing', dealer_total: '', hands: st.hands.map(h => ({ ...h, result: null })) } : st;
    // mid-hand finish (bust, stand, double): show your new card first, then the dealer reveals
    if (st.status === 'done' && BJ && BJ.status && BJ.status !== 'done' && BJ.dealer && BJ.dealer.length) {
      bjAnim = 0; bjRender({ ...pre, dealer: BJ.dealer });
      await sleep(bjAnim + (navigationMotion.matches?0:240)); if (owner !== me?.id) return;
    }
    bjAnim = 0; bjRender(pre);
    await sleep(bjAnim + (navigationMotion.matches?0:150)); if (owner !== me?.id) return;
    bjBusy = false; bjRender(st);
    if (st.status === 'done') {
      await sleep(navigationMotion.matches?0:250);
      if (owner === me?.id) bjFinishMsg(st);
    }
  } catch (e) { bjBusy = false; bjRender(BJ); toast(esc(niceErr(e)), 'lose'); }
}
$('bjDeal').onclick = () => {
  if (!requireAuth()) return;
  const bet = $('bjBet').value.trim();
  if (!(minorInput(bet) > 0n)) return toast('Enter a valid bet in the selected currency', 'lose');
  $('bjDealer').innerHTML = ''; $('bjHands').innerHTML = ''; BJ = null;
  bjSend('start', { asset:window.ebCurrency(), bet, request:requestId() });
};
$('bjHit').onclick = () => BJ && bjSend('action', { id:BJ.id, version:BJ.version, action: 'hit' });
$('bjStand').onclick = () => BJ && bjSend('action', { id:BJ.id, version:BJ.version, action: 'stand' });
$('bjDouble').onclick = () => BJ && bjSend('action', { id:BJ.id, version:BJ.version, action: 'double' });
$('bjSplit').onclick = () => BJ && bjSend('action', { id:BJ.id, version:BJ.version, action: 'split' });
$('bjYesIns').onclick = () => BJ && bjSend('action', { id:BJ.id, version:BJ.version, action: 'insure' });
$('bjNoIns').onclick = () => BJ && bjSend('action', { id:BJ.id, version:BJ.version, action: 'no_insure' });
document.querySelectorAll('[data-bb]').forEach(b => b.onclick = () => { const el = $('bjBet'); adjustStake(el,b.dataset.bb); });
addEventListener('keydown', e => {
  if (document.querySelector('body.account-open,dialog[open],.modal:not([hidden])') || !$('blackjack').classList.contains('on') || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) return;
  const k = e.key.toLowerCase(), map = { h: 'bjHit', s: 'bjStand', d: 'bjDouble', p: 'bjSplit' };
  if (map[k] && !$(map[k]).disabled) $(map[k]).click();
});
async function resumeBj() { if (!me) return; try { const owner = me.id; const {round:st} = await api('/api/games/blackjack/active'); if (owner === me?.id && st) { $('bjDealer').innerHTML = ''; $('bjHands').innerHTML = ''; bjRender(st); } } catch (e) { } }
bjRender(null);
window.addEventListener('eb-currency', () => {
  updM(); $('bjCurrency').textContent = ccySym(BJ && BJ.status !== 'done' ? BJ.asset_id : undefined);
});

/* ---------- provably fair ---------- */
const FAIR_IC = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z" opacity=".9"/><path d="M8.5 12l2.4 2.4L15.8 9.6" stroke="#14161b" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PF_GAME = { cases: 'Cases', mines: 'Mines', upgrader: 'Upgrader', blackjack: 'Blackjack', rewards: 'Rewards', battles: 'Battles' };
let PF = { tab: 'seeds', state: null, bets: [], v: null };
async function pfFloats(seed, client, nonce, n) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const out = [];
  for (let c = 0; out.length < n; c++) {
    const h = new DataView(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${client}:${nonce}:${c}`)));
    for (let i=0;i<32 && out.length<n;i+=4) out.push(h.getUint32(i) / 4294967296);
  }
  return out;
}
async function fairShuffle(v, n) {
  const values = await pfFloats(v.seed, v.client, v.nonce, n);
  const order = Array.from({length:n}, (_,i) => i);
  for (let i=n-1; i>0; i--) {
    const j = Math.floor(values[n-1-i]*(i+1));
    [order[i],order[j]] = [order[j],order[i]];
  }
  return order;
}
async function sha256hex(t) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join(''); }
const pickW = (items, f) => { const tot = items.reduce((s, i) => s + i.w, 0), x = f * tot; let c = 0; for (const it of items.slice().sort((a, b) => a.idx - b.idx)) { c += it.w; if (c > x) return it; } return items[items.length - 1]; };
const cardName = c => RANKS[c % 13] + SUITS[Math.floor(c / 13)];
/* recompute a bet's result from its seeds, exactly like the server does */
async function pfVerify(v) {
  const hash = await sha256hex(v.seed);
  let out = `<div>Server seed hash: <span class="pfmono" style="display:inline;padding:2px 6px">${hash.slice(0, 16)}…</span>${v.hash ? (hash === v.hash ? ' <b>✓ matches</b>' : ' ✗ does not match') : ''}</div>`;
  if (v.game === 'cases') {
    const c = caseById(v.detail.case); if (!c) return out + '<div>Unknown case.</div>';
    const [f] = await pfFloats(v.seed, v.client, v.nonce, 1), it = pickW(c.items, f);
    out += `<div>Roll ${f.toFixed(8)} → <b>${esc(it.n)}</b> (${cv(it.v)}) from ${esc(c.name)}</div>`;
  } else if (v.game === 'rewards') {
    const p = PACKS.find(x => x.level === +v.detail.level); if (!p) return out;
    const [f] = await pfFloats(v.seed, v.client, v.nonce, 1), it = pickW(p.items, f);
    out += `<div>Roll ${f.toFixed(8)} → <b>${esc(it.n)}</b> from the level ${p.level} reward</div>`;
  } else if (v.game === 'upgrader') {
    const [f] = await pfFloats(v.seed, v.client, v.nonce, 1);
    out += `<div>Roll <b>${(Math.floor(f * 1000000) / 10000).toFixed(4)}</b> (0 to 99.9999)</div>`;
  } else if (v.game === 'mines') {
    const n=Number(v.detail.size), m=Number(v.detail.mines);
    if (![16,25,36,49,64].includes(n) || !Number.isInteger(m) || m<1 || m>=n) throw new Error('Invalid board');
    const mines = (await fairShuffle(v,n)).slice(0,m).map(t => t+1).sort((a,b)=>a-b);
    out += `<div>Mines on tiles <b>${mines.join(', ')}</b> (counting 1 to ${n}, left to right, top to bottom)</div>`;
  } else if (v.game === 'blackjack') {
    const shoe = (await fairShuffle(v,312)).map(c => c % 52);
    out += `<div>First cards from the shoe: <b>${shoe.slice(0, 10).map(cardName).join(' ')}</b></div><div class="mut small">Dealt in order: you, dealer, you, dealer, then hits.</div>`;
  } else if (v.game === 'battles') {
    const b = BT[v.battle]; if (!b) return out + '<div>Open the battle to verify it.</div>';
    const n = b.seats.length * b.cases.length + (b.jackpot ? 1 : 0), fl = await pfFloats(v.seed, v.client, 0, n);
    let k = 0, rows = '';
    b.seats.forEach((s, i) => { rows += `<div>${esc(nameOf(s))}: ${b.cases.map(c => esc(pickW(c.items, fl[k++]).n)).join(', ')}</div>`; });
    if (b.jackpot) rows += `<div>Jackpot roll <b>${fl[k].toFixed(8)}</b></div>`;
    out += rows;
  }
  return out;
}
function pfRender() {
  document.querySelectorAll('#fairModal .pftabs [data-pft]').forEach(b => b.classList.toggle('on', b.dataset.pft === PF.tab));
  const B = $('pfBody');
  if (PF.tab === 'how') {
    B.innerHTML = `<p class="pfnote">The active server seed hash commits to your next round. Each round uses a fresh seed, your client seed and its nonce. Completed rounds reveal the server seed in My bets.</p>
      <p class="pfnote">HMAC-SHA256 uses the server seed as the key and the message <code>client:nonce:cursor</code>. Each digest supplies eight unsigned 32-bit values. Dividing each by 2³² supplies the draws for a Fisher–Yates shuffle of the tiles or six-deck shoe.</p>`;
    return;
  }
  if (!me) { B.innerHTML = '<p class="pfnote">Sign in to see your seeds and bets.</p>'; return; }
  if (PF.tab === 'seeds') {
    const st = PF.state, cp = v => `<button class="pfcp" data-copy="${esc(v)}" title="Copy" aria-label="Copy"><svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><rect x=\"8\" y=\"8\" width=\"13\" height=\"13\" rx=\"3\"/><path d=\"M5 16H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/></svg></button>`;
    if (!st) { B.innerHTML = '<div class="loading">Loading…</div>'; return; }
    if (!PF.newClient) PF.newClient = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    B.innerHTML = `<div class="pfl">Active client seed</div><div class="pfv"><span>${esc(st.client)}</span>${cp(st.client)}</div>
      <div class="pfl">Active server seed (Hashed)</div><div class="pfv"><span>${esc(st.hash)}</span>${cp(st.hash)}</div>
      <div class="pfl">Nonce</div><div class="pfv"><span>${fmt(st.nonce)}</span>${cp(String(st.nonce))}</div>
      <div class="pfsep"></div>
      <div class="pfl">New client seed</div><div class="pfv edit"><input id="pfNew" value="${esc(PF.newClient)}" maxlength="64" aria-label="New client seed"></div>
      <div class="pfl">Next server seed (Hashed)</div><div class="pfv"><span>${esc(st.next_hash || '')}</span>${cp(st.next_hash || '')}</div>
      <button class="btn gold pfrot" id="pfRot">Rotate seed</button>
      ${PF.revealed ? `<div class="pfl" style="margin-top:16px">Previous server seed (revealed)</div><div class="pfv"><span>${esc(PF.revealed)}</span>${cp(PF.revealed)}</div>` : ''}
      <p class="pfwarn">Completed rounds reveal their seed in My bets. Rotating changes the seeds for your next game.</p>`;
    $('pfNew').oninput = e => PF.newClient = e.target.value;
    $('pfRot').onclick = async () => { try { const x = await api('/api/games/fair/rotate', 'POST', { client: $('pfNew').value.trim() }); PF.revealed = x.revealed; PF.newClient = ''; await pfLoad(); toast('Seed rotated. Your previous server seed is revealed'); } catch (e) { toast(esc(niceErr(e)), 'lose'); } };
  } else if (PF.tab === 'bets') {
    B.innerHTML = PF.bets.length ? `<div class="pfbets">${PF.bets.map((b, i) => `<div class="pfbet"><span>${PF_GAME[b.game] || b.game}${b.detail && b.detail.case ? ' · ' + esc((caseById(b.detail.case) || {}).name || '') : ''}</span><span class="mut">#${b.nonce}</span><span class="h" title="${esc(b.seed_hash)}">${esc(b.seed_hash)}</span><button data-pfv="${i}" ${b.server_seed ? '' : 'disabled title="Change seeds to reveal this server seed"'}>${b.server_seed ? 'Verify' : 'Hidden'}</button></div>`).join('')}</div>` : '<p class="pfnote">No bets yet.</p>';
  } else if (PF.tab === 'verify') {
    const v = PF.v || { game: 'mines', seed: '', client: '', nonce: 0, detail: {} };
    B.innerHTML = `<div class="pff"><label>Game</label><select class="fsel" id="pvGame">${['mines','blackjack','cases','upgrader','rewards'].map(g => `<option value="${g}" ${v.game === g ? 'selected' : ''}>${PF_GAME[g]}</option>`).join('')}</select></div>
      <div class="pff"><label>Server seed</label><input class="tin" id="pvSeed" value="${esc(v.seed)}"></div>
      <div class="pff"><label>Client seed</label><input class="tin" id="pvClient" value="${esc(v.client)}"></div>
      <div class="pff"><label>Nonce</label><input class="tin" id="pvNonce" type="number" min="0" value="${v.nonce}"></div>
      <div class="pff" id="pvExtra"></div>
      <button class="btn gold" id="pvGo">Verify</button><div id="pvOut"></div>`;
    const extra = () => { const g = $('pvGame').value, d = v.detail || {};
      $('pvExtra').innerHTML = g === 'cases' ? `<label>Case</label><select class="fsel" id="pvCase">${onSale().map(c => `<option value="${c.id}" ${d.case === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`
        : g === 'mines' ? `<label>Grid & mines</label><div class="row"><select class="fsel" id="pvSize">${[16, 25, 36, 49, 64].map(n => `<option ${+d.size === n ? 'selected' : ''}>${n}</option>`).join('')}</select><input class="tin" id="pvMines" type="number" min="1" value="${d.mines || 3}"></div>`
        : g === 'rewards' ? `<label>Level</label><select class="fsel" id="pvLvl">${PACKS.map(p => `<option ${+d.level === p.level ? 'selected' : ''}>${p.level}</option>`).join('')}</select>` : ''; };
    extra(); $('pvGame').onchange = extra;
    $('pvGo').onclick = async () => {
      const g = $('pvGame').value, d = g === 'cases' ? { case: $('pvCase').value } : g === 'mines' ? { size: +$('pvSize').value, mines: +$('pvMines').value } : g === 'rewards' ? { level: +$('pvLvl').value } : {};
      PF.v = { game: g, seed: $('pvSeed').value.trim(), client: $('pvClient').value.trim(), nonce: +$('pvNonce').value || 0, detail: d, hash: v.hash };
      if (!PF.v.seed) return toast('Enter the server seed', 'lose');
      try { $('pvOut').innerHTML = `<div class="pfres">${await pfVerify(PF.v)}</div>`; } catch (e) { $('pvOut').innerHTML = `<div class="pfres bad">Could not verify: ${esc(e.message)}</div>`; }
    };
    if (PF.v && PF.v.seed && PF.v.auto) { PF.v.auto = false; $('pvGo').click(); }
  }
}
async function pfLoad() {
  if (!me) return pfRender();
  try { const [st, bets] = await Promise.all([api('/api/games/fair'), api('/api/games/fair/bets')]); PF.state = st; PF.bets = bets || []; } catch (e) { toast(esc(niceErr(e)), 'lose'); }
  pfRender();
}
function openFair(tab) { PF.tab = tab || 'seeds'; $('fairModal').hidden = false; pfRender(); pfLoad(); }
$('fairModal').onclick = e => {
  if (e.target === $('fairModal') || e.target.closest('[data-pfclose]')) { $('fairModal').hidden = true; return; }
  const cpb = e.target.closest('[data-copy]'); if (cpb) { navigator.clipboard && navigator.clipboard.writeText(cpb.dataset.copy).then(() => toast('Copied')).catch(() => {}); return; }
  const t = e.target.closest('[data-pft]'); if (t) { e.preventDefault(); PF.tab = t.dataset.pft; pfRender(); return; }
  const v = e.target.closest('[data-pfv]');
  if (v) {
    const b = PF.bets[+v.dataset.pfv], row = v.closest('.pfbet'), old = row.querySelector('.pfres');
    if (old) { old.remove(); return; }
    const box = document.createElement('div'); box.className = 'pfres'; box.textContent = 'Checking…'; row.appendChild(box);
    pfVerify({ game: b.game, seed: b.server_seed, client: b.client_seed, nonce: +b.nonce, detail: b.detail || {}, hash: b.seed_hash })
      .then(h => box.innerHTML = h).catch(err => { box.className = 'pfres bad'; box.textContent = 'Could not verify: ' + err.message; });
  }
};
document.addEventListener('click', e => { const b = e.target.closest('[data-fair]'); if (b) openFair(); });
async function verifyBattle(id) {
  const b = BT[id]; if (!b || !b.pfSeed) return;
  openFair('verify');
  $('pfBody').innerHTML = `<div class="pff"><label>Battle seed</label><code>${esc(b.pfSeed)}</code></div><div class="pff"><label>Client seed (battle id)</label><code>${esc(b.id)}</code></div><div class="pfres">${await pfVerify({ game: 'battles', seed: b.pfSeed, client: b.id, nonce: 0, hash: b.pfHash, battle: b.id })}</div>`;
}

/* ---------- weekly leaderboard ---------- */
let LB = null, lbEnd = 0;
const pad2 = n => String(Math.max(0, n)).padStart(2, '0');
async function loadLb() {
  const asset=window.ebCurrency(); if(!asset) return;
  try {
    const data=await api('/api/leaderboard/'+encodeURIComponent(asset));
    if(asset!==window.ebCurrency()) return;
    LB=data;lbEnd=Date.parse(data.ends_at);
    $('lbRows').innerHTML=data.top.map((r,i)=>`<div class="lbrow"><span>${i+1}</span><span>${esc(r.username)}</span><b>${esc(currencyText(r.wagered,asset))}</b></div>`).join('') || '<div class="lbempty">No wagers in this currency this week.</div>';
    tickLb();
  }catch { $('lbRows').textContent='Leaderboard temporarily unavailable.'; }
}
function tickLb() {
  if (!lbEnd) return;
  let t = Math.max(0, Math.floor((lbEnd - Date.now()) / 1000));
  $('cdD').textContent = pad2(Math.floor(t / 86400)); t %= 86400;
  $('cdH').textContent = pad2(Math.floor(t / 3600)); t %= 3600;
  $('cdM').textContent = pad2(Math.floor(t / 60)); $('cdS').textContent = pad2(t % 60);
  if (lbEnd - Date.now() < -2000 && $('leaderboard').classList.contains('on')) { lbEnd = 0; setTimeout(loadLb, 1500); }
}
setInterval(tickLb, 1000);
setInterval(() => { if ($('leaderboard').classList.contains('on')) loadLb(); }, 30000);
$('leaderboard').onclick = e => { const u = e.target.closest('[data-uid]'); if (u) openProfile(u.dataset.uid); };

// Historical pack contents are used to verify previously settled outcomes.
let PACKS=[];
function loadPacks(data) {
  PACKS = data.packs.map(pk => {
    const items = data.rewardItems.filter(x => x.level === pk.level).map(x => {
      const u = UPI.find(y => y.id === Number(x.item_id)) || { n: 'Limited', v: 0, r: 'common', art: ART.crown('#9aa3b8', '#fff'), img: null };
      return { idx: x.idx, w: x.weight, id: u.id, get n() { return u.n; }, get v() { return u.v; }, get r() { return u.r; }, get art() { return u.art; }, get img() { return u.img; } };
    }).sort((a, b) => a.idx - b.idx);
    return { level: pk.level, name: pk.name, items, tot: items.reduce((s, x) => s + x.w, 0), top: items.slice().sort((a, b) => b.v - a.v)[0] };
  });
}

/* ---------- levels, profiles, tips, transactions ---------- */
let LV = [];
function levelInfo(w) {
  w = Number(w) || 0;
  if (!LV.length) return { level: 1, pct: 0, toGo: 0 };
  let i = 0; while (i + 1 < LV.length && LV[i + 1].xp <= w) i++;
  const cur = LV[i], next = LV[i + 1];
  if (!next) return { level: cur.level, pct: 100, toGo: 0 };
  return { level: cur.level, pct: Math.max(0, Math.min(100, (w - cur.xp) / (next.xp - cur.xp) * 100)), toGo: next.xp - w };
}
const lvlBadge = l => `<span class="lvl t${l >= 100 ? 6 : l >= 75 ? 5 : l >= 50 ? 4 : l >= 25 ? 3 : l >= 10 ? 2 : 1}" title="Level ${l}">${l}</span>`;
const fmtDate = t => new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
let profileSeq=0;
async function openProfile(uid) {
  if (!uid || uid.startsWith('bot:')) return;
  if(me?.id===uid) return window.ebOpenWallet();
  const seq=++profileSeq;
  $('tipForm').hidden=true;$('profModal').hidden=false;$('pmBody').textContent='Loading profile…';
  try {
    const u=await api('/api/players/'+encodeURIComponent(uid));if(seq!==profileSeq)return;
    $('pmBody').innerHTML=`<div class="wallet-identity"><span class="wallet-avatar">${esc(u.username[0])}</span><div><h3>${esc(u.username)}</h3><p>Member since ${esc(fmtDate(u.created_at))}</p></div></div>`;
  }catch{if(seq===profileSeq)$('pmBody').textContent='Player unavailable.';}
}
$('pmClose').onclick=()=>{++profileSeq;$('profModal').hidden=true;};

function pricedBet(){return {asset:quote.asset_id,quote:quote.id,request:requestId()};}
function requireQuote(){
  if(quote && quote.asset_id===window.ebCurrency() && Date.parse(quote.expires_at)>Date.now()) return true;
  void refreshQuote();toast('Updating the market price. Review the price before placing your bet.');return false;
}
async function refreshQuote(){
  const asset=window.ebCurrency(), seq=++quoteRequest;
  if(!asset)return;
  try {
    const q=await api('/api/quote/'+encodeURIComponent(asset));if(seq!==quoteRequest || asset!==window.ebCurrency())return;
    quote=q;
  }catch{if(seq!==quoteRequest)return; quote=null;}
  bal=quote?Number(BigInt(window.ebBalance()||'0')/BigInt(quote.unit)):0;
  renderCaseGrid();if(cur&&!spinning&&!$('caseView').hidden)openCase(cur.id);renderUGrid();if(!uSpinning)renderUpg();
  if(!$('bCreate').hidden)renderCreate();if(!$('pickModal').hidden)renderPicker();
}
window.addEventListener('eb-currency',()=>{
  const asset=window.ebCurrency();
  if(asset!==lastAsset){
    lastAsset=asset;quote=null;Object.keys(BT).forEach(k=>delete BT[k]);showB('bLobby');$('borrowModal').hidden=true;
    $('uCurrency').textContent=ccySym();void refreshQuote();void loadBattles();
    if($('leaderboard').classList.contains('on'))void loadLb();
  }
});

/* ---------- start ---------- */
renderAuth(); renderChatInput(); renderCaseGrid(); renderChat(); renderLobby(true);
(async () => {
  await Promise.all([refreshMe(), walletCatalog]);
  if (me) { void resumeMines(); void resumeBj(); }
  try {
    const data=await api('/api/catalog');
    LV=data.levels.map(r=>({level:r.level,xp:Number(r.xp)}));
    loadCases(data);loadUpgradeItems(data.upgrades);loadPacks(data);
  } catch { $('caseGrid').textContent=$('uGrid').textContent='Could not load the catalog. Refresh to try again.'; }
  await Promise.all([loadBattles(), loadChat()]);
})();
setInterval(()=>{if(!document.hidden){void loadChat();if($('battles').classList.contains('on'))void loadBattles();}},5000);
setInterval(()=>{if(!document.hidden){void refreshQuote(); if($('rewards').classList.contains('on'))void window.ebLobbyRewards?.();}},60000);
