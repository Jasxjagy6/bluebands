alter table alchemy_rpc_budget alter column tokens set default 60;
update alchemy_rpc_budget set tokens=least(tokens,60) where singleton;
alter table alchemy_rpc_budget drop constraint if exists alchemy_rpc_budget_tokens_check;
alter table alchemy_rpc_budget add constraint alchemy_rpc_budget_tokens_check check (tokens>=0 and tokens<=60);
