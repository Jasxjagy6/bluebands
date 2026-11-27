import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db.js';
import { getOrCreateAddress } from '../derive.js';
import { getUserBalances } from '../ledger.js';
import { supportedAssets } from '../chains/receive.js';
import { requireUser } from './guards.js';

export async function depositSetup() {
  const {rows:[setup]}=await query(`select (select value from settings where key='deposits_paused') is distinct from 'false'::jsonb
    or coalesce((select deposits_paused from alchemy_rpc_state where singleton),false) as deposits_paused`);
  return setup;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // Public: what can be deposited (for the UI to render chain/asset pickers).
  app.get('/api/assets', async () => {
    const chains = await query(
      `select id,display_name,kind,enabled,required_conf from chains order by id`,
    );
    const assets = await query(`select a.id,a.chain_id,a.symbol,a.kind,a.decimals,a.min_deposit::text,(a.enabled and n.enabled) as enabled
      from assets a join chains n on n.id=a.chain_id where ${supportedAssets} order by a.chain_id,a.kind desc,a.symbol`);
    const currencies=await query(`select id,symbol,decimals,kind,chain_id,min_deposit::text from playing_assets order by (id='USDT') desc,symbol`);
    const walletCurrencies=await query(`select id,symbol,decimals,kind,chain_id from wallet_assets order by (id='USDT') desc,symbol`);
    const direct=await query(`select a.id,a.chain_id,a.symbol,a.kind,a.decimals,a.min_deposit::text,(a.enabled and n.enabled) as enabled,
      (a.enabled and h.ready) as available from custody_launch_assets a join chains n on n.id=a.chain_id
      join custody_network_readiness h on h.chain_id=n.id order by a.symbol,n.id`);
    const denominations=await query('select id,symbol,decimals,chain_id from assets');
    const {deposits_paused}=await depositSetup();
    return {deposits_paused,chains:chains.rows,assets:assets.rows.filter(a=>a.enabled),transferRoutes:assets.rows,
      directRoutes:direct.rows.map(a=>({...a,available:!deposits_paused && a.available})),currencies:currencies.rows,walletCurrencies:walletCurrencies.rows,
      coinRate:{coins:'6000',usdt:'10'},denominations:denominations.rows};
  });

  // Everything below needs a signed-in player.
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/me/balances', async (req) => {
      return { balances: await getUserBalances(req.userId!) };
    });

    r.put('/api/me/currency', async (req, reply) => {
      const body = z.object({ asset: z.string().min(1).max(32) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'Choose a currency' });
      const saved=await query(`update users set display_ccy=$2 where id=$1 and exists(select 1 from playing_assets where id=$2) returning display_ccy`,[req.userId!,body.data.asset]);
      if (!saved.rowCount) return reply.code(400).send({ error: 'Currency unavailable' });
      return saved.rows[0];
    });

    r.get('/api/me/address/:chain', async (req, reply) => {
      const params = z.object({ chain: z.string().min(1).max(10) }).safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: 'Bad chain' });
      const chainId = params.data.chain.toUpperCase();

      const setup=await depositSetup();
      if(setup.deposits_paused)return reply.code(503).send({error:'Deposits are temporarily paused'});

      try {
        const { address } = await getOrCreateAddress(req.userId!, chainId);
        const chain = await query<{ display_name: string; required_conf: number }>(
          `select display_name, required_conf from chains where id=$1`,
          [chainId],
        );
        const assets = await query(
          `select a.id,a.symbol,a.kind,a.decimals,a.min_deposit::text from custody_launch_assets a join chains n on n.id=a.chain_id
             where a.chain_id=$1 and a.enabled and n.enabled order by a.kind desc,a.symbol`,
          [chainId],
        );
        return {
          chain: chainId,
          display_name: chain.rows[0]?.display_name ?? chainId,
          required_conf: chain.rows[0]?.required_conf ?? null,
          address,
          assets: assets.rows,
          warning: `Only send ${assets.rows.map((a: any) => a.symbol).join(', ')} on the ${chain.rows[0]?.display_name ?? chainId} network to this address. Sending any other asset or using a different network will lose your funds permanently.`,
        };
      } catch (e) {
        return reply.code(503).send({ error: 'Deposits are temporarily unavailable on this network.' });
      }
    });

    r.get('/api/me/deposits', async (req, reply) => {
      const q = z.object({ asset: z.string().max(32).optional() }).safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: 'Bad currency' });
      const rows = await query(
        `select d.id,d.provider,d.track_id,d.chain_id,d.asset_id,a.symbol,a.decimals,d.amount::text,d.txid,d.confirmations,d.required_conf,
                d.status,d.review_hold,d.first_seen_at,d.credited_at
           from deposit_records d join assets a on a.id=d.asset_id where d.user_id=$1 and ($2::text is null or d.asset_id=$2 or ($2='USDT' and a.symbol='USDT'))
           order by d.first_seen_at desc, d.id desc limit 50`,
        [req.userId!, q.data.asset ?? null],
      );
      return { deposits: rows.rows };
    });
  });
}
