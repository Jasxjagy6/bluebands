import { createHash, randomBytes } from 'node:crypto';
import { base58 } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519';
import { query } from '../db.js';

// Watcher/browser suites only need public material. Real enrollment and offline restoration are tested separately.
export async function publicCustodyFixture(xpub:string){
  if(process.env.NODE_ENV!=='test'||!['127.0.0.1','localhost'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Disposable local database required');
  const spki=Buffer.from('fixture-public-data'),key=createHash('sha256').update(spki).digest('hex');
  await query(`insert into custody_root(singleton,key_id,wrap_spki,sealed_seed,evm_xpub,fee_address,verified_at)
    values(true,$1,$2,$3,$4,$5,now()) on conflict(singleton) do update set verified_at=now()`,[key,spki,Buffer.alloc(384),xpub,'0x'+randomBytes(20).toString('hex')]);
  const root=(await query('select key_id,evm_xpub from custody_root')).rows[0];
  for(let i=0;i<8;i++)await query('insert into custody_sol_pool(key_id,deriv_index,address) values($1,$2,$3) on conflict do nothing',[root.key_id,i,base58.encode(ed25519.getPublicKey(randomBytes(32)))]);
  return root.evm_xpub as string;
}
