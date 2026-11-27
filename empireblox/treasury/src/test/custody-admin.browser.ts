/// <reference lib="dom" />
import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHash, generateKeyPairSync, privateDecrypt, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';

// All browser traffic is fulfilled or denied in memory, including the synthetic HTTPS origin.
// No API, RPC, database, signer process or wallet is contacted by these tests.
const pageFile=fileURLToPath(new URL('../admin/index.html',import.meta.url));
const pickerRoot=new URL('../../../assets/wallet/',import.meta.url);
const panel='https://operator.test.invalid', custody='/api/admin/custody';
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:3072});
const der=publicKey.export({type:'spki',format:'der'}),fingerprint=createHash('sha256').update(der).digest('hex');
const sponsor='0x'+'a1'.repeat(20),destination='0x'+'b2'.repeat(20);
const tokens={ETH:'0xdac17f958d2ee523a2206206994597c13d831ec7',BSC:'0x55d398326f99059ff775485246999027b3197955',POL:'0xc2132d05d31c914a87c6611c10748aeb04b58e8f'};
let browser:Browser;
before(async()=>{browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--host-resolver-rules=MAP * ~NOTFOUND']});});
after(()=>browser?.close());

function status(){
  const networks=[['ETH','Ethereum','ETH','USDT.ERC20'],['BSC','BNB Smart Chain','BNB','USDT.BEP20'],['POL','Polygon','POL','USDT.POL'],['SOL','Solana','SOL','']] as const;
  return {deposits_paused:false,alchemy_configured:false,alchemy_key_count:0,alchemy_key_slots:[] as {slot:number;active:boolean;cooling_down:boolean}[],
    key:{id:fingerprint,spki:der.toString('base64'),configured:false,ready:false,fee_address:null as string|null},
    networks:networks.map(([id,display_name,native,token])=>({id,display_name,required_conf:id==='POL'?128:15,rpc_configured:false,destination:null as string|null,destination_locked:false,sweeps_enabled:false,scan_ready:false,last_scanned:null as string|null,ready:false,
      assets:[{id:native,symbol:native,enabled:true,decimals:id==='SOL'?9:18,min_deposit:id==='SOL'?'1000000':'2000000000000001',token_address:null},
         ...(token?[{id:token,symbol:'USDT',enabled:true,decimals:id==='BSC'?18:6,min_deposit:id==='BSC'?'1000000000000000000':'1000000',token_address:tokens[id]}]:[])]})),
    jobs:[{id:randomUUID(),chain_id:'ETH',asset_id:'USDT.ERC20',status:'review',last_error:'insufficient_funds',txid:'0x'+'1a'.repeat(32),updated_at:'2026-01-01T00:00:00Z',raw:'signed-bytes-canary',email:'private-player@fixture.invalid'}]};
}

async function fixture(t:TestContext,options:{origin?:string;factor?:boolean;crypto?:boolean;width?:number}={}){
  const origin=options.origin||panel,ctx=await browser.newContext({viewport:{width:options.width||1080,height:650},serviceWorkers:'block'});
  t.after(()=>ctx.close());ctx.setDefaultTimeout(6000);
  if(options.crypto===false)await ctx.addInitScript(()=>Object.defineProperty(window.crypto,'subtle',{value:undefined}));
  const d=status(),writes:{path:string;body:Record<string,unknown>}[]=[],other:string[]=[],wire:string[]=[],consoleMessages:string[]=[];
  let rejectNext=0;
  await ctx.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname;
    wire.push(req.url(),req.postData()||'');
    if(url.origin===origin){
      if(req.method()==='GET'){
        if(path==='/admin')return route.fulfill({path:pageFile,contentType:'text/html'});
        if(['/admin/option-picker.js','/admin/option-picker.css'].includes(path))return route.fulfill({path:fileURLToPath(new URL(path.slice(7),pickerRoot)),contentType:path.endsWith('.js')?'text/javascript':'text/css'});
        if(path==='/api/admin/me')return route.fulfill({json:{username:'fixture-operator',totp_enabled:options.factor!==false}});
        if(path==='/api/admin/overview')return route.fulfill({json:{deposits_paused:d.deposits_paused,addresses:0,credited:[],recent:[],pending:0}});
        if(path==='/api/admin/settings')return route.fulfill({json:{settings:[{key:'deposits_paused',value:d.deposits_paused}],deposits_paused:d.deposits_paused}});
        if(path==='/api/admin/bet-limits')return route.fulfill({json:{min_usdt:'0',max_usdt:null}});
        if(path==='/api/admin/secrets')return route.fulfill({json:{secrets:[]}});
        if(path==='/api/admin/sol-addresses')return route.fulfill({json:{remaining:0}});
        if(path===custody)return route.fulfill({json:d});
      }else if(req.method()==='PATCH' && path==='/api/admin/settings'){
        const body=req.postDataJSON();writes.push({path,body});
        assert.deepEqual(Object.keys(body).sort(),['key','value']);assert.equal(body.key,'deposits_paused');assert.equal(typeof body.value,'boolean');
        d.deposits_paused=body.value;return route.fulfill({json:{ok:true}});
      }else if((req.method()==='POST' && path===custody+'/root') || (req.method()==='PUT' && (path===custody+'/alchemy' || path.startsWith(custody+'/networks/')))){
        const body=req.postDataJSON();writes.push({path,body});
        if(rejectNext){const code=rejectNext;rejectNext=0;return route.fulfill({status:code,json:{error:'DO_NOT_ECHO '+JSON.stringify(body)}});}
        if(path.endsWith('/root'))d.key.configured=true;
        else if(path.endsWith('/alchemy')){
          d.alchemy_key_slots=d.alchemy_key_slots.filter(k=>k.slot!==1);
          if(body.api_key!==null)d.alchemy_key_slots.unshift({slot:1,active:true,cooling_down:false});
          d.alchemy_key_count=d.alchemy_key_slots.length;d.alchemy_configured=d.alchemy_key_count>0;
          d.networks.forEach(n=>n.rpc_configured=d.alchemy_configured);
        }
        else{
          const n=d.networks.find(n=>path.endsWith('/'+n.id))!;
          if(body.destination)n.destination=body.destination;if(typeof body.enabled==='boolean')n.sweeps_enabled=body.enabled;
        }
        return route.fulfill({json:{ok:true}});
      }
    }
    other.push(req.method()+' '+req.url());return route.abort('blockedbyclient');
  });
  await ctx.routeWebSocket(/.*/,socket=>socket.close());
  const page=await ctx.newPage();page.on('console',m=>consoleMessages.push(m.text()));page.on('pageerror',e=>consoleMessages.push(e.message));
  async function open(){await page.goto(origin+'/admin');await page.locator('#nav').getByRole('button',{name:'Direct wallets',exact:true}).click();await page.locator('#custodyNetworks').waitFor();}
  return {page,d,open,writes,other,wire,consoleMessages,reject:(code:number)=>{rejectNext=code;}};
}

