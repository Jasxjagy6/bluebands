/// <reference lib="dom" />
import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { expectBelow } from './picker-geometry.js';

const database = new URL(process.env.DATABASE_URL || 'about:blank');
assert.ok(process.env.NODE_ENV === 'test' && database.hostname === '127.0.0.1' && !database.search &&
  process.env.PUBLIC_SITE_ORIGIN === 'https://payments.test.invalid',
  'Run with the disposable PostgreSQL test runner');
const { installMarketFixture } = await import('./market-fixture.js');
const restoreFetch = installMarketFixture(); // Also denies non-fixture HTTP from the server.
const { buildServer } = await import('../api/server.js');
const { hashPassword } = await import('../authutil.js');
const { pool, query, tx } = await import('../db.js');
const { post } = await import('../ledger.js');
const app = await buildServer(), root = new URL('../../../', import.meta.url);
const invoices = '/api/me/oxapay/invoices', deposit = '/account/deposit';
let base: string, browser: Browser;

before(async () => {
  app.log.level = 'warn';
  const mime: Record<string, string> = {'.html':'text/html', '.js':'application/javascript', '.css':'text/css',
    '.svg':'image/svg+xml', '.webp':'image/webp', '.png':'image/png', '.woff2':'font/woff2'};
  app.get('/*', async (req, reply) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    const file = pathname === '/' || /^\/account\/[a-z]+\/?$/.test(pathname) ? '/index.html' : pathname;
    if (!['/index.html', '/app.js', '/wallet.js', '/config.js'].includes(file) && !file.startsWith('/assets/')) return reply.code(404).send();
    return reply.type(mime[extname(file)] || 'application/octet-stream').send(await readFile(new URL(file.slice(1), root)));
  });
  base = await app.listen({host:'127.0.0.1', port:0});
  browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
});
after(async () => {
  try { await browser?.close(); await app.close(); }
  finally { restoreFetch(); await pool.end(); }
});

async function context(t: TestContext, width = 1280) {
  const ctx = await browser.newContext({viewport:{width, height:750}, serviceWorkers:'block'});
  t.after(() => ctx.close());
  ctx.setDefaultTimeout(8000);
  // An unexpected submit must not even reach the server's provider adapter.
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === base && !url.pathname.startsWith(invoices) ? route.continue() : route.abort('blockedbyclient');
  });
  await ctx.routeWebSocket(/.*/, socket => socket.close());
  return ctx;
}

async function player(t: TestContext, fixtureCatalog = true) {
  const ctx = await context(t), name = 'oxa' + randomUUID().slice(0, 8);
  const registered = await ctx.request.post(base + '/api/auth/register', {data:{username:name, email:name+'@test.invalid', password:randomUUID()}});
  assert.ok(registered.ok());
  const { user } = await registered.json(), funds = 2500000000000000000n;
  await tx(c => post(c, 'deposit', 'browser:' + user.id, [{account:'u:'+user.id, asset:'BNB', delta:funds}, {account:'ext:fixture', asset:'BNB', delta:-funds}]));
  assert.ok((await ctx.request.put(base + '/api/me/currency', {data:{asset:'BNB'}})).ok());
  if (fixtureCatalog) await ctx.route(base + '/api/assets', async route => {
    const response = await route.fetch({maxRedirects:0});
    await route.fulfill({response, json:{...await response.json(), deposit_provider:'oxapay', oxapay_ready:true, deposits_paused:false}});
  });
  const page = await ctx.newPage(), addresses: string[] = [], currencyWrites: string[] = [];
  await ctx.route(base + '/api/me/address/**', route => {
    addresses.push(route.request().url());
    return route.fulfill({status:503, json:{error:'Direct address issuance is offline in this fixture'}});
  });
  ctx.on('request', r => { if (r.method() !== 'GET' && r.url() === base + '/api/me/currency') currencyWrites.push(r.method()); });
  await page.goto(base);
  await page.locator('#ebwCcy[aria-label*="BNB"]').filter({hasText:/2\.5/}).waitFor();
  return {ctx, page, addresses, currencyWrites};
}

