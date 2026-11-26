import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteUnit } from '../games/prices.js';
import { checkLimits,limitsInput,publicLimits,usdtValue } from '../games/wager-limits.js';

test('configuration is a complete, ordered pair of exact 18-place decimal strings',()=>{
  const huge='9'.repeat(60)+'.'+'9'.repeat(18);
  for(const amount of ['1','0.000000000000000001',huge]){
    const range={min_usdt:amount,max_usdt:amount};
    assert.deepEqual(publicLimits(limitsInput.parse(range)),range);
  }
  assert.deepEqual(publicLimits(limitsInput.parse({min_usdt:'00.000',max_usdt:null})),{min_usdt:'0',max_usdt:null});
  for(const b of [{min_usdt:'1'},{max_usdt:null},{min_usdt:0,max_usdt:null},{min_usdt:'-1',max_usdt:null},
    {min_usdt:'1',max_usdt:'0.999999999999999999'},{min_usdt:'0',max_usdt:'0'},{min_usdt:'0',max_usdt:Infinity},
    ...['0x12','1e3','1.0000000000000000001','.5',' '.repeat(100),'1'.repeat(61)].map(v=>({min_usdt:'0',max_usdt:v}))]){
    assert.equal(limitsInput.safeParse(b).success,false);
  }
});

test('bounds use the exact USD cross rate, not rounded catalog units or truncated exposure',()=>{
  // 2 ETH-minor per USDT-minor: 3 minor cost 1.5 USDT-minor, not 1.
  const q={minor_per_usd:'2500000000000000000',usdt_per_usd:'1.25'};
  const range={min_units:'1',max_units:'1'};
  assert.doesNotThrow(()=>checkLimits(range,usdtValue(2n,q)));
  assert.throws(()=>checkLimits(range,usdtValue(1n,q)),/Minimum/);
  assert.throws(()=>checkLimits(range,usdtValue(3n,q)),/Maximum/);
  assert.throws(()=>checkLimits({min_units:'0',max_units:'2'},usdtValue(2n,q),[usdtValue(3n,q)]),/Maximum/);
  assert.doesNotThrow(()=>checkLimits({min_units:'0',max_units:'2'},usdtValue(1n,q),[usdtValue(3n,q)]));
  // Even above the safe JS integer range, adjacent asset units differ.
  const n=BigInt('9'.repeat(54));
  assert.doesNotThrow(()=>checkLimits({min_units:String(n),max_units:String(n)},usdtValue(n*2n,q)));
  assert.throws(()=>checkLimits({min_units:'0',max_units:String(n)},usdtValue(n*2n+1n,q)),/Maximum/);
  assert.equal(quoteUnit('0.000600000000000000000001',18),1000000000000n);
  for(const invalid of ['0','1e-6','-2','NaN','Infinity','1'.repeat(17),'0.'+'1'.repeat(25)])assert.throws(()=>quoteUnit(invalid,18));
});
