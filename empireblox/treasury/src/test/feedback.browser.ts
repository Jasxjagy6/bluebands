/// <reference lib="dom" />
import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';

const root=resolve('..'),origin='https://feedback.test.invalid';
const user={id:'11111111-2222-4333-8444-555555555555',username:'Receipt_Player',email:'player@fixture.invalid',created_at:'2026-11-26T12:00:00Z',display_ccy:'COINS'};
const usdt={id:'COINS',symbol:'COINS',kind:'ledger',decimals:18,chain_id:'ETH',min_deposit:'0',enabled:true};
let browser:Browser;
before(async()=>{browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});});
after(()=>browser?.close());
async function fixture(t:TestContext,initial=false,hasTouch=false){
  const ctx=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',hasTouch});
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
        if(path==='/api/auth/me')return route.fulfill({json:{user,balances:[{...usdt,asset_id:'COINS',amount:balance}]}});
        if(path==='/api/assets')return route.fulfill({json:{currencies:[usdt],denominations:[usdt],transferRoutes:[],directRoutes:[],chains:[{id:'POL',display_name:'Polygon',required_conf:5}],deposits_paused:false}});
        if(path.startsWith('/api/leaderboard/'))return route.fulfill({json:{top:[{user_id:user.id,username:user.username,wagered:'10000000000000000000',rank:'1'},{user_id:'22222222-2222-4333-8444-555555555555',username:'Second_Player',wagered:'8000000000000000000',rank:'2'},{user_id:'33333333-2222-4333-8444-555555555555',username:'Third_Player',wagered:'2000000000000000000',rank:'3'}],me:{user_id:user.id,username:user.username,wagered:'10000000000000000000',rank:'1'},participants:'3',total_wagered:'20000000000000000000',starts_at:'2026-11-23T00:00:00Z',ends_at:'2026-11-30T00:00:00Z'}});
        if(path==='/api/catalog')return route.fulfill({json:{levels:[],cases:[],items:[],upgrades:[],packs:[],rewardItems:[]}});
        if(path==='/api/chat')return url.search?route.abort():route.fulfill({json:{messages:[]}});
        if(path==='/api/me/rewards')return route.fulfill({json:{packs:[],levels:[],claims:[],wagered:'0',level:1,next_level:2,to_next:'6000',progress:0,ready_count:0}});
        if(path==='/api/me/levels'||path==='/api/reward-levels')return route.fulfill({json:{levels:[],wagered_usd:'0',unpriced:false}});
        if(path==='/api/me/deposits')return route.fulfill({json:{deposits:[]}});
        if(path.startsWith('/api/quote/'))return route.fulfill({json:{id:'feedback-quote',asset_id:'COINS',unit:'1000000000000000',expires_at:'2030-01-01T00:00:00Z'}});
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
  const push=(kind:string,overrides:Record<string,unknown>={})=>{rows=[{...receipt(++revision,kind),...overrides},...rows];wake();};
  return {page,ctx,push,wake,setBalance:(amount:string)=>{balance=amount;},changeRead:()=>{rows=rows.map(r=>({...r,read_at:new Date().toISOString()}));revision++;wake();}};
}
function receipt(revision:number,kind:string){
  return {revision:String(revision),kind,amount:'100000',decimals:6,symbol:'USDT',asset_id:'USDT.POL',chain_id:'POL',
    txid:'0x'+'ab'.repeat(32),required_conf:5,confirmations:kind==='deposit.credited'?5:1,read_at:null,created_at:new Date().toISOString()};
}
test('USD preview lasts only while pressed and the original dropdown shows the equivalent without converting',async t=>{
  const {page,setBalance}=await fixture(t);const writes:string[]=[];page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url());});
  setBalance('6000000000000000000000');await page.evaluate(()=>(window as any).ebWalletRefresh());const url=page.url(),trigger=page.locator('#ebwCcy');
  await trigger.hover();await page.mouse.down();assert.equal(await page.locator('#ebwBal').innerText(),'$10.00');assert.equal(await page.locator('#ebwSym').innerText(),'USD');
  assert.match(await page.locator('#ebwIco img').getAttribute('src')||'',/coin\.svg$/);
  await page.mouse.up();await page.getByRole('dialog',{name:'Coin balance',exact:true}).waitFor();assert.equal(await page.locator('#ebwSym').innerText(),'COINS');
  assert.equal(await page.locator('#coinEquivalentValue').innerText(),'$10.00');assert.equal(await page.locator('#ebwMenu [data-profile]').count(),0);
  for(const [coins,expected] of [['12000000000000000000000','$20.00'],['1','<$0.01'],['0','$0.00']]){
    setBalance(coins!);await page.evaluate(()=>(window as any).ebWalletRefresh());assert.equal(await page.locator('#coinEquivalentValue').innerText(),expected);
    assert.equal(await page.locator('#ebwSym').innerText(),'COINS');assert.equal(page.url(),url);
    assert.equal(await page.evaluate(()=>(window as any).ebCurrency()),'COINS');assert.equal(await page.evaluate(()=>(window as any).ebBalance()),coins);
  }
  await page.locator('.coin-equivalent').click();assert.equal(page.url(),url);await page.keyboard.press('Escape');
  await trigger.hover();await page.mouse.down();assert.equal(await page.locator('#ebwSym').innerText(),'USD');
  await page.mouse.move(2,800);assert.equal(await page.locator('#ebwSym').innerText(),'COINS');await page.mouse.up();assert.deepEqual(writes,[]);
});
test('touch release and touch cancellation immediately restore the coin balance',async t=>{
  const {page,ctx,setBalance}=await fixture(t,false,true);setBalance('6000000000000000000000');await page.evaluate(()=>(window as any).ebWalletRefresh());
  const client=await ctx.newCDPSession(page),button=page.locator('#ebwCcy'),box=await button.boundingBox();assert.ok(box);
  const point={x:box.x+box.width-10,y:box.y+box.height/2,id:0};
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});assert.equal(await page.locator('#ebwBal').innerText(),'$10.00');
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.getByRole('dialog',{name:'Coin balance',exact:true}).waitFor();
  assert.equal(await page.locator('#ebwSym').innerText(),'COINS');assert.equal(await page.locator('#coinEquivalentValue').innerText(),'$10.00');await page.keyboard.press('Escape');
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});assert.equal(await page.locator('#ebwSym').innerText(),'USD');
  await client.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});assert.equal(await page.locator('#ebwSym').innerText(),'COINS');
  assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.evaluate(()=>(window as any).ebCurrency()),'COINS');
});
test('coin menu joins its header on every screen while the wallet remains centered',async t=>{
  const {page}=await fixture(t);await page.emulateMedia({reducedMotion:'reduce'});
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:800});const trigger=page.locator('#ebwCcy');await trigger.click();
    const menu=page.getByRole('dialog',{name:'Coin balance',exact:true});await menu.waitFor();
    const group=page.locator('#ebwPill'),anchor=await group.boundingBox(),box=await menu.boundingBox();assert.ok(anchor&&box);
    assert.ok(Math.abs(box.y-(anchor.y+anchor.height-1))<1,'Dropdown joins directly beneath the balance');
    assert.ok(Math.abs(box.x+box.width/2-anchor.x-anchor.width/2)<1,'Dropdown is centered beneath the combined Coins and Wallet control');
    assert.ok(box.width>=236,'Menu retains enough width for its icon, label and amount');
    await page.waitForFunction(()=>Array.from(document.querySelectorAll<HTMLImageElement>('#ebwIco img,#ebwMenu .sheet-list img')).every(img=>img.complete&&img.naturalWidth>0));
    for(const image of [page.locator('#ebwIco img'),menu.locator('.sheet-list .currency-logo')]){
      assert.ok(await image.isVisible());assert.match(await image.getAttribute('src')||'',/coin\.svg$/);
      const size=await image.boundingBox();assert.ok(size&&size.width>=18&&size.height>=18,'Coin icon stays visible at its intended size');
    }
    assert.ok(await menu.evaluate(el=>el.scrollWidth<=el.clientWidth),JSON.stringify(await menu.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,width:el.getBoundingClientRect().width,overflow:Array.from(el.querySelectorAll('*')).filter(x=>x.getBoundingClientRect().right>el.getBoundingClientRect().right).map(x=>({tag:x.tagName,cls:x.className,text:x.textContent?.slice(0,35),width:x.getBoundingClientRect().width}))}))));
    assert.ok(box.x>=0&&box.x+box.width<=width&&box.y+box.height<=800);
    assert.equal(await menu.evaluate(el=>el.matches(':modal')),false);
    assert.equal(await menu.evaluate(el=>getComputedStyle(el).backgroundColor),await group.evaluate(el=>getComputedStyle(el).backgroundColor));
    assert.equal(await menu.evaluate(el=>getComputedStyle(el).borderTopLeftRadius),'0px');
    assert.equal(await menu.locator('.sheet-heading').isVisible(),false);assert.equal(await menu.locator('.wallet-search').isVisible(),false);
    assert.ok(await menu.locator('.coin-equivalent').isVisible());
    const dir=process.env.WALLET_SCREENSHOT_DIR;if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,'joined-coins-'+width+'.png')});}
    await page.mouse.click(2,700);assert.equal(await menu.isVisible(),false);assert.equal(await trigger.getAttribute('aria-expanded'),'false');
    await page.locator('#ebwDep').click();await page.locator('#walletSummary:visible').waitFor();
    const wallet=page.getByRole('dialog',{name:'Wallet',exact:true}),bounds=await wallet.boundingBox();assert.ok(bounds);
    assert.equal(await wallet.evaluate(el=>el.matches(':modal')),true);assert.ok(Math.abs(bounds.x+bounds.width/2-width/2)<1);
    assert.equal(await wallet.locator('.sheet-heading').isVisible(),true);await page.keyboard.press('Escape');
  }
});
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
test('credit and debit receipts use a neutral design, retain exact amounts and fit narrow phones',async t=>{
  const {page,push}=await fixture(t);await page.emulateMedia({reducedMotion:'reduce'});
  const alert=page.locator('#accountAlert'),route=page.url();
  for(const width of [320,390,1440]){
    await page.setViewportSize({width,height:900});
    for(const [kind,amount,label,display] of [
      ['balance.credit','1500000000000000000000','Credit','+1500 COINS'],
      ['balance.debit','-100000000000000001','Debit','−0.100000000000000001 COINS']
    ] as const){
      push(kind,{amount,decimals:18,symbol:'COINS',asset_id:'COINS',chain_id:null});
      await alert.locator('.alert-type').getByText(label,{exact:true}).waitFor();
      assert.equal(await alert.getAttribute('data-flow'),label.toLowerCase());
      assert.equal(await alert.locator('.alert-amount').innerText(),display);
      assert.match(await alert.evaluate(e=>getComputedStyle(e).backgroundImage),/rgb\(27, 38, 53\)/);
      assert.ok(Number(await alert.locator('.alert-number').evaluate(e=>getComputedStyle(e).fontWeight))>=750);
      assert.equal(await alert.locator('.alert-amount img').getAttribute('src'),'/assets/wallet/coin.svg');
      const box=await alert.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=900,JSON.stringify(box));
      assert.ok(await alert.evaluate(e=>e.scrollWidth<=e.clientWidth),'Long exact amounts must stay inside the receipt');
      const dir=process.env.WALLET_SCREENSHOT_DIR;
      if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,'receipt-'+label.toLowerCase()+'-'+width+'.png')});}
      await alert.getByRole('button',{name:'Dismiss notification',exact:true}).click();
      assert.equal(await alert.isVisible(),false);assert.equal(page.url(),route);
    }
  }
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
  await input.fill('10');assert.equal(await play.isDisabled(),true);assert.match(await page.locator('#mPlayHint').innerText(),/Insufficient balance.*5 COINS/);
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
  assert.equal(await page.locator('#lbParticipants').innerText(),'3');assert.equal(await page.locator('#lbTotal').innerText(),'20 COINS');assert.match(await page.locator('#lbMe').innerText(),/#1/);
  assert.match(await page.locator('#lbPeriod').innerText(),/Nov 23.*Nov 30.*UTC/);
  for(const width of [320,390,1440]){
    await page.setViewportSize({width,height:900});assert.ok(await page.locator('#leaderboard').evaluate(e=>e.scrollWidth<=e.clientWidth));
    const dir=process.env.WALLET_SCREENSHOT_DIR;if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,'weekly-standings-'+width+'.png')});}
  }
  await page.getByRole('button',{name:'Refresh leaderboard'}).click();await page.waitForFunction(()=>!(document.getElementById('lbRefresh') as HTMLButtonElement).disabled);
  assert.equal(await page.locator('#lbRows .lbrow').count(),3);
});
