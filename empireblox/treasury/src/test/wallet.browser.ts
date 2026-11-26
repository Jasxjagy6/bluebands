/// <reference lib="dom" />
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { hashPassword } from '../authutil.js';
import { resolve, extname } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { HDNodeWallet } from 'ethers';
import { buildServer } from '../api/server.js';
import { pool, query, tx } from '../db.js';
import { startMines,revealMines } from '../games/mines.js';
import { post } from '../ledger.js';
import { setSecret } from '../vault.js';
import { installMarketFixture } from './market-fixture.js';
import { expectBelow } from './picker-geometry.js';

installMarketFixture();
const app=await buildServer(), root=resolve('..');
let browser:Browser, context:BrowserContext, page:Page, base:string;
let delayResponse:((url:string)=>Promise<void>)|undefined;
const username='ui'+randomBytes(5).toString('hex'), errors:string[]=[];
before(async()=>{
  // Several cases use a real address endpoint; the watcher integration suite covers its heartbeat.
  await query("update settings set value=to_jsonb('direct'::text) where key='deposit_provider'");
  await setSecret('xpub:EVM', HDNodeWallet.fromSeed(randomBytes(32)).neuter().extendedKey,'browser-test');
  for (const chain of ['ETH','BSC']) await setSecret('rpc:'+chain,'http://127.0.0.1:1','browser-test');
  await query("update chains set scan_ready_at=now() where id in ('ETH','BSC')");
  app.addHook('onSend',async(req,_reply,payload)=>{await delayResponse?.(req.url);return payload;});
  app.get('/*',async(req,reply)=>{
    const pathname=req.url.split('?')[0]!;
    const path=/^\/account\/[a-z]+\/?$/.test(pathname)?'/':pathname;
    if (!['/','/app.js','/wallet.js','/config.js'].includes(path) && !path.startsWith('/assets/')) return reply.code(404).send();
    const name=path==='/'?'index.html':path.slice(1);
    const mime:Record<string,string>={'.html':'text/html','.js':'application/javascript','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.css':'text/css','.woff2':'font/woff2'};
    return reply.type(mime[extname(name)]||'application/octet-stream').send(await readFile(resolve(root,name)));
  });
  base=await app.listen({host:'127.0.0.1',port:0});
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']});
  context=await browser.newContext({viewport:{width:390,height:750},permissions:['clipboard-read','clipboard-write']});
  page=await context.newPage(); page.setDefaultTimeout(7000);
  page.on('pageerror', e=>errors.push(e.message));
  await page.goto(base);
});
async function screenshot(name:string,target=page){
  const dir=process.env.WALLET_SCREENSHOT_DIR;
  if(dir){await mkdir(dir,{recursive:true});await target.evaluate(()=>document.fonts.ready.then(()=>true));await target.screenshot({path:resolve(dir,name+'.png'),animations:'disabled'});}
}
function picker(p:Page,selector:string){return p.locator(selector).locator('..').getByRole('combobox');}
async function choose(p:Page,selector:string,value:string){
  const label=await p.locator(selector).evaluate((el,value)=>Array.from((el as HTMLSelectElement).options).find(o=>o.value===value)?.label,value);
  assert.ok(label,`Missing ${value} in ${selector}`);
  await picker(p,selector).click();await expectBelow(p,selector,'.eb-option-picker[open]');
  await p.getByRole('listbox').getByRole('option',{name:label,exact:true}).click();
}
after(async()=>{await browser?.close();await app.close();await query("update settings set value=to_jsonb('oxapay'::text) where key='deposit_provider'");await pool.end();});
test('instant signup works with external services offline and displays the wallet',async()=>{
  await page.locator('#signBtn').click(); await page.locator('[data-v=signup]').click();
  await page.fill('#suName',username); await page.fill('#suEmail',username+'@test.invalid');
  await page.fill('#suPass','test-password-123'); await page.check('#suAge');
  const registered=page.waitForResponse(r=>r.url().endsWith('/api/auth/register'),{timeout:7000});
  await page.click('#suGo');
  try { assert.equal((await registered).status(),200); }
  catch(e) { throw new Error(String(e)+' / '+await page.locator('#authErr').innerText()+' / '+errors.join(', ')); }
  await page.locator('#ebwCcy').waitFor({state:'visible'});
  assert.equal(await page.locator('#authModal').isVisible(),false);
  assert.ok((await context.cookies()).find(c=>c.name==='eb_sess' && c.httpOnly));
});
test('currency menu remains visible at desktop and phone widths, and choice survives reload',async()=>{
  for (const width of [320,390,1024,1440]) {
    await page.setViewportSize({width,height:width===320?480:750});
    await page.locator('#ebwCcy').click(); const box=await page.locator('#ebwMenu').boundingBox();
    assert.ok(box && box.x>=0 && box.y>=0 && box.x+box.width<=width && box.y+box.height<=page.viewportSize()!.height);
    await expectBelow(page,'#ebwCcy','#ebwMenu[open]');
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({width:390,height:750});
  await page.click('#ebwCcy'); assert.equal(await page.locator('#ebwMenu [data-asset^=USDT]').count(),1); await page.click('[data-asset="USDT"]');
  await page.waitForFunction(()=>document.querySelector('#ebwMenu')?.hasAttribute('hidden'));
  await page.reload(); await page.locator('#ebwCcy[aria-label*="USDT balance"]').waitFor();
});
test('deposit opens the selected network, shows a local QR, exact minimum and copies the address',async()=>{
  await page.click('#ebwDep');await page.locator('#ebwMenu [data-asset=USDT]').click(); const addr=page.locator('#depositAddress'); await addr.waitFor();
  const expected=await addr.inputValue(); assert.match(expected,/^0x[0-9a-f]{40}$/);
  assert.equal(await page.inputValue('#depositNetwork'),'USDT.ERC20');
  assert.deepEqual((await page.locator('#depositNetwork option').evaluateAll(els=>els.map(el=>(el as HTMLOptionElement).value))).sort(),
    ['USDT.BEP20','USDT.ERC20','USDT.POL','USDT.SPL']);
  assert.ok(await page.locator('#depositQr svg').isVisible()); assert.match(await page.locator('.wallet-facts').innerText(),/1 USDT/);
  await page.click('#copyAddress'); assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),expected);
  const bounds=await page.locator('#accountPage').boundingBox(); assert.ok(bounds && bounds.width<=390);
  const selector=picker(page,'#depositNetwork');await selector.click();const networkList=page.getByRole('listbox');
  assert.ok(await networkList.evaluate(el=>!!el.closest('dialog:modal')));
  await screenshot('deposit-network-sheet');await page.keyboard.press('End');await page.keyboard.press('Escape');
  assert.equal(await page.inputValue('#depositNetwork'),'USDT.ERC20');assert.ok(await selector.evaluate(el=>el===document.activeElement));
  await choose(page,'#depositNetwork','USDT.POL');
  await page.locator('#addressResult [data-retry]').waitFor();
  assert.equal(await addr.count(),0);
  await choose(page,'#depositNetwork','USDT.SPL');
  await page.getByText('Solana deposits are currently unavailable.').waitFor();
  assert.equal(await addr.count(),0); await page.keyboard.press('Escape');
});
test('stale network responses cannot replace the current address',async()=>{
  let unblock!:()=>void, seen!:()=>void;
  const hold=new Promise<void>(r=>unblock=r), started=new Promise<void>(r=>seen=r);
  delayResponse=async url=>{if(url==='/api/me/address/ETH'){seen();await hold;}};
  try{
    await page.click('#ebwDep');await page.locator('#ebwMenu [data-asset=USDT]').click();await started;await choose(page,'#depositNetwork','USDT.BEP20');
    await page.locator('#depositAddress').waitFor();assert.match(await page.locator('.network-warning').innerText(),/BNB Chain/);
  }finally{unblock();delayResponse=undefined;}
  assert.match(await page.locator('.network-warning').innerText(),/BNB Chain/); await page.keyboard.press('Escape');
});
test('profile and currency selector round displayed balances while preserving exact spendable units',async()=>{
  const uid=(await query('select id from users where username=$1',[username])).rows[0].id;
  const amount=900719925474099312345678n;
  await tx(c=>post(c,'deposit','browser-fixture',[{account:'u:'+uid,asset:'ETH',delta:amount},{account:'ext:ETH',asset:'ETH',delta:-amount}]));
  for(const [asset,units] of [['USDT',9999500000000000000n],['BNB',1234550000000000000n],['POL',1234500000000000000n]] as const)
    await tx(c=>post(c,'deposit','rounding-fixture',[{account:'u:'+uid,asset,delta:units},{account:'ext:fixture',asset,delta:-units}]));
  await page.evaluate(()=> (window as any).ebWalletRefresh());
  await page.click('#meChip');
  const expected={ETH:'900719.92547',USDT:'10',POL:'1.23',BNB:'1.2346'};
  for(const [symbol,display] of Object.entries(expected)){
    const row=page.locator('.wallet-balances>div').filter({has:page.getByText(symbol,{exact:true})});
    assert.equal(await row.locator('b').innerText(),display);
  }
  assert.equal(await page.evaluate(()=>(window as any).ebBalance()),'9999500000000000000');
  await page.click('#ebwCcy');
  for(const [symbol,display] of Object.entries(expected))assert.equal(await page.locator('[data-asset="'+symbol+'"] b').innerText(),display);
  await page.keyboard.press('Escape');
  assert.match(await page.locator('#walletContent').innerText(),new RegExp(username+'@test.invalid'));
  assert.match(await page.locator('#walletHistory').innerText(),/No deposits/);
  await page.keyboard.press('Escape');
  await page.click('#ebwCcy'); await page.click('[data-profile]'); await page.locator('#walletTitle').waitFor();
  assert.equal(await page.locator('#walletTitle').innerText(),'Account overview'); await page.keyboard.press('Escape');
});
test('real game, chat, leaderboard and catalog entry points work without external services',async()=>{
  await page.click('#gamesBtn'); await page.click('[data-p=blackjack]');
  await page.fill('#bjBet','0.000001');
  // This opening stake is placed in ETH; explicitly choose the funded currency.
  await page.click('#ebwCcy'); await page.click('[data-asset="ETH"]');
  await page.locator('#ebwCcy[aria-label*="ETH on Ethereum"]').waitFor();
  await page.click('#bjDeal'); await page.locator('#bjDealer .pcard').first().waitFor();
  await page.click('#gamesBtn'); await page.click('[data-p=cases]'); await page.locator('.ccard').first().waitFor();
  await page.click('#lbBtn'); await page.locator('#lbRows').getByText(username).waitFor();
  await page.click('#chatOpen'); await page.fill('#chatIn','Wallet browser smoke');await page.click('#chatSend');
  await page.locator('#msgs').getByText('Wallet browser smoke').waitFor(); await page.click('#chatClose');
});
test('account menu fits compact phones, supports the keyboard and opens each activity section',async()=>{
  await page.setViewportSize({width:320,height:480});
  await page.locator('#meChip').focus();await page.keyboard.press('Enter');
  await page.waitForURL('**/account/profile');
  const overview=page.locator('#walletContent');await overview.getByRole('heading',{name:'Wallet balances'}).waitFor();
  assert.equal(await overview.locator('[data-view=security], [data-view=transactions]').count(),0);
  assert.equal(await page.locator('#walletNav a[href="/account/security"], #walletNav a[href="/account/transactions"]').count(),2);
  assert.equal(await page.locator('#walletNav a').count(),9);
  assert.ok(await page.locator('#accountPage').evaluate(el=>el.scrollWidth<=el.clientWidth));
  await page.click('#walletNav [data-view=rewards]');await page.waitForURL('**/account/rewards');
  await page.reload();await page.getByText('Current level',{exact:true}).waitFor();
  await page.goBack();await page.waitForURL('**/account/profile');
  await page.setViewportSize({width:390,height:750});await screenshot('account-phone');
  await page.click('#walletNav [data-view=deposit]');await page.locator('#depositAddress').waitFor();
  await screenshot('deposit-phone');await page.keyboard.press('Escape');
  await page.click('#meChip');await page.click('#walletNav [data-view=transactions]');
  await page.locator('.transaction-details summary').first().click();await page.locator('.transaction-details[open]').getByText('Ledger entry',{exact:true}).waitFor();
  await page.keyboard.press('Escape');await page.click('#meChip');await page.click('#walletNav [data-view=bets]');
  await choose(page,'#betFilter','blackjack');
  await page.locator('[data-game=blackjack]').first().click();await page.getByText('Bet ID',{exact:true}).waitFor();
  assert.match(await page.locator('.bet-facts').innerText(),/Dealer cards/);
  await page.click('[data-back-bets]');await picker(page,'#betFilter').waitFor();await page.keyboard.press('Escape');
  const uid=(await query('select id from users where username=$1',[username])).rows[0].id;
  // Give the chart a settled wager from yesterday even when the UI hand remains active.
  await query(`insert into instant_rounds(user_id,request,game,asset_id,result,server_seed,client_seed,nonce,created_at)
    values($1,$2,'upgrader','ETH',$3,'fixture','client',0,now()-interval '1 day')`,[uid,randomUUID(),{stake:'1000000000000000000',payout:'2000000000000000000'}]);
  await page.click('#meChip');await page.click('#walletNav [data-view=stats]');await page.locator('.result-chart').waitFor();
  assert.match(await page.locator('#wagerValuation').innerText(),/USDT wagered\..*historical bet/i);
  await choose(page,'#statsPeriod','30');await page.waitForFunction(()=>document.querySelectorAll('.chart-table tbody tr').length===30);
  const period=await page.locator('#statsPeriod').elementHandle(),entries=await page.evaluate(()=>history.length);
  await page.click('#walletNav [data-view=stats]');
  assert.equal(await page.evaluate(()=>history.length),entries);assert.equal(await page.locator('#statsPeriod').inputValue(),'30');
  assert.ok(await page.locator('#statsPeriod').evaluate((el,old)=>el===old,period));
  await page.click('[data-metric=stake]');await page.getByRole('img',{name:'Daily amount wagered in ETH'}).waitFor();
  await page.click('.chart-card summary');assert.equal(await page.locator('.chart-table tbody tr').count(),30);
  await page.click('.chart-card summary');await page.click('[data-metric=net]');
  await page.setViewportSize({width:1280,height:850});await screenshot('statistics-desktop');
  await page.setViewportSize({width:320,height:480});await screenshot('statistics-phone');
  assert.ok(await page.locator('#walletContent').evaluate(e=>e.scrollWidth<=e.clientWidth));
  await choose(page,'#statsAsset','USDT');await page.getByText('No settled bets in this period.').waitFor();
  await page.keyboard.press('Escape');
});

