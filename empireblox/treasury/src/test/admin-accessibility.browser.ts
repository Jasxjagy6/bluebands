/// <reference lib="dom" />
import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Locator } from 'playwright';

// Every request is fulfilled or denied in memory; all credentials below are synthetic fixtures.
const origin='https://admin-accessibility.test.invalid',stamp='2026-11-26T18:00:00Z';
const pageFile=fileURLToPath(new URL('../admin/index.html',import.meta.url));
const pickerRoot=new URL('../../../assets/wallet/',import.meta.url);
const player='11111111-2222-4333-8444-555555555555',destination='0x'+'b2'.repeat(20);
const der=generateKeyPairSync('rsa',{modulusLength:3072}).publicKey.export({type:'spki',format:'der'});
const fingerprint=createHash('sha256').update(der).digest('hex');
let browser:Browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--host-resolver-rules=MAP * ~NOTFOUND']});});
after(()=>browser?.close());

async function fixture(t:TestContext,options:{login?:boolean;challenge?:boolean;factor?:boolean;enrollment?:boolean;width?:number}={}){
  const ctx=await browser.newContext({viewport:{width:options.width||390,height:844},serviceWorkers:'block'});
  t.after(()=>ctx.close());ctx.setDefaultTimeout(6000);
  const writes:{path:string;body:Record<string,unknown>}[]=[],requests:string[]=[],unexpected:string[]=[],errors:string[]=[];
  const user={id:player,username:'fixture-player',email:'player@fixture.invalid',status:'active',created_at:stamp};
  const row={id:player,chain_id:'ETH',provider:'direct',symbol:'ETH',amount:'123456789012345678',decimals:18,status:'pending',first_seen_at:stamp,created_at:stamp};
  const key={id:fingerprint,spki:der.toString('base64'),configured:!options.enrollment,ready:!options.enrollment,fee_address:null};
  const network={id:'ETH',display_name:'Ethereum',required_conf:15,rpc_configured:true,destination,destination_locked:false,sweeps_enabled:false,scan_ready:true,last_scanned:'70001234',ready:true,assets:[]};
  await ctx.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname;
    if(url.origin!==origin){unexpected.push(req.url());return route.abort();}
    requests.push(path+url.search);
    if(req.method()==='GET'){
      if(path==='/admin')return route.fulfill({path:pageFile,contentType:'text/html'});
      if(['/admin/option-picker.js','/admin/option-picker.css'].includes(path))return route.fulfill({path:fileURLToPath(new URL(path.slice(7),pickerRoot)),contentType:path.endsWith('.js')?'text/javascript':'text/css'});
      if(path==='/api/admin/me')return route.fulfill({status:options.login?401:200,json:options.login?{error:'Unauthorized'}:{username:'fixture-operator',totp_enabled:options.factor!==false}});
      if(path==='/api/admin/overview')return route.fulfill({json:{pending:0,credited:[],recent:[],deposits_paused:false}});
      if(path==='/api/admin/custody')return route.fulfill({json:{key,networks:[network],jobs:[],deposits_paused:false}});
      if(path==='/api/admin/deposits')return route.fulfill({json:{deposits:[]}});
      if(path==='/api/admin/users')return route.fulfill({json:url.searchParams.get('page')==='1'?{rows:[],more:false}:{rows:[user],more:true}});
      if(path==='/api/admin/users/'+player)return route.fulfill({json:{user,vip:{levels:[],wagered_usdt:'0',wagered_usd:'0'},activity:{bets:0,wins:0},balances:[],addresses:[]}});
      if(path==='/api/admin/users/'+player+'/transactions')return route.fulfill({json:url.searchParams.get('type')!=='all'||url.searchParams.get('page')==='1'?{rows:[],more:false}:{rows:[row],more:true}});
      if(path==='/api/admin/users/'+player+'/deposits')return route.fulfill({json:{rows:url.searchParams.get('pending')==='true'?[]:[row],more:false}});
      if(path==='/api/assets')return route.fulfill({json:{currencies:[{id:'ETH'}]}});
      if(path==='/api/admin/chains')return route.fulfill({json:{chains:[{...network,kind:'evm',enabled:true}]}});
      if(path==='/api/admin/assets')return route.fulfill({json:{assets:[{id:'ETH',chain_id:'ETH',kind:'native',decimals:18,min_deposit:'1',enabled:true}]}});
      if(path==='/api/admin/secrets')return route.fulfill({json:{secrets:[{name:'rpc:ETH',updated_at:stamp,hint:'fixture hint'}]}});
      if(path==='/api/admin/sol-addresses')return route.fulfill({json:{remaining:0}});
      if(path==='/api/admin/settings')return route.fulfill({json:{deposits_paused:false}});
      if(path==='/api/admin/bet-limits')return route.fulfill({json:{min_usdt:'0',max_usdt:null}});
      if(path==='/api/admin/withdrawals')return route.fulfill({json:{rows:[{...row,id:'withdrawal-fixture',status:'approved',reviewer:'fixture-operator',user_id:player,username:user.username,email:user.email,destination}],more:false}});
    }else{
      const body=req.postDataJSON() as Record<string,unknown>;writes.push({path,body});
      if(path==='/api/admin/login' && options.challenge && !body.totp)return route.fulfill({status:401,json:{need2fa:true}});
      if(path==='/api/admin/login'||path==='/api/admin/secrets'||path==='/api/admin/2fa/enable'||path.startsWith('/api/admin/custody/'))return route.fulfill({status:403,json:{error:'DO_NOT_ECHO '+JSON.stringify(body)}});
      if(path==='/api/admin/sol-addresses')return route.fulfill({status:400,json:{error:'Enter unique public Solana addresses.'}});
      if(path==='/api/admin/2fa/setup')return route.fulfill({json:{secret:'SYNTHETICSETUPONLY',uri:'otpauth://totp/Fixture?secret=SYNTHETICSETUPONLY'}});
      if(path==='/api/admin/bet-limits')return route.fulfill({status:400,json:{error:'Check the minimum and maximum wager limits.'}});
      if(path==='/api/admin/assets/ETH')return route.fulfill({status:400,json:{error:'Check the minimum deposit.'}});
      if(path==='/api/admin/users/'+player+'/actions')return route.fulfill({status:400,json:{error:'Review the adjustment amount and reason.'}});
    }
    unexpected.push(req.method()+' '+path);return route.abort();
  });
  await ctx.routeWebSocket(/.*/,socket=>socket.close());
  const page=await ctx.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/admin');
  await page.locator(options.login?'#loginForm':'.stats').waitFor();
  async function open(name:string,selector:string){await page.locator('#nav').getByRole('button',{name,exact:true}).click();await page.locator(selector).first().waitFor();}
  t.after(()=>{assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);});
  return {page,open,writes,requests};
}

