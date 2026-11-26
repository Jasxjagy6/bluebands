import { HDKey } from '@scure/bip32';
import { base58, base58check, bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { ed25519 } from '@noble/curves/ed25519';
import { computeAddress } from 'ethers';

const tronCheck=base58check(sha256);
export function tronAddress(hex:string) {
  if(!/^(41)?[a-f\d]{40}$/i.test(hex)) throw new Error('Malformed TRON address');
  return tronCheck.encode(Buffer.from('41'+hex.slice(-40),'hex'));
}
export function validSolOwner(address:string){
  try{const bytes=base58.decode(address);return bytes.length===32 && !ed25519.ExtendedPoint.fromHex(bytes).isSmallOrder();}
  catch{return false;}
}
export function receiveAddress(kind:string,xpub:string,index:number){
  const key=HDKey.fromExtendedKey(xpub);
  if(key.privateKey || !key.publicKey)throw new Error('Use a watch-only extended public key');
  const child=key.deriveChild(0).deriveChild(index).publicKey!;
  if(kind==='btc')return bech32.encode('bc',[0,...bech32.toWords(ripemd160(sha256(child)))]);
  const evm=computeAddress('0x'+Buffer.from(child).toString('hex')).toLowerCase();
  return kind==='tron'?tronAddress(evm.slice(2)):evm;
}

export const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM=base58.decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export function associatedTokenAccount(owner:string,mint:string){
  const seeds=[base58.decode(owner),base58.decode(TOKEN_PROGRAM),base58.decode(mint)];
  for(let bump=255;bump>=0;bump--){
    const addr=sha256(Buffer.concat([...seeds,Buffer.from([bump]),ATA_PROGRAM,Buffer.from('ProgramDerivedAddress')]));
    try{ed25519.ExtendedPoint.fromHex(addr);}catch{return base58.encode(addr);}
  }
  throw new Error('Cannot derive associated token account');
}

export const supportedAssets=`(a.symbol<>'USDT' or n.id in ('ETH','BSC','SOL','POL')) and (a.kind='native' or (a.kind='token' and case n.kind
  when 'evm' then a.token_address ~ '^0x[0-9a-fA-F]{40}$'
  when 'sol' then a.token_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  when 'tron' then a.token_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$' else false end))`;
