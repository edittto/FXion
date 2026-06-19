-- =====================================================================
--  MIRAGE / 蜃気楼 - Phase 1 backend (Supabase)
--  これを丸ごとコピーして Supabase の SQL Editor に貼り付け→ Run
--  ・通貨は架空、価格は本物の市場データ(裏はCoinGecko/暗号資産=24時間動く)
--  ・売買と残高はサーバー側関数だけが書き込み可能(ブラウザから改ざん不可)
--  ・価格更新と日次スナップショットは Postgres 内の cron で自動実行
--  何度貼っても壊れないよう、作り直し可能な書き方にしています。
-- =====================================================================

-- 1) 拡張機能 ----------------------------------------------------------
create extension if not exists http        with schema extensions; -- 同期HTTP(価格取得)
create extension if not exists pg_cron;                            -- 定期実行
-- pg_cron は postgres データベース上に cron スキーマを作ります

-- 2) テーブル ----------------------------------------------------------

-- プロフィール (auth.users と 1:1)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique not null,
  country     text not null,           -- 例 'JP' (将来の国別ランキング用に必ず保持)
  prefecture  text,                     -- 例 '東京都' (日本のときだけ。表に出すのはこちら)
  created_at  timestamptz not null default now()
);

-- 取引対象(架空通貨)の定義。symbol=ゲーム内コード、coingecko_id=裏の本物銘柄
create table if not exists public.assets (
  symbol        text primary key,
  name          text not null,
  coingecko_id  text not null,
  sort_order    int  not null default 0
);

-- 最新価格(全員が同じ数字を見る = 公平なランキングの土台)
create table if not exists public.prices (
  symbol      text primary key references public.assets(symbol) on delete cascade,
  price       numeric not null,
  updated_at  timestamptz not null default now()
);

-- アカウント(=モードごとの財布)。unranked は無限/ranked は月シーズン
create table if not exists public.accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  mode          text not null check (mode in ('unranked','ranked')),
  season        text not null,                 -- ranked:'YYYY-MM' / unranked:'sandbox'
  cash          numeric not null,
  starting_cash numeric not null,
  status        text not null default 'active' check (status in ('active','bankrupt')),
  created_at    timestamptz not null default now(),
  unique (user_id, mode, season)
);

-- 保有ポジション
create table if not exists public.holdings (
  account_id  uuid not null references public.accounts(id) on delete cascade,
  symbol      text not null references public.assets(symbol),
  qty         numeric not null,
  avg_cost    numeric not null,
  primary key (account_id, symbol)
);

-- 取引履歴
create table if not exists public.trades (
  id          bigint generated always as identity primary key,
  account_id  uuid not null references public.accounts(id) on delete cascade,
  symbol      text not null,
  side        text not null check (side in ('buy','sell')),
  qty         numeric not null,
  price       numeric not null,
  ts          timestamptz not null default now()
);

-- 日次スナップショット(週/月/累計ランキングの計算元。Phase2で集計)
create table if not exists public.snapshots (
  account_id    uuid not null references public.accounts(id) on delete cascade,
  snapshot_date date not null,
  net_worth     numeric not null,
  primary key (account_id, snapshot_date)
);

-- 3) 行レベルセキュリティ(RLS) ---------------------------------------
alter table public.profiles  enable row level security;
alter table public.assets    enable row level security;
alter table public.prices    enable row level security;
alter table public.accounts  enable row level security;
alter table public.holdings  enable row level security;
alter table public.trades    enable row level security;
alter table public.snapshots enable row level security;

-- 参照系(誰でも読める):価格と銘柄定義
drop policy if exists assets_read on public.assets;
create policy assets_read on public.assets for select using (true);
drop policy if exists prices_read on public.prices;
create policy prices_read on public.prices for select using (true);

-- プロフィール:ログイン済みは全員分を読める(ランキングで名前表示するため)
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);
-- ※ 書き込みは ensure_profile 関数経由のみ(直接 insert/update のポリシーは作らない)

-- 自分のアカウント/保有/取引/スナップショットだけ「読める」
drop policy if exists accounts_read on public.accounts;
create policy accounts_read on public.accounts
  for select to authenticated using (user_id = auth.uid());

drop policy if exists holdings_read on public.holdings;
create policy holdings_read on public.holdings
  for select to authenticated using (
    account_id in (select id from public.accounts where user_id = auth.uid())
  );

drop policy if exists trades_read on public.trades;
create policy trades_read on public.trades
  for select to authenticated using (
    account_id in (select id from public.accounts where user_id = auth.uid())
  );

drop policy if exists snapshots_read on public.snapshots;
create policy snapshots_read on public.snapshots
  for select to authenticated using (
    account_id in (select id from public.accounts where user_id = auth.uid())
  );
