import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { oxapayRoutes } from '../api/routes-oxapay.js';
import { notificationRoutes } from '../api/routes-notifications.js';
import { activityRoutes } from '../api/routes-activity.js';
import { userRoutes } from '../api/routes-user.js';
import { adminRoutes } from '../api/routes-admin.js';
import { playerManagement } from '../api/routes-players.js';
import { signAdminToken } from '../authutil.js';
import { createSession } from '../auth-user.js';
import { config } from '../config.js';
import { pool, query, tx } from '../db.js';
import { OxaPay } from '../oxapay.js';
import { setSecret } from '../vault.js';

if(config.env!=='test')throw new Error('Run against the disposable test database');
const secret='fixture-'+randomBytes(24).toString('hex'), trackBase=BigInt('0x'+randomBytes(16).toString('hex')), owner=randomUUID(), other=randomUUID();
const firstOrigin=config.publicOrigin, publicOrigin='https://merchant.test.invalid', base='/api/me/oxapay/invoices';
const oldSettings=new Map<string,unknown>();
let oldSecret:Record<string,unknown>|undefined, oldBtcEnabled:boolean;
let session='', second='', operator='', posts=0, reads=0, requests=0, accepted=['ETH','USDT','BTC'];
let afterPost:((remote:Remote)=>Promise<void>)|undefined, unsafe:string|undefined, reject=false, failInfo=false;
let faultyEnvelope=false, historyPage=1; const historyQueries:URLSearchParams[]=[];
type Remote={track_id:string;order_id:string;type:string;currency:string;status:string;amount:string;txs:Record<string,unknown>[];
  callback_url:string;return_url:string;expired_at:number;[key:string]:unknown};
const orders=new Map<string,Remote>(), written=new Map<string,{raw:string; fields:Record<string,unknown>}>();
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const digest=(raw:string|Buffer)=>createHmac('sha512',secret).update(raw).digest('hex');
// Encode selected fixture values as unquoted wire decimals without converting to a JS Number.
const dec=(v:string)=>'@decimal:'+v;
const encode=(v:unknown)=>JSON.stringify(v).replace(/"@decimal:(\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)"/g,'$1');
const json=(data:unknown)=>new Response(encode({status:200,error:{},data}),{headers:{'Content-Type':'application/json'}});
const networks={ERC20:{network:'ERC20',name:'Ethereum Network',deposit_min:1},BEP20:{network:'BEP20',name:'BNB Smart Chain',deposit_min:1}};
const catalog={USDT:{symbol:'USDT',status:true,networks},ETH:{symbol:'ETH',status:true,networks:{ERC20:{...networks.ERC20,deposit_min:0.001}}},
  BTC:{symbol:'BTC',status:true,networks:{Bitcoin:{network:'Bitcoin',name:'Bitcoin Network',deposit_min:0.00001}}}};
const transport:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));requests++;
  assert.equal(url.origin,'https://api.oxapay.com'); assert.equal(init?.redirect,'error'); assert.ok(init?.signal);
  assert.equal(new Headers(init.headers).get('content-type'),'application/json');
  assert.equal(new Headers(init.headers).get('merchant_api_key'),url.pathname==='/v1/common/currencies'?null:secret);
  if(url.pathname==='/v1/common/currencies'){assert.equal(init.method,'GET');return json(catalog);}
  if(url.pathname==='/v1/payment/accepted-currencies'){assert.equal(init.method,'GET');return json({list:accepted});}
  if(url.pathname==='/v1/payment/invoice'){
    assert.equal(init.method,'POST'); posts++;
    if(reject){reject=false;return new Response(JSON.stringify({status:400,error:{type:'validation'},data:{}}),{status:400});}
    const raw=String(init.body), fields=JSON.parse(raw), track=String(trackBase+BigInt(posts));
    assert.equal(raw.includes(secret),false);
    const amount=raw.match(/"amount":(\d+(?:\.\d+)?),/)![1]!;
    const remote:Remote={order_id:fields.order_id,track_id:track,type:'invoice',amount:dec(amount),currency:fields.currency,
      status:'new',txs:[],callback_url:fields.callback_url,return_url:fields.return_url,expired_at:Math.floor(Date.now()/1000)+3600};
    orders.set(track,remote);written.set(remote.order_id,{fields,raw});
    const hook=afterPost;afterPost=undefined;if(hook)await hook(remote);
    const url=unsafe??'https://pay.oxapay.com/'+track;unsafe=undefined;
    return json({track_id:track,payment_url:url,expired_at:remote.expired_at,date:remote.expired_at-3600});
  }
  if(url.pathname==='/v1/payment'){
    assert.equal(init.method,'GET');historyQueries.push(url.searchParams);
    return json({list:Number(url.searchParams.get('page'))===historyPage?[...orders.values()]:[],meta:{last_page:historyPage}});
  }
  const found=url.pathname.match(/^\/v1\/payment\/(\d+)$/);
  if(found){
    assert.equal(init.method,'GET');reads++;
    if(failInfo)throw new Error('fixture unavailable');
    const data=orders.get(found[1]!)??{};
    return faultyEnvelope?new Response(encode({status:200,data,error:{type:'service_unavailable'}})):json(data);
  }
  throw new Error('Unexpected provider request');
};
const service=new OxaPay(transport), app=Fastify();
await app.register(cookie); await app.register(oxapayRoutes,{service});
await app.register(userRoutes); await app.register(activityRoutes); await app.register(notificationRoutes);
await app.register(adminRoutes);await app.register(playerManagement);
const send=(asset:string,amount:string,request=randomUUID(),who=session)=>app.inject({method:'POST',url:base,headers:{cookie:who,
  host:'untrusted.test.invalid','x-forwarded-host':'forwarded.test.invalid','x-forwarded-proto':'http'},payload:{asset,amount,request}});