test('withdraw review, cancellation and external settlement are visible through the player and admin interfaces',async()=>{
  await page.setViewportSize({width:390,height:750});
  await page.click('#meChip');await page.click('#walletNav [data-view=withdraw]');await page.locator('#withdrawForm').waitFor();
  await choose(page,'#withdrawCurrency','USDT');
  await page.waitForFunction(()=>document.querySelector('#withdrawForm label')?.closest('form')?.textContent?.includes('Amount in USDT'));
  await choose(page,'#withdrawCurrency','ETH');
  await page.getByText('Amount in ETH',{exact:true}).waitFor();
  const request=async()=>{
    await page.fill('#withdrawForm [name=destination]','0x'+'2b'.repeat(20));await page.fill('#withdrawForm [name=amount]','0.0001');
    await page.getByRole('button',{name:'Review withdrawal'}).click();
    assert.match(await page.locator('#reviewDetails').innerText(),/Ethereum/);
    await page.getByRole('button',{name:'Edit details'}).click();
    assert.equal(await page.inputValue('#withdrawForm [name=amount]'),'0.0001');
    await page.getByRole('button',{name:'Review withdrawal'}).click();
    assert.match(await page.locator('#reviewDetails').innerText(),/0x(2b){20}/);
    await screenshot('withdraw-review-phone');
    await page.getByRole('button',{name:'Confirm request'}).click();
    await page.locator('.transaction-details summary').filter({hasText:'Requested'}).waitFor();
  };
  await request();
  await page.locator('.transaction-details summary').filter({hasText:'Requested'}).click();
  await page.getByRole('button',{name:'Cancel withdrawal'}).click();await page.getByText('Cancelled',{exact:true}).waitFor();
  await request();
  const admin=await browser.newContext(),panel=await admin.newPage();
  try{
    const login='reviewer-'+randomUUID().slice(0,8),password=randomUUID();
    await query('insert into admin_users(username,pass_hash) values($1,$2)',[login,hashPassword(password)]);
    await panel.goto(base+'/admin');await panel.fill('#l_user',login);await panel.fill('#l_pass',password);await panel.click('#l_btn');
    await panel.getByRole('button',{name:'Withdrawals',exact:true}).click();
    const card=panel.locator('.withdrawal-review').filter({hasText:'0x'+'2b'.repeat(20)});
    await card.getByRole('button',{name:'Claim for review'}).click();await card.getByRole('button',{name:'Approve withdrawal'}).click();await card.locator('[name=txid]').waitFor();
    const hash='0x'+'ce'.repeat(32);await card.locator('[name=txid]').fill(hash);panel.once('dialog',d=>d.accept());
    await card.getByRole('button',{name:'Record as sent'}).click();await card.waitFor({state:'detached'});
    const receipt=page.locator('.transaction-details').filter({hasText:'Sent'});
    await receipt.locator('summary').click();assert.equal(await receipt.getByRole('link').getAttribute('href'),'https://etherscan.io/tx/'+hash);
    await page.click('#noticeBell');const popup=page.getByRole('dialog',{name:'Notifications'});
    await popup.getByText('Withdrawal sent',{exact:true}).waitFor();await popup.getByText('Withdrawal approved',{exact:true}).waitFor();
    await popup.getByText('Withdrawal requested',{exact:true}).waitFor();
    await popup.locator('.notice-entry').filter({hasText:'Withdrawal sent'}).locator('summary').click();
    assert.equal(await popup.getByRole('link',{name:hash}).getAttribute('href'),'https://etherscan.io/tx/'+hash);
    await page.keyboard.press('Escape');assert.ok(page.url().endsWith('/account/withdraw'));
  }finally{await admin.close();}
  await page.keyboard.press('Escape');
});
test('profile panes scroll independently, stats show a layout placeholder and respect reduced motion',async()=>{
  await page.setViewportSize({width:1100,height:440});await page.click('#meChip');
  await page.locator('.wallet-balances').waitFor();
  const rail=page.locator('.account-rail'),main=page.locator('.account-main');
  await main.hover();await page.mouse.wheel(0,300);
  await page.waitForFunction(()=>document.querySelector('.account-main')!.scrollTop>0);
  const offset=await main.evaluate(e=>e.scrollTop);assert.equal(await rail.evaluate(e=>e.scrollTop),0);
  await rail.hover();await page.mouse.wheel(0,250);
  await page.waitForFunction(()=>document.querySelector('.account-rail')!.scrollTop>0);
  assert.equal(await main.evaluate(e=>e.scrollTop),offset);assert.equal(await page.evaluate(()=>scrollY),0);
  let release!:()=>void;
  const hold=new Promise<void>(r=>release=r);
  delayResponse=async url=>{if(url.startsWith('/api/me/stats?'))await hold;};
  try{
    await page.click('#walletNav [data-view=stats]');const loader=page.locator('.skeleton-stats');
    await loader.waitFor();assert.equal(await loader.innerText(),'');
    assert.match(await loader.locator('i').first().evaluate(e=>getComputedStyle(e,'::after').animationName),/skeleton-sweep/);
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await loader.locator('i').first().evaluate(e=>getComputedStyle(e,'::after').animationName),'none');
  }finally{delayResponse=undefined;release();}
  await page.locator('.stats-grid').waitFor();await page.emulateMedia({reducedMotion:'no-preference'});
  await page.setViewportSize({width:1280,height:850});await page.click('#meChip');await screenshot('account-desktop');
  await page.keyboard.press('Escape');
});
test('admin search, detailed records and an audited credit reach a player with the notification popup open',async()=>{
  const ctx=await browser.newContext(),panel=await ctx.newPage();
  panel.setDefaultTimeout(7000);panel.on('pageerror',e=>errors.push(e.message));
  try{
    const login='op-'+randomUUID().slice(0,8),password=randomUUID(),email=username+'@test.invalid';
    await query('insert into admin_users(username,pass_hash) values($1,$2)',[login,hashPassword(password)]);
    await panel.goto(base+'/admin');await panel.locator('#l_user').waitFor();await screenshot('operator-sign-in',panel);
    await panel.fill('#l_user',login);await panel.fill('#l_pass',password);await panel.locator('#l_pass').press('Enter');
    await panel.locator('#nav').getByRole('button',{name:'Users',exact:true}).click();
    await panel.fill('#playerSearch',username.slice(1).toUpperCase());
    const row=panel.locator('[data-player]').filter({hasText:email});await row.waitFor();await panel.fill('#playerSearch',email);
    await panel.waitForFunction(()=>document.querySelectorAll('[data-player]').length===1);await screenshot('admin-directory',panel);await row.click();
    await panel.getByText('Account details',{exact:true}).waitFor();
    for(const tab of ['Statistics','Deposits','Withdrawals','Bets','Transactions']){
      await panel.locator('#playerTabs').getByRole('button',{name:tab,exact:true}).click();
      await panel.locator(tab==='Statistics'?'#playerStats table':'#playerRecord h3').waitFor();
    }
    await panel.locator('#playerTabs').getByRole('button',{name:'Controls',exact:true}).click();
    await choose(panel,'#adjustPlayer select[name=asset]','USDT');await panel.fill('#adjustPlayer [name=amount]','100');
    await panel.fill('#adjustPlayer [name=reason]','Browser reconciliation');
    await page.click('#ebwDep');await page.waitForURL('**/account/deposit');await page.click('#noticeBell');await page.locator('.popup-feed article').first().waitFor();
    const receipt=page.locator('.popup-feed article').filter({hasText:'Withdrawal sent'}).locator('details');
    await receipt.locator('summary').click();await receipt.locator('a').focus();const link=await receipt.locator('a').elementHandle();
    const route=page.url();panel.once('dialog',d=>d.accept());await panel.locator('#adjustPlayer button').click();
    await page.locator('.popup-feed').getByText('Balance credited',{exact:true}).waitFor();
    assert.equal(page.url(),route);assert.ok(await receipt.evaluate(el=>el.hasAttribute('open')));
    assert.ok(await receipt.locator('a').evaluate((el,old)=>el===old && document.activeElement===el,link));await screenshot('notification-popup');
    await panel.locator('#playerTabs').getByRole('button',{name:'Audit',exact:true}).click();
    const record=panel.locator('#playerRecord .record').first();await record.locator('summary').click();
    assert.match(await record.innerText(),/Browser reconciliation/);
    await page.route('**/api/me/notifications/read',r=>r.fulfill({status:503,json:{error:'Temporarily unavailable'}}),{times:1});
    await page.click('#readPopup');await page.getByRole('status').filter({hasText:/could not mark notifications/i}).waitFor();
    assert.ok(await receipt.evaluate(el=>el.hasAttribute('open')));assert.ok(await page.locator('#readPopup').isEnabled());
    await page.click('#readPopup');await page.waitForFunction(()=>!document.querySelector('#noticeBell')!.classList.contains('has-unread'));
    await page.click('#openInbox');await page.waitForURL('**/account/notifications');await page.getByText('0 unread',{exact:true}).waitFor();
    await screenshot('notifications-desktop');
    const uid=(await query('select id from users where username=$1',[username])).rows[0].id;
    const round=await startMines(uid,'USDT','100',25,3,randomUUID());
    const mines=(await query('select mine_positions from mines_rounds where id=$1',[round.id])).rows[0].mine_positions;
    await revealMines(uid,mines[0],round.id);
    await page.click('#walletNav [data-view=rewards]');const claim=page.locator('[data-claim="1"]');await claim.waitFor();
    await screenshot('rewards-desktop');await claim.click();
    const bronze=page.locator('#walletContent .vip-tiers details').filter({has:page.locator('summary').getByText(/Bronze/)});
    await bronze.locator('.vip-row').filter({has:page.getByText('Rank I',{exact:true})}).getByText('Claimed',{exact:true}).waitFor();
    await page.click('#walletNav [data-view=notifications]');await page.locator('#noticeList').getByText('Level bonus credited',{exact:true}).waitFor();
    await page.click('#markRead');await page.getByText('0 unread',{exact:true}).waitFor();
    await page.setViewportSize({width:320,height:650});await screenshot('notifications-phone');
    await page.click('#walletNav [data-view=rewards]');await page.locator('.vip-summary').waitFor();
    assert.ok(await page.locator('#walletContent').evaluate(e=>e.scrollWidth<=e.clientWidth));await screenshot('rewards-phone');
    await page.click('#noticeBell');const bounds=await page.locator('#noticePopup').boundingBox();
    assert.ok(bounds && bounds.x>=0 && bounds.x+bounds.width<=320 && bounds.y+bounds.height<=650);
    await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  }finally{await ctx.close();}
});
test('operator navigation discards late responses and recovers from a failed load on a narrow viewport',async()=>{
  const ctx=await browser.newContext({viewport:{width:320,height:520},reducedMotion:'reduce'}),p=await ctx.newPage();
  let release: (()=>void)|undefined;
  try{
    const username='desk-'+randomUUID().slice(0,8),password=randomUUID();
    await query('insert into admin_users(username,pass_hash) values($1,$2)',[username,hashPassword(password)]);
    assert.ok((await ctx.request.post(base+'/api/admin/login',{data:{username,password}})).ok());
    await p.goto(base+'/admin');await p.locator('.stats').waitFor();
    const nav=p.getByRole('navigation',{name:'Treasury sections'}),overview=nav.getByRole('button',{name:'Overview',exact:true});
    await overview.focus();await p.keyboard.press('End');assert.ok(await nav.getByRole('button',{name:'Audit',exact:true}).evaluate(el=>el===document.activeElement));
    await p.keyboard.press('Home');assert.ok(await overview.evaluate(el=>el===document.activeElement));
    let started!:()=>void;const waiting=new Promise<void>(r=>started=r),hold=new Promise<void>(r=>release=r);
    delayResponse=async url=>{if(url==='/api/admin/deposits'){started();await hold;}};
    const late=p.waitForResponse(r=>r.url().endsWith('/api/admin/deposits'));
    await nav.getByRole('button',{name:'Deposits',exact:true}).click();await waiting;
    await p.locator('#view[aria-busy=true] .load-state').waitFor();
    assert.equal(await p.locator('.load-state:visible').evaluate(el=>getComputedStyle(el,'::before').animationName),'none');
    await nav.getByRole('button',{name:'Users',exact:true}).click();const search=p.getByLabel('Find a player');
    await search.fill('no-matching-operator-qa');await p.getByText(/No matching users/i).waitFor();
    release!();await (await late).finished();await p.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
    assert.equal(await p.locator('#sectionTitle').textContent(),'Users');assert.ok(await search.evaluate(el=>el===document.activeElement));
    assert.equal(await p.locator('#view table').count(),0);assert.equal(await nav.locator('[aria-current=page]').textContent(),'Users');
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await screenshot('operator-directory-phone',p);

    await p.route('**/api/admin/deposits',r=>r.fulfill({status:503,json:{error:'Temporarily unavailable'}}),{times:1});
    await nav.getByRole('button',{name:'Deposits',exact:true}).click();await p.getByRole('alert').filter({hasText:/could not load deposits/i}).waitFor();
    await p.getByRole('button',{name:'Try again'}).click();await p.getByRole('region',{name:'Deposit ledger'}).waitFor();
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await nav.getByRole('button',{name:'Secrets',exact:true}).click();await picker(p,'#s_name').waitFor();
    await choose(p,'#s_name','rpc:ETH');assert.equal(await p.locator('#s_name').inputValue(),'rpc:ETH');
    await choose(p,'#s_name','custom');await p.getByLabel('Custom secret name').waitFor();
    const mast=await p.locator('.masthead').boundingBox(),strip=await nav.boundingBox();
    await p.mouse.move(175,400);await p.mouse.wheel(0,380);await p.waitForFunction(()=>document.getElementById('workspaceScroll')!.scrollTop>0);
    assert.deepEqual(await p.locator('.masthead').boundingBox(),mast);assert.deepEqual(await nav.boundingBox(),strip);
    assert.equal(await p.evaluate(()=>scrollY),0);
  }finally{release?.();delayResponse=undefined;await ctx.close();}
});
test('the main logo returns from an account page or a game to the home entry point',async()=>{
  await page.click('#meChip');await page.waitForURL('**/account/profile');
  const logo=page.getByRole('link',{name:'EmpireBlox home'}),documentRoot=await page.locator('html').elementHandle();
  assert.equal(await logo.evaluate(el=>getComputedStyle(el).getPropertyValue('-webkit-tap-highlight-color')),'rgba(0, 0, 0, 0)');
  await page.keyboard.press('Tab');await logo.focus();assert.ok(await logo.evaluate(el=>el.matches(':focus-visible') && getComputedStyle(el).outlineStyle==='solid'));
  await page.keyboard.press('Enter');await page.waitForURL(base+'/');
  assert.ok(await page.locator('html').evaluate((el,old)=>el===old,documentRoot));
  await page.goBack();await page.waitForURL('**/account/profile');await page.locator('.wallet-balances').waitFor();
  await page.click('#gamesBtn');await page.click('[data-p=cases]');await page.locator('#cases.on').waitFor();
  await logo.click();await page.waitForURL(base+'/');await page.locator('#home.on').waitFor();
  await page.locator('#ebwCcy').waitFor();
});
test('Mines previews and cash-out receipts round ETH while the journal credits the exact payout',async()=>{
  await page.click('#gamesBtn');await page.click('#gmenu [data-p=mines]');
  await page.fill('#mBet','0.123456789');const started=page.waitForResponse(r=>r.url().endsWith('/api/games/mines/start'));
  await page.click('#mPlay');const round=await (await started).json();
  const row=(await query('select mine_positions,user_id from mines_rounds where id=$1',[round.id])).rows[0];
  const safe=Array.from({length:25},(_,i)=>i).find(i=>!row.mine_positions.includes(i))!;
  await page.locator('#board .tile').nth(safe).click();
  const cashout=page.locator('#mPlay').filter({hasText:'Cash out'});await cashout.waitFor();
  const preview=(await cashout.innerText()).replace('Cash out ','');assert.match(preview,/^0\.\d{1,5} ETH$/);
  const finished=page.waitForResponse(r=>r.url().endsWith('/api/games/mines/cashout'));
  await cashout.click();const result=await (await finished).json();
  const units=BigInt(result.payout),rounded=(units+5000000000000n)/10000000000000n;
  assert.notEqual(units%10000000000000n,0n);assert.equal(preview,(Number(rounded)/100000).toString()+' ETH');
  await page.locator('#toast').getByText('Cashed out +'+preview,{exact:false}).waitFor();
  const entry=(await query("select e.delta from ledger_entries e join journals j on j.id=e.journal_id where j.kind='payout:mines' and e.account=$1 order by e.id desc limit 1",['u:'+row.user_id])).rows[0];
  assert.equal(entry.delta,result.payout);
});
test('mobile account navigation, fixed header and security settings fit phone viewports',async()=>{
  for(const width of [320,375,390,430,740]){
    await page.setViewportSize({width,height:650});
    await page.click('#meChip');await page.locator('.profile-funds').waitFor();
    const top=page.locator('header.top'),before=await top.boundingBox();assert.equal(before?.y,0);
    const pane=page.getByRole('region',{name:'Page content'});
    const pinnedNav=await page.locator('#gamesBtn').boundingBox();
    const headerBottom=before!.y+before!.height;
    await page.mouse.move(width/2,380);await page.mouse.wheel(0,280);
    await page.waitForFunction(()=>document.getElementById('pageScroll')!.scrollTop>0);
    assert.equal(await page.evaluate(()=>scrollY),0);assert.deepEqual(await top.boundingBox(),before);
    assert.deepEqual(await page.locator('#gamesBtn').boundingBox(),pinnedNav);
    assert.equal((await pane.boundingBox())?.y,headerBottom);
    const home=page.getByRole('link',{name:'EmpireBlox home'}),brand=await home.boundingBox();assert.ok(brand && brand.height>=44);
    if(brand.width<=84)assert.match(await home.locator('img').evaluate(el=>getComputedStyle(el).content),/dice-gold/);
    const headerBoxes=await page.locator('.top .logo,#ebwCcy,#ebwDep,#noticeBell,#meChip').evaluateAll(els=>els.map(el=>{const b=el.getBoundingClientRect();return [b.left,b.right,b.width];}));
    for(let i=0;i<headerBoxes.length;i++){
      const [left,right,w]=headerBoxes[i] as [number,number,number];
      assert.ok(left>=0 && right<=width && w>=28,JSON.stringify(headerBoxes));
      if(i)assert.ok(left>=(headerBoxes[i-1]![1]!-1));
    }
    assert.equal(await page.locator('#accountPage #changeName').count(),0);
    assert.ok(await page.locator('#accountPage').evaluate(e=>e.scrollWidth<=e.clientWidth));
    const games=await page.locator('#gamesBtn').boundingBox();assert.ok(games && games.y>550 && games.y+games.height<=651);
  }
  await page.setViewportSize({width:390,height:750});await page.click('#meChip');await screenshot('account-mobile-final');
  await page.click('#walletNav [data-view=security]');await page.waitForURL('**/account/security');
  await page.reload();await page.locator('#changePassword').waitFor();
  await page.fill('#changeName [name=username]',username);await page.click('#changeName button');
  await page.getByText('Username saved.',{exact:true}).waitFor();
  await page.fill('#changePassword [name=current]','test-password-123');await page.fill('#changePassword [name=password]','new-browser-pw-456');
  await page.click('#changePassword button');await page.getByText('Password changed. Other sessions were signed out.').waitFor();
  await screenshot('security-mobile-final');
  await page.click('.top .logo');await page.waitForURL(base+'/');
  for(const game of ['mines','blackjack','cases','battles','upgrader']){
    await page.click('#gamesBtn');await page.locator('#gmenu [data-p='+game+']').click();await page.locator('#'+game+'.on').waitFor();
    const overflow=await page.locator('#'+game).evaluate(el=>el.scrollWidth<=el.clientWidth+1?[]:Array.from(el.querySelectorAll('*')).filter(n=>n.getBoundingClientRect().right>el.getBoundingClientRect().right+1 && !n.closest('.tabs,.vscroll')).slice(0,10).map(n=>[n.tagName,n.id,n.className,n.getBoundingClientRect().width]));
    assert.deepEqual(overflow,[],'game overflow '+game+' '+JSON.stringify(overflow));
    assert.ok(await page.locator('#'+game).evaluate(el=>el.scrollWidth<=el.clientWidth+1),'game overflows its content box');
    if(game==='cases'||game==='upgrader'){
      const values=page.locator('#'+game+' .cv');await values.first().waitFor();
      const amounts=(await values.allTextContents()).filter(v=>v.endsWith(' ETH'));
      assert.ok(amounts.length>0);assert.ok(amounts.every(v=>/^\d+(?:\.\d{1,5})? ETH$/.test(v)),game);
    }
  }
});
test('phone deposit sheet fits, preserves playing currency and ledger type filters show matching records',async()=>{
  for(const width of [320,390]){
    await page.setViewportSize({width,height:480});await page.click('#ebwDep');
    const sheet=page.getByRole('dialog',{name:'Deposit currency'});await sheet.waitFor();
    await expectBelow(page,'#ebwDep','#ebwMenu[open]');
    const bounds=await sheet.boundingBox();assert.ok(bounds && bounds.x>=0 && bounds.x+bounds.width<=width && bounds.y>=0 && bounds.y+bounds.height<=480);
    await screenshot('deposit-sheet-'+width);
    await sheet.locator('[data-asset="USDT"]').click();await page.waitForURL('**/account/deposit');await page.locator('#depositAddress').waitFor();
    assert.equal(await page.inputValue('#depositNetwork'),'USDT.ERC20');assert.equal(await page.evaluate(()=>(window as any).ebCurrency()),'ETH');
    await page.click('#walletNav [data-view=transactions]');await picker(page,'#transactionType').waitFor();
    for(const [type,label] of [['bets','Stake'],['withdrawals','Withdrawal reserved'],['deposits','Deposit'],['rewards','Level bonus'],['adjustments','Balance credit']]){
      await choose(page,'#transactionType',type!);
      await page.locator('.transaction-details summary').filter({hasText:label!}).first().waitFor();
      assert.equal(await page.inputValue('#transactionType'),type);
    }
  }
  await page.click('#rewardsBtn');await page.locator('#vipLobby .vip-tiers').waitFor();
  assert.equal(await page.locator('#rewards').getByText(/daily pack|open pack|loading packs/i).count(),0);
  assert.equal(await page.locator('#vipLobby details').count(),9);
});
test('currency picker preserves focus, reports failed saves and does not dismiss a newer deposit sheet',async()=>{
  const ctx=await browser.newContext({viewport:{width:700,height:270}}),p=await ctx.newPage();
  let release: (()=>void)|undefined;
  try{
    const name='pick'+randomUUID().slice(0,8);
    const registration=await ctx.request.post(base+'/api/auth/register',{data:{username:name,email:name+'@test.invalid',password:randomUUID()}});
    assert.equal(registration.status(),200);await p.goto(base);await p.click('#ebwCcy');
    const sheet=p.getByRole('dialog',{name:'Playing currency'}),list=sheet.locator('.sheet-list');
    assert.ok(await sheet.evaluate(el=>el.matches(':modal')));
    assert.ok(await list.evaluate(el=>el.scrollHeight>el.clientHeight));
    const last=list.locator('button').last();await p.keyboard.press('End');
    assert.ok(await last.evaluate(el=>el===document.activeElement));
    const row=await last.elementHandle();
    await p.evaluate(()=>(window as any).ebWalletRefresh());
    assert.ok(await last.evaluate((el,old)=>el===old && el===document.activeElement,row));
    await p.keyboard.press('Home');assert.ok(await list.locator('button').first().evaluate(el=>el===document.activeElement));
    await p.keyboard.press('Escape');assert.ok(await p.locator('#ebwCcy').evaluate(el=>el===document.activeElement));

    await p.setViewportSize({width:1120,height:760});await p.emulateMedia({reducedMotion:'reduce'});await p.click('#ebwCcy');
    assert.equal(await sheet.evaluate(el=>el.matches(':modal')),false);
    assert.equal(await sheet.evaluate(el=>getComputedStyle(el).animationName),'none');
    const before=await p.evaluate(()=>(window as any).ebCurrency());
    const other=sheet.locator('[data-asset][aria-pressed=false]').first(),id=await other.getAttribute('data-asset');
    await p.route('**/api/me/currency',r=>r.fulfill({status:503,json:{error:'Temporarily unavailable'}}),{times:1});
    await other.click();await sheet.getByRole('status').filter({hasText:'Currency was not changed'}).waitFor();
    assert.equal(await p.evaluate(()=>(window as any).ebCurrency()),before);
    assert.ok(await other.evaluate(el=>el===document.activeElement && !el.hasAttribute('aria-disabled')));

    let started!:()=>void;
    const waiting=new Promise<void>(r=>started=r),hold=new Promise<void>(r=>release=r);
    delayResponse=async url=>{if(url==='/api/me/currency'){started();await hold;}};
    await other.click();await waiting;await sheet.getByRole('status').filter({hasText:'Saving'}).waitFor();
    await p.keyboard.press('Escape');await p.setViewportSize({width:320,height:480});await p.click('#ebwDep');
    const deposit=p.getByRole('dialog',{name:'Deposit currency'});await deposit.waitFor();
    const focused=await deposit.locator(':focus').getAttribute('data-asset');assert.ok(focused);
    release!();await p.waitForFunction(id=>(window as any).ebCurrency()===id,id);
    assert.ok(await deposit.isVisible());assert.equal(await deposit.locator(':focus').getAttribute('data-asset'),focused);
    assert.match(await deposit.locator('[data-asset=USDT] b').innerText(),/networks?$/);
    assert.equal(await deposit.evaluate(el=>getComputedStyle(el).animationName),'none');
    await p.keyboard.press('Escape');assert.ok(await p.locator('#ebwDep').evaluate(el=>el===document.activeElement));
    await p.emulateMedia({reducedMotion:'no-preference'});await p.click('#ebwDep');
    await expectBelow(p,'#ebwDep','#ebwMenu[open]');
    await screenshot('currency-sheet-compact',p);
  }finally{release?.();delayResponse=undefined;await ctx.close();}
});
test('page copying and zoom shortcuts are suppressed while form editing still works',async()=>{
  const state=await page.evaluate(`(() => {
    const fire=(el,event)=>!el.dispatchEvent(event);
    document.querySelector('#ebwCcy').focus();
    const copy=()=>new Event('copy',{bubbles:true,cancelable:true});
    return {page:fire(document.body,copy()),input:fire(document.querySelector('#mBet'),copy()),
      zoom:fire(document,new KeyboardEvent('keydown',{key:'+',ctrlKey:true,bubbles:true,cancelable:true})),
      scroll:fire(document,new WheelEvent('wheel',{bubbles:true,cancelable:true})),
      pinch:fire(document,new WheelEvent('wheel',{ctrlKey:true,bubbles:true,cancelable:true}))};
  })()`);
  assert.deepEqual(state,{page:true,input:false,zoom:true,scroll:false,pinch:true});
  await page.click('#meChip'); await page.click('[data-signout]'); await page.locator('#signBtn').waitFor();
  assert.equal(await page.isVisible('#ebwPill'),false); assert.deepEqual(errors,[]);
});

