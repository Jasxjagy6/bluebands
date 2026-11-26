import { mock } from 'node:test';
import { query } from '../db.js';

const fixtureRates={USDT:'1',ETH:'0.0006',BNB:'0.002',POL:'2',BTC:'0.00002',SOL:'0.01'};
export function marketResponse(overrides:Record<string,unknown>={},headers:Record<string,string>={}) {
  return Response.json({data:{currency:'USD',rates:{...fixtureRates,...overrides}}},
    {headers:{date:new Date().toUTCString(),...headers}});
}
export function krakenResponse(overrides:Record<string,unknown>={},headers:Record<string,string>={}) {
  return Response.json({error:[],result:{
    TRXUSD:{b:['0.30999','1','1.0'],a:['0.31001','2','2.0'],c:['0.30990','1.0']},
    USDTZUSD:{b:['1.0299','3','3.0'],a:['1.0301','1','1.0'],c:['1.0298','1.0']},...overrides}},
    {headers:{date:new Date().toUTCString(),...headers}});
}

/** Exercise the production HTTP validation and DB cache without external I/O. */
type Reply=(init?:Parameters<typeof fetch>[1])=>Response|Promise<Response>;
export function installMarketFixture(response:Reply=()=>marketResponse(),kraken:Reply=()=>krakenResponse()) {
  const forward=globalThis.fetch;
  const f=mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
    const url=new URL(typeof input==='string' || input instanceof URL?input:input.url);
    if(url.href==='https://api.coinbase.com/v2/exchange-rates?currency=USD')return response(init);
    if(url.href==='https://api.kraken.com/0/public/Ticker?pair=TRXUSD,USDTUSD')return kraken(init);
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Non-fixture network request blocked');
    return forward(input,init);
  });
  return ()=>f.mock.restore();
}

/** Advance just the quote clock, leaving the frozen leg prices untouched. */
export async function expireMarket(asset:string) {
  await query(`update game_quotes set expires_at=clock_timestamp()
    where asset_id=$1 and quoted_at is not null and expires_at>clock_timestamp()`,[asset]);
}
