/// <reference lib="dom" />
import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';

const root=resolve('..'),origin='https://feedback.test.invalid';
const user={id:'11111111-2222-4333-8444-555555555555',username:'Receipt_Player',email:'player@fixture.invalid',created_at:'2026-11-26T12:00:00Z',display_ccy:'USDT'};
const usdt={id:'USDT',symbol:'USDT',kind:'ledger',decimals:18,chain_id:'ETH',min_deposit:'0',enabled:true};
let browser:Browser;
before(async()=>{browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});});
after(()=>browser?.close());
async function fixture(t:TestContext,initial=false){
  const ctx=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const errors:string[]=[],waiting=new Set<()=>void>();
  let balance='5000000000000000000';
  let revision=initial?1:0,rows:any[]=initial?[receipt(1,'deposit.credited')]:[];
  const state=()=>({revision:String(revision),unread:rows.filter(r=>!r.read_at).length,more:false,rows});
  const wake=()=>{for(const resolve of waiting)resolve();waiting.clear();};
  await ctx.addInitScript(()=>{
    (window as any).audioNotes=0;
    const proto=AudioContext.prototype,create=proto.createOscillator;
    proto.createOscillator=function(){(window as any).audioNotes++;return create.call(this);};
  });
  await ctx.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(url.origin!==origin)return route.abort();
    try{
      if(path.startsWith('/api/')){
        if(path==='/api/me/notifications/changes'){
          if(Number(url.searchParams.get('after'))===revision)await new Promise<void>(resolve=>waiting.add(resolve));
          return route.fulfill({json:{revision:String(revision),unread:state().unread}});
        }
        if(path==='/api/me/notifications')return route.fulfill({json:state()});
        if(path==='/api/me/notifications/read'){
          rows=rows.map(r=>({...r,read_at:new Date().toISOString()}));revision++;wake();return route.fulfill({json:state()});
        }
        if(path==='/api/auth/me')return route.fulfill({json:{user,balances:[{...usdt,asset_id:'USDT',amount:balance}]}});
        if(path==='/api/assets')return route.fulfill({json:{currencies:[usdt],denominations:[usdt],transferRoutes:[],directRoutes:[],chains:[{id:'POL',display_name:'Polygon',required_conf:5}],deposits_paused:false}});
        if(path.startsWith('/api/leaderboard/'))return route.fulfill({json:{top:[{user_id:user.id,username:user.username,wagered:'10000000000000000000',rank:'1'},{user_id:'22222222-2222-4333-8444-555555555555',username:'Second_Player',wagered:'8000000000000000000',rank:'2'},{user_id:'33333333-2222-4333-8444-555555555555',username:'Third_Player',wagered:'2000000000000000000',rank:'3'}],me:{user_id:user.id,username:user.username,wagered:'10000000000000000000',rank:'1'},participants:'3',total_wagered:'20000000000000000000',starts_at:'2026-11-23T00:00:00Z',ends_at:'2026-11-30T00:00:00Z'}});
        if(path==='/api/catalog')return route.fulfill({json:{levels:[],cases:[],items:[],upgrades:[],packs:[],rewardItems:[]}});
        if(path==='/api/chat')return url.search?route.abort():route.fulfill({json:{messages:[]}});
        if(path==='/api/me/levels'||path==='/api/reward-levels')return route.fulfill({json:{levels:[],wagered_usd:'0',unpriced:false}});
        if(path==='/api/me/deposits')return route.fulfill({json:{deposits:[]}});
        if(path.startsWith('/api/quote/'))return route.fulfill({json:{id:'feedback-quote',asset_id:'USDT',unit:'1000000000000000',expires_at:'2030-01-01T00:00:00Z'}});
        return route.fulfill({status:404,json:{error:'No fixture'}});
      }
      const file=path==='/'||path.startsWith('/account/')?'index.html':path.slice(1);
      const mime:Record<string,string>={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'};
      return route.fulfill({body:await readFile(resolve(root,file)),contentType:mime[extname(file)]||'application/octet-stream'});
    }catch{await route.abort().catch(()=>{});}
  });
  const page=await ctx.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
  t.after(async()=>{wake();await ctx.close();assert.deepEqual(errors,[]);});
  await page.goto(origin);await page.locator('#ebwCcy').waitFor();
  for(let attempt=0;attempt<100&&!waiting.size;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(waiting.size,'The account notification subscription must be active');
  const push=(kind:string)=>{rows=[receipt(++revision,kind),...rows];wake();};
  return {page,ctx,push,wake,setBalance:(amount:string)=>{balance=amount;},changeRead:()=>{rows=rows.map(r=>({...r,read_at:new Date().toISOString()}));revision++;wake();}};
}
function receipt(revision:number,kind:string){
  return {revision:String(revision),kind,amount:'100000',decimals:6,symbol:'USDT',asset_id:'USDT.POL',chain_id:'POL',
    txid:'0x'+'ab'.repeat(32),required_conf:5,confirmations:kind==='deposit.credited'?5:1,read_at:null,created_at:new Date().toISOString()};
}
test('game search and category filters compose, with a keyboard-accessible empty-state reset',async t=>{
  const {page}=await fixture(t);
  await page.locator('#lobbySearch').fill('black');assert.equal(await page.locator('.lobby-game:visible').count(),1);
  await page.locator('[data-game-filter=multiplayer]').click();await page.locator('#lobbyEmpty').waitFor();
  assert.equal(await page.locator('.lobby-game:visible').count(),0);
  await page.getByRole('button',{name:'Show all games'}).press('Enter');
  assert.equal(await page.locator('.lobby-game:visible').count(),5);
  assert.equal(await page.locator('#lobbySearch').inputValue(),'');
});
test('sound control mutes account audio, persists after reload and synchronizes between tabs',async t=>{
  const {page,ctx,push}=await fixture(t);
  await page.click('#noticeBell');await page.getByRole('button',{name:'Mute all sounds'}).click();
  assert.equal(await page.locator('#noticeSound').getAttribute('aria-pressed'),'false');
  await page.click('#closeNotices');const before=await page.evaluate(()=>(window as any).audioNotes);
  push('deposit.credited');await page.locator('#accountAlert:not([hidden])').waitFor();
  assert.equal(await page.evaluate(()=>(window as any).audioNotes),before);
  await page.reload();await page.locator('#ebwCcy').waitFor();await page.click('#noticeBell');
  assert.equal(await page.locator('#noticeSound').getAttribute('aria-pressed'),'false');
  const second=await ctx.newPage();await second.goto(origin);await second.locator('#ebwCcy').waitFor();await second.click('#noticeBell');
  await second.getByRole('button',{name:'Enable sounds'}).click();
  await page.waitForFunction(()=>document.getElementById('noticeSound')!.getAttribute('aria-pressed')==='true');
  await second.close();
});
test('new deposit alerts preserve input focus, explain five confirmations and can be dismissed without navigation',async t=>{
  const {page,push}=await fixture(t);
  await page.locator('#lobbySearch').click();await page.locator('#lobbySearch').fill('Mines');const route=page.url();
  push('deposit.pending');await page.locator('#accountAlert:not([hidden])').waitFor();
  assert.match(await page.locator('#accountAlert').innerText(),/0\.1 USDT.*Polygon/s);
  assert.match(await page.locator('#accountAlert').innerText(),/5 confirmations/);
  assert.equal(await page.locator('#lobbySearch').evaluate(e=>e===document.activeElement),true);
  const before=await page.evaluate(()=>(window as any).audioNotes);assert.ok(before>0);
  await page.getByRole('button',{name:'Dismiss notification',exact:true}).click();
  assert.equal(await page.locator('#accountAlert').isVisible(),false);assert.equal(page.url(),route);
  push('deposit.credited');await page.locator('#accountAlert:not([hidden])').waitFor();
  assert.match(await page.locator('#accountAlert').innerText(),/Deposit credited/);
  assert.equal(await page.locator('#accountAlert').getAttribute('data-tone'),'success');
  await page.locator('#accountAlert .notice-open').click();await page.waitForURL('**/account/notifications');
  await page.locator('#noticeList').getByText('Deposit credited',{exact:true}).waitFor();
});
test('existing unread history and read-state revisions never replay a receipt or notification sound',async t=>{
  const {page,changeRead}=await fixture(t,true);
  await page.locator('#lobbySearch').focus();
  assert.equal(await page.locator('#accountAlert').isVisible(),false);
  const before=await page.evaluate(()=>(window as any).audioNotes);
  const changed=page.waitForResponse(r=>r.url().includes('/notifications/changes'));changeRead();await changed;
  await page.waitForFunction(()=>!document.getElementById('noticeBell')!.classList.contains('has-unread'));
  assert.equal(await page.locator('#accountAlert').isVisible(),false);
  assert.equal(await page.evaluate(()=>(window as any).audioNotes),before);
});
test('notification center and receipt alerts fit small screens and honor reduced motion',async t=>{
  const {page,push}=await fixture(t,true);await page.emulateMedia({reducedMotion:'reduce'});
  for(const [width,height] of [[320,568],[390,844],[1440,900]] as const){
    await page.setViewportSize({width,height});await page.click('#noticeBell');await page.locator('.notice-entry').waitFor();
    const box=await page.locator('#noticePopup').boundingBox();assert.ok(box&&box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height,JSON.stringify(box));
    assert.equal(await page.locator('#noticePopup').evaluate(e=>getComputedStyle(e).animationName),'none');
    const dir=process.env.WALLET_SCREENSHOT_DIR;if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,'notifications-upgrade-'+width+'.png')});}
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({width:390,height:844});await page.locator('#lobbySearch').focus();push('deposit.credited');
  await page.locator('#accountAlert:not([hidden])').waitFor();
  assert.equal(await page.locator('#accountAlert').evaluate(e=>getComputedStyle(e).animationName),'none');
  const dir=process.env.WALLET_SCREENSHOT_DIR;if(dir)await page.screenshot({path:resolve(dir,'deposit-alert-upgrade.png')});
});

