import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { validSolOwner } from '../chains/receive.js';
import { HDKey } from '@scure/bip32';
import { config } from '../config.js';
import {
  verifyPassword, signAdminToken, newTotpSecret, verifyTotp, totpUri, tokenHash,
} from '../authutil.js';
import { encryptBlob, decryptBlob, setSecret, listSecretMeta, deleteSecret } from '../vault.js';
import { requireAdmin, audit } from './guards.js';
import { limitsInput,publicLimits,readLimits } from '../games/wager-limits.js';
import { depositSetup } from './routes-user.js';

async function writeSecret(name:string,value:string|null,actor:string,ip:string){
  return tx(async c=>{
    if(/^rpc:(ETH|BSC|POL|SOL)$/.test(name) && (await c.query('select 1 from custody_root where sealed_seed is not null')).rowCount)return false;
    if(value===null)await deleteSecret(name,c);else await setSecret(name,value,actor,c);
    await c.query('insert into audit_log(actor,action,detail,ip) values($1,$2,$3,$4)',[actor,value===null?'secret.delete':'secret.set',{name},ip]);
    return true;
  });
}

const cookieOpts = {
  httpOnly: true as const,
  sameSite: 'lax' as const,
  secure: config.cookieSecure,
  path: '/',
  maxAge: 12 * 3600,
};

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // --- Login (public) ---
  app.post('/api/admin/login', async (req, reply) => {
    const body = z.object({
      username: z.string().min(1).max(64),
      password: z.string().min(1).max(256),
      totp: z.string().max(10).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Missing credentials' });

    const r = await query<any>(
      `select id, username, pass_hash, totp_enabled, totp_secret_enc, totp_iv, totp_tag, totp_dek, disabled
         from admin_users where username=$1`,
      [body.data.username],
    );
    const u = r.rows[0];
    const ok = u && !u.disabled && verifyPassword(body.data.password, u.pass_hash);
    if (!ok) {
      await audit(body.data.username, 'admin.login.fail', {}, req.ip);
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    if (u.totp_enabled) {
      if (!body.data.totp) return reply.code(401).send({ error: '2FA code required', need2fa: true });
      const secret = decryptBlob({ enc_dek: u.totp_dek, iv: u.totp_iv, tag: u.totp_tag, ciphertext: u.totp_secret_enc }).toString('utf8');
      if (!verifyTotp(secret, body.data.totp)) {
        await audit(u.username, 'admin.login.fail2fa', {}, req.ip);
        return reply.code(401).send({ error: 'Invalid 2FA code' });
      }
    }
    const token = await tx(async c=>{
      // Verify credentials still represent this account after any concurrent rotation or enrollment.
      const current=await c.query(`update admin_users set last_login_at=now()
        where id=$1 and pass_hash=$2 and totp_enabled=$3 and not disabled
        and totp_secret_enc is not distinct from $4 returning id`,[u.id,u.pass_hash,u.totp_enabled,u.totp_secret_enc]);
      return current.rowCount?signAdminToken(u.id,c):null;
    });
    if(!token)return reply.code(401).send({error:'Sign in again'});
    await audit(u.username, 'admin.login.ok', {}, req.ip);
    reply.setCookie('eb_admin', token, cookieOpts);
    return { ok: true, username: u.username, totp_enabled: u.totp_enabled };
  });

  // --- Everything below requires an admin session ---
  app.register(async (r) => {
    r.addHook('preHandler', requireAdmin);

    r.post('/api/admin/logout', async (req, reply) => {
      await query('delete from admin_sessions where token_hash=$1',[tokenHash(req.cookies.eb_admin!)]);
      reply.clearCookie('eb_admin', { path: '/' });
      return { ok: true };
    });

    r.get('/api/admin/me', async (req) => {
      const u = await query<any>(`select username, totp_enabled, last_login_at from admin_users where id=$1`, [req.admin!.adminId]);
      return u.rows[0] ?? {};
    });

    r.get('/api/admin/bet-limits',async()=>publicLimits(await readLimits()));
    r.put('/api/admin/bet-limits',async(req,reply)=>{
      const b=limitsInput.safeParse(req.body);
      if(!b.success)return reply.code(400).send({error:'Enter decimal USDT limits (up to 18 places). Maximum must be positive and at least the minimum, or null.'});
      return tx(async c=>{
        const saved=await c.query('update wager_limits set min_units=$1,max_units=$2 where singleton',[b.data.min_units,b.data.max_units]);
        if(!saved.rowCount)throw new Error('Bet settings unavailable');
        const limits=publicLimits(b.data);
        await c.query('insert into audit_log(actor,action,detail,ip) values($1,$2,$3,$4)',[req.admin!.username,'bet_limits.update',limits,req.ip]);
        return limits;
      });
    });

    // --- Overview ---
    r.get('/api/admin/overview', async () => {
      const addrs = await query<any>(`select count(*)::int c from deposit_addresses`);
      const pend = await query<any>(`select count(*)::int c from deposits where status in ('pending','confirmed')`);
      const credited = await query<any>(
        `select a.id as asset_id,a.decimals,sum(d.amount)::text total,count(*)::int n from deposit_records d join assets a on a.id=d.asset_id where d.status='credited' group by a.id order by a.id`,
      );
      const recent = await query<any>(
        `select d.*,a.decimals from deposit_records d join assets a on a.id=d.asset_id order by first_seen_at desc,d.id desc limit 20`,
      );
      return {
        addresses: addrs.rows[0].c,
        pending: pend.rows[0].c,
        credited: credited.rows,
        recent: recent.rows,
        ...await depositSetup(),
      };
    });

    // --- Secrets (write-only values; never returned in plaintext) ---
    r.get('/api/admin/secrets', async () => ({ secrets: await listSecretMeta() }));

    r.put('/api/admin/secrets', async (req, reply) => {
      const body = z.object({ name: z.string().min(1).max(64), value: z.string().min(1).max(4096) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'Bad secret' });
      if (body.data.name.startsWith('xpub:')) {
        try { const key=HDKey.fromExtendedKey(body.data.value); if (key.privateKey || !key.publicKey) throw new Error(); }
        catch { return reply.code(400).send({error:'Enter a watch-only extended public key'}); }
      }
      if(!/^(rpc|xpub):(EVM|ETH|BSC|POL|SOL|BTC|TRON)$/.test(body.data.name))return reply.code(400).send({error:'Use a supported network RPC or watch-only key'});
      if(!await writeSecret(body.data.name,body.data.value,req.admin!.username,req.ip))return reply.code(409).send({error:'Manage enrolled network RPCs through Direct wallets.'});
      return { ok: true };
    });

    r.delete('/api/admin/secrets/:name', async (req, reply) => {
      const p = z.object({ name: z.string().min(1).max(64) }).safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: 'Bad name' });
      if(!await writeSecret(p.data.name,null,req.admin!.username,req.ip))return reply.code(409).send({error:'Manage enrolled network RPCs through Direct wallets.'});
      return { ok: true };
    });

    r.get('/api/admin/sol-addresses',async()=> (await query('select count(*) filter(where user_id is null)::int as remaining from sol_receive_pool')).rows[0]);
    r.post('/api/admin/sol-addresses',async(req,reply)=>{
      const b=z.object({addresses:z.array(z.string().min(32).max(44)).min(1).max(500)}).safeParse(req.body);
      if(!b.success || !b.data.addresses.every(validSolOwner)) return reply.code(400).send({error:'Use valid public Solana wallet addresses'});
      const result=await query('insert into sol_receive_pool(address) select distinct unnest($1::text[]) on conflict do nothing',[b.data.addresses]);
      await audit(req.admin!.username,'sol.addresses.imported',{count:result.rowCount},req.ip);
      return {added:result.rowCount};
    });

    // --- Chains ---
    r.get('/api/admin/chains', async () => ({
      chains: (await query(`select id, kind, display_name, enabled, required_conf, last_scanned::text from chains order by id`)).rows,
    }));

    r.patch('/api/admin/chains/:id', async (req, reply) => {
      const p = z.object({ id: z.string().min(1).max(10) }).safeParse(req.params);
      const b = z.object({ enabled: z.boolean().optional(), required_conf: z.number().int().min(1).max(1000).optional() }).safeParse(req.body);
      if (!p.success || !b.success) return reply.code(400).send({ error: 'Bad input' });
      const sets: string[] = [], vals: unknown[] = [p.data.id];
      if (b.data.enabled !== undefined) { vals.push(b.data.enabled); sets.push(`enabled=$${vals.length}`); }
      if (b.data.required_conf !== undefined) { vals.push(b.data.required_conf); sets.push(`required_conf=$${vals.length}`); }
      if (!sets.length) return { ok: true };
      await query(`update chains set ${sets.join(', ')} where id=$1`, vals);
      await audit(req.admin!.username, 'chain.update', { id: p.data.id, ...b.data }, req.ip);
      return { ok: true };
    });

    // --- Assets ---
    r.get('/api/admin/assets', async () => ({
      assets: (await query(`select id, chain_id, symbol, kind, token_address, decimals, min_deposit::text min_deposit, enabled from assets order by chain_id, kind desc, symbol`)).rows,
    }));

    r.patch('/api/admin/assets/:id', async (req, reply) => {
      const p = z.object({ id: z.string().min(1).max(32) }).safeParse(req.params);
      const b = z.object({
        enabled: z.boolean().optional(),
        min_deposit: z.string().regex(/^\d+$/).optional(),
        token_address: z.string().max(80).optional(),
      }).safeParse(req.body);
      if (!p.success || !b.success) return reply.code(400).send({ error: 'Bad input' });
      const sets: string[] = [], vals: unknown[] = [p.data.id];
      if (b.data.enabled !== undefined) { vals.push(b.data.enabled); sets.push(`enabled=$${vals.length}`); }
      if (b.data.min_deposit !== undefined) { vals.push(b.data.min_deposit); sets.push(`min_deposit=$${vals.length}`); }
      if (b.data.token_address !== undefined) {
        if(['USDT.ERC20','USDT.BEP20','USDT.POL'].includes(p.data.id))return reply.code(400).send({error:'The launch USDT contract is pinned to its network'});
        const row=(await query("select n.kind from assets a join chains n on n.id=a.chain_id where a.id=$1 and a.kind='token'",[p.data.id])).rows[0];
        const value=b.data.token_address;
        const patterns:Record<string,RegExp>={evm:/^0x[0-9a-fA-F]{40}$/,sol:/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,tron:/^T[1-9A-HJ-NP-Za-km-z]{33}$/};
        if(!row || !patterns[row.kind]?.test(value))return reply.code(400).send({error:'Check the token contract for this network'});
        vals.push(row.kind==='evm'?value.toLowerCase():value);sets.push(`token_address=$${vals.length}`);
      }
      if (!sets.length) return { ok: true };
      await query(`update assets set ${sets.join(', ')} where id=$1`, vals);
      await audit(req.admin!.username, 'asset.update', { id: p.data.id, ...b.data }, req.ip);
      return { ok: true };
    });

    // --- Deposits view ---
    r.get('/api/admin/deposits', async (req) => {
      const q = z.object({ status: z.string().optional() }).parse(req.query);
      const rows=await query(`select d.*,a.decimals from deposit_records d join assets a on a.id=d.asset_id where ($1::text is null or d.status=$1)
        order by d.first_seen_at desc,d.id desc limit 100`,[q.status??null]);
      return { deposits: rows.rows };
    });

    // --- Settings (kill switches) ---
    r.get('/api/admin/settings', async () => ({settings:(await query('select key,value from settings order by key')).rows,...await depositSetup()}));

    r.patch('/api/admin/settings', async (req, reply) => {
      const b = z.object({key:z.literal('deposits_paused'),value:z.boolean()}).strict().safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'Bad setting' });
      await tx(async c=>{await c.query(
        `insert into settings(key,value,updated_at) values ($1,$2,now())
         on conflict (key) do update set value=$2, updated_at=now()`,
        [b.data.key, JSON.stringify(b.data.value)],
      );await c.query('insert into audit_log(actor,action,detail,ip) values($1,$2,$3,$4)',[req.admin!.username,'setting.update',b.data,req.ip]);});
      return { ok: true };
    });

    // --- 2FA enrolment ---
    r.post('/api/admin/2fa/setup', async (req,reply) => {
      const secret = newTotpSecret();
      const blob = encryptBlob(secret);
      const saved=await query(
        `update admin_users set totp_secret_enc=$2, totp_iv=$3, totp_tag=$4, totp_dek=$5 where id=$1 and not totp_enabled`,
        [req.admin!.adminId, blob.ciphertext, blob.iv, blob.tag, blob.enc_dek],
      );
      if (!saved.rowCount) return reply.code(409).send({error:'Two-factor authentication is already enabled'});
      return { secret, uri: totpUri(secret, req.admin!.username) };
    });

    r.post('/api/admin/2fa/enable', async (req, reply) => {
      const b = z.object({ totp: z.string().min(6).max(10) }).safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'Enter the 6-digit code' });
      const u = await query<any>(`select totp_secret_enc, totp_iv, totp_tag, totp_dek from admin_users where id=$1`, [req.admin!.adminId]);
      const row = u.rows[0];
      if (!row?.totp_secret_enc) return reply.code(400).send({ error: 'Run setup first' });
      const secret = decryptBlob({ enc_dek: row.totp_dek, iv: row.totp_iv, tag: row.totp_tag, ciphertext: row.totp_secret_enc }).toString('utf8');
      if (!verifyTotp(secret, b.data.totp)) return reply.code(401).send({ error: 'Code did not match' });
      const enabled=await tx(async c=>{
        const result=await c.query(`update admin_users set totp_enabled=true where id=$1 and totp_secret_enc=$2 and not totp_enabled`,[req.admin!.adminId,row.totp_secret_enc]);
        if(!result.rowCount)return false;
        await c.query('delete from admin_sessions where admin_id=$1 and token_hash<>$2',[req.admin!.adminId,tokenHash(req.cookies.eb_admin!)]);
        return true;
      });
      if (!enabled) return reply.code(409).send({error:'Enrollment changed. Refresh and retry.'});
      await audit(req.admin!.username, 'admin.2fa.enabled', {}, req.ip);
      return { ok: true };
    });

    // --- Audit log ---
    r.get('/api/admin/audit', async () => ({
      audit: (await query(`select actor, action, detail, ip, created_at from audit_log order by created_at desc limit 100`)).rows,
    }));
  });
}
