/// <reference lib="dom" />
import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const origin='https://branding.test.invalid';
const logoPath='/assets/banditblox-logo.svg';
const user={id:'11111111-2222-4333-8444-555555555555',username:'Institutional_User20',email:'brand@fixture.invalid',created_at:'2026-11-26T12:00:00Z',display_ccy:'ETH',is_admin:false};
const asset={id:'ETH',symbol:'ETH',chain_id:'ETH',decimals:18,enabled:true,available:true};
let browser:Browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--host-resolver-rules=MAP * ~NOTFOUND']});});
after(()=>browser?.close());

async function fixture(t:TestContext,admin=false){
  const ctx=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  t.after(()=>ctx.close());
  const errors:string[]=[],unexpected:string[]=[],writes:string[]=[];
  await ctx.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname;
    if(url.origin!==origin)return route.abort();
    if(req.method()!=='GET'){writes.push(path);return route.fulfill({status:405,json:{error:'Branding fixture is read-only'}});}
    if(path.startsWith('/api/')){
      if(path==='/api/assets')return route.fulfill({json:{currencies:[asset],denominations:[asset],transferRoutes:[asset],directRoutes:[asset],chains:[],deposits_paused:false,withdrawals_paused:false}});
      if(path==='/api/auth/me')return route.fulfill({json:{user,balances:[{...asset,asset_id:'ETH',amount:'1234567890123456789'}]}});
      if(path==='/api/catalog')return route.fulfill({json:{levels:[],cases:[],items:[],upgrades:[],packs:[],rewardItems:[]}});
      if(path==='/api/battles/ETH'||path==='/api/me/battles/ETH')return route.fulfill({json:{battles:[]}});
      if(path.startsWith('/api/quote/'))return route.fulfill({json:{id:'brand-quote',asset_id:'ETH',unit:'1000000000000',expires_at:'2030-01-01T00:00:00Z'}});
      if(path==='/api/me/notifications/changes'||path==='/api/chat'&&url.search)return route.abort();
      if(path==='/api/chat')return route.fulfill({json:{messages:[]}});
      if(path==='/api/me/notifications')return route.fulfill({json:{revision:'0',unread:0,more:false,rows:[]}});
      if(path==='/api/me/levels'||path==='/api/reward-levels')return route.fulfill({json:{levels:[],wagered_usd:'0',unpriced:false}});
      if(path==='/api/me/deposits')return route.fulfill({json:{deposits:[]}});
      if(path==='/api/games/mines/active'||path==='/api/games/blackjack/active')return route.fulfill({json:{round:null}});
      if(path.startsWith('/api/leaderboard/'))return route.fulfill({json:{top:[],ends_at:'2030-01-07T00:00:00Z'}});
      if(path==='/api/admin/me')return route.fulfill(admin?{json:{username:'brand-operator',totp_enabled:true}}:{status:401,json:{error:'Unauthorized'}});
      if(path==='/api/admin/overview')return route.fulfill({json:{pending:0,credited:[],recent:[],deposits_paused:false}});
      unexpected.push(path);return route.fulfill({status:404,json:{error:'No branding fixture'}});
    }
    let file=path==='/'||path.startsWith('/account/')?'index.html':path.slice(1);
    if(path==='/admin')file='treasury/src/admin/index.html';
    if(path.startsWith('/admin/option-picker.'))file='assets/wallet/'+path.slice(7);
    const absolute=resolve(root,file);
    if(!absolute.startsWith(root))return route.abort();
    const mime:Record<string,string>={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'};
    try{return route.fulfill({body:await readFile(absolute),contentType:mime[extname(file)]||'application/octet-stream'});}
    catch{unexpected.push(path);return route.fulfill({status:404,body:''});}
  });
  const page=await ctx.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
  t.after(()=>{assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(writes,[]);});
  return {ctx,page};
}

async function screenshot(page:Page,name:string){
  const dir=process.env.BRANDING_SCREENSHOT_DIR;
  if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,name+'.png')});}
}