-- ※ accounts/holdings/trades への書き込みポリシーは「あえて作らない」。
--    残高や保有を変えられるのは下のサーバー関数(security definer)だけ。

-- 4) サーバー関数(ここだけが残高を動かせる) -------------------------

-- 4-1) 価格取得:CoinGecko を叩いて prices を更新(cron が毎分実行)
create or replace function public.fetch_prices()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ids  text;
  v_url  text;
  v_body jsonb;
begin
  select string_agg(coingecko_id, ',') into v_ids from public.assets;
  if v_ids is null then return; end if;

  v_url := 'https://api.coingecko.com/api/v3/simple/price?ids='
           || v_ids || '&vs_currencies=usd';

  select (extensions.http_get(v_url)).content::jsonb into v_body;

  insert into public.prices (symbol, price, updated_at)
  select a.symbol, (v_body -> a.coingecko_id ->> 'usd')::numeric, now()
  from public.assets a
  where v_body ? a.coingecko_id
    and (v_body -> a.coingecko_id ->> 'usd') is not null
  on conflict (symbol)
  do update set price = excluded.price, updated_at = excluded.updated_at;
exception when others then
  -- 失敗しても落とさない(次の分にまた取りに行く)
  return;
end $$;

-- 4-2) 日次スナップショット(純資産を記録)
create or replace function public.take_snapshot()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.snapshots (account_id, snapshot_date, net_worth)
  select a.id, current_date,
         a.cash + coalesce(sum(h.qty * p.price), 0)
  from public.accounts a
  left join public.holdings h on h.account_id = a.id
  left join public.prices   p on p.symbol = h.symbol
  group by a.id, a.cash
  on conflict (account_id, snapshot_date)
  do update set net_worth = excluded.net_worth;
end $$;

-- 4-3) プロフィール作成/更新
create or replace function public.ensure_profile(
  p_username text, p_country text, p_prefecture text
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_row public.profiles;
begin
  if v_uid is null then raise exception 'ログインが必要です'; end if;
  if length(trim(p_username)) < 2 then raise exception 'ユーザー名が短すぎます'; end if;

  insert into public.profiles (id, username, country, prefecture)
  values (v_uid, trim(p_username), p_country, p_prefecture)
  on conflict (id) do update
    set username = excluded.username,
        country = excluded.country,
        prefecture = excluded.prefecture
  returning * into v_row;
  return v_row;
exception when unique_violation then
  raise exception 'そのユーザー名は使われています';
end $$;

-- 4-4) アカウント取得(無ければ初期資金100万で作成)
create or replace function public.get_or_create_account(p_mode text)
returns public.accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_season text;
  v_row    public.accounts;
begin
  if v_uid is null then raise exception 'ログインが必要です'; end if;
  if p_mode not in ('unranked','ranked') then raise exception 'モード不正'; end if;

  if p_mode = 'ranked'
  then v_season := to_char(now() at time zone 'utc', 'YYYY-MM');  -- 月替わりで自動更新
  else v_season := 'sandbox';
  end if;

  select * into v_row from public.accounts
   where user_id = v_uid and mode = p_mode and season = v_season;
  if found then return v_row; end if;

  insert into public.accounts (user_id, mode, season, cash, starting_cash)
  values (v_uid, p_mode, v_season, 1000000, 1000000)
  returning * into v_row;
  return v_row;
end $$;

