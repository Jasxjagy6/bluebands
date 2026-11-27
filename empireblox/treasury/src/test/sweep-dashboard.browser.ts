/// <reference lib="dom" />
import { after,before,test,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium,type Browser } from 'playwright';
const origin='https://sweep-dashboard.test.invalid',stamp='2026-11-27T09:00:00Z';
const html=fileURLToPath(new URL('../admin/index.html',import.meta.url)),picker=new URL('../../../assets/wallet/',import.meta.url);
const source='0x'+'12'.repeat(20),destination='0x'+'34'.repeat(20),sponsor='0x'+'56'.repeat(20),txid='0x'+'ab'.repeat(32);
const job={id:'201',deposit_id:'101',chain_id:'ETH',asset_id:'USDT.ERC20',symbol:'USDT',decimals:6,amount:'123456789012',source,destination,sponsor,status:'completed',last_error:null,created_at:stamp,updated_at:stamp,completed_at:stamp,next_check_at:stamp,finality_conf:5,username:'=formula_fixture',collection_amount:'123456789012',fee_reserved:'1000000000000000',fee_recorded:'234567890123456',missing_fee_receipts:0,deposit_txid:txid};
const steps=['sponsor','sweep'].map((phase,i)=>({phase,txid:'0x'+String(i+1).repeat(64),amount:phase==='sponsor'?'1000000000000000':job.amount,fee:'500000000000000',actual_fee:'117283945061728',attempts:1,nonce:String(i+1),block_number:'1000',block_hash:txid,created_at:stamp,finalized_at:stamp}));
let browser:Browser;
before(async()=>{browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});});after(()=>browser.close());
async function fixture(t:TestContext){
  const ctx=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,serviceWorkers:'block'}),requests:string[]=[],writes:string[]=[],errors:string[]=[];
  t.after(()=>ctx.close());
  await ctx.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname;requests.push(path+url.search);
    if(url.origin!==origin)return route.abort();
    if(req.method()!=='GET'){writes.push(path);return route.fulfill({status:405,json:{error:'Read-only fixture'}});}
    if(path==='/admin')return route.fulfill({path:html,contentType:'text/html'});
    if(path==='/admin/option-picker.js'||path==='/admin/option-picker.css')return route.fulfill({path:fileURLToPath(new URL(path.slice(7),picker)),contentType:path.endsWith('.js')?'text/javascript':'text/css'});
    if(path==='/api/admin/me')return route.fulfill({json:{username:'Fixture Operator',totp_enabled:true}});
    if(path==='/api/admin/overview')return route.fulfill({json:{pending:1,credited:[],recent:[],deposits_paused:false}});
    if(path==='/api/admin/sweeps')return route.fulfill({json:{as_of:stamp,counts:[{status:'completed',count:'21'},{status:'queued',count:'2'},{status:'review',count:'1'}],amounts:[{chain_id:'ETH',asset_id:'USDT.ERC20',symbol:'USDT',decimals:6,outstanding:'200000000',collected:job.amount}],awaiting:[{chain_id:'ETH',asset_id:'USDT.ERC20',symbol:'USDT',decimals:6,count:'1',amount:'300000000'}]}});
    if(path==='/api/admin/sweeps/fee-wallets')return route.fulfill({json:{wallets:[
      {chain_id:'ETH',display_name:'Ethereum',symbol:'ETH',decimals:18,address:sponsor,balance:null,status:'unavailable',checked_at:null,sweeps_enabled:true,worker_status:'ready',fee_ceiling:'10000000000000000',daily_sponsor_cap:'100000000000000000',sponsor_budget_used:'1000000000000000',sponsor_budget_committed:'0'},
      {chain_id:'BSC',display_name:'BNB Smart Chain',symbol:'BNB',decimals:18,address:sponsor,balance:'1001234567890123456',status:'current',checked_at:stamp,sweeps_enabled:false,worker_status:'ready',fee_ceiling:'600000000000000',daily_sponsor_cap:'6000000000000000',sponsor_budget_used:'0',sponsor_budget_committed:'0'},
      {chain_id:'POL',display_name:'Polygon',symbol:'POL',decimals:18,address:sponsor,balance:'5000000000000000000',status:'stale',checked_at:stamp,sweeps_enabled:false,worker_status:'offline',fee_ceiling:'60000000000000000',daily_sponsor_cap:'600000000000000000',sponsor_budget_used:'0',sponsor_budget_committed:'0'},
      {chain_id:'SOL',display_name:'Solana',symbol:'SOL',decimals:9,address:null,balance:null,status:'self_funded',checked_at:null,sweeps_enabled:false,worker_status:'ready',fee_ceiling:'50000'}]}});
    if(path==='/api/admin/sweeps/jobs/201')return route.fulfill({json:{job,steps}});
    if(path==='/api/admin/sweeps/jobs'){
      const next=url.searchParams.has('before'),empty=url.searchParams.get('q')==='missing';
      return route.fulfill({json:{rows:empty?[]:[next?{...job,id:'199',status:'review',last_error:'insufficient_funds',completed_at:null,collection_amount:null}:job],more:!next&&!empty,next_before:!next&&!empty?'200':null}});
    }
    if(path==='/api/admin/sweeps/awaiting')return route.fulfill({json:{rows:[{id:'102',chain_id:'ETH',symbol:'USDT',asset_id:'USDT.ERC20',decimals:6,amount:'100000',source,username:'Waiting_Player',reason:'sweeps_paused',credited_at:stamp}],more:false,next_before:null}});
    return route.fulfill({status:404,json:{error:'Unexpected fixture request'}});
  });
  const page=await ctx.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  t.after(()=>{assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);});
  await page.goto(origin+'/admin#Sweeps');await page.locator('.sweep-record').waitFor();await page.locator('.sweep-wallet').first().waitFor();
  return {page,requests};
}
test('sweep dashboard shows full funding and collection receipts and keeps unknown gas balances distinct from zero',async t=>{
  const {page}=await fixture(t);assert.equal(await page.locator('.sweep-wallet').count(),4);
  const eth=page.locator('.sweep-wallet').filter({has:page.getByText('Ethereum',{exact:true})});assert.match(await eth.innerText(),/Unavailable/);assert.match(await eth.locator('.fee-balance').innerText(),/—/);
  assert.match(await page.locator('.sweep-wallet').filter({has:page.getByText('Solana',{exact:true})}).innerText(),/Paid from deposit/);
  await page.locator('.sweep-record summary').click();await page.locator('.sweep-step').first().waitFor();assert.equal(await page.locator('.sweep-step').count(),2);
  assert.match(await page.locator('.sweep-record-detail').innerText(),/123456\.789012 USDT/);assert.match(await page.locator('.sweep-record-detail').innerText(),/0\.000234567890123456 ETH/);
  assert.equal(await page.locator('.sweep-record-detail a[target=_blank]').first().getAttribute('rel'),'noopener noreferrer');
  for(const width of [320,390,1440]){
    await page.setViewportSize({width,height:1000});await page.locator('#workspaceScroll').evaluate(el=>el.scrollTop=0);assert.ok(await page.locator('#workspaceScroll').evaluate(el=>el.scrollWidth<=el.clientWidth));
    const dir=process.env.WALLET_SCREENSHOT_DIR;if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,'admin-sweeps-'+width+'.png')});}
  }
});
test('sweep history supports cursor pages, awaiting reasons, filtered CSV and reset without custody writes',async t=>{
  const {page,requests}=await fixture(t);await page.locator('#sweepNext').click();await page.locator('[data-job="199"]').waitFor();assert.match(await page.locator('#sweepPage').innerText(),/Page 2/);
  await page.locator('#sweepPrevious').click();await page.locator('[data-job="201"]').waitFor();
  const downloadEvent=page.waitForEvent('download');await page.locator('#exportSweeps').click();const download=await downloadEvent,path=await download.path();assert.ok(path);const csv=await readFile(path,'utf8');
  assert.match(csv,/123456789012/);assert.match(csv,/'=formula_fixture/);assert.ok(!csv.includes('[object Object]'));
  await page.locator('[data-sweep-tab=awaiting]').click();await page.locator('.sweep-waiting').waitFor();assert.match(await page.locator('.sweep-waiting').innerText(),/0\.1 USDT/);assert.match(await page.locator('.sweep-waiting').innerText(),/Sweeps paused/);
  await page.locator('[data-sweep-tab=history]').click();await page.locator('.sweep-record').waitFor();
  await page.locator('#sweepFilters input[name=q]').fill('missing');await page.getByText('No sweep jobs match these filters.',{exact:true}).waitFor();assert.equal(await page.locator('#exportSweeps').isDisabled(),true);
  await page.locator('#resetSweepFilters').click();await page.locator('.sweep-record').waitFor();assert.equal(await page.locator('#sweepFilters input[name=q]').inputValue(),'');
  assert.ok(requests.some(r=>r.includes('before=200')));assert.ok(requests.some(r=>r.includes('q=missing')));
});