test('guest deep link prompts for sign-in and another player sees an empty private inbox',async()=>{
  await page.goto(base+'/account/notifications');await page.getByRole('button',{name:'Sign in to your account'}).click();
  const name='new'+randomUUID().slice(0,8);
  await page.locator('[data-v=signup]').click();await page.fill('#suName',name);await page.fill('#suEmail',name+'@test.invalid');
  await page.fill('#suPass','another-account-456');await page.check('#suAge');await page.click('#suGo');
  await page.locator('#noticeList').getByText('No account notifications yet.').waitFor();
  assert.ok(page.url().endsWith('/account/notifications'));await page.click('#noticeBell');await page.locator('.popup-empty').waitFor();
  assert.equal(await page.locator('.popup-feed .notice-entry').count(),0);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#noticePopup').isVisible(),false);
  assert.deepEqual(errors,[]);
});

test('an unavailable session check can be retried on the same account deep link',async()=>{
  const ctx=await browser.newContext({viewport:{width:390,height:480}}),p=await ctx.newPage();
  let release: (()=>void)|undefined;
  try{
    const username='again'+randomUUID().slice(0,8);
    assert.ok((await ctx.request.post(base+'/api/auth/register',{data:{username,email:username+'@test.invalid',password:randomUUID()}})).ok());
    await p.route('**/api/auth/me',r=>r.fulfill({status:503,json:{error:'Temporarily unavailable'}}),{times:1});
    await p.goto(base+'/account/security');const account=p.locator('#walletContent');
    await account.getByText('Could not check your session.').waitFor();assert.equal(await p.locator('#signBtn,[data-login]').count(),0);
    assert.equal(await p.locator('#ebwPill').isVisible(),false);
    const documentRoot=await p.locator('html').elementHandle();
    const hold=new Promise<void>(r=>release=r);delayResponse=async url=>{if(url==='/api/auth/me')await hold;};
    await account.getByRole('button',{name:'Try again'}).click();await account.getByRole('status',{name:'Checking your session'}).waitFor();
    assert.equal(await p.locator('#sessionAction').isDisabled(),true);
    release!();await p.locator('#changeName').waitFor();assert.equal(await p.locator('#meChip .nm').textContent(),username);
    assert.equal(new URL(p.url()).pathname,'/account/security');assert.ok(await p.locator('html').evaluate((el,old)=>el===old,documentRoot));

    const draft=p.locator('#changeName [name=username]');await draft.fill('unsaved_draft');
    await p.click('#walletNav [data-view=security]');assert.equal(await draft.inputValue(),'unsaved_draft');
    await p.locator('#pageScroll').evaluate(el=>el.scrollTo(0,el.scrollHeight));
    const nav=p.locator('#walletNav');assert.ok(await nav.evaluate(el=>Math.abs(el.getBoundingClientRect().top-document.querySelector('.top')!.getBoundingClientRect().bottom)<=1));
    await p.click('#walletNav [data-view=transactions]');await picker(p,'#transactionType').waitFor();await p.goBack();
    await draft.waitFor();assert.equal(await nav.locator('[aria-current=page]').getAttribute('data-view'),'security');
    assert.ok(await p.locator('#walletTitle').evaluate(el=>el===document.activeElement && el.getBoundingClientRect().top>=document.querySelector('#walletNav')!.getBoundingClientRect().bottom));
  }finally{release?.();delayResponse=undefined;await ctx.close();}
});

