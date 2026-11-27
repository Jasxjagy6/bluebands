/// <reference lib="dom" />
import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac,randomBytes,randomUUID } from 'node:crypto';
import { readFile,readdir,mkdir } from 'node:fs/promises';
import { resolve,extname } from 'node:path';
import pg from 'pg';
import { base32 } from '@scure/base';
import { chromium,type Browser } from 'playwright';

const runner=new URL(process.env.DATABASE_URL??'');
if(process.env.NODE_ENV!=='test'||!['127.0.0.1','localhost','[::1]'].includes(runner.hostname))throw Error('Disposable local database required');
const control=new pg.Pool({connectionString:runner.href}),dbName='player_security_'+randomBytes(8).toString('hex');
const isolated=new URL(runner);isolated.pathname='/'+dbName;process.env.DATABASE_URL=isolated.href;
const {query,pool}=await import('../db.js');
const {buildServer}=await import('../api/server.js');
const {createSession,verifySession}=await import('../auth-user.js');
const {hashPassword,verifyPassword}=await import('../authutil.js');
const {installMarketFixture}=await import('./market-fixture.js');installMarketFixture();
const app=await buildServer(),root=resolve('..'),password='Fixture-password-2026';
let requests=0,base='',browser:Browser;
const otp=(secret:string,offset=0)=>{
  const buf=Buffer.alloc(8);buf.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)+offset));
  const h=createHmac('sha1',base32.decode(secret)).update(buf).digest(),at=h[19]!&15;
  return ((h.readUInt32BE(at)&0x7fffffff)%1000000).toString().padStart(6,'0');
};
const call=(path:string,payload?:Record<string,unknown>,cookie='')=>app.inject({url:'/api/auth/'+path,method:payload===undefined?'GET':'POST',headers:{cookie},payload,remoteAddress:'127.0.2.'+(++requests%240+1)});
async function player(){
  const id=randomUUID(),suffix=randomBytes(6).toString('hex'),email=suffix+'@security.test.invalid';
  await query('insert into users(id,email,username,pass_hash) values($1,$2,$3,$4)',[id,email,'p'+suffix,hashPassword(password)]);
  const token=await createSession(id);return {id,email,token,cookie:'eb_sess='+token};
}
async function enabled(){
  const p=await player(),setup=await call('2fa/setup',{password},p.cookie);assert.equal(setup.statusCode,200,setup.body);
  const secret=setup.json().secret,activation=await call('2fa/enable',{password,totp:otp(secret,-1)},p.cookie);
  assert.equal(activation.statusCode,200,activation.body);return {...p,secret,codes:activation.json().recovery_codes as string[]};
}
before(async()=>{
  await control.query('create database '+dbName+' template template0');
  const sql=new URL('../../sql/',import.meta.url);
  for(const f of (await readdir(sql)).filter(f=>f.endsWith('.sql')).sort())await query(await readFile(new URL(f,sql),'utf8'));
  await query("update settings set value='true' where key='player_2fa_available'");
  app.get('/*',async(req,reply)=>{
    const path=req.url.split('?')[0]!,name=path==='/'||path.startsWith('/account/')?'index.html':path.slice(1);
    if(!['index.html','app.js','wallet.js','config.js'].includes(name)&&!name.startsWith('assets/'))return reply.code(404).send();
    const mime:Record<string,string>={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'};
    return reply.type(mime[extname(name)]||'application/octet-stream').send(await readFile(resolve(root,name)));
  });
  base=await app.listen({host:'127.0.0.1',port:0});
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
});
after(async()=>{
  await browser?.close();await app.close();await pool.end();
  try{await control.query('drop database if exists '+dbName);}finally{await control.end();}
});
test('enrollment requires a session and password, is encrypted, and is gated until every API replica is ready',async()=>{
  assert.equal((await call('security')).statusCode,401);
  assert.equal((await call('2fa/setup',{password})).statusCode,401);
  const p=await player();
  await query("update settings set value='false' where key='player_2fa_available'");
  assert.equal((await call('2fa/setup',{password},p.cookie)).statusCode,503);
  await query("update settings set value='true' where key='player_2fa_available'");
  assert.equal((await call('2fa/setup',{password:'wrong'},p.cookie)).statusCode,401);
  const r=await call('2fa/setup',{password},p.cookie);assert.equal(r.statusCode,200,r.body);
  const d=r.json();assert.match(d.secret,/^[A-Z2-7]{32}$/);assert.match(d.uri,/^otpauth:\/\/totp\/BANDITBLOX/);
  assert.ok(d.uri.includes(d.secret));assert.equal(d.expires_in,600);
  const stored=(await query('select * from user_authenticators where user_id=$1',[p.id])).rows[0];
  assert.equal(stored.enabled_at,null);assert.ok(stored.ciphertext instanceof Buffer);assert.ok(!stored.ciphertext.includes(Buffer.from(d.secret)));
  const status=await call('security',undefined,p.cookie);assert.equal(status.json().totp_enabled,false);assert.doesNotMatch(status.body,/secret|ciphertext|enc_dek|token_hash/);
  await query("update user_authenticators set setup_expires_at=now()-interval '1 second' where user_id=$1",[p.id]);
  assert.equal((await call('2fa/enable',{password,totp:otp(d.secret)},p.cookie)).statusCode,409);
  assert.equal((await call('security',undefined,p.cookie)).json().totp_enabled,false);
});
test('activation validates the app code, returns ten codes once and revokes pre-enrollment sessions',async()=>{
  const p=await player(),other=await createSession(p.id),setup=await call('2fa/setup',{password},p.cookie),secret=setup.json().secret;
  assert.equal((await call('2fa/enable',{password:'wrong',totp:otp(secret)},p.cookie)).statusCode,401);
  const bad=(Number(otp(secret))+17).toString().padStart(6,'0').slice(-6);
  assert.equal((await call('2fa/enable',{password,totp:bad},p.cookie)).statusCode,401);
  const r=await call('2fa/enable',{password,totp:otp(secret,-1)},p.cookie);assert.equal(r.statusCode,200,r.body);
  const codes=r.json().recovery_codes;assert.equal(codes.length,10);assert.equal(new Set(codes).size,10);assert.ok(codes.every((c:string)=>/^[A-F0-9]{5}(?:-[A-F0-9]{5}){3}$/.test(c)));
  assert.equal(await verifySession(other),null);assert.equal(await verifySession(p.token),p.id);
  const status=await call('security',undefined,p.cookie);assert.equal(status.json().totp_enabled,true);assert.equal(status.json().recovery_codes_remaining,10);assert.equal(status.json().sessions.length,1);
  assert.doesNotMatch(status.body,/recovery_codes":|token_hash|secret|ciphertext/);
  const stored=(await query('select recovery_hashes from user_authenticators where user_id=$1',[p.id])).rows[0];assert.equal(stored.recovery_hashes.length,10);assert.ok(stored.recovery_hashes.every((h:Buffer)=>h.length===32));
  assert.equal((await call('2fa/setup',{password},p.cookie)).statusCode,409);
});
test('login requires the factor and concurrent use of the same TOTP creates exactly one session',async()=>{
  const p=await enabled();
  const noFactor=await call('login',{email:p.email,password});assert.equal(noFactor.statusCode,401);assert.equal(noFactor.json().need2fa,true);assert.equal(noFactor.headers['set-cookie'],undefined);
  const wrongPassword=await call('login',{email:p.email,password:'incorrect'});assert.equal(wrongPassword.statusCode,401);assert.equal(wrongPassword.json().need2fa,undefined);
  const code=otp(p.secret),responses=await Promise.all([call('login',{email:p.email,password,totp:code}),call('login',{email:p.email,password,totp:code})]);
  assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,401]);assert.equal(responses.filter(r=>r.headers['set-cookie']).length,1);
  assert.equal((await query('select count(*)::int as n from user_sessions where user_id=$1',[p.id])).rows[0].n,2);
  const recovery=await call('login',{email:p.email,password,totp:p.codes[0]!.toLowerCase()});assert.equal(recovery.statusCode,200,recovery.body);
  assert.equal((await call('login',{email:p.email,password,totp:p.codes[0]})).statusCode,401);
  assert.equal((await call('security',undefined,p.cookie)).json().recovery_codes_remaining,9);
});
test('authenticator password recovery is generic on failure, consumes a code once and invalidates every existing session',async()=>{
  const p=await enabled(),other=await createSession(p.id),newPassword='Recovered-fixture-password';
  const invalid=await call('password/recover',{email:p.email,password:newPassword,totp:'000000'}),missing=await call('password/recover',{email:'missing@security.test.invalid',password:newPassword,totp:'000000'});
  assert.equal(invalid.statusCode,401);assert.equal(invalid.body,missing.body);assert.equal(await verifySession(other),p.id);
  const original=(await query('select pass_hash from users where id=$1',[p.id])).rows[0].pass_hash;assert.ok(verifyPassword(password,original));
  const reset=await call('password/recover',{email:p.email,password:newPassword,totp:p.codes[0]});assert.equal(reset.statusCode,200,reset.body);
  assert.equal(await verifySession(p.token),null);assert.equal(await verifySession(other),null);
  assert.equal((await call('login',{email:p.email,password,totp:p.codes[1]})).statusCode,401);
  assert.equal((await call('login',{email:p.email,password:newPassword})).json().need2fa,true);
  assert.equal((await call('password/recover',{email:p.email,password:newPassword,totp:p.codes[0]})).statusCode,401);
  const login=await call('login',{email:p.email,password:newPassword,totp:p.codes[1]});assert.equal(login.statusCode,200,login.body);
  const events=(await query("select kind,amount,asset_id from player_notifications where user_id=$1 and kind like 'security.%'",[p.id])).rows;
  assert.ok(events.some(e=>e.kind==='security.password_recovered'));assert.ok(events.every(e=>e.amount===null&&e.asset_id===null));
});
test('password change, session revocation and authenticator removal require a password and a fresh factor',async()=>{
  const p=await enabled(),other=await createSession(p.id);
  assert.equal((await call('sessions/revoke',{password},p.cookie)).statusCode,401);assert.equal(await verifySession(other),p.id);
  assert.equal((await call('sessions/revoke',{password,totp:p.codes[0]},p.cookie)).statusCode,200);assert.equal(await verifySession(other),null);
  assert.equal((await call('password',{current:password,password:'Another-fixture-password'},p.cookie)).statusCode,401);
  const changed=await call('password',{current:password,password:'Another-fixture-password',totp:p.codes[1]},p.cookie);assert.equal(changed.statusCode,200,changed.body);assert.equal(await verifySession(p.token),null);
  const cookie=String(changed.headers['set-cookie']).split(';')[0]!;
  assert.equal((await call('2fa/disable',{password:'wrong',totp:p.codes[2]},cookie)).statusCode,401);
  assert.equal((await call('2fa/disable',{password:'Another-fixture-password',totp:p.codes[2]},cookie)).statusCode,200);
  assert.equal((await call('security',undefined,cookie)).json().totp_enabled,false);
  assert.equal((await call('login',{email:p.email,password:'Another-fixture-password'})).statusCode,200);
  assert.equal((await call('password/recover',{email:p.email,password:'Cannot-reset-password',totp:p.codes[3]})).statusCode,401);
});
test('failed recovery attempts remain rate-limited after transaction rollback',async()=>{
  const p=await enabled();
  for(let n=0;n<5;n++)assert.equal((await call('password/recover',{email:p.email,password:'Unchanged-password',totp:'invalid-code'})).statusCode,401);
  assert.equal((await call('password/recover',{email:p.email,password:'Unchanged-password',totp:p.codes[0]})).statusCode,429);
  assert.equal((await call('security',undefined,p.cookie)).json().recovery_codes_remaining,10);
  assert.equal(await verifySession(p.token),p.id);
});
test('Security displays local QR and manual key, saves recovery codes, supports sign-in and password recovery on mobile',async()=>{
  const p=await player(),ctx=await browser.newContext({viewport:{width:390,height:844},permissions:['clipboard-read','clipboard-write']});
  const errors:string[]=[],external:string[]=[];
  await ctx.addCookies([{name:'eb_sess',value:p.token,url:base}]);
  await ctx.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){external.push(route.request().url());return route.abort();}return route.continue();});
  const page=await ctx.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(base+'/account/security');await page.locator('#setupAuthenticator').waitFor();
    await page.locator('#setupAuthenticator input').fill(password);await page.getByRole('button',{name:'Set up authenticator',exact:true}).click();
    await page.locator('#authenticatorQr svg').waitFor();const secret=(await page.locator('#authenticatorKey').textContent())!;assert.match(secret,/^[A-Z2-7]{32}$/);
    await page.getByRole('button',{name:'Copy setup key'}).click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),secret);
    for(const width of [320,1440]){
      await page.setViewportSize({width,height:900});assert.ok(await page.locator('#accountPage').evaluate(el=>el.scrollWidth<=el.clientWidth));
      const dir=process.env.WALLET_SCREENSHOT_DIR;if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:resolve(dir,'authenticator-setup-'+width+'.png')});}
    }
    await page.locator('#enableAuthenticator input[name=password]').fill(password);await page.locator('#enableAuthenticator input[name=totp]').fill(otp(secret,-1));await page.getByRole('button',{name:'Enable authenticator',exact:true}).click();
    await page.locator('.recovery-codes').waitFor();assert.equal(await page.locator('#authenticatorKey').count(),0);assert.equal(await page.locator('.recovery-codes li').count(),10);
    const codes=await page.locator('.recovery-codes code').allTextContents();await page.getByRole('button',{name:'Copy recovery codes'}).click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),codes.join('\n'));
    await page.getByRole('button',{name:'I saved my recovery codes'}).click();await page.getByText('Two-factor authentication is on',{exact:true}).waitFor();assert.equal(await page.locator('.recovery-codes').count(),0);
    assert.equal(await page.locator('#changePassword input[name=totp]').isVisible(),true);
    await page.locator('#walletNav [data-view=profile]').click();await page.locator('.profile-security').waitFor();assert.match(await page.locator('.profile-security').innerText(),/Authenticator enabled/);
    await ctx.clearCookies();await page.goto(base);await page.locator('#signBtn').click();await page.locator('#liEmail').fill(p.email);await page.locator('#liPass').fill(password);await page.locator('#liGo').click();await page.locator('#liTotp').waitFor();
    await page.locator('#liTotp').fill(codes[0]!);await page.locator('#liGo').click();await page.locator('#ebwCcy').waitFor();
    await ctx.clearCookies();await page.goto(base);await page.locator('#signBtn').click();await page.locator('#toForgot').click();
    await page.locator('#fpEmail').fill(p.email);await page.locator('#fpCode').fill(codes[1]!);await page.locator('#fpPassword').fill('Browser-reset-password');await page.locator('#fpConfirm').fill('Browser-reset-password');await page.locator('#fpGo').click();
    await page.getByRole('heading',{name:'Password updated',exact:true}).waitFor();assert.match(await page.locator('#sentMsg').innerText(),/fresh authenticator code/);assert.equal((await ctx.cookies()).filter(c=>c.name==='eb_sess'&&c.value).length,0);
  }finally{await ctx.close();}
  assert.deepEqual(errors,[]);assert.ok(external.every(url=>['fonts.googleapis.com','thumbnails.roproxy.com'].includes(new URL(url).hostname)),'Authenticator setup must not contact an external QR service');
});

test('a fresh six-digit authenticator code can recover a password and cannot be replayed for login',async()=>{
  const p=await enabled(),code=otp(p.secret),next='TOTP-recovered-password';
  const recovered=await call('password/recover',{email:p.email,password:next,totp:code});assert.equal(recovered.statusCode,200,recovered.body);
  assert.equal(await verifySession(p.token),null);
  const replay=await call('login',{email:p.email,password:next,totp:code});assert.equal(replay.statusCode,401);assert.equal(replay.json().need2fa,true);
  assert.equal((await call('login',{email:p.email,password:next,totp:p.codes[0]})).statusCode,200);
});
