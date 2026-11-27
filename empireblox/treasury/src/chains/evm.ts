import type { PoolClient } from 'pg';
import { JsonRpcProvider, id } from 'ethers';
import { tx } from '../db.js';
import { createAlchemyEvmProvider, flushRpcFailure, getRpcConfig, type RpcEndpoint } from './rpc.js';
import { creditConfirmedDeposit } from '../ledger.js';
import { config } from '../config.js';
import { scanIntervalMs } from './scan-policy.js';

const TRANSFER = id('Transfer(address,address,uint256)');
const NETWORK: Record<string, bigint> = { ETH: 1n, BSC: 56n, POL: 137n };
const BATCH = 40, LOG_BATCH = 10, LOG_OWNERS = 100;
type Asset = { id: string; kind: string; token_address: string | null; min_deposit: string };

export class EvmWatcher {
  private provider?: JsonRpcProvider;
  private route?: string;
  private routeEpoch:string|null=null;
  private endpoint?:RpcEndpoint;
  needsCatchUp=false;
  constructor(readonly chainId: string,private readonly scheduled=false) {}

  private async rpc(c: PoolClient) {
    const endpoint = await getRpcConfig(this.chainId,c);
    if (!endpoint) throw new Error('RPC endpoint is not configured');
    const route = `${endpoint.provider}:${endpoint.slot??''}:${endpoint.epoch??''}:${endpoint.url}`;
    if (!this.provider || this.route !== route) {
      this.provider?.destroy();
      this.provider = endpoint.provider==='legacy' ? new JsonRpcProvider(endpoint.url, undefined, { cacheTimeout: -1,staticNetwork:true }) : createAlchemyEvmProvider(endpoint);
      this.route = route;
      this.endpoint=endpoint;
    }
    this.routeEpoch=endpoint.epoch;
    return this.provider;
  }

  private async observe(c: PoolClient, asset: Asset, user: string, address: string, hash: string,
    index: number, amount: bigint, height: number, blockHash: string, confirmations: number) {
    if (amount <= 0n || amount < BigInt(asset.min_deposit)) return;
    // Sponsor gas is an internal transfer to a player address, not a deposit.
    if((await c.query('select 1 from custody_sweep_steps where chain_id=$1 and txid=$2',[this.chainId,hash.toLowerCase()])).rowCount)return;
    await c.query(`
      insert into deposits(chain_id,asset_id,user_id,address,txid,log_index,amount,block_number,block_hash,required_conf)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict(chain_id,txid,log_index) do update set
        asset_id=excluded.asset_id, user_id=excluded.user_id, address=excluded.address, amount=excluded.amount,
        block_number=excluded.block_number, block_hash=excluded.block_hash, required_conf=excluded.required_conf,
        confirmations=0, status='pending', confirmed_at=null
      where deposits.status='orphaned' and deposits.journal_id is null`,
      [this.chainId, asset.id, user, address, hash, index, amount.toString(), height, blockHash, confirmations]);
  }

  async tick(): Promise<void> {
    this.needsCatchUp=false;
    try { await this.scan(); }
    finally { if(this.endpoint)await flushRpcFailure(this.endpoint).catch(()=>{}); }
  }