async function choose(page: Page, selector: string, value: string) {
  const control = page.locator(selector);
  const label = await control.evaluate((el, v) => Array.from((el as HTMLSelectElement).options).find(o => o.value === v)?.label, value);
  assert.ok(label, `Expected ${value} in ${selector}`);
  await control.click();
  await expectBelow(page,selector,'.eb-option-picker[open]');
  await page.getByRole('listbox').getByRole('option', {name:label, exact:true}).click();
}

async function amountForm(page: Page) {
  await page.waitForURL(base + deposit);
  await page.locator('#oxapayForm #depositAmount').waitFor();
  assert.equal(await page.inputValue('#depositCurrency'), 'BNB');
  assert.ok(await page.getByLabel('Enter your deposit amount',{exact:true}).isVisible());
  assert.ok(await page.getByRole('button',{name:'Continue',exact:true}).isVisible());
  assert.doesNotMatch(await page.locator('#accountPage').innerText(),/oxapay|hosted (?:deposit|checkout)|merchant key/i);
  assert.equal(await page.getByRole('dialog', {name:'Deposit currency'}).count(), 0);
  assert.equal(await page.locator('#depositNetwork:visible, #depositAddress:visible, #copyAddress:visible, #depositQr:visible').count(), 0);
  assert.equal(await page.locator('#walletContent').getByRole('combobox', {name:/network|chain/i}).count(), 0);
}

// Only the invoice boundary and one exact HTTPS navigation are synthetic. The return is an ordinary link,
// not a mock settlement. Neither a checkout page nor a query parameter has access to the ledger.
async function checkout(ctx: BrowserContext, options: {failFirst?: boolean; unsafeLink?: boolean} = {}) {
  const id = randomUUID(), url = 'https://pay.oxapay.com/' + id, receipt = base + deposit + '?invoice=' + id;
  const invoice = {id, asset_id:'USDT', symbol:'USDT', decimals:18, amount:'12500000000000000000', status:'waiting',
    payment_url: options.unsafeLink ? 'https://pay.oxapay.com.untrusted.invalid/' + id : url, networks:['ETH'],
    created_at:new Date().toISOString(), expires_at:new Date(Date.now()+3600000).toISOString(), credited_at:null};
  const posts: {asset:string; amount:string; request:string}[] = [], reads: boolean[] = [], navigations: string[] = [];
  await ctx.route(base + invoices, route => {
    if (route.request().method() === 'GET') return route.fulfill({json:{invoices:posts.length ? [invoice] : []}});
    if (route.request().method() !== 'POST') return route.fulfill({status:405});
    posts.push(route.request().postDataJSON());
    if (options.failFirst && posts.length === 1) return route.abort('connectionreset');
    return route.fulfill({status:201, json:invoice});
  });
  await ctx.route(base + invoices + '/' + id, async route => {
    reads.push(route.request().method() === 'GET' && /\beb_sess=/.test(await route.request().headerValue('cookie') || ''));
    await route.fulfill({json:invoice});
  });
  ctx.on('request', r => { if (r.isNavigationRequest() && new URL(r.url()).origin !== base && !r.frame().parentFrame()) navigations.push(r.url()); });
  await ctx.route(url, route => route.fulfill({contentType:'text/html',
    body:`<!doctype html><title>Offline checkout</title><a href="${receipt}&amp;status=paid">Return without paying</a>`}));
  return {id, url, receipt, posts, reads, navigations};
}