test('deposit operations expose direct wallets and only the pause switch, without merchant or provider controls',async t=>{
  const {page,open,writes,other}=await fixture(t,{width:320});await open();
  const view=page.locator('#view'),nav=page.locator('#nav');
  assert.doesNotMatch(await view.innerText(),/OxaPay|hosted checkout|merchant|choose the deposit method/i);
  assert.equal(await view.locator('#merchantForm,#merchantKey,#providerForm,#provider').count(),0);
  await nav.getByRole('button',{name:'Settings',exact:true}).click();await page.locator('#pauseBtn').waitFor();
  assert.equal(await view.locator('#merchantForm,#merchantKey,#providerForm,#provider').count(),0);
  assert.doesNotMatch(await view.innerText(),/OxaPay|hosted checkout|merchant|PUBLIC_SITE_ORIGIN|callback URL|new invoices/i);
  await page.getByRole('button',{name:'Pause deposits',exact:true}).click();await page.getByRole('button',{name:'Resume deposits',exact:true}).waitFor();
  assert.deepEqual(writes.at(-1),{path:'/api/admin/settings',body:{key:'deposits_paused',value:true}});
  await page.getByRole('button',{name:'Resume deposits',exact:true}).click();await page.getByRole('button',{name:'Pause deposits',exact:true}).waitFor();
  assert.deepEqual(writes.at(-1),{path:'/api/admin/settings',body:{key:'deposits_paused',value:false}});
  await nav.getByRole('button',{name:'Overview',exact:true}).click();await view.locator('.stats').waitFor();
  assert.doesNotMatch(await view.innerText(),/OxaPay|merchant|hosted checkout|deposit provider|setup needed/i);
  await nav.getByRole('button',{name:'Secrets',exact:true}).click();await page.locator('#s_name').waitFor({state:'attached'});
  assert.doesNotMatch(await view.innerText(),/OxaPay|merchant|hosted checkout/i);
  assert.equal(await view.locator('#merchantForm,#merchantKey,#providerForm,#provider,#customName,#s_name option[value=custom]').count(),0);
  assert.ok((await page.locator('#s_name option').evaluateAll(els=>els.map(el=>(el as HTMLOptionElement).value))).every(value=>!value||/^(rpc|xpub):/.test(value)));
  assert.equal(writes.length,2);assert.deepEqual(other,[]);
});

