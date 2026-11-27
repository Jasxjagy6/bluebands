import { SolRpcUnavailable } from './sol-rpc.js';

// Provider error messages can contain authenticated URLs. Log only our own
// fixed validation messages or known client/database error codes.
const reasons=new Set([
  'RPC endpoint is not configured','RPC network mismatch','Missing scan anchor',
  'Existing EVM deposit addresses require history reconciliation',
  'Reorganization exceeds retained block history','Reorganization affected credited funds; reconciliation required',
  'Incomplete or changing block history','Missing canonical receipt','Inconsistent transfer log',
  'Invalid ERC-20 transfer log','Confirmation block unavailable','Missing endpoint',
  'Invalid chain head','Historical reconciliation required','Credited reorganization requires reconciliation',
  'Existing deposit addresses require history reconciliation','Inconsistent block history','Noncanonical deposit',
  'Solana RPC unavailable','Invalid Solana evidence','Solana network mismatch','Solana history unavailable',
  'Solana block unavailable','Solana head is stale','Solana head regressed','Solana retained history unavailable',
  'Solana historical reconciliation required','Credited Solana reorganization requires reconciliation',
  'Solana receive history requires reconciliation','Solana transaction unavailable','Unrelated Solana history entry',
  'Noncanonical Solana transaction','Solana indexed history unavailable','Invalid Solana history probe',
  'Solana history capability unavailable','Solana status history unavailable','Solana scan history unavailable',
  'Incomplete Solana signature page','Discontinuous Solana signature page','Invalid Solana signature page',
  'Inconsistent Solana transaction status','Solana signature anchor missing','Noncanonical Solana deposit',
  'Missing transaction metadata','Missing token metadata','Invalid inner instructions',
  'Incomplete parsed instruction','Incomplete native transfer','Invalid amount','Inexact amount',
]);
const clientCodes=new Set(['NETWORK_ERROR','SERVER_ERROR','TIMEOUT','BAD_DATA','UNKNOWN_ERROR','CANCELLED']);

export function scanFailureReason(error:unknown):string{
  if(error instanceof SolRpcUnavailable)return 'Solana RPC unavailable';
  if(error instanceof Error&&reasons.has(error.message))return error.message;
  const code=(error as {code?:unknown}|null)?.code;
  if(typeof code==='string'&&(clientCodes.has(code)||/^[0-9A-Z]{5}$/.test(code)))return code;
  return 'Unexpected scan failure';
}
