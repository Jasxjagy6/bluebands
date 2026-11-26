import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const allowOrigins=(process.env.ALLOW_ORIGIN ?? '').split(',').map(s=>s.trim()).filter(Boolean);
function publicSiteOrigin():string {
  const trusted=allowOrigins.filter(s=>s.startsWith('https://'));
  const value=process.env.PUBLIC_SITE_ORIGIN?.trim() || (trusted.length===1?trusted[0]:'');
  if(!value)return '';
  let u:URL;
  try{u=new URL(value);}catch{throw new Error('PUBLIC_SITE_ORIGIN must be a canonical public HTTPS origin');}
  if(u.protocol!=='https:' || !u.hostname || u.username || u.password || u.pathname!=='/' || u.search || u.hash)
    throw new Error('PUBLIC_SITE_ORIGIN must be a canonical public HTTPS origin');
  return u.origin;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  env: process.env.NODE_ENV ?? 'development',
  databaseUrl: req('DATABASE_URL'),
  masterKeyB64: req('TREASURY_MASTER_KEY'),
  allowOrigins,
  publicOrigin:publicSiteOrigin(),
  reorgSafety: Number(process.env.REORG_SAFETY_BLOCKS ?? 3),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
};

if (config.masterKeyB64 && Buffer.from(config.masterKeyB64, 'base64').length !== 32) {
  throw new Error('TREASURY_MASTER_KEY must be exactly 32 bytes, base64-encoded (run: npm run keygen)');
}