test('one-time enrollment submits only a worker-bound RSA envelope containing the raw 32-byte fixture seed',async t=>{
  const {page,d,open,writes,wire,other,consoleMessages}=await fixture(t);await open();
  const seed=randomBytes(32),hex=seed.toString('hex'),form=page.locator('#custodyRoot'),field=form.locator('#custodySeed'),button=form.getByRole('button');
  assert.equal(await field.getAttribute('type'),'password');assert.equal(await field.getAttribute('name'),null);
  await field.fill(hex);await form.locator('[data-code]').fill('111111');await button.click();
  await form.getByRole('status').filter({hasText:/backup/}).waitFor();assert.equal(await field.inputValue(),'');assert.equal(writes.length,0);
  await field.fill('bad-length');await form.locator('#custodyBackup').check();await button.click();
  await form.getByRole('status').filter({hasText:/64 hexadecimal/}).waitFor();assert.equal(await field.inputValue(),'');assert.equal(writes.length,0);
  await field.fill(hex);await form.locator('#custodyBackup').check();await button.click();await form.getByRole('status').filter({hasText:/six-digit/}).waitFor();assert.equal(writes.length,0);
  await field.fill(hex);await form.locator('#custodyBackup').check();await form.locator('[data-code]').fill('123456');await button.click();
  await page.getByText(/Seed enrolled\./).waitFor();assert.equal(writes.length,1);
  const {path,body}=writes[0]!;assert.equal(path,custody+'/root');assert.deepEqual(Object.keys(body).sort(),['key_id','sealed_base64','totp']);
  assert.equal(body.key_id,fingerprint);assert.equal(body.totp,'123456');assert.equal(typeof body.sealed_base64,'string');
  const cipher=Buffer.from(String(body.sealed_base64),'base64');assert.equal(cipher.length,384);assert.ok(cipher.toString('base64')===body.sealed_base64);
  const plain=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256',oaepLabel:Buffer.from(fingerprint)},cipher);
  assert.ok(plain.equals(seed),'Worker must recover the 32 decoded bytes, not printable hex');plain.fill(0);seed.fill(0);
  await open();assert.equal(await field.count(),0);assert.equal(d.key.ready,false);assert.equal(d.key.configured,true);
  const visible=await page.locator('body').innerText(),storage=await page.evaluate(()=>[JSON.stringify(localStorage),JSON.stringify(sessionStorage),document.cookie,window.name]);
  assert.ok(![visible,...wire,...consoleMessages,...storage].some(s=>s.includes(hex)),'Seed escaped the write-only input');assert.deepEqual(other,[]);
});

test('HTTP, absent WebCrypto or operator 2FA are read-only; invalid worker keys never offer a seed field',async t=>{
  for(const options of [{origin:'http://127.0.0.1'},{crypto:false},{factor:false}]){
    const {page,open,writes}=await fixture(t,options);await open();await page.getByRole('heading',{name:'Read-only access'}).waitFor();assert.equal(await page.locator('.custody-form').count(),0);assert.equal(writes.length,0);
  }
  const {d,page,open,writes}=await fixture(t);
  d.key.id='00'.repeat(32);await open();await page.getByText(/No usable worker enrollment key/).waitFor();assert.equal(await page.locator('#custodySeed').count(),0);
  const weak=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
  d.key.id=createHash('sha256').update(weak).digest('hex');d.key.spki=weak.toString('base64');await open();assert.equal(await page.locator('#custodySeed').count(),0);
  d.key.spki='';await open();assert.equal(await page.locator('#custodySeed').count(),0);assert.equal(writes.length,0);
});