test('phone and desktop Deposit start with the playing currency amount; editing and cancelling issue nothing', async t => {
  const {ctx, page, addresses, currencyWrites} = await player(t), fixture = await checkout(ctx);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({width, height:width===320?480:750});
    await page.click('#ebwDep'); await amountForm(page);
    await page.fill('#depositAmount', '1.25'); await choose(page, '#depositCurrency', 'USDT');
    await page.fill('#depositAmount', '12.5');
    assert.equal(await page.inputValue('#depositCurrency'), 'USDT');
    assert.ok(await page.locator('#ebwCcy[aria-label*="BNB"]').isVisible());
    if (width === 390) await page.click('#cancelDeposit'); else await page.goBack();
    await page.waitForURL(base + '/');
    assert.equal(await page.locator('#oxapayForm').isVisible(), false);
  }
  assert.equal((await (await ctx.request.get(base + '/api/auth/me')).json()).user.display_ccy, 'BNB');
  assert.deepEqual([fixture.posts, addresses, currencyWrites, fixture.navigations], [[], [], [], []]);
});

test('deposit errors and unconfigured checkout never display provider diagnostics to players',async t=>{
  const {ctx,page}=await player(t);await page.click('#ebwDep');await amountForm(page);
  await ctx.route(base+invoices,r=>r.fulfill({status:400,json:{error:'OxaPay merchant configuration failure'}}));
  await page.fill('#depositAmount','12.5');await page.click('#depositCheckout');
  await page.locator('#depositStatus:not(:empty)').waitFor();await page.waitForFunction(()=>document.querySelector('#oxapayForm')?.getAttribute('aria-busy')!=='true');
  assert.doesNotMatch(await page.locator('#walletContent').innerText(),/oxapay|hosted (?:deposit|checkout)|merchant configuration/i);
  await ctx.route(base+'/api/assets',async route=>{const r=await route.fetch();await route.fulfill({response:r,json:{...await r.json(),deposit_provider:'oxapay',oxapay_ready:false,deposits_paused:false}});});
  await page.reload();await page.locator('#depositCheckout:disabled').waitFor();
  assert.doesNotMatch(await page.locator('#walletContent').innerText(),/oxapay|hosted (?:deposit|checkout)|merchant key/i);
});

