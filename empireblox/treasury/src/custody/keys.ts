// Worker/offline only. The player and admin routes import derive.ts, never this module.
import { constants, createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPair, privateDecrypt, timingSafeEqual, type KeyObject } from 'node:crypto';
import { constants as fs } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base58 } from '@scure/base';
import { HDKey, HARDENED_OFFSET } from '@scure/bip32';
import { computeAddress, getAddress, getBytes, hexlify, Interface, toBeHex, Transaction, ZeroAddress } from 'ethers';
import { buildSolSweepMessage, type SolSweepSigner } from './sol-sweep.js';
import type { EvmSweepSigner } from './evm-sweep.js';
import { SweepStop } from './types.js';

export type { EvmSweepSigner, SolSweepSigner };
export interface CustodySigner extends EvmSweepSigner, SolSweepSigner {
  readonly keyId: string;
  readonly evmXpub: string;
  destroy(): void;
}

const evm = {
  ETH: { id:1, native:'ETH', asset:'USDT.ERC20', token:'0xdac17f958d2ee523a2206206994597c13d831ec7', min:10n**6n, price:100n*10n**9n, cap:10n**16n },
  BSC: { id:56, native:'BNB', asset:'USDT.BEP20', token:'0x55d398326f99059ff775485246999027b3197955', min:10n**18n, price:5n*10n**9n, cap:6n*10n**14n },
  POL: { id:137, native:'POL', asset:'USDT.POL', token:'0xc2132d05d31c914a87c6611c10748aeb04b58e8f', min:10n**6n, price:500n*10n**9n, cap:6n*10n**16n },
} as const;
const transfer = new Interface(['function transfer(address,uint256)']);
const solPoolTarget = 32;

function checkedIndex(i: number): number {
  if (!Number.isSafeInteger(i) || i<0 || i>=HARDENED_OFFSET) throw new SweepStop('invalid_intent');
  return i;
}

/** SLIP-0010 ed25519 uses a different master string from secp256k1 and only hardened children. */
function solKey(seed: Buffer, index: number): Buffer {
  let state=createHmac('sha512','ed25519 seed').update(seed).digest();
  const child=Buffer.alloc(37);
  try {
    for (const component of [44,501,checkedIndex(index),0]) {
      state.copy(child,1,0,32); child.writeUInt32BE(HARDENED_OFFSET+component,33);
      const next=createHmac('sha512',state.subarray(32)).update(child).digest();
      state.fill(0); state=next;
    }
    return Buffer.from(state.subarray(0,32));
  } finally { state.fill(0); child.fill(0); }
}

