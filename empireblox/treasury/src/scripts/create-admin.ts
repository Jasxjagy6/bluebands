import { pool, tx } from '../db.js';
import { hashPassword } from '../authutil.js';

// Usage: npm run admin:create -- <username> <password>
// Creates (or resets the password of) an admin. Enable 2FA afterwards
// from inside the panel — strongly recommended before going live.
async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: npm run admin:create -- <username> <password>');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Choose a password of at least 10 characters.');
    process.exit(1);
  }
  const hash = hashPassword(password);
  await tx(async c=>{
    const account=await c.query(
    `insert into admin_users(username, pass_hash) values ($1,$2)
     on conflict (username) do update set pass_hash=$2, disabled=false returning id`,
    [username, hash],
  );
    await c.query('delete from admin_sessions where admin_id=$1',[account.rows[0].id]);
  });
  console.log(`Admin "${username}" is ready. Log in at /admin and enable 2FA.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
