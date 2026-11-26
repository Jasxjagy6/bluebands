insert into assets(id,chain_id,symbol,kind,decimals,min_deposit,enabled,token_address) values
 ('BTC','BTC','BTC','native',8,10000,true,null),
 ('SOL','SOL','SOL','native',9,1000000,true,null),
 ('USDT.SPL','SOL','USDT','token',6,1000000,true,'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
 ('TRX','TRON','TRX','native',6,1000000,true,null),
 ('USDT.TRC20','TRON','USDT','token',6,1000000,true,'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
on conflict(id) do nothing;
create table if not exists sol_receive_pool(
 address text primary key, user_id uuid unique references users(id), imported_at timestamptz not null default now()
);