/** Takes ownership of seed, exposes no general sign(bytes) or private-key export. */
function makeSigner(seed: Buffer, keyId: string): CustodySigner {
  if (seed.length!==32) throw new Error('Invalid custody seed');
  let account=HDKey.fromMasterSeed(seed), live=true;
  for (const component of [44,60,0]) {
    const next=account.deriveChild(HARDENED_OFFSET+component);
    account.wipePrivateData(); account=next;
  }
  const checkLive=()=>{if (!live) throw new SweepStop('unavailable');};
  const child=(branch:number,index:number)=>{
    checkLive(); checkedIndex(index);
    const parent=account.deriveChild(branch);
    try { return parent.deriveChild(index); } finally { parent.wipePrivateData(); }
  };
  const publicAddress=(branch:number,index:number)=>{
    const key=child(branch,index);
    try { return computeAddress(hexlify(key.publicKey!)).toLowerCase(); } finally { key.wipePrivateData(); }
  };
  const feeAddress=publicAddress(1,0);
  return Object.freeze<CustodySigner>({keyId,feeAddress,evmXpub:account.publicExtendedKey,
    evmAddress: (index)=>publicAddress(0,index),
    solAddress(index) {
      checkLive(); const key=solKey(seed,index);
      try { return base58.encode(ed25519.getPublicKey(key)); } finally { key.fill(0); }
    },
    async signSolSweep(intent,fields) {
      checkLive();
      if (keyId!==intent.keyId || intent.chainId!=='SOL' || intent.assetId!=='SOL') throw new SweepStop('unowned');
      const message=buildSolSweepMessage(intent,fields), key=solKey(seed,intent.derivIndex);
      try {
        if (base58.encode(ed25519.getPublicKey(key))!==intent.source) throw new SweepStop('unowned');
        return ed25519.sign(message,key);
      } finally { key.fill(0); }
    },
    async signEvmSweep(i,f) {
      checkLive();
      if (keyId!==i.keyId || i.chainId==='SOL' || !Object.hasOwn(evm,i.chainId)) throw new SweepStop('unowned');
      const n=evm[i.chainId], token=i.assetId===n.asset, sponsor=f.phase==='sponsor';
      const source=publicAddress(0,i.derivIndex), destination=getAddress(i.destination).toLowerCase();
      if (source!==getAddress(i.source).toLowerCase() || ((token || i.sponsor!==null) && i.sponsor?.toLowerCase()!==feeAddress))
        throw new SweepStop('unowned');
      if (new Set([source,destination,feeAddress,ZeroAddress,n.token]).size!==5 ||
          (!token && i.assetId!==n.native) || (sponsor && !token) || (!sponsor && f.phase!=='sweep') ||
          !Number.isSafeInteger(f.nonce) || f.nonce<0 || i.amount<=0n || f.amount<=0n || (token && i.amount<n.min))
        throw new SweepStop('invalid_intent');
      const fee=f.gasLimit*f.gasPrice;
      if (f.gasPrice<=0n || f.gasPrice>n.price || fee>n.cap || f.gasLimit<21000n ||
          f.gasLimit>(sponsor?21000n:token?120000n:100000n) || (sponsor && f.amount+fee>n.cap)) throw new SweepStop('fee_limit');
      if (!sponsor && (token ? f.amount!==i.amount : f.amount+fee!==i.amount)) throw new SweepStop('invalid_intent');
      const tx=Transaction.from({type:0,chainId:n.id,nonce:f.nonce,gasPrice:f.gasPrice,gasLimit:f.gasLimit,
        to:sponsor?source:token?n.token:destination,value:token && !sponsor?0n:f.amount,
        data:token && !sponsor?transfer.encodeFunctionData('transfer',[destination,f.amount]):'0x'});
      const key=child(sponsor?1:0,sponsor?0:i.derivIndex);
      try {
        const sig=secp256k1.sign(getBytes(tx.unsignedHash),key.privateKey!);
        if (sig.recovery!==0 && sig.recovery!==1) throw new SweepStop('invalid_intent');
        tx.signature={r:toBeHex(sig.r,32),s:toBeHex(sig.s,32),v:27+sig.recovery};
        return tx.serialized;
      } finally { key.wipePrivateData(); }
    },
    destroy() { live=false; seed.fill(0); account.wipePrivateData(); },
  });
}

/** Offline backup verification. No database, vault KEK, RPC or wrapping file is required. */
export function restoreCustodyPublic(seed: Uint8Array, index: number) {
  const signer=makeSigner(Buffer.from(seed),'offline');
  try { return {evmXpub:signer.evmXpub,feeAddress:signer.feeAddress,evmAddress:signer.evmAddress(index),solAddress:signer.solAddress(index)}; }
  finally { signer.destroy(); }
}

const makeRsa=promisify(generateKeyPair);
const keyFile='worker-rsa.pk8';
async function wrappingKey(registered: boolean): Promise<KeyObject> {
  const dir=process.env.CUSTODY_KEY_DIR;
  if (!dir || !isAbsolute(dir) || resolve(dir)==='/') throw new Error('Private custody directory required');
  if (!registered) await mkdir(dir,{mode:0o700}).catch(e=>{if (e.code!=='EEXIST') throw e;});
  const d=await lstat(dir), uid=process.getuid!();
  if (!d.isDirectory() || d.uid!==uid || (d.mode & 0o777)!==0o700 || await realpath(dir)!==resolve(dir))
    throw new Error('Unsafe custody directory');
  const path=join(dir,keyFile);
  let file;
  try { file=await open(path,fs.O_RDONLY|fs.O_NOFOLLOW|fs.O_NONBLOCK); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code!=='ENOENT' || registered) throw new Error('Custody identity unavailable');
    const {privateKey}=await makeRsa('rsa',{modulusLength:3072,publicExponent:65537});
    const bytes=privateKey.export({type:'pkcs8',format:'der'});
    try {
      // Exclusive create, never rename over or replace even a damaged file. A
      // partial first write requires manual inspection; nothing has been published.
      const out=await open(path,fs.O_WRONLY|fs.O_CREAT|fs.O_EXCL|fs.O_NOFOLLOW,0o400);
      try { await out.writeFile(bytes); await out.sync(); } finally { await out.close(); }
      const folder=await open(dir,fs.O_DIRECTORY|fs.O_RDONLY);
      try { await folder.sync(); } finally { await folder.close(); }
    } finally { bytes.fill(0); }
    file=await open(path,fs.O_RDONLY|fs.O_NOFOLLOW|fs.O_NONBLOCK);
  }
  try {
    const s=await file.stat();
    if (!s.isFile() || s.uid!==uid || s.nlink!==1 || ![0o400,0o600].includes(s.mode & 0o777) || s.size<1 || s.size>4096)
      throw new Error('Unsafe custody file');
    const bytes=await file.readFile();
    try {
      const key=createPrivateKey({key:bytes,format:'der',type:'pkcs8'});
      if (key.asymmetricKeyType!=='rsa' || key.asymmetricKeyDetails?.modulusLength!==3072 || key.asymmetricKeyDetails.publicExponent!==65537n)
        throw new Error('Invalid custody identity');
      return key;
    } finally { bytes.fill(0); }
  } finally { await file.close(); }
}

