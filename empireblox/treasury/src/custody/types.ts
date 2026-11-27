export const sweepChains = ['ETH', 'BSC', 'POL', 'SOL'] as const;
export type SweepChain = typeof sweepChains[number];

/** Worker-only intent. All values come from one immutable, credited deposit and its pinned route. */
export interface SweepIntent {
  jobId: string;
  depositId: string;
  chainId: SweepChain;
  assetId: string;
  source: string;
  destination: string;
  sponsor: string | null;
  keyId: string;
  derivIndex: number;
  amount: bigint;
  depositTxid: string;
  depositIndex: number;
  depositBlock: number;
  depositBlockHash: string;
  requiredConf: number;
}

export interface SignedSweep {
  phase: 'sponsor' | 'sweep';
  /** Complete signed wire transaction: EVM hex with 0x prefix, Solana base64. */
  raw: string;
  txid: string;
  from: string;
  amount: bigint;
  fee: bigint;
  nonce: string | null;
  lastValidBlockHeight: number | null;
}

export const sweepReasons = ['wrong_chain', 'orphaned', 'unowned', 'dust', 'fee_limit',
  'insufficient_funds', 'expired', 'nonce_conflict', 'invalid_receipt', 'ambiguous',
  'not_final', 'unavailable', 'invalid_intent'] as const;
export type SweepReason = typeof sweepReasons[number];
export class SweepStop extends Error {
  constructor(readonly code: SweepReason) { super(code); }
}

export type SweepObservation = { state: 'unseen' | 'pending' } |
  { state: 'included' | 'final'; blockHash: string; blockNumber: number; networkFee?: bigint } |
  { state: 'review'; reason: SweepReason };

/** Never register these capabilities on the HTTP server. No method accepts an arbitrary recipient or unsigned transaction. */
export interface SweepAdapter {
  verifyDeposit(intent: SweepIntent): Promise<void>;
  prepare(intent: SweepIntent, confirmedSponsor: SignedSweep | null): Promise<SignedSweep>;
  inspect(intent: SweepIntent, signed: SignedSweep): Promise<SweepObservation>;
  broadcast(intent: SweepIntent, signed: SignedSweep): Promise<void>;
}