test('routing separates scanner readiness, pinned assets, saved destination, TOTP activation and pausing',async t=>{
  const {page,d,open,writes,other,reject}=await fixture(t,{width:320});d.key.configured=false;d.key.ready=true;d.key.fee_address=sponsor;
  await open();assert.equal(await page.locator('#custodyFeeAddress').innerText(),sponsor);assert.equal(await page.locator('[data-network]').count(),4);
  assert.match(await page.locator('#view').innerText(),/Solana uses Alchemy directly/);
  assert.equal(await page.locator('[data-rpc]').count(),0);
  assert.match(await page.locator('#view').innerText(),/ETH on Ethereum, BNB on BNB Smart Chain and POL on Polygon/);
  const jobs=page.getByRole('region',{name:'Recent sweep jobs'});assert.match(await jobs.innerText(),/Needs review/);assert.match(await jobs.innerText(),/native gas funding/);
  assert.ok(!(await page.locator('#view').innerHTML()).match(/signed-bytes-canary|private-player@/));
  const eth=page.locator('[data-network=ETH]'),edit=eth.locator('[data-network-settings]'),sweep=eth.locator('[data-sweep-toggle]');
  for(const [id,pinned] of Object.entries(tokens)){const row=page.locator('[data-network='+id+']');await row.locator(':scope > summary').click();assert.match(await row.innerText(),/Pinned USDT contract/);assert.ok((await row.innerText()).includes(pinned));}
  const sol=page.locator('[data-network=SOL]');await sol.locator(':scope > summary').click();assert.match(await sol.innerText(),/SOL only/);assert.doesNotMatch(await sol.innerText(),/USDT|Pinned USDT contract/);
  await eth.locator(':scope > summary').click();assert.match(await eth.innerText(),/0\.002000000000000001 ETH/);assert.equal(await sweep.count(),0);
  const keyForm=page.locator('#alchemyRpcForm'),keyField=keyForm.locator('[data-alchemy-key]');
  await keyField.fill('bad key');await keyForm.getByRole('button',{name:'Save Alchemy API key'}).click();
  await keyForm.getByRole('status').filter({hasText:/without spaces/}).waitFor();assert.equal(writes.length,0);assert.equal(await keyField.inputValue(),'');
  const apiKey='fixture-alchemy-api-key-1234567890';await keyField.fill(apiKey);await keyForm.locator('[data-code]').fill('222222');reject(403);
  await keyForm.getByRole('button',{name:'Save Alchemy API key'}).click();
  await keyForm.getByRole('status').filter({hasText:/not authorized/i}).waitFor();assert.doesNotMatch(await page.locator('#view').innerText(),/fixture-alchemy-api-key|DO_NOT_ECHO|222222/);
  assert.equal(await keyForm.locator('[data-code]').inputValue(),'');assert.equal(await keyField.inputValue(),'');
  await keyField.fill(apiKey);await keyForm.locator('[data-code]').fill('333333');await keyForm.getByRole('button',{name:'Save Alchemy API key'}).click();
  await page.getByRole('status').filter({hasText:/Alchemy API key saved/}).waitFor();await page.locator('#alchemyRpcForm [data-remove-alchemy]').waitFor();
  assert.deepEqual(writes.at(-1),{path:custody+'/alchemy',body:{api_key:apiKey,totp:'333333'}});
  await eth.locator(':scope > summary').click();
  await eth.locator('.custody-edit > summary').click();await edit.locator('[data-destination]').fill(destination);await edit.locator('[data-code]').fill('334444');await edit.getByRole('button').click();
  await eth.locator('code').filter({hasText:destination}).waitFor();assert.deepEqual(writes.at(-1),{path:custody+'/networks/ETH',body:{destination,totp:'334444'}});
  assert.equal(await sweep.count(),0);const config=d.networks[0]!;config.scan_ready=config.ready=true;config.last_scanned='70001234';
  await page.locator('#refreshCustody').click();await eth.getByText('Block 70001234').waitFor();assert.match(await eth.locator(':scope > summary').innerText(),/Ready/);
  await sweep.locator('[data-code]').fill('444444');await sweep.getByRole('button',{name:'Enable sweeps'}).click();await sweep.getByRole('status').filter({hasText:/Verify the full/}).waitFor();assert.equal(writes.length,3);
  await sweep.locator('[data-verified]').check();await sweep.getByRole('button').click();await sweep.getByRole('status').filter({hasText:/six-digit/}).waitFor();assert.equal(writes.length,3);
  await sweep.locator('[data-code]').fill('555555');await sweep.getByRole('button').click();await sweep.getByRole('button',{name:'Pause sweeps'}).waitFor();
  assert.deepEqual(writes.at(-1)?.body,{enabled:true,destination,totp:'555555'});assert.equal(writes.length,4);assert.equal(await edit.count(),0);
  config.scan_ready=config.ready=d.key.ready=false;config.destination_locked=true;await page.locator('#refreshCustody').click();await eth.getByText('Not current',{exact:true}).waitFor();
  await sweep.locator('[data-code]').fill('666666');await sweep.getByRole('button',{name:'Pause sweeps'}).click();await eth.locator('.custody-edit > summary').click();
  assert.deepEqual(writes.at(-1)?.body,{enabled:false,totp:'666666'});assert.ok(await edit.locator('[data-destination]').isDisabled());
  assert.ok(await page.locator('#workspaceScroll').evaluate(el=>el.scrollWidth<=el.clientWidth));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(other,[]);
});