const get=(path:string,who=session)=>app.inject({url:path,headers:{cookie:who}});
const remote=(id:string)=>[...orders.values()].find(r=>r.order_id===id)!;
const callback=(raw:string,signature=digest(raw),type='application/json')=>app.inject({method:'POST',url:'/api/oxapay/webhook',
  headers:{hmac:signature,'content-type':type},payload:raw});
const ipn=(r:Remote)=>`{ "type":"invoice", "track_id":"${r.track_id}", "order_id":"${r.order_id}", "status":"Paid", "note":"caf\u00e9", "amount":9999999 }\n`;
const pay=(r:Remote,change:Record<string,unknown>={})=>{
  r.status='Paid';r.txs=[{status:'confirmed',currency:r.currency,network:r.currency==='BTC'?'Bitcoin Network':'Ethereum Network',
    tx_hash:(r.currency==='BTC'?'':'0x')+hash(r.order_id),address:'provider-address',amount:r.amount,...change}];
};
const row=async(id:string)=>(await query('select * from oxapay_invoices where id=$1',[id])).rows[0];
const due=async(id:string)=>{await query('update oxapay_invoices set next_check_at=now() where id=$1',[id]);};
const flags=async(provider:'direct'|'oxapay',paused:boolean)=>{
  await query('update settings set value=$2::jsonb where key=$1',['deposit_provider',JSON.stringify(provider)]);
  await query('update settings set value=$2::jsonb where key=$1',['deposits_paused',JSON.stringify(paused)]);
};
const noCredit=async(id:string)=>assert.equal((await query("select count(*)::int as n from journals where ref=$1",['oxapay:'+id])).rows[0].n,0);
before(async()=>{
  for(const s of (await query("select key,value from settings where key in ('deposit_provider','deposits_paused')")).rows)oldSettings.set(s.key,s.value);
  oldSecret=(await query("select * from secrets where name='oxapay:merchant'")).rows[0];
  oldBtcEnabled=(await query("select enabled from chains where id='BTC'")).rows[0].enabled;
  await flags('oxapay',false);await query("delete from secrets where name='oxapay:merchant'");config.publicOrigin=publicOrigin;
  for(const uid of [owner,other])await query("insert into users(id,email,username,pass_hash) values($1,$2,$3,'fixture')",[uid,uid+'@test.invalid','oxa'+uid.slice(0,8)]);
  session='eb_sess='+await createSession(owner);second='eb_sess='+await createSession(other);
  const admin=(await query("insert into admin_users(username,pass_hash) values($1,'fixture') returning id",['oxa'+owner])).rows[0];
  operator='eb_admin='+await signAdminToken(Number(admin.id));
});
after(async()=>{
  await app.close();config.publicOrigin=firstOrigin;
  try{await tx(async c=>{
    // Don't leave unreconciled work for another test's worker or orphan its historical journals.
    await c.query('delete from oxapay_invoices where user_id=any($1) and journal_id is null',[[owner,other]]);
    await c.query("delete from secrets where name='oxapay:merchant'");
    if(oldSecret)await c.query(`insert into secrets(name,enc_dek,iv,tag,ciphertext,hint,updated_at,updated_by) values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [oldSecret.name,oldSecret.enc_dek,oldSecret.iv,oldSecret.tag,oldSecret.ciphertext,oldSecret.hint,oldSecret.updated_at,oldSecret.updated_by]);
    for(const [k,v] of oldSettings)await c.query('update settings set value=$2::jsonb where key=$1',[k,JSON.stringify(v)]);
    await c.query("update chains set enabled=$1 where id='BTC'",[oldBtcEnabled]);
  });}finally{await pool.end();}
});

test('issuance requires an active owner, canonical origin, enabled provider, merchant key and valid playing amount',async()=>{
  assert.equal((await send('USDT','2',randomUUID(),'')).statusCode,401);
  assert.equal((await get(base,'')).statusCode,401);
  assert.equal((await send('USDT','2')).statusCode,503);
  await setSecret('oxapay:merchant',secret,'test');
  config.publicOrigin='';assert.equal((await send('USDT','2')).statusCode,503);config.publicOrigin=publicOrigin;
  await flags('direct',false);assert.equal((await send('USDT','2')).statusCode,503);
  await flags('oxapay',true);assert.equal((await send('USDT','2')).statusCode,503);await flags('oxapay',false);
  for(const [asset,amount] of [['USDT.ERC20','2'],['UNKNOWN','2'],['ETH','0.0001'],['USDT','0'],['USDT','1e5'],['BTC','1.000000001']] as const)
    assert.equal((await send(asset,amount)).statusCode,400);
  assert.equal(requests,0);
  accepted=['BTC'];assert.equal((await send('USDT','2')).statusCode,400);accepted=['USDT','ETH','BTC'];
  assert.equal((await send('USDT','0.1')).statusCode,400);assert.equal(posts,0);
});

let primary='';const localRequest=randomUUID(), exact='2.000000000000000001', exactMinor='2000000000000000001';
test('concurrent retries share one hosted POST; units, HTTPS callbacks and receipt ownership are immutable',async()=>{
  const copies=await Promise.all(Array.from({length:8},()=>send('USDT',exact,localRequest)));
  assert.ok(copies.every(r=>r.statusCode===200 || r.statusCode===202));
  primary=copies[0]!.json().id;assert.ok(copies.every(r=>r.json().id===primary));assert.equal(posts,1);
  const i=(await get(base+'/'+primary)).json();
  assert.equal(i.amount,exactMinor);assert.equal(i.status,'waiting');assert.equal(i.decimals,18);assert.equal(i.asset_id,'USDT');
  assert.deepEqual(i.networks,['BSC','ETH']);assert.equal(i.payment_url,'https://pay.oxapay.com/'+remote(primary).track_id);
  await assert.rejects(query('update oxapay_invoices set amount=amount+1 where id=$1',[primary]),/immutable/);
  await assert.rejects(query('update oxapay_invoices set user_id=$2 where id=$1',[primary,other]),/immutable/);
  await assert.rejects(query("update oxapay_invoices set networks='{OTHER}' where id=$1",[primary]),/immutable/);
  const {raw,fields}=written.get(primary)!;
  assert.ok(raw.includes('"amount":'+exact+','));assert.deepEqual(fields,{amount:2,currency:'USDT',lifetime:60,fee_paid_by_payer:1,under_paid_coverage:0,
    mixed_payment:false,auto_withdrawal:false,order_id:primary,callback_url:publicOrigin+'/api/oxapay/webhook',return_url:publicOrigin+'/account/deposit?invoice='+primary,sandbox:false});
  assert.equal((await send('USDT','3',localRequest)).statusCode,409);assert.equal((await send('ETH',exact,localRequest)).statusCode,409);
  assert.equal((await get(base+'/'+primary,second)).statusCode,404);assert.deepEqual((await get(base,second)).json().invoices,[]);
  assert.ok((await get(base)).json().invoices.some((x:{id:string})=>x.id===primary));
  assert.equal(JSON.stringify(i).includes(secret),false);assert.equal(i.network_aliases,undefined);assert.equal(i.user_id,undefined);
  const calls=reads;await get('/account/deposit?invoice='+primary+'&status=paid');await get(base+'/'+primary+'?status=paid');
  assert.equal(reads,calls);await noCredit(primary);
});

test('merchant credentials cannot change while an issued invoice still depends on them',async()=>{
  const replacement=randomBytes(24).toString('hex');
  for(const response of [await app.inject({url:'/api/admin/secrets',method:'PUT',headers:{cookie:operator},payload:{name:'oxapay:merchant',value:replacement}}),
    await app.inject({url:'/api/admin/secrets/oxapay%3Amerchant',method:'DELETE',headers:{cookie:operator}})]){
    assert.equal(response.statusCode,409);assert.equal(response.body.includes(replacement),false);assert.equal(response.body.includes(secret),false);
  }
  assert.equal((await get('/api/admin/settings',operator)).json().merchant_configured,true);
});

test('callback uses exact raw bytes, constant-length SHA-512 HMAC, authoritative information and literal acknowledgement',async()=>{
  const r=remote(primary), raw=ipn(r), calls=reads;
  for(const bad of ['','0'.repeat(127),'x'.repeat(128),digest(raw.trim()),digest(JSON.stringify(JSON.parse(raw)))])assert.equal((await callback(raw,bad)).statusCode,400);
  assert.equal((await callback(raw,digest(raw),'text/plain')).statusCode,415);
  assert.equal((await callback(raw+' '.repeat(65536))).statusCode,413);
  assert.equal((await callback('{broken')).statusCode,400);
  assert.equal((await callback(JSON.stringify({...JSON.parse(raw),type:'payout'}))).statusCode,400);
  assert.equal((await callback(JSON.stringify({...JSON.parse(raw),order_id:randomUUID()}))).body,'ok');
  assert.equal((await callback(JSON.stringify({...JSON.parse(raw),track_id:'18'}))).body,'ok');assert.equal(reads,calls);
  const valid=await callback(raw);assert.equal(valid.statusCode,200);assert.equal(valid.body,'ok');assert.match(String(valid.headers['content-type']),/^text\/plain/);
  assert.equal(reads,calls+1);assert.equal((await row(primary)).status,'waiting');await noCredit(primary);
  r.status='Paying';await callback(raw);await callback(raw);assert.equal((await row(primary)).status,'paying');
  const pending=(await get('/api/me/notifications')).json().rows.filter((n:{reference:string})=>n.reference==='oxapay:'+primary);
  assert.equal(pending.length,1);assert.equal(pending[0].kind,'deposit.pending');
  failInfo=true;try{assert.equal((await callback(raw)).statusCode,503);}finally{failInfo=false;}
  pay(r);faultyEnvelope=true;try{assert.equal((await callback(raw)).statusCode,503);}finally{faultyEnvelope=false;}
  await noCredit(primary);
});

test('unknown states, mismatched invoice terms, unconfirmed, short, duplicate and wrong-network transfers all fail closed',async()=>{
  const r=remote(primary), track=r.track_id, raw=ipn(r);pay(r);const original=structuredClone(r), t=r.txs[0]!;
  for(const [overrides,expected] of [
    [{status:'manual_accept'},'review'],[{status:'strange'},'review'],[{status:'underpaid'},'underpaid'],[{status:'expired'},'expired'],
    [{order_id:other},'review'],[{track_id:'12345678'},'review'],[{type:'static_address'},'review'],[{currency:'USD'},'review'],
    [{callback_url:'https://other.test.invalid'},'review'],[{sandbox:true},'review'],[{amount:dec('2.000000000000000002')},'review'],
    [{txs:[]},'review'],[{txs:[{...t,currency:'BTC'}]},'review'],[{txs:[{...t,network:'Unknown Chain'}]},'review'],
    [{txs:[{...t,status:'confirming'}]},'review'],[{txs:[{...t,tx_hash:''}]},'review'],[{txs:[t,t]},'review'],
    [{txs:[{...t,amount:dec('2.0000000000000000001')}]},'review'],
    [{txs:[{...t,amount:dec('2'),sent_amount:dec('3'),received_amount:dec('2')}]},'underpaid'],
  ] as const){
    orders.set(track,{...original,...overrides} as Remote);
    assert.equal((await callback(raw)).body,'ok');assert.equal((await row(primary)).status,expected,JSON.stringify(overrides));await noCredit(primary);
  }
  orders.set(track,original);
});

test('paid IPN, concurrent replicas and repeated polls post one exact balanced credit during pause/provider cutover',async()=>{
  const r=remote(primary),raw=ipn(r);pay(r);const one=r.txs[0]!;
  r.txs=[{...one,received_amount:dec('1.000000000000000001'),sent_amount:dec('1.01')},
    {...one,tx_hash:'0x'+hash('second:'+primary),amount:dec('1.5')}];
  await flags('direct',true);
  try {
    assert.equal((await send('USDT','7')).statusCode,503);assert.equal((await send('USDT',exact,localRequest)).json().id,primary);
    await due(primary);const concurrent=await Promise.all([service.reconcile(),new OxaPay(transport).reconcile(),...Array.from({length:8},()=>callback(raw))]);
    for(const res of concurrent)if(res)assert.equal(res.body,'ok');
    const i=(await get(base+'/'+primary)).json();assert.equal(i.status,'credited');assert.equal(i.payment_url,null);assert.ok(i.credited_at);
    const j=await row(primary);assert.ok(j.journal_id);assert.equal((await query('select count(*)::int as n from oxapay_transfers where invoice_id=$1',[primary])).rows[0].n,2);
    await assert.rejects(query("insert into journals(kind,ref) values('deposit',$1)",['oxapay:'+primary]),/duplicate key/);
    await assert.rejects(query("update oxapay_invoices set status='waiting',credited_at=null,journal_id=null where id=$1",[primary]),/immutable/);
    const entries=await query('select asset_id,account,delta::text from ledger_entries where journal_id=$1 order by account',[j.journal_id]);
    assert.deepEqual(entries.rows,[{asset_id:'USDT',account:'ext:oxapay',delta:'-'+exactMinor},{asset_id:'USDT',account:'u:'+owner,delta:exactMinor}]);
    const history=(await get('/api/me/transactions?type=deposits')).json().rows;
    assert.equal(history.length,1);assert.equal(history[0].delta,exactMinor);assert.equal(history[0].ref,'oxapay:'+primary);
    assert.equal(history[0].provider,'oxapay');assert.equal(history[0].invoice_id,primary);
    for(const [path,auth,key] of [['/api/me/deposits?asset=USDT',session,'deposits'],['/api/admin/deposits?status=credited',operator,'deposits'],
      [`/api/admin/users/${owner}/deposits`,operator,'rows']] as const){
      const response=await get(path,auth);assert.equal(response.statusCode,200);
      const matches=response.json()[key].filter((v:{id:string})=>v.id===primary);assert.equal(matches.length,1);
      const receipt=matches[0];assert.deepEqual([receipt.provider,receipt.status,receipt.amount,receipt.track_id,receipt.txid,receipt.chain_id,receipt.confirmations],['oxapay','credited',exactMinor,r.track_id,null,null,null]);
    }
    assert.deepEqual((await get('/api/me/deposits',second)).json().deposits,[]);
    const notes=(await get('/api/me/notifications')).json().rows;assert.equal(notes.filter((n:{kind:string})=>n.kind==='deposit.credited').length,1);
    assert.equal((await query("select count(*)::int as n from audit_log where action='invoice.credited' and detail->>'id'=$1",[primary])).rows[0].n,1);
    assert.equal((await query('select id from deposits where user_id=$1',[owner])).rowCount,0);
    assert.equal((await get('/api/me/balances')).json().balances[0].amount,exactMinor);
    r.status='Paying';await callback(raw);assert.equal((await row(primary)).status,'credited');
  } finally {await flags('oxapay',false);}
});

test('lost POST result is never reissued; a fresh worker pages v1 history then verifies a native payment offline',async()=>{
  await query("update chains set enabled=false where id='BTC'");
  const request=randomUUID(), beforePosts=posts;
  afterPost=async()=>{throw new Error('connection lost after vendor accepted the invoice');};
  const res=await send('BTC','0.00010001',request);assert.equal(res.statusCode,202);
  const {id}=res.json();assert.equal(res.json().payment_url,null);assert.equal((await row(id)).track_id,null);assert.ok((await row(id)).dispatched_at);
  const r=remote(id);pay(r,{amount:dec('1.0001e-4')});
  for(let n=0;n<3;n++)assert.equal((await send('BTC','0.00010001',request)).json().id,id);
  assert.equal((await send('BTC','0.00010001')).statusCode,409);assert.equal(posts,beforePosts+1);
  historyPage=2;try{
    const replica=new OxaPay(transport);
    await due(id);await replica.reconcile();assert.equal((await row(id)).history_page,2);await noCredit(id);
    await due(id);await replica.reconcile();
    const j=await row(id);assert.equal(j.status,'credited');assert.equal(j.asset_id,'BTC');assert.equal(j.amount,'10001');assert.equal(j.track_id,r.track_id);
    assert.equal(historyQueries.at(-1)?.get('page'),'2');assert.equal(historyQueries.at(-1)?.get('type'),'invoice');assert.equal(historyQueries.at(-1)?.has('order_id'),false);
    assert.equal(posts,beforePosts+1);assert.equal((await get('/api/me/balances')).json().balances.find((a:{asset_id:string})=>a.asset_id==='BTC').amount,'10001');
  }finally{historyPage=1;}
});

test('early IPN is recoverable and an on-chain transaction already claimed by a different invoice needs review',async()=>{
  afterPost=async r=>{pay(r);assert.equal((await callback(ipn(r))).body,'ok');};
  const first=await send('ETH','0.1',randomUUID(),second), firstId=first.json().id;
  assert.equal(first.json().status,'credited');const proof=remote(firstId).txs[0]!;
  const duplicate=(await send('ETH','0.1')).json().id, next=remote(duplicate);
  pay(next,{...proof,tx_hash:String(proof.tx_hash).toUpperCase()});
  await due(duplicate);await service.reconcile();const held=await row(duplicate);
  assert.equal(held.status,'review');assert.equal(held.review_reason,'transfer_claimed');await noCredit(duplicate);
  assert.equal((await query('select * from oxapay_transfers where invoice_id=$1',[duplicate])).rowCount,0);
});

test('invalid hosted links and definitive API rejection never produce a payable URL or trigger an automatic re-POST',async()=>{
  for(const bad of ['http://pay.oxapay.com/123','https://pay.oxapay.com.invalid/123','https://user@pay.oxapay.com/123','https://pay.oxapay.com:8443/123',
    'https://oxapay.com/redirect?to=bad','https://pay.oxapay.com/123?next=bad','https://pay.oxapay.com/two/tokens','https://pay.oxapay.com/token#']){
    unsafe=bad;const req=randomUUID(), before=posts;const created=(await send('USDT','5',req,second)).json();
    assert.equal(created.payment_url,null);assert.equal(created.status,'review');assert.equal((await row(created.id)).payment_url,null);
    assert.equal((await send('USDT','5',req,second)).json().id,created.id);assert.equal(posts,before+1);await noCredit(created.id);
  }
  reject=true;const req=randomUUID(), before=posts;const declined=(await send('USDT','5',req,second)).json();
  assert.equal(declined.status,'failed');assert.equal(declined.payment_url,null);assert.equal((await send('USDT','5',req,second)).json().id,declined.id);assert.equal(posts,before+1);
});

test('gateways that round the requested denomination cannot supply a launchable checkout',async()=>{
  afterPost=async r=>{r.amount=dec('2');};
  const i=(await send('USDT',exact)).json();assert.equal(i.status,'review');assert.equal(i.payment_url,null);
  assert.equal((await row(i.id)).review_reason,'invoice_mismatch');await noCredit(i.id);
});

test('a local notification failure rolls back journal, transfer claims and balances; an offline retry finishes the whole transaction',async()=>{
  const id=(await send('ETH','0.05',randomUUID(),second)).json().id,r=remote(id);pay(r);
  const revision=(await query('select revision+1 as next from notification_heads where user_id=$1',[other])).rows[0].next;
  await query("insert into player_notifications(user_id,revision,kind,reference) values($1,$2,'fixture','notification-conflict')",[other,revision]);
  try {
    assert.equal((await callback(ipn(r))).statusCode,503);await noCredit(id);
    assert.equal((await query('select * from oxapay_transfers where invoice_id=$1',[id])).rowCount,0);
    assert.equal((await row(id)).status,'waiting');
  } finally {await query("delete from player_notifications where user_id=$1 and revision=$2 and kind='fixture'",[other,revision]);}
  await due(id);await new OxaPay(transport).reconcile();assert.equal((await row(id)).status,'credited');
  assert.equal((await query("select count(*)::int as n from player_notifications where reference=$1 and kind='deposit.credited'",['oxapay:'+id])).rows[0].n,1);
});