test('retry preserves the checkout intent; an unpaid return, reload and resume never credit or reissue it', async t => {
  const {ctx, page, addresses, currencyWrites} = await player(t), fixture = await checkout(ctx, {failFirst:true});
  const balances = async () => (await (await ctx.request.get(base + '/api/me/balances')).json()).balances;
  const original = await balances();
  await page.click('#ebwDep'); await amountForm(page);
  await choose(page, '#depositCurrency', 'USDT'); await page.fill('#depositAmount', '12.5');
  await page.click('#depositCheckout');
  await page.locator('#depositStatus').filter({hasText:/retry|try again|could not|unavailable|failed|connection/i}).waitFor();
  await page.reload(); await page.locator('#depositAmount').waitFor();
  assert.equal(await page.inputValue('#depositAmount'), '12.5'); assert.equal(await page.inputValue('#depositCurrency'), 'USDT');
  await page.click('#depositCheckout'); await page.waitForURL(fixture.url);
  assert.equal(fixture.posts.length, 2); assert.deepEqual(fixture.posts[0], fixture.posts[1]);
  assert.equal(fixture.posts[0]!.asset, 'USDT'); assert.equal(fixture.posts[0]!.amount, '12.5');
  assert.match(fixture.posts[0]!.request, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
  const requestsBeforeReturn = fixture.reads.length;
  await ctx.route(base + invoices + '/' + fixture.id, r => r.fulfill({status:503, json:{error:'Offline status check'}}), {times:1});
  await page.getByRole('link', {name:'Return without paying'}).click();
  const receipt = page.locator('#invoiceReceipt');
  await receipt.getByText(/no payment status has been confirmed/i).waitFor();
  assert.equal(await receipt.locator('#resumeCheckout:visible').count(), 0);
  await receipt.getByRole('button', {name:/retry|try again/i}).click();
  const waiting = page.locator('#invoiceStatus').filter({hasText:/waiting|awaiting|unpaid|pending/i});
  await waiting.waitFor();
  assert.equal(new URL(page.url()).searchParams.get('invoice'), fixture.id);
  assert.match(await receipt.innerText(), /12\.5\s*USDT/);
  assert.doesNotMatch(await page.locator('#accountPage').innerText(),/oxapay|hosted (?:deposit|checkout)/i);
  assert.ok(fixture.reads.length > requestsBeforeReturn && fixture.reads.every(Boolean), 'Return must read the owner-scoped invoice');
  const beforeReload = fixture.reads.length;
  await page.reload(); await waiting.waitFor(); assert.ok(fixture.reads.length > beforeReload);
  await page.click('#resumeCheckout'); await page.waitForURL(fixture.url);
  await page.goBack(); await waiting.waitFor();
  assert.deepEqual(fixture.navigations, [fixture.url, fixture.url]); assert.equal(fixture.posts.length, 2);
  assert.deepEqual(await balances(), original); assert.deepEqual([addresses, currencyWrites], [[], []]);
  assert.ok(await page.locator('#ebwCcy[aria-label*="BNB"]').filter({hasText:/2\.5/}).isVisible());
  await page.click('#ebwCcy'); assert.equal(await page.locator('#ebwMenu [data-asset=USDT] b').innerText(), '0');
});

test('a lookalike checkout origin is neither followed on creation nor offered on a restored receipt', async t => {
  const {ctx, page} = await player(t), fixture = await checkout(ctx, {unsafeLink:true});
  await page.click('#ebwDep'); await amountForm(page);
  await choose(page, '#depositCurrency', 'USDT'); await page.fill('#depositAmount', '12.5');
  await page.click('#depositCheckout');
  await page.locator('#invoiceReceipt, #depositStatus').filter({hasText:/unavailable|invalid|unsafe|not available|cannot|could not|waiting/i}).first().waitFor();
  assert.equal(new URL(page.url()).origin, base); assert.equal(fixture.posts.length, 1);
  await page.goto(fixture.receipt); await page.locator('#invoiceStatus').waitFor();
  assert.ok(fixture.reads.length > 0 && fixture.reads.every(Boolean));
  assert.equal(await page.locator('#resumeCheckout:visible:not(:disabled)').count(), 0);
  assert.deepEqual(fixture.navigations, []);
});

test('Settings persists a write-only merchant key, validates both limits, and switches a direct wallet to hosted', async t => {
  const admin = await context(t), panel = await admin.newPage(), login = 'op-' + randomUUID().slice(0, 8), password = randomUUID();
  await query('insert into admin_users(username,pass_hash) values($1,$2)', [login, hashPassword(password)]);
  assert.ok((await admin.request.post(base + '/api/admin/login', {data:{username:login, password}})).ok());
  const settings = '/api/admin/settings', limits = '/api/admin/bet-limits', secrets = '/api/admin/secrets';
  const get = async (path: string) => { const r = await admin.request.get(base + path); assert.ok(r.ok()); return r.json(); };
  const open = async () => {
    await panel.goto(base + '/admin'); await panel.locator('#nav').getByRole('button', {name:'Settings', exact:true}).click();
    await panel.locator('#merchantKey').waitFor();
  };
  const save = async (form: string, path: string, method: string) => {
    const [response] = await Promise.all([panel.waitForResponse(r => r.url() === base + path && r.request().method() === method),
      panel.locator(form).getByRole('button', {name:/save|apply/i}).click()]);
    return response;
  };
  const snapshot = (await query(`select (select jsonb_agg(s) from settings s where key in ('deposit_provider','deposits_paused')) as settings,
    (select jsonb_agg(s) from secrets s where name='oxapay:merchant') as merchant,
    min_units,max_units from wager_limits where singleton`)).rows[0];
  const key = randomBytes(24).toString('hex') + 'QXZK';
  try {
    assert.ok((await admin.request.patch(base + settings, {data:{key:'deposits_paused', value:false}})).ok());
    await open();
    const field = panel.locator('#merchantForm #merchantKey');
    assert.equal(await field.getAttribute('type'), 'password'); assert.equal(await field.inputValue(), '');
    await field.fill(key);
    const stored = await save('#merchantForm', secrets, 'PUT'); assert.ok(stored.ok());
    assert.equal(stored.request().postDataJSON().name, 'oxapay:merchant');
    assert.ok(stored.request().postDataJSON().value === key, 'Merchant form did not save the entered key');
    assert.ok(!(await stored.text()).includes(key));
    await panel.waitForFunction(() => (document.querySelector('#merchantKey') as HTMLInputElement)?.value === '');
    assert.equal((await get(settings)).merchant_configured, true);
    for (const path of [settings, secrets]) assert.ok(!JSON.stringify(await get(path)).includes(key.slice(-4)), 'Merchant metadata exposed a key fragment');
    await open(); assert.equal(await field.inputValue(), '');

    await panel.route(base + secrets, route => route.fulfill({status:503, json:{error:'Fixture refused ' + key}}), {times:1});
    await field.fill(key); assert.equal((await save('#merchantForm', secrets, 'PUT')).status(), 503);
    await panel.locator('#toast').filter({hasText:/\S/}).waitFor();
    assert.ok(!(await panel.locator('body').innerText()).includes(key.slice(-4)), 'Operator error echoed the write-only key');

    const min = panel.locator('#limitsForm [name=minimum]'), max = panel.locator('#limitsForm [name=maximum]');
    const range = {min_usdt:'1.000000000000000001', max_usdt:'25.5'};
    await min.fill(range.min_usdt); await max.fill(range.max_usdt); assert.ok((await save('#limitsForm', limits, 'PUT')).ok());
    assert.deepEqual(await get(limits), range);
    await open(); assert.equal(await min.inputValue(), range.min_usdt); assert.equal(await max.inputValue(), range.max_usdt);
    await min.fill('26'); await panel.locator('#limitsForm').getByRole('button', {name:/save|apply/i}).click();
    await panel.locator('#limitsForm').getByRole('status').filter({hasText:/maximum|minimum|invalid/i}).waitFor();
    assert.deepEqual(await get(limits), range);

    const wallet = await player(t, false);
    for (const mode of ['direct', 'oxapay']) {
      await choose(panel, '#provider', mode);
      const reply = await save('#providerForm', settings, 'PATCH'); assert.ok(reply.ok());
      assert.deepEqual(reply.request().postDataJSON(), {key:'deposit_provider', value:mode});
      await open(); assert.equal(await panel.inputValue('#provider'), mode);
      assert.equal((await get(settings)).deposit_provider, mode); assert.equal((await get('/api/assets')).deposit_provider, mode);
      const attempts = wallet.addresses.length;
      await wallet.page.goto(base + deposit);
      if (mode === 'direct') {
        await wallet.page.locator('#depositNetwork').waitFor(); assert.equal(await wallet.page.locator('#oxapayForm').isVisible(), false);
      } else {
        await amountForm(wallet.page); await wallet.page.fill('#depositAmount', '2'); assert.ok(await wallet.page.locator('#depositCheckout').isEnabled());
        assert.equal(wallet.addresses.length, attempts);
      }
    }
  } finally {
    // Restore opaque encrypted data, including absent rows, without ever decrypting the old key.
    await tx(async c => {
      await c.query("delete from secrets where name='oxapay:merchant'");
      await c.query('insert into secrets select * from jsonb_populate_recordset(null::secrets,$1)', [JSON.stringify(snapshot.merchant || [])]);
      await c.query("delete from settings where key in ('deposit_provider','deposits_paused')");
      await c.query('insert into settings select * from jsonb_populate_recordset(null::settings,$1)', [JSON.stringify(snapshot.settings || [])]);
      await c.query('update wager_limits set min_units=$1,max_units=$2 where singleton', [snapshot.min_units, snapshot.max_units]);
    });
  }
});