async function associated(field:Locator,message:RegExp){
  await field.locator('xpath=self::*[@aria-invalid="true"]').waitFor();
  assert.equal(await field.getAttribute('aria-invalid'),'true');
  const id=await field.getAttribute('data-field-error');assert.ok(id);
  assert.ok((await field.getAttribute('aria-describedby'))?.split(/\s+/).includes(id));
  const text=await field.evaluate((el,id)=>el.ownerDocument.getElementById(id)?.textContent,id);
  assert.match(text||'',message);
}

test('directory reset clears query, status and pagination; empty deposit setup actions navigate',async t=>{
  const {page,open,writes,requests}=await fixture(t,{width:320});
  await page.getByRole('button',{name:'Review deposit setup',exact:true}).click();await page.locator('#custodyNetworks').waitFor();
  await open('Deposits','.tscroll');assert.match(await page.locator('#view').innerText(),/Direct transfers and archived historical payments/);
  await page.getByRole('button',{name:'Review deposit setup',exact:true}).click();await page.locator('#custodyNetworks').waitFor();
  await open('Users','.user-row');await page.locator('#playerSearch').fill('missing');await page.locator('#playerStatus').selectOption('banned');
  await page.locator('.user-row').waitFor();await page.locator('#directoryResults').getByRole('button',{name:'Next',exact:true}).click();
  await page.getByRole('button',{name:'Clear directory filters'}).click();await page.locator('.user-row').waitFor();
  assert.equal(await page.locator('#playerSearch').inputValue(),'');assert.equal(await page.locator('#playerStatus').inputValue(),'all');
  assert.match(requests.filter(path=>path.startsWith('/api/admin/users?')).at(-1)||'',/q=&status=all&page=0$/);
  assert.ok(await page.locator('#playerSearch').evaluate(el=>el===document.activeElement));assert.deepEqual(writes,[]);
});

