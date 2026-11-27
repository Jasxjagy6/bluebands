import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanFailureReason } from '../chains/scan-error.js';
import { SolRpcUnavailable } from '../chains/sol-rpc.js';

test('scanner diagnostics describe known failures without exposing arbitrary provider text or secrets',()=>{
  assert.equal(scanFailureReason(new Error('Solana indexed history unavailable')),'Solana indexed history unavailable');
  assert.equal(scanFailureReason(new SolRpcUnavailable()),'Solana RPC unavailable');
  assert.equal(scanFailureReason(Object.assign(new Error('https://provider.invalid/private-key'),{code:'TIMEOUT'})),'TIMEOUT');
  for(const error of [new Error('private-key'),new Error('RPC endpoint https://provider.invalid/private-key'),
    {code:'secret-provider-key',message:'private-key'},null])assert.equal(scanFailureReason(error),'Unexpected scan failure');
});