  private async scan(): Promise<void> {
    await tx(async (c) => {
      // Both replicas run watchers. One scan owns the cursor, observations and
      // credits for a chain until all three commit together.
      const chain = (await c.query<{ last_scanned: string; required_conf: number }>(
        `select last_scanned, required_conf from chains where id=$1 and enabled
          and (not $2::boolean or next_scan_at is null or next_scan_at<=clock_timestamp()) for update skip locked`,
        [this.chainId,this.scheduled])).rows[0];
      if (!chain) return;
      const rpc = await this.rpc(c);
      // Check the actual endpoint every scan, even though ethers caches network
      // metadata for formatting. Rechecking it for every block wastes quota.
      if (BigInt(await rpc.send('eth_chainId',[])) !== NETWORK[this.chainId]) throw new Error('RPC network mismatch');
      const head = await rpc.getBlockNumber();
      const safeHead = Math.max(0, head - config.reorgSafety);
      let last = Number(chain.last_scanned);
      if (safeHead < last) return;
      const owners = new Map((await c.query<{address: string; user_id: string}>(
        'select address,user_id from deposit_addresses where chain_id=$1', [this.chainId])).rows.map(a => [a.address.toLowerCase(), a.user_id]));
      if (last === 0 && owners.size) throw new Error('Existing EVM deposit addresses require history reconciliation');
      const assets = (await c.query<Asset>('select * from assets where chain_id=$1 and enabled', [this.chainId])).rows;
      const native = assets.find(a => a.kind === 'native');
      const tokens = new Map(assets.filter(a => a.kind === 'token' && a.token_address).map(a => [a.token_address!.toLowerCase(), a]));
      const previous = (await c.query<{height: string; hash: string}>(
        'select height,hash from scanned_blocks where chain_id=$1 order by height desc', [this.chainId])).rows;
      let parent = previous[0]?.hash;
      if (parent) {
        const anchor = await rpc.getBlock(last);
        if (!anchor?.hash) throw new Error('Missing scan anchor');
        if (anchor.hash !== parent) {
          let common: typeof previous[number] | undefined;
          for (const block of previous.slice(1)) {
            if ((await rpc.getBlock(Number(block.height)))?.hash === block.hash) { common = block; break; }
          }
          if (!common) throw new Error('Reorganization exceeds retained block history');
          last = Number(common.height);
          parent = common.hash;
          const credited = await c.query('select 1 from deposits where chain_id=$1 and block_number>$2 and journal_id is not null limit 1', [this.chainId, last]);
          if (credited.rowCount) throw new Error('Reorganization affected credited funds; reconciliation required');
          await c.query("update deposits set status='orphaned', confirmations=0 where chain_id=$1 and block_number>$2 and journal_id is null", [this.chainId, last]);
          await c.query('delete from scanned_blocks where chain_id=$1 and height>$2', [this.chainId, last]);
        }
      } else if (last === 0) {
        // No address can be issued before this initial checkpoint commits.
        last = Math.max(0, safeHead - 1);
      }
      const end = Math.min(safeHead, last + BATCH);
      const blockHashes = new Map<number, string>();
      for (let n = last + 1; n <= end; n++) {
        const block = await rpc.getBlock(n, Boolean(native && owners.size));
        if (!block?.hash || (parent && block.parentHash !== parent)) throw new Error('Incomplete or changing block history');
        parent = block.hash; blockHashes.set(n,block.hash);
        if (native && owners.size) {
          for (const payment of block.prefetchedTransactions) {
            const dest = payment.to?.toLowerCase(), uid = dest && owners.get(dest);
            if (!dest || !uid || !payment.value) continue;
            const receipt = await rpc.getTransactionReceipt(payment.hash);
            if (!receipt || receipt.blockHash !== block.hash) throw new Error('Missing canonical receipt');
            if (receipt.status === 1) await this.observe(c, native, uid, dest, payment.hash, -1, payment.value, n, block.hash, chain.required_conf);
          }
        }
        await c.query('insert into scanned_blocks(chain_id,height,hash) values($1,$2,$3)', [this.chainId, n, block.hash]);
      }
      if(tokens.size&&owners.size){
        const recipients=[...owners.keys()].map(address=>'0x'+address.slice(2).padStart(64,'0'));
        for(let from=last+1;from<=end;from+=LOG_BATCH){
          const to=Math.min(end,from+LOG_BATCH-1);
          for(let offset=0;offset<recipients.length;offset+=LOG_OWNERS){
            const logs=await rpc.getLogs({fromBlock:from,toBlock:to,address:[...tokens.keys()],topics:[TRANSFER,null,recipients.slice(offset,offset+LOG_OWNERS)]});
            for (const log of logs) {
              const height=log.blockNumber,blockHash=blockHashes.get(height);
              if(log.removed||!blockHash||log.blockHash!==blockHash)throw new Error('Inconsistent transfer log');
              if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER.toLowerCase() ||
                  !/^0x0{24}[\da-f]{40}$/i.test(log.topics[1]!) || !/^0x0{24}[\da-f]{40}$/i.test(log.topics[2]!) ||
                  !/^0x[\da-f]{64}$/i.test(log.data)) throw new Error('Invalid ERC-20 transfer log');
              const dest = '0x' + log.topics[2]!.slice(-40).toLowerCase(), uid = owners.get(dest);
              const asset = tokens.get(log.address.toLowerCase());
              if (uid && asset) await this.observe(c, asset, uid, dest, log.transactionHash, log.index, BigInt(log.data), height, blockHash, chain.required_conf);
            }
          }
        }
      }

      const pending = await c.query<{id: string; block_number: string; block_hash: string; required_conf: number}>(
        "select id,block_number,block_hash,required_conf from deposits where chain_id=$1 and status in ('pending','confirmed') and block_number<=$2 and journal_id is null", [this.chainId, end]);
      for (const d of pending.rows) {
        const count = head - Number(d.block_number) + 1;
        if (count < d.required_conf) {
          await c.query('update deposits set confirmations=$2 where id=$1', [d.id, count]);
          continue;
        }
        const block = await rpc.getBlock(Number(d.block_number));
        if (!block?.hash) throw new Error('Confirmation block unavailable');
        if (block.hash !== d.block_hash) {
          await c.query("update deposits set status='orphaned',confirmations=0 where id=$1", [d.id]);
          continue;
        }
        await c.query("update deposits set confirmations=$2,status='confirmed',confirmed_at=now() where id=$1", [d.id, count]);
        await creditConfirmedDeposit(c, d.id);
      }
      await c.query(`update chains set last_scanned=$2,scan_ready_at=case when $2=$3::bigint and
        ($4::bigint is null or $4=(select routing_epoch from alchemy_rpc_state where singleton)) then now() end,
        next_scan_at=clock_timestamp()+($5::integer*interval '1 millisecond') where id=$1`,
      [this.chainId,end,safeHead,this.routeEpoch,end<safeHead?1000:scanIntervalMs(this.chainId)]);
      await c.query('delete from scanned_blocks where chain_id=$1 and height<$2', [this.chainId, end - Math.max(256, chain.required_conf + BATCH)]);
      this.needsCatchUp=end<safeHead;
    });
  }

}