test('record resets clear the active filter and page while amounts retain eighteen-decimal precision',async t=>{
  const {page,open,writes,requests}=await fixture(t);
  await open('Users','.user-row');await page.locator('.user-row').click();await page.locator('#playerTabs').waitFor();
  await page.locator('#playerTabs').getByRole('button',{name:'Transactions',exact:true}).click();await page.locator('#adminTransactionType').waitFor();
  await page.locator('#adminTransactionType').selectOption('rewards');await page.getByRole('button',{name:'Reset record filters'}).click();
  await page.locator('.record').waitFor();assert.equal(await page.locator('#adminTransactionType').inputValue(),'all');
  assert.match(await page.locator('.record>summary').innerText(),/0\.123456789012345678 ETH/);
  await page.locator('#playerRecord').getByRole('button',{name:'Next',exact:true}).click();await page.getByRole('button',{name:'Reset record filters'}).click();await page.locator('.record').waitFor();
  assert.match(requests.filter(path=>path.includes('/transactions?')).at(-1)||'',/page=0&type=all$/);
  await page.locator('#playerTabs').getByRole('button',{name:'Deposits',exact:true}).click();await page.locator('#pendingDeposits').check();
  await page.getByRole('button',{name:'Reset record filters'}).click();await page.locator('.record').waitFor();assert.equal(await page.locator('#pendingDeposits').isChecked(),false);
  assert.match(requests.filter(path=>path.includes('/deposits?')).at(-1)||'',/page=0&pending=false$/);assert.deepEqual(writes,[]);
});