-- 4-5) 売買の実行(残高チェック→更新→履歴。全部サーバー側で原子的に)
create or replace function public.execute_trade(
  p_account_id uuid, p_symbol text, p_side text, p_qty numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_acc     public.accounts;
  v_price   numeric;
  v_updated timestamptz;
  v_cost    numeric;
  v_hold    public.holdings;
  v_new_qty numeric;
begin
  if v_uid is null then raise exception 'ログインが必要です'; end if;
  if p_qty is null or p_qty <= 0 then raise exception '数量は0より大きく'; end if;

  select * into v_acc from public.accounts
   where id = p_account_id and user_id = v_uid;
  if not found then raise exception 'アカウントが見つかりません'; end if;
  if v_acc.status <> 'active' then raise exception '破産中です。リセットしてください'; end if;

  select price, updated_at into v_price, v_updated
    from public.prices where symbol = p_symbol;
  if v_price is null then raise exception '不明な銘柄です'; end if;
  if v_updated < now() - interval '15 minutes' then
    raise exception '価格が古いため取引できません(少し待って下さい)';
  end if;

  if p_side = 'buy' then
    v_cost := v_price * p_qty;
    if v_acc.cash < v_cost then raise exception '残高不足です'; end if;

    update public.accounts set cash = cash - v_cost where id = p_account_id;

    select * into v_hold from public.holdings
      where account_id = p_account_id and symbol = p_symbol;
    if found then
      v_new_qty := v_hold.qty + p_qty;
      update public.holdings
         set avg_cost = (v_hold.avg_cost * v_hold.qty + v_cost) / v_new_qty,
             qty = v_new_qty
       where account_id = p_account_id and symbol = p_symbol;
    else
      insert into public.holdings (account_id, symbol, qty, avg_cost)
      values (p_account_id, p_symbol, p_qty, v_price);
    end if;

  elsif p_side = 'sell' then
    select * into v_hold from public.holdings
      where account_id = p_account_id and symbol = p_symbol;
    if not found or v_hold.qty < p_qty then raise exception '保有数が足りません'; end if;

    update public.accounts set cash = cash + v_price * p_qty where id = p_account_id;
    v_new_qty := v_hold.qty - p_qty;
    if v_new_qty = 0 then
      delete from public.holdings where account_id = p_account_id and symbol = p_symbol;
    else
      update public.holdings set qty = v_new_qty
       where account_id = p_account_id and symbol = p_symbol;
    end if;
  else
    raise exception '売買種別が不正です';
  end if;

  insert into public.trades (account_id, symbol, side, qty, price)
  values (p_account_id, p_symbol, p_side, p_qty, v_price);

  -- 破産判定:現金<=0 かつ 保有なし
  select * into v_acc from public.accounts where id = p_account_id;
  if v_acc.cash <= 0
     and not exists (select 1 from public.holdings where account_id = p_account_id) then
    update public.accounts set status = 'bankrupt' where id = p_account_id;
  end if;

  return jsonb_build_object(
    'ok', true, 'price', v_price,
    'cash', (select cash from public.accounts where id = p_account_id)
  );
end $$;

-- 4-6) リセット(アンランクのみ。破産後/任意のやり直し)
create or replace function public.reset_account(p_account_id uuid)
returns public.accounts
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_row public.accounts;
begin
  if v_uid is null then raise exception 'ログインが必要です'; end if;
  select * into v_row from public.accounts
    where id = p_account_id and user_id = v_uid;
  if not found then raise exception 'アカウントが見つかりません'; end if;
  if v_row.mode <> 'unranked' then
    raise exception 'リセットできるのはアンランクだけです';
  end if;

  delete from public.holdings where account_id = p_account_id;
  update public.accounts
     set cash = starting_cash, status = 'active'
   where id = p_account_id
  returning * into v_row;
  return v_row;
end $$;

-- 5) 実行権限(ログイン済みユーザーが呼べる関数だけ許可) ----------------
revoke all on function public.fetch_prices()                         from public, anon, authenticated;
revoke all on function public.take_snapshot()                        from public, anon, authenticated;
grant execute on function public.ensure_profile(text,text,text)      to authenticated;
grant execute on function public.get_or_create_account(text)         to authenticated;
grant execute on function public.execute_trade(uuid,text,text,numeric) to authenticated;
grant execute on function public.reset_account(uuid)                 to authenticated;

-- 6) 銘柄シード(架空通貨名 ← 裏は本物の暗号資産。24時間動く) ----------
insert into public.assets (symbol, name, coingecko_id, sort_order) values
  ('ZNT','Zenith', 'bitcoin',  1),
  ('AUR','Aurora', 'ethereum', 2),
  ('HLX','Helix',  'solana',   3),
  ('NOVA','Nova',  'ripple',   4),
  ('VEGA','Vega',  'cardano',  5),
  ('ORB','Orbit',  'dogecoin', 6)
on conflict (symbol) do update
  set name = excluded.name,
      coingecko_id = excluded.coingecko_id,
      sort_order = excluded.sort_order;

-- 7) cron 登録(重複登録を避けてから貼り直しOK) ----------------------
select cron.unschedule('mirage_fetch_prices')  where exists
  (select 1 from cron.job where jobname = 'mirage_fetch_prices');
select cron.unschedule('mirage_daily_snapshot') where exists
  (select 1 from cron.job where jobname = 'mirage_daily_snapshot');

-- 毎分:価格を更新
select cron.schedule('mirage_fetch_prices', '* * * * *',
  $$ select public.fetch_prices(); $$);

-- 毎日 15:00 UTC (= 日本時間 0:00):純資産スナップショット
select cron.schedule('mirage_daily_snapshot', '0 15 * * *',
  $$ select public.take_snapshot(); $$);

-- 8) 価格を今すぐ1回取得(画面で即動くように) ----------------------
select public.fetch_prices();

-- 完了。Table Editor の prices に6銘柄の価格が入っていれば成功です。