test('BANDITBLOX uses one self-contained vector logo and fits existing header geometry',async t=>{
  const svg=await readFile(resolve(root,'.'+logoPath),'utf8');
  assert.match(svg,/<title[^>]*>BANDITBLOX<\/title>/);
  assert.match(svg,/viewBox="0 0 640 116"/);
  assert.doesNotMatch(svg,/<text\b|<image\b|font-family|@import|(?:href|src)=["']https?:/);
  const {page}=await fixture(t);
  await page.goto(origin);await page.locator('#ebwCcy').waitFor();
  const art=await page.evaluate(source=>{
    const svg=new DOMParser().parseFromString(source,'image/svg+xml').documentElement as unknown as SVGSVGElement;
    svg.style.cssText='position:fixed;left:-2000px;top:0;width:640px;height:116px';
    document.body.append(svg);const box=svg.getBBox();svg.remove();
    return {left:box.x,top:box.y,right:box.x+box.width,bottom:box.y+box.height};
  },svg);
  assert.ok(art.left>=0&&art.top>=0&&art.right<=640&&art.bottom<=116,JSON.stringify(art));
  assert.equal(await page.title(),'BANDITBLOX | Games & Wallet');
  for(const width of [320,390,740,768,1024,1181,1200,1440]){
    await page.setViewportSize({width,height:900});
    const logo=page.getByRole('link',{name:'BANDITBLOX home'});
    assert.equal(await logo.locator('img').getAttribute('src'),logoPath);
    assert.equal(await logo.locator('img').getAttribute('alt'),'BANDITBLOX');
    const geometry=await logo.evaluate(el=>{
      const img=el.querySelector('img')!,a=el.getBoundingClientRect(),b=img.getBoundingClientRect(),style=getComputedStyle(img);
      return {complete:img.complete&&img.naturalWidth===640&&img.naturalHeight===116,inside:b.x>=a.x-.5&&b.right<=a.right+.5&&b.y>=a.y-.5&&b.bottom<=a.bottom+.5,header:document.querySelector('.top')!.scrollWidth<=innerWidth,filter:style.filter,opacity:style.opacity,content:style.content,width:a.width};
    });
    assert.equal(geometry.complete,true);assert.equal(geometry.inside,true,JSON.stringify({width,geometry}));
    assert.equal(geometry.header,true);assert.equal(geometry.filter,'none');assert.equal(geometry.opacity,'1');
    if(geometry.width<=84)assert.match(geometry.content,/dice-gold/);
    assert.doesNotMatch(await page.locator('body').innerText(),/empireblox/i);
    if(width===390||width===1440)await screenshot(page,'banditblox-header-'+width);
  }
  await page.click('#meChip');await page.locator('#walletContent .wallet-balances').waitFor();
  assert.match(await page.title(),/BANDITBLOX$/);
  await page.getByRole('link',{name:'BANDITBLOX home'}).click();await page.locator('#home.on').waitFor();
  assert.equal(await page.title(),'BANDITBLOX | Games & Wallet');
});

test('loading reveals the same BANDITBLOX logo and keeps cancellation and reduced motion',async t=>{
  const {page}=await fixture(t);
  await page.goto(origin);await page.locator('#ebwCcy').waitFor();
  for(const width of [390,1440]){
    await page.setViewportSize({width,height:900});
    await page.locator('#home [data-game-page=mines]').click();
    await page.locator('#pageTransition:not([hidden])').waitFor();
    const state=await page.locator('.transition-wordmark').evaluate(el=>{
      const reveal=el.querySelector('.transition-logo-reveal')!,style=getComputedStyle(reveal),b=el.getBoundingClientRect();
      return {brand:el.textContent,src:reveal.getAttribute('src'),animation:style.animationName,duration:style.animationDuration,exit:getComputedStyle(document.querySelector('#pageTransition')!).transitionDuration,inside:b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight};
    });
    assert.equal(state.brand,'BANDITBLOX');assert.equal(state.src,logoPath);assert.equal(state.animation,'brand-logo-complete');
    assert.equal(state.duration,'0.378s');assert.equal(state.exit,'0.1s');assert.equal(state.inside,true);
    assert.equal(await page.locator('#home.on').isVisible(),true);
    await page.locator('#pageTransition').evaluate(el=>{
      el.getAnimations({subtree:true}).forEach(a=>{a.pause();a.currentTime=378;});
    });
    await screenshot(page,'banditblox-loading-'+width);
    await page.locator('#mines.on').waitFor();
    await page.getByRole('link',{name:'BANDITBLOX home'}).click();await page.locator('#home.on').waitFor();
  }
  await page.locator('#home [data-game-page=blackjack]').click();await page.locator('#pageTransition:not([hidden])').waitFor();
  await page.locator('#meChip').click();await page.locator('#walletContent .wallet-balances').waitFor();
  assert.equal(await page.locator('#pageTransition').isVisible(),false);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.getByRole('link',{name:'BANDITBLOX home'}).click();await page.locator('#home.on').waitFor();
  await page.locator('#home [data-game-page=mines]').click();await page.locator('#mines.on').waitFor();
  assert.equal(await page.locator('#pageTransition').isVisible(),false);
  await page.evaluate(()=>{const el=document.getElementById('pageTransition')!;el.hidden=false;el.classList.add('is-running');});
  assert.equal(await page.locator('.transition-logo-reveal').evaluate(el=>getComputedStyle(el).animationName),'none');
  const clip=await page.locator('.transition-logo-reveal').evaluate(el=>getComputedStyle(el).clipPath);
  assert.ok(clip==='none'||clip.startsWith('inset(')&&[...clip.matchAll(/[\d.]+/g)].every(n=>Number(n[0])===0),'Reduced motion keeps the complete logo visible');
});

test('operator screens and new authenticator enrollment use the renamed public brand',async t=>{
  const {page}=await fixture(t,true);
  await page.goto(origin+'/admin');await page.locator('#app:not(.hide)').waitFor();
  for(const width of [320,390,1440]){
    await page.setViewportSize({width,height:900});
    assert.match(await page.title(),/BANDITBLOX Treasury$/);
    assert.match(await page.locator('.masthead .brand').innerText(),/^BANDITBLOX/);
    assert.doesNotMatch(await page.locator('body').innerText(),/empireblox/i);
    assert.equal(await page.locator('.masthead .brand').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  }
  const auth=await readFile(resolve(root,'treasury/src/authutil.ts'),'utf8');
  assert.match(auth,/issuer = 'BANDITBLOX Treasury'/);
  assert.doesNotMatch(auth,/EmpireBlox Treasury/);
});