/** Call on startup and every worker cycle (even when sweeps are paused). */
export async function provisionCustodyKeys(): Promise<CustodySigner|null> {
  const {tx}=await import('../db.js');
  let signer:CustodySigner|null=null;
  try {
    const ok=await tx(async c=>{
      await c.query("select pg_advisory_xact_lock(hashtext('custody:provision'))");
      const root=(await c.query(`select key_id,wrap_spki,sealed_seed,evm_xpub,fee_address from custody_root where singleton for update`)).rows[0];
      await c.query('savepoint provision');
      try {
        const privateKey=await wrappingKey(!!root), spki=createPublicKey(privateKey).export({type:'spki',format:'der'});
        const keyId=createHash('sha256').update(spki).digest('hex');
        if (!root) {
          await c.query('insert into custody_root(key_id,wrap_spki,wrap_seen_at) values($1,$2,clock_timestamp())',[keyId,spki]);
          return true;
        }
        if (root.key_id!==keyId || !spki.equals(root.wrap_spki)) throw new Error('Custody identity mismatch');
        if (!root.sealed_seed) {
          await c.query('update custody_root set wrap_seen_at=clock_timestamp() where singleton');
          return true;
        }
        const seed=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256',oaepLabel:Buffer.from(keyId)},root.sealed_seed);
        try {
          const kek=Buffer.from(process.env.TREASURY_MASTER_KEY??'','base64');
          try { if (seed.length!==32 || (kek.length===32 && timingSafeEqual(seed,kek))) throw new Error('Invalid custody seed'); }
          finally { kek.fill(0); }
          signer=makeSigner(seed,keyId);
        } catch (e) { seed.fill(0); throw e; }
        if (root.evm_xpub && (root.evm_xpub!==signer.evmXpub || root.fee_address!==signer.feeAddress)) throw new Error('Custody seed mismatch');
        if (!root.evm_xpub) await c.query('update custody_root set evm_xpub=$1,fee_address=$2 where singleton',[signer.evmXpub,signer.feeAddress]);
        const {available,highest}=(await c.query(`select count(*) filter(where user_id is null)::int as available,
          coalesce(max(deriv_index),-1) as highest from custody_sol_pool where key_id=$1`,[keyId])).rows[0];
        const indexes:number[]=[],addresses:string[]=[];
        for (let i=0;i<solPoolTarget-available;i++) {
          const index=highest+i+1;
          addresses.push(signer.solAddress(index)); indexes.push(index);
        }
        if (indexes.length) await c.query(`insert into custody_sol_pool(key_id,deriv_index,address)
          select $1,* from unnest($2::integer[],$3::text[])`,[keyId,indexes,addresses]);
        await c.query('update custody_root set wrap_seen_at=clock_timestamp(),verified_at=clock_timestamp() where singleton');
        return true;
      } catch {
        // Commit revocation of the readiness lease, never another public identity.
        await c.query('rollback to savepoint provision');
        await c.query('update custody_root set wrap_seen_at=null,verified_at=null where wrap_seen_at is not null or verified_at is not null');
        return false;
      }
    });
    if (!ok) throw new Error('Unavailable');
    return signer;
  } catch {
    (signer as CustodySigner|null)?.destroy();
    throw new Error('Custody provisioning unavailable');
  }
}