test('table actions expose network or asset context and real action headers',async t=>{
  const {page,open,writes}=await fixture(t);
  await open('Chains','[data-tog]');assert.equal(await page.getByRole('columnheader',{name:'Actions',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Disable Ethereum network (ETH)',exact:true}).count(),1);
  await open('Assets','[data-aen]');assert.equal(await page.getByRole('button',{name:'ETH asset enabled on ETH',pressed:true,exact:true}).count(),1);
  await open('Secrets','#s_save');assert.equal(await page.getByRole('columnheader',{name:'Actions',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Delete secret rpc:ETH',exact:true}).count(),1);assert.deepEqual(writes,[]);
});

test('credential and financial form errors are linked, clear on correction, and do not echo secret values',async t=>{
  const {page,open,writes}=await fixture(t);
  await open('Secrets','#s_save');await page.locator('#s_save').click();await associated(page.locator('#s_name'),/Name and value required/);await associated(page.locator('#s_val'),/Name and value required/);
  await page.locator('#s_name').selectOption('rpc:ETH');assert.equal(await page.locator('#s_name').getAttribute('aria-invalid'),null);
  const secret='fixture-credential-do-not-echo';await page.locator('#s_val').fill(secret);await page.locator('#s_save').click();await associated(page.locator('#s_val'),/secret could not be saved/);
  assert.ok(!(await page.locator('body').innerText()).includes(secret));assert.ok(!(await page.locator('body').innerText()).includes('DO_NOT_ECHO'));
  await page.locator('#s_val').fill('corrected-fixture');assert.equal(await page.locator('#s_val').getAttribute('aria-invalid'),null);assert.equal(await page.locator('#s_val').getAttribute('aria-describedby'),null);
  await page.locator('#importSol').click();await associated(page.locator('#solOwners'),/public Solana addresses/);await page.locator('#solOwners').fill('FixturePublicAddress');assert.equal(await page.locator('#solOwners').getAttribute('aria-invalid'),null);
  await open('Settings','#limitsForm');await page.locator('[name=minimum]').fill('');await page.locator('#limitsForm button').click();await associated(page.locator('[name=minimum]'),/highlighted fields/);
  await page.locator('[name=minimum]').fill('0.000000000000000001');await page.locator('[name=maximum]').fill('0.000000000000000002');await page.locator('#limitsForm button').click();
  await associated(page.locator('[name=maximum]'),/minimum and maximum/);assert.deepEqual(writes.at(-1)?.body,{min_usdt:'0.000000000000000001',max_usdt:'0.000000000000000002'});
  await page.locator('[name=maximum]').fill('1');assert.equal(await page.locator('[name=minimum]').getAttribute('aria-invalid'),null);
  await open('Assets','[data-min]');await page.locator('[data-min]').fill('bad');await page.locator('[data-min]').press('Tab');await associated(page.locator('[data-min]'),/minimum deposit/);
  await page.locator('[data-min]').fill('1');assert.equal(await page.locator('[data-min]').getAttribute('aria-invalid'),null);
});

test('custody enrollment and routing errors retain help links, bind fresh TOTP, and never expose entered credentials',async t=>{
  const {page,open,writes}=await fixture(t,{enrollment:true});
  await open('Direct wallets','#custodyRoot');const form=page.locator('#custodyRoot'),seed=form.locator('#custodySeed'),code=form.locator('[data-code]');
  await form.getByRole('button').click();await associated(seed,/64 hexadecimal/);assert.equal(await seed.inputValue(),'');
  const hex='a5'.repeat(32);await seed.fill(hex);await form.getByRole('button').click();await associated(form.locator('#custodyBackup'),/offline seed backup/);
  await form.locator('#custodyBackup').check();await seed.fill(hex);await form.getByRole('button').click();await associated(code,/fresh six-digit/);assert.equal(await code.inputValue(),'');
  await seed.fill(hex);await code.fill('123456');assert.equal(await code.getAttribute('aria-invalid'),null);await form.getByRole('button').click();await associated(code,/not authorized/);
  assert.equal(await code.inputValue(),'');assert.deepEqual(Object.keys(writes.at(-1)!.body).sort(),['key_id','sealed_base64','totp']);assert.ok(!JSON.stringify(writes).includes(hex));
  assert.ok(!(await page.locator('body').innerText()).match(/123456|DO_NOT_ECHO|a5a5a5a5/));
  await code.fill('654321');assert.equal(await code.getAttribute('aria-invalid'),null);
  await page.locator('[data-network=ETH]>summary').click();await page.locator('[data-network=ETH] .custody-edit>summary').click();
  const network=page.locator('[data-network=ETH] [data-network-settings]'),rpc=network.locator('[data-rpc]'),networkCode=network.locator('[data-code]');
  await rpc.fill('http://fixture.invalid/private-credential');await network.getByRole('button').click();await associated(rpc,/mainnet HTTPS/);
  assert.ok((await rpc.getAttribute('aria-describedby'))?.split(' ').includes('rpc-help-ETH'));assert.equal(await rpc.inputValue(),'');
  await rpc.fill('https://fixture.invalid/private-credential');assert.equal(await rpc.getAttribute('aria-describedby'),'rpc-help-ETH');await network.getByRole('button').click();await associated(networkCode,/fresh six-digit/);
  await rpc.fill('https://fixture.invalid/private-credential');await networkCode.fill('123456');await network.getByRole('button').click();await associated(networkCode,/not authorized/);
  assert.equal(await networkCode.inputValue(),'');assert.equal(await rpc.inputValue(),'');assert.ok(!(await page.locator('body').innerText()).match(/private-credential|123456|DO_NOT_ECHO/));
});

test('sweep verification and withdrawal validation retain the existing confirmation boundary',async t=>{
  const {page,open,writes}=await fixture(t);
  await open('Direct wallets','#custodyNetworks');await page.locator('[data-network=ETH]>summary').click();
  const sweep=page.locator('[data-network=ETH] [data-sweep-toggle]');await sweep.getByRole('button').click();await associated(sweep.locator('[data-verified]'),/full saved collection address/);
  await sweep.locator('[data-verified]').check();await sweep.getByRole('button').click();await associated(sweep.locator('[data-code]'),/fresh six-digit/);assert.deepEqual(writes,[]);
  await open('Withdrawals','[name=txid]');await page.locator('[data-w=sent]').click();await associated(page.locator('[name=txid]'),/transaction ID/);
  await page.locator('[name=txid]').fill('0x'+'a1'.repeat(32));assert.equal(await page.locator('[name=txid]').getAttribute('aria-invalid'),null);
  let confirmation='';page.once('dialog',async dialog=>{confirmation=dialog.message();await dialog.dismiss();});await page.locator('[data-w=sent]').click();
  assert.equal(confirmation,'Record the broadcast transaction and settle this withdrawal?');assert.deepEqual(writes,[]);
});

test('player action errors preserve confirmation, exact amounts and idempotency payloads',async t=>{
  const {page,open,writes}=await fixture(t);await open('Users','.user-row');await page.locator('.user-row').click();await page.locator('#playerTabs').getByRole('button',{name:'Controls',exact:true}).click();
  const adjust=page.locator('#adjustPlayer');await adjust.locator('[name=amount]').fill('0.123456789012345678');await adjust.locator('[name=reason]').fill('Fixture adjustment reason');
  let confirmation='';page.once('dialog',async dialog=>{confirmation=dialog.message();await dialog.accept();});await adjust.getByRole('button').click();await associated(adjust.locator('[name=amount]'),/adjustment amount and reason/);
  assert.match(confirmation,/^Confirm this change\?\n/);const body=writes.at(-1)!.body;assert.deepEqual({...body,request:undefined},{action:'credit',asset:'ETH',amount:'0.123456789012345678',reason:'Fixture adjustment reason',request:undefined});assert.match(String(body.request),/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  await adjust.locator('[name=reason]').fill('Corrected reason');assert.equal(await adjust.locator('[name=amount]').getAttribute('aria-invalid'),null);
  const access=page.locator('#restrictPlayer');await access.getByRole('button').click();await associated(access.locator('[name=until]'),/highlighted fields/);await access.locator('[name=action]').selectOption('restore');
  assert.equal(await access.locator('[name=until]').isDisabled(),true);assert.equal(await access.locator('[name=until]').getAttribute('aria-invalid'),null);assert.equal(writes.length,1);
});

test('sign-in and 2FA errors associate fields and sanitize rejected credential responses',async t=>{
  const login=await fixture(t,{login:true}),password='fixture-login-password';
  await login.page.locator('#l_user').fill('fixture-operator');await login.page.locator('#l_pass').fill(password);await login.page.locator('#l_btn').click();await associated(login.page.locator('#l_pass'),/Sign-in failed/);
  assert.ok(!(await login.page.locator('body').innerText()).match(/fixture-login-password|DO_NOT_ECHO/));await login.page.locator('#l_pass').fill('corrected-fixture');assert.equal(await login.page.locator('#l_pass').getAttribute('aria-invalid'),null);
  const challenge=await fixture(t,{login:true,challenge:true});await challenge.page.locator('#l_user').fill('fixture-operator');await challenge.page.locator('#l_pass').fill(password);await challenge.page.locator('#l_btn').click();await associated(challenge.page.locator('#l_totp'),/authenticator code/);
  await challenge.page.locator('#l_totp').fill('123456');assert.equal(await challenge.page.locator('#l_totp').getAttribute('aria-invalid'),null);await challenge.page.locator('#l_btn').click();await associated(challenge.page.locator('#l_totp'),/Sign-in failed/);assert.ok(!(await challenge.page.locator('body').innerText()).match(/123456|DO_NOT_ECHO/));
  const {page,open}=await fixture(t,{factor:false});await open('Security','#setup2fa');await page.locator('#setup2fa').click();await page.locator('#en_btn').waitFor();
  await page.locator('#en_btn').click();await associated(page.locator('#en_totp'),/fresh six-digit/);await page.locator('#en_totp').fill('123456');await page.locator('#en_btn').click();await associated(page.locator('#en_totp'),/Could not enable/);
  assert.ok(!(await page.locator('body').innerText()).match(/123456|DO_NOT_ECHO/));await page.locator('#en_totp').fill('654321');assert.equal(await page.locator('#en_totp').getAttribute('aria-invalid'),null);
});
