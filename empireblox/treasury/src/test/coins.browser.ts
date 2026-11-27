/// <reference lib="dom" />
import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { readFile,mkdir } from 'node:fs/promises';
import { extname,resolve } from 'node:path';
import { chromium,type Browser,type BrowserContext,type Page } from 'playwright';
import { buildServer } from '../api/server.js';
import { query,pool,tx } from '../db.js';
import { post,balanceOf } from '../ledger.js';
import { startMines,revealMines } from '../games/mines.js';
import { installMarketFixture } from './market-fixture.js';

installMarketFixture();
const app=await buildServer(),root=resolve('..'),shots=process.env.COIN_SCREENSHOT_DIR||'/tmp/empireblox-coins-qa';
let browser:Browser,context:BrowserContext,page:Page,base:string,uid:string;
const errors:string[]=[],unit=10n**18n;
const balance=(asset='COINS')=>tx(c=>balanceOf(c,'u:'+uid,asset));
async function shot(name:string){await page.locator('#accountAlert:not([hidden]) .notice-dismiss').click({timeout:250}).catch(()=>{});await mkdir(shots,{recursive:true});await page.evaluate(()=>document.fonts.ready.then(()=>true));await page.screenshot({path:resolve(shots,name+'.png'),animations:'disabled'});}
before(async()=>{
  app.get('/*',async(req,reply)=>{
    const pathname=req.url.split('?')[0]!,path=/^\/account\/[a-z]+\/?$/.test(pathname)?'/':pathname;
    if(!['/','/app.js','/wallet.js','/config.js'].includes(path)&&!path.startsWith('/assets/'))return reply.code(404).send();
    const name=path==='/'?'index.html':path.slice(1),mime:Record<string,string>={'.html':'text/html','.js':'application/javascript','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.css':'text/css','.woff2':'font/woff2'};
    return reply.type(mime[extname(name)]||'application/octet-stream').send(await readFile(resolve(root,name)));
  });
  base=await app.listen({host:'127.0.0.1',port:0});
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']});
  context=await browser.newContext({viewport:{width:1440,height:1000}});
  const name='cui'+randomBytes(5).toString('hex'),r=await context.request.post(base+'/api/auth/register',{data:{username:name,email:name+'@fixture.invalid',password:randomUUID()}});
  assert.equal(r.status(),200);uid=(await r.json()).user.id;
  await tx(c=>post(c,'fixture:funding',uid,[{account:'ext:fixture',asset:'USDT',delta:-20n*unit},{account:'u:'+uid,asset:'USDT',delta:20n*unit}]));
  page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('#ebwBal').filter({hasText:'0'}).waitFor();
});
after(async()=>{await browser?.close();await app.close();await pool.end();assert.deepEqual(errors,[]);});

test('header uses a coin icon and the conversion screen fits phones and desktop',async()=>{
  assert.equal(await page.locator('#ebwSym').innerText(),'COINS');assert.match(await page.locator('#ebwIco img').getAttribute('src')||'',/coin\.svg$/);
  await page.click('#meChip');await page.locator('#walletNav [data-view=conversion]').click();await page.locator('#conversionForm').waitFor();
  assert.equal(await page.locator('#walletTitle').innerText(),'Conversion');
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:width<740?850:1000});
    assert.ok(await page.locator('#accountPage').evaluate(el=>el.scrollWidth<=el.clientWidth),'Account must fit '+width);
    assert.ok(await page.locator('.conversion-card').evaluate(el=>el.scrollWidth<=el.clientWidth),'Form must fit '+width);
    await shot('conversion-'+width);
  }
});

test('review and confirmation convert 10 USDT into 6,000 server coins, surviving reload',async()=>{
  await page.setViewportSize({width:390,height:850});await page.fill('#conversionAmount','10');await page.click('#conversionSubmit');
  await page.locator('#conversionReview:not([hidden])').waitFor();assert.equal(await page.locator('#conversionGet').innerText(),'6000 COINS');
  assert.equal(await balance(),0n);await shot('conversion-review-phone');
  await page.click('#conversionSubmit');await page.locator('#conversionReceipt:not([hidden])').waitFor();
  assert.equal(await balance(),6000n*unit);assert.equal(await balance('USDT'),10n*unit);
  await page.reload();await page.locator('#conversionForm').waitFor();assert.equal(await page.locator('#ebwBal').innerText(),'6,000');
  await page.locator('#conversionRecords .transaction-details').first().waitFor();assert.match(await page.locator('#conversionRecords').innerText(),/6000 COINS/);
});