test('touch swipes scroll only the pane below the masthead, including reversals and scroll boundaries',async()=>{
  const ctx=await browser.newContext({viewport:{width:390,height:600},hasTouch:true,isMobile:true}),p=await ctx.newPage();
  try{
    const username='scroll'+randomUUID().slice(0,8);
    assert.ok((await ctx.request.post(base+'/api/auth/register',{data:{username,email:username+'@test.invalid',password:randomUUID()}})).ok());
    await p.goto(base);await p.locator('#meChip').waitFor();const cdp=await ctx.newCDPSession(p);
    const pane=p.getByRole('region',{name:'Page content'}),header=p.locator('.top'),bottom=p.locator('.top .nav');
    async function swipe(from:number,to:number){
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:180,y:from}]});
      for(let i=1;i<=8;i++){
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:180,y:from+(to-from)*i/8}]});
        await p.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>r())));
      }
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }
    const rootPosition=()=>p.evaluate(()=>[scrollY,document.documentElement.scrollTop,document.body.scrollTop,visualViewport?.pageTop]);
    const topBox=await header.boundingBox(),bottomBox=await bottom.boundingBox(),paneBox=await pane.boundingBox();
    assert.ok(topBox && bottomBox && paneBox && paneBox.y===topBox.height && paneBox.y+paneBox.height===bottomBox.y);
    await p.click('#gamesBtn');await p.click('#gmenu [data-p=battles]');await p.getByRole('combobox',{name:'Sort battles'}).tap();
    const sort=p.getByRole('listbox',{name:'Sort battles'});await sort.getByRole('option',{name:'Newest First'}).tap();
    assert.equal(await p.inputValue('#bSort'),'new');assert.deepEqual(await rootPosition(),[0,0,0,0]);
    await p.click('#gamesBtn');await p.click('#gmenu [data-p=cases]');await p.locator('#caseGrid button').first().waitFor();
    await swipe(470,190);await p.waitForFunction(()=>document.getElementById('pageScroll')!.scrollTop>100);
    assert.deepEqual(await rootPosition(),[0,0,0,0]);assert.deepEqual(await header.boundingBox(),topBox);assert.deepEqual(await bottom.boundingBox(),bottomBox);
    await pane.evaluate(el=>el.scrollTop=el.scrollHeight);await swipe(425,170);
    assert.deepEqual(await rootPosition(),[0,0,0,0]);
    const footer=await pane.locator('footer').boundingBox();assert.ok(footer && Math.abs(footer.y+footer.height-bottomBox.y)<=1);
    await p.click('#meChip');await p.locator('.profile-funds').waitFor();await p.click('#walletNav [data-view=security]');await p.locator('#changePassword').waitFor();
    await swipe(470,190);await p.waitForFunction(()=>document.getElementById('pageScroll')!.scrollTop>100);
    assert.equal((await p.locator('#walletNav').boundingBox())?.y,topBox.height);assert.deepEqual(await header.boundingBox(),topBox);
    await pane.evaluate(el=>el.scrollTop=0);await swipe(180,445);assert.equal(await pane.evaluate(el=>el.scrollTop),0);
    assert.deepEqual(await rootPosition(),[0,0,0,0]);assert.deepEqual(await bottom.boundingBox(),bottomBox);
    await p.setViewportSize({width:390,height:415});const smaller=await pane.boundingBox(),tabs=await bottom.boundingBox();
    assert.ok(smaller && tabs && smaller.y===topBox.height && smaller.y+smaller.height===tabs.y && Math.abs(tabs.y+tabs.height-415)<=1);
    await p.keyboard.press('Escape');await p.locator('#cases.on').waitFor();assert.ok(await pane.evaluate(el=>el.scrollTop>100));
    await p.click('#rewardsBtn');assert.equal(await pane.evaluate(el=>el.scrollTop),0);assert.deepEqual(await rootPosition(),[0,0,0,0]);
  }finally{await ctx.close();}
});
