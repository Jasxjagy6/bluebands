import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HDNodeWallet } from 'ethers';
import { restoreCustodyPublic } from '../custody/keys.js';
import { receiveAddress } from '../chains/receive.js';

// PUBLIC test vector, raw bytes 00..1f (not a mnemonic, hex text, or a usable wallet).
// EVM independently checked with ethers; SOL with SLIP-0010 HMAC + OpenSSL Ed25519.
const fixture=Buffer.from(Array.from({length:32},(_,i)=>i));
const xpub='xpub6DMFE9j2ncmpqUwtaiyPPdiYWRud5iDLhE1ka9gFJKockpH9xeXNKrXRM1XrPsh9NonaRW6hbZ83sukTc2544gvTTTRbp1ak823LG5gBYV5';
const fee='0x020302db40449eaa4e6fbcd87cd585ce89b122ce';
test('offline restoration matches the account xpub, receive/fee branches and hardened Solana vectors',()=>{
  const account=HDNodeWallet.fromSeed(fixture).derivePath("m/44'/60'/0'");
  assert.equal(account.neuter().extendedKey,xpub);
  assert.equal(account.derivePath('1/0').address.toLowerCase(),fee);
  const vectors=[
    [0,'0x919538116b4f25f1ce01429fd9ed7964556bf565','CuzTwnSW4kZrTz6hGmLgfdmNDwq18nJpmJvAgDizacU1'],
    [1,'0xf23692a9de556ee1711b172bf744c5f33b13dc89','EkvUfeJR1zi5ADgCsWA12gi2cg6Gx7GahLbhYDENmeWH'],
    [37,'0x9c12cda0925821cc17bf5ac8554d7e4a21340252','4KAsauQ6mMCA3wG9f3dE8wMkcYLS9wC9stiUdFPVTY8X'],
    [2147483647,'0x98a596dec77c60779617fc1951a39d820ca14ee6','45tKNDmFTht5w8CzknNwPL5uKMfxXpSwqaXer8JaKxV8'],
  ] as const;
  for(const [index,evmAddress,solAddress] of vectors){
    assert.deepEqual(restoreCustodyPublic(fixture,index),{evmXpub:xpub,feeAddress:fee,evmAddress,solAddress});
    assert.equal(receiveAddress('evm',xpub,index),evmAddress);
    assert.equal(account.derivePath(`0/${index}`).address.toLowerCase(),evmAddress);
    assert.notEqual(evmAddress,fee);
  }
});
test('restoration rejects non-32-byte seeds and out-of-range path components',()=>{
  for (const bytes of [16,31,33,64]) assert.throws(()=>restoreCustodyPublic(Buffer.alloc(bytes),0));
  for (const index of [-1,0.2,NaN,2**31,2**32]) assert.throws(()=>restoreCustodyPublic(fixture,index));
});