test('a lost confirmation response retries the same request without a second debit',async()=>{
  await page.fill('#conversionAmount','1');await page.click('#conversionSubmit');await page.locator('#conversionReview:not([hidden])').waitFor();
  let lost=false;
  const intercept=async(route:import('playwright').Route)=>{
    if(route.request().method()!=='POST'||lost)return route.continue();
    lost=true;await route.fetch();return route.abort('failed');
  };
  await page.route('**/api/me/conversions',intercept);
  try{
    await page.click('#conversionSubmit');await page.getByRole('button',{name:'Check pending conversion',exact:true}).waitFor();
    assert.equal(await balance(),6600n*unit);await page.click('#conversionSubmit');await page.locator('#conversionReceipt:not([hidden])').waitFor();
    assert.equal(await balance(),6600n*unit);assert.equal(await balance('USDT'),9n*unit);
    assert.equal((await query('select count(*) from wallet_conversions where user_id=$1',[uid])).rows[0].count,'2');
  }finally{await page.unroute('**/api/me/conversions',intercept);}
});

test('coins convert back to crypto and the original withdrawal popup displays the crypto balance',async()=>{
  await page.locator('[data-direction=coins_to_crypto]').click();await page.fill('#conversionAmount','600');await page.click('#conversionSubmit');
  await page.locator('#conversionReview:not([hidden])').waitFor();assert.equal(await page.locator('#conversionGet').innerText(),'1 USDT');
  await page.click('#conversionSubmit');await page.locator('#conversionWithdraw').waitFor();await page.click('#conversionWithdraw');
  await page.locator('#popupWithdrawForm').waitFor();assert.match(await page.locator('#popupWithdrawAvailable').innerText(),/^10 USDT$/);
  await page.evaluate(()=>(window as any).ebWalletRefresh());assert.match(await page.locator('#popupWithdrawAvailable').innerText(),/^10 USDT$/);
  await shot('withdraw-crypto-phone');await page.keyboard.press('Escape');
});

test('settled coin stakes appear in coin statistics and weekly standings with prizes',async()=>{
  const round=await startMines(uid,'COINS','100',25,3),mine=(await query('select mine_positions from mines_rounds where id=$1',[round.id])).rows[0].mine_positions[0];
  await revealMines(uid,mine);await page.locator('#walletNav [data-view=stats]').click();await page.locator('.result-chart').waitFor();
  assert.match(await page.locator('.stats-grid').innerText(),/100 COINS/);assert.doesNotMatch(await page.locator('#walletContent').innerText(),/USDT|USD|\$/);
  await page.click('#lbBtn');await page.locator('#leaderboard.on .lb-leader').first().waitFor();
  assert.equal(await page.locator('.podium .lb-leader').count(),3);assert.match(await page.locator('#lbMe').innerText(),/#\d+/);
  assert.match(await page.locator('.podium-prize').nth(1).innerText(),/150,000 COINS/);
  for(const width of [320,390,1440]){await page.setViewportSize({width,height:width<740?900:1100});assert.ok(await page.locator('#leaderboard').evaluate(el=>el.scrollWidth<=el.clientWidth));await shot('leaderboard-'+width);}
});

test('earned winter daily pack opens once and the retired VIP program is absent',async()=>{
  await query('update users set catalog_wagered=(select xp from levels where level=10) where id=$1',[uid]);
  await page.setViewportSize({width:1440,height:1000});await page.click('#rewardsBtn');await page.locator('#rewards.on [data-pk="10"]').waitFor();
  assert.equal(await page.locator('#rwGrid .pk').count(),10);await shot('rewards-desktop');
  await page.setViewportSize({width:390,height:850});await shot('rewards-phone');
  await page.locator('[data-pack-view="10"]').click();await page.locator('#rwItems .ic2').first().waitFor();
  const before=await balance();await page.click('#rwOpen');await page.locator('#rwStatus').filter({hasText:'credited to your coin balance'}).waitFor();
  assert.ok(await balance()>before);assert.equal(await page.locator('#rwOpen').isDisabled(),true);assert.match(await page.locator('#rwOpen').innerText(),/Opens in/);
  await page.click('#rwBack');assert.equal(await page.locator('#vipLobby,[data-reward-tab=levels],[data-claim]').count(),0);
  const retired=await context.request.post(base+'/api/me/levels/1/claim',{data:{}});assert.equal(retired.status(),410);
  await page.click('#meChip');await page.locator('#walletNav [data-view=rewards]').click();await page.locator('.account-pack-grid').waitFor();
  assert.equal(await page.locator('.account-pack').count(),10);assert.doesNotMatch(await page.locator('#walletContent').innerText(),/Bronze|Diamond|USDT|\$/);
});

test('snow is optional, persists locally and stops for reduced motion',async()=>{
  await page.locator('.top .logo').click();await page.locator('#home.on').waitFor();
  await page.setViewportSize({width:1440,height:1000});await shot('lobby-desktop');
  await page.locator('#snowToggle').click();assert.equal(await page.locator('#snowToggle').getAttribute('aria-pressed'),'false');
  await page.reload();await page.locator('#snowToggle').waitFor();assert.equal(await page.locator('#snowToggle').getAttribute('aria-pressed'),'false');
  await page.locator('#snowToggle').click();await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>(document.getElementById('snowToggle') as HTMLButtonElement).disabled);
  assert.equal(await page.locator('#snowToggle').isDisabled(),true);assert.equal(await page.locator('#snow').isVisible(),false);
});