test('the main logo returns to the lobby silently',async t=>{
  const {page}=await fixture(t);await page.locator('#home [data-game-page=mines]').click();await page.locator('#mines.on').waitFor();
  await page.locator('#pageTransition').waitFor({state:'hidden'});const notes=await page.evaluate(()=>(window as any).audioNotes);
  await page.locator('.top .logo').click();await page.locator('#home.on').waitFor();await page.locator('#pageTransition').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>(window as any).audioNotes),notes);
});
test('wager buttons disable above the exact balance, support stake shortcuts and update after balance changes',async t=>{
  const {page,setBalance}=await fixture(t);await page.locator('#home [data-game-page=mines]').click();await page.locator('#mines.on').waitFor();
  const input=page.locator('#mBet'),play=page.locator('#mPlay');
  await input.fill('10');assert.equal(await play.isDisabled(),true);assert.match(await page.locator('#mPlayHint').innerText(),/Insufficient balance.*5 USDT/);
  await input.fill('5');assert.equal(await play.isEnabled(),true);
  await input.fill('5.000000000000000001');assert.equal(await play.isDisabled(),true);
  await input.fill('2.5');await page.locator('#mines [data-b="2"]').click();assert.equal(await input.inputValue(),'5');assert.equal(await play.isEnabled(),true);
  await page.locator('#mines [data-b="2"]').click();assert.equal(await play.isDisabled(),true);
  await page.locator('#mines [data-b=max]').click();assert.equal(await input.inputValue(),'5');assert.equal(await play.isEnabled(),true);
  setBalance('1000000000000000000');await page.evaluate(()=>(window as any).ebWalletRefresh());assert.equal(await play.isDisabled(),true);
  await input.fill('0.5');assert.equal(await play.isEnabled(),true);await input.fill('invalid');assert.equal(await play.isDisabled(),true);
  await page.locator('#gamesBtn').click();await page.locator('#gmenu [data-p=blackjack]').click();await page.locator('#blackjack.on').waitFor();
  await page.locator('#bjBet').fill('2');assert.equal(await page.locator('#bjDeal').isDisabled(),true);
  await page.locator('#bjBet').fill('1');assert.equal(await page.locator('#bjDeal').isEnabled(),true);
});
test('weekly standings show leaders, personal rank, exact currency totals and fit phones and desktop',async t=>{
  const {page}=await fixture(t);await page.locator('#lbBtn').click();await page.locator('#leaderboard.on').waitFor();await page.locator('.lb-leader').first().waitFor();
  assert.equal(await page.locator('.lb-leader').count(),3);assert.equal(await page.locator('#lbRows .lbrow').count(),3);
  assert.equal(await page.locator('#lbParticipants').innerText(),'3');assert.equal(await page.locator('#lbTotal').innerText(),'20 USDT');assert.match(await page.locator('#lbMe').innerText(),/#1/);
  assert.match(await page.locator('#lbPeriod').innerText(),/Nov 23.*Nov 30.*UTC/);
  for(const width of [320,390,1440]){
    await page.setViewportSize({width,height:900});assert.ok(await page.locator('#leaderboard').evaluate(e=>e.scrollWidth<=e.clientWidth));
    const dir=process.env.WALLET_SCREENSHOT_DIR;if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,'weekly-standings-'+width+'.png')});}
  }
  await page.getByRole('button',{name:'Refresh leaderboard'}).click();await page.waitForFunction(()=>!(document.getElementById('lbRefresh') as HTMLButtonElement).disabled);
  assert.equal(await page.locator('#lbRows .lbrow').count(),3);
});
