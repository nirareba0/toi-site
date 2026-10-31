-- スマホのホーム画面に置いた「なんでポスト」に、通知（Web Push）を届ける
-- （2026-10-31 本人「問いポストをスマホのホームに追加して通知が来るような機能を追加したい。ボイスログの方にその機能をつけたから、そのようなものにして」）
-- お手本は声のログ（C:\code\toi-voice の supabase/schema.sql「通知」の節と work/notify-setup.md）。同じ形をなんでポストに移した。
--
-- 流れ:
--   知らせること（返事が載った／新しい問いが載った）→ push_outbox に1行（宛先の端末と種類だけ。名前・問いや返事の本文は持たない）
--   → pg_net が Edge Function notify-push を呼ぶ（合言葉は Vault の push_hook_secret。関数の URL と公開の anon キーは push_settings）
--   → notify-push が鍵（VAPID）を Vault から読み（無ければ作って置く）、op_take_push で列を受け取り、web-push で各端末へ送る（中身は {kind} だけ）
--   → 端末の web/sw.js が文を出す。押すと画面が開く
--
-- 端末の見分け方: 投函のときと同じ client_hash（端末の localStorage の乱数の一方向ハッシュ。ブラウザからは読めない列・schema.sql）。
--   名前・メール・LINE の ID は使わない。iPhone はホーム画面のアプリと Safari で保存場所が分かれるので、
--   Safari で出した問いは「引き継ぎの番号」（8けた・15分だけ有効）でホーム画面のアプリに結ぶ（push_hash_links）。
--
-- 届く知らせ（kind）。どちらも LINE で届けているものと同じ時点:
--   reply     … 自分の問いに返事が載った（返事と問いの両方が承認されたとき。line-notify.sql と同じ）
--   question  … 新しい問いが載った（1日1回まで、19時ごろ。前の回から新しく載った問いがあるときだけ。line-sync.sql の毎日の問いと同じ時刻）
-- 夜（21時〜7時）に出た知らせは、朝7時に送る（中高生のスマホを夜中に鳴らさない）。
--
-- schema.sql のあとに流す（line-*.sql とは独立。どの順でもよい）。何度流しても同じ結果になる。秘密の値はこのファイルに書かない
-- （合言葉はここでデータベースの中に作り、通知の鍵は notify-push が最初に動いたときに作る。どちらも人は見ない・写さない）。

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------- 設定（秘密ではないもの）

create table if not exists push_settings (
  key   text primary key,
  value text not null
);
alter table push_settings enable row level security;
revoke all on push_settings from anon, authenticated;
insert into push_settings (key, value) values
  ('function_url', 'https://btbykfnlsxwmpfcfslxb.supabase.co/functions/v1/notify-push'),
  -- 公開の anon キー（web/js/config.js と同じ。ブラウザに配る前提の鍵で、秘密ではない）。
  -- 関数の JWT の確かめを切らずに pg_net から呼ぶために Authorization に付ける（Supabase の手引き「Scheduling Edge Functions」と同じ使い方）。
  -- config.js の鍵を替えたら、ここも update push_settings set value = '…' where key = 'anon_key'; で替える
  ('anon_key', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0YnlrZm5sc3h3bXBmY2ZzbHhiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MTQ0NDAsImV4cCI6MjEwNTI5MDQ0MH0.Fe85o6eT_h6-kq-DvNKe4lN3QJY9YbvMXZ9j9El9CMQ'),
  ('question_hour_jst', '19'),   -- 新しい問いの知らせを送る時刻（JST の時）
  ('quiet_from_jst', '21'),      -- この時から
  ('quiet_until_jst', '7')       -- この時までは送らず、朝に回す
on conflict (key) do nothing;

create or replace function toi_push_setting(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select value from push_settings where key = p_key;
$$;

-- 送り先（push service）として受け付ける宛先。Apple・Google・Mozilla・Microsoft のものだけ
-- （どこにでも送れると、Edge Function が知らない宛先へ通信する踏み台になるため）
create or replace function toi_push_endpoint_ok(p_endpoint text) returns boolean
language sql immutable as $$
  select coalesce(p_endpoint, '') ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)/[!-~]+$'
     and char_length(p_endpoint) <= 1000;
$$;

-- 端末の印（api.js の clientHash: sha256 の先頭 16 バイトを 16 進で）。'anon-hash'（印を作れなかった端末）や 'line' は通さない
create or replace function toi_push_hash_ok(p_hash text) returns boolean
language sql immutable as $$
  select coalesce(p_hash, '') ~ '^[0-9a-f]{32}$';
$$;

-- ---------------------------------------------------------------- 表（どれも非公開。ブラウザからは関数経由でだけ触る）

-- 購読（端末のブラウザごとに1行）。名前・メールは持たない
create table if not exists push_subscriptions (
  endpoint    text primary key check (toi_push_endpoint_ok(endpoint)),
  p256dh      text not null check (p256dh ~ '^[A-Za-z0-9_-]{1,200}$'),
  auth        text not null check (auth ~ '^[A-Za-z0-9_-]{1,100}$'),
  client_hash text not null check (toi_push_hash_ok(client_hash)),
  questions   boolean not null default true,   -- 新しい問いの知らせも受け取るか（返事の知らせはいつも）
  created_at  timestamptz not null default now()
);
create index if not exists push_subscriptions_hash on push_subscriptions (client_hash);

-- 引き継ぎで結んだ端末（Safari の印 → ホーム画面のアプリの印）。from の問いに返事が載ったら、to の端末にも知らせる
create table if not exists push_hash_links (
  from_hash  text not null check (toi_push_hash_ok(from_hash)),
  to_hash    text not null check (toi_push_hash_ok(to_hash)),
  created_at timestamptz not null default now(),
  primary key (from_hash, to_hash)
);
create index if not exists push_hash_links_to on push_hash_links (to_hash);

-- 引き継ぎの番号（番号そのものは持たず、ハッシュだけ）。1つの端末に1つ。15分で切れる
create table if not exists push_handoffs (
  code_hash   text primary key,
  client_hash text not null unique,
  expires_at  timestamptz not null
);

-- 番号を入れた回数（総当たりを止める）
create table if not exists push_handoff_tries (
  id          bigint generated always as identity primary key,
  client_hash text not null,
  created_at  timestamptz not null default now()
);

-- 送る列（中身を持たない。どの端末に・どの種類か・いつから送ってよいか）。Edge Function が op_take_push で受け取って消す
create table if not exists push_outbox (
  id         bigint generated always as identity primary key,
  endpoint   text not null references push_subscriptions(endpoint) on delete cascade on update cascade,
  kind       text not null check (kind in ('reply', 'question')),
  send_after timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists push_outbox_due on push_outbox (send_after);

-- 知らせ終えた返事・問い（同じものを二度知らせない。購読より前に載ったものも、ここに入れて知らせない）
create table if not exists push_answers_seen (
  answer_id  uuid primary key references answers(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists push_questions_seen (
  question_id uuid primary key references questions(id) on delete cascade,
  created_at  timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['push_subscriptions', 'push_hash_links', 'push_handoffs', 'push_handoff_tries', 'push_outbox',
                           'push_answers_seen', 'push_questions_seen'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

-- はじめて流したとき: いま載っている返事・問いは知らせ終えたことにする（入れた途端に、昔の分がまとめて届かないように）
do $$ begin
  if not exists (select 1 from push_answers_seen) then
    insert into push_answers_seen (answer_id)
    select a.id from answers a join questions q on q.id = a.question_id and q.approved where a.approved
    on conflict do nothing;
  end if;
  if not exists (select 1 from push_questions_seen) then
    insert into push_questions_seen (question_id) select id from questions where approved on conflict do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------- 送る列に足す

-- いつから送ってよいか。夜（quiet_from〜quiet_until・JST）なら、朝の quiet_until 時にする
create or replace function toi_push_send_after(p_at timestamptz) returns timestamptz
language plpgsql stable security definer set search_path = public as $$
declare
  v_local timestamp := p_at at time zone 'Asia/Tokyo';
  v_hour  int := extract(hour from v_local);
  v_from  int := coalesce(toi_push_setting('quiet_from_jst'), '21')::int;
  v_until int := coalesce(toi_push_setting('quiet_until_jst'), '7')::int;
begin
  if v_hour >= v_from then
    return ((v_local::date + 1) + make_time(v_until, 0, 0)) at time zone 'Asia/Tokyo';
  elsif v_hour < v_until then
    return (v_local::date + make_time(v_until, 0, 0)) at time zone 'Asia/Tokyo';
  end if;
  return p_at;
end;
$$;

-- 問い1つについて、まだ知らせていない承認済みの返事があれば、問いを出した端末（と引き継いだ端末）に「返事が載った」を1つ足す
create or replace function toi_push_replied(p_question_id uuid) returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  v_hash text;
  v_new  int;
  v_n    int;
begin
  select client_hash into v_hash from questions where id = p_question_id and approved;
  if not found then
    return 0;   -- 問いが公開されてから知らせる（開いた先で読めるように）
  end if;
  with fresh as (
    insert into push_answers_seen (answer_id)
    select a.id from answers a where a.question_id = p_question_id and a.approved
    on conflict do nothing
    returning answer_id
  ) select count(*) into v_new from fresh;
  if v_new = 0 or not toi_push_hash_ok(v_hash) then
    return 0;
  end if;
  insert into push_outbox (endpoint, kind, send_after)
  select s.endpoint, 'reply', toi_push_send_after(now()) from push_subscriptions s
   where s.client_hash = v_hash
      or s.client_hash in (select l.to_hash from push_hash_links l where l.from_hash = v_hash);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 返事・問いが承認されたら（文1つにつき問いごとに1回）
create or replace function toi_push_on_answers() returns trigger
language plpgsql security definer set search_path = public as $$
declare q uuid;
begin
  for q in select distinct question_id from new_rows where approved loop
    perform toi_push_replied(q);
  end loop;
  return null;
end;
$$;

create or replace function toi_push_on_questions() returns trigger
language plpgsql security definer set search_path = public as $$
declare q uuid;
begin
  for q in select id from new_rows where approved loop
    perform toi_push_replied(q);
  end loop;
  return null;
end;
$$;

drop trigger if exists push_answers_insert on answers;
create trigger push_answers_insert after insert on answers
  referencing new table as new_rows for each statement execute function toi_push_on_answers();
drop trigger if exists push_answers_update on answers;
create trigger push_answers_update after update on answers
  referencing new table as new_rows for each statement execute function toi_push_on_answers();
drop trigger if exists push_questions_update on questions;
create trigger push_questions_update after update on questions
  referencing new table as new_rows for each statement execute function toi_push_on_questions();

-- 前の回から新しく載った問いがあれば、受け取ると決めた端末に「新しい問いが届いた」を1つ足す。
-- 自分（と引き継ぎ元）の問いだけのときは、その端末には送らない。足した数を返す
create or replace function toi_push_new_questions() returns int
language plpgsql volatile security definer set search_path = public as $$
declare v_n int;
begin
  with fresh as (
    insert into push_questions_seen (question_id)
    select id from questions where approved
    on conflict do nothing
    returning question_id
  ), owners as (
    select q.client_hash from fresh f join questions q on q.id = f.question_id
  )
  insert into push_outbox (endpoint, kind, send_after)
  select s.endpoint, 'question', toi_push_send_after(now()) from push_subscriptions s
   where s.questions
     and exists (select 1 from owners o
                  where o.client_hash is distinct from s.client_hash
                    and not exists (select 1 from push_hash_links l where l.from_hash = o.client_hash and l.to_hash = s.client_hash));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------- Edge Function を呼ぶ

-- 送ってよい列があれば、pg_net で notify-push を呼ぶ（待たない）。呼べないとき（Vault・pg_net・設定が無い）は何もしない。
-- 書く操作（返事の承認など）を止めない。列に残った分は、次に呼んだとき（毎時の toi_push_tick）に送る
create or replace function toi_push_call() returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare
  v_url    text := toi_push_setting('function_url');
  v_anon   text := toi_push_setting('anon_key');
  v_secret text;
begin
  if not exists (select 1 from push_outbox where send_after <= now()) then return false; end if;
  begin
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_hook_secret';
    if coalesce(v_url, '') = '' or coalesce(v_anon, '') = '' or coalesce(v_secret, '') = '' then return false; end if;
    perform net.http_post(url := v_url, body := '{}'::jsonb,
      headers := jsonb_build_object('content-type', 'application/json', 'authorization', 'Bearer ' || v_anon, 'x-push-secret', v_secret));
    return true;
  exception when others then
    return false;
  end;
end;
$$;

create or replace function toi_push_kick() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform toi_push_call();
  return null;
end;
$$;
drop trigger if exists push_outbox_kick on push_outbox;
create trigger push_outbox_kick after insert on push_outbox for each statement execute function toi_push_kick();

-- 毎時（pg_cron）: 決まった時刻なら新しい問いの知らせを足す。夜のあいだに回した分・呼べなかった分を送る。古い番号を消す
create or replace function toi_push_tick() returns int
language plpgsql volatile security definer set search_path = public as $$
declare v_n int := 0;
begin
  if extract(hour from now() at time zone 'Asia/Tokyo')::int = coalesce(toi_push_setting('question_hour_jst'), '19')::int then
    v_n := toi_push_new_questions();
  end if;
  perform toi_push_call();
  delete from push_handoffs where expires_at < now();
  delete from push_handoff_tries where created_at < now() - interval '1 day';
  return v_n;
end;
$$;

-- ---------------------------------------------------------------- Edge Function（service_role）が呼ぶ

-- 送ってよい列を受け取って消し、宛先と種類だけを返す（同じ端末・同じ種類は1つにまとめる）
create or replace function op_take_push(p_limit int default 100) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_rows jsonb;
begin
  with taken as (
    delete from push_outbox
     where id in (select id from push_outbox where send_after <= now() order by id limit greatest(coalesce(p_limit, 100), 1))
    returning endpoint, kind
  ), one as (select distinct endpoint, kind from taken)
  select coalesce(jsonb_agg(jsonb_build_object('kind', o.kind, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
    into v_rows
    from one o join push_subscriptions s on s.endpoint = o.endpoint;
  return v_rows;
end;
$$;

-- 送って 404・410（購読が切れた）が返った宛先を消す
create or replace function op_drop_push(p_endpoint text) returns void
language sql volatile security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint;
$$;

-- pg_net から来た呼び出しかを確かめる合言葉
create or replace function op_push_hook_secret() returns text
language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'push_hook_secret';
$$;

-- 通知の鍵（VAPID）。notify-push が最初に動いたときに作って Vault に置く（人の手で作らない・写さない）
create or replace function op_vapid() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'publicKey', (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_public_key'),
    'privateKey', (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_private_key'));
$$;

-- 鍵を置く。もうあれば置かずに、いまある鍵を返す（2つ同時に動いても鍵は1組）
create or replace function op_set_vapid(p_public text, p_private text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  if coalesce(p_public, '') !~ '^[A-Za-z0-9_-]{87}$' or coalesce(p_private, '') !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'bad_vapid_key';
  end if;
  perform pg_advisory_xact_lock(hashtext('toi-site-vapid'));
  if not exists (select 1 from vault.decrypted_secrets where name = 'vapid_public_key') then
    perform vault.create_secret(p_public, 'vapid_public_key', '通知の公開の鍵（notify-push が作った）');
    perform vault.create_secret(p_private, 'vapid_private_key', '通知の秘密の鍵（notify-push が作った）');
  end if;
  return op_vapid();
end;
$$;

-- ---------------------------------------------------------------- ブラウザ（anon）から呼ぶ

-- 通知の公開の鍵（公開してよい鍵。まだ無ければ null）
create or replace function push_public_key() returns text
language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'vapid_public_key';
$$;

-- 購読を保存する（同じ宛先は1行。印や「新しい問いも」を替えたら置き換える）
create or replace function save_push(p_endpoint text, p_p256dh text, p_auth text, p_client_hash text, p_questions boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not toi_push_endpoint_ok(p_endpoint) then raise exception 'bad_endpoint'; end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{1,200}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{1,100}$' then
    raise exception 'bad_push_key';
  end if;
  if not toi_push_hash_ok(p_client_hash) then raise exception 'bad_client_hash'; end if;
  insert into push_subscriptions (endpoint, p256dh, auth, client_hash, questions)
  values (p_endpoint, p_p256dh, p_auth, p_client_hash, coalesce(p_questions, true))
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth, client_hash = excluded.client_hash, questions = excluded.questions;
  return jsonb_build_object('ok', true);
end;
$$;

-- 購読を消す（宛先を知っている端末だけが消せる。宛先は端末の外に出ない長い URL）
create or replace function delete_push(p_endpoint text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  delete from push_subscriptions where endpoint = p_endpoint;
  return jsonb_build_object('ok', true);
end;
$$;

-- 引き継ぎの番号を作る（Safari で出した問いを、ホーム画面のアプリに結ぶため。8けた・15分）。番号は1回だけ返し、ハッシュだけ持つ
create or replace function push_handoff_make(p_client_hash text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_code text;
  v_exp  timestamptz := now() + interval '15 minutes';
begin
  if not toi_push_hash_ok(p_client_hash) then raise exception 'bad_client_hash'; end if;
  delete from push_handoffs where client_hash = p_client_hash or expires_at < now();
  -- gen_random_uuid() の先頭 8 文字（32 ビットの乱数）から 8 けたを作る
  v_code := lpad((('x' || lpad(substr(gen_random_uuid()::text, 1, 8), 16, '0'))::bit(64)::bigint % 100000000)::text, 8, '0');
  insert into push_handoffs (code_hash, client_hash, expires_at)
  values (encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), p_client_hash, v_exp)
  on conflict (code_hash) do nothing;
  if not found then raise exception 'try_again'; end if;
  return jsonb_build_object('code', v_code, 'expires_at', v_exp);
end;
$$;

-- 番号を入れて結ぶ（ホーム画面のアプリで）。結んだら、番号を作った端末で出した問いを返す（この端末の「自分への返事」に入れるため）。
-- まちがいは断りではなく ok=false で返す（断ると、入れた回数の記録まで巻き戻るため）。
-- 総当たりを止める: 1つの端末は15分に5回まで、全体でも15分に60回まで
create or replace function push_handoff_take(p_code text, p_client_hash text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_from text;
  v_code text := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
begin
  if not toi_push_hash_ok(p_client_hash) then raise exception 'bad_client_hash'; end if;
  if (select count(*) from push_handoff_tries where created_at > now() - interval '15 minutes') >= 60 then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  if (select count(*) from push_handoff_tries where client_hash = p_client_hash and created_at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'tries');
  end if;
  insert into push_handoff_tries (client_hash) values (p_client_hash);
  delete from push_handoffs
   where code_hash = encode(sha256(convert_to(v_code, 'UTF8')), 'hex') and expires_at >= now()
  returning client_hash into v_from;
  if v_from is null then
    return jsonb_build_object('ok', false, 'reason', 'code');
  end if;
  if v_from <> p_client_hash then
    insert into push_hash_links (from_hash, to_hash) values (v_from, p_client_hash) on conflict do nothing;
  end if;
  delete from push_handoff_tries where client_hash = p_client_hash;
  return jsonb_build_object('ok', true, 'questions', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', q.id, 'body', q.body, 'nickname', coalesce(nullif(q.nickname, ''), 'だれか'),
      'theme_id', q.theme_id, 'theme_label', t.label, 'created_at', q.created_at) order by q.created_at desc)
      from (select * from questions where client_hash = v_from order by created_at desc limit 200) q
      left join themes t on t.id = q.theme_id), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------- 権限

revoke execute on function toi_push_setting(text), toi_push_send_after(timestamptz), toi_push_replied(uuid),
  toi_push_on_answers(), toi_push_on_questions(), toi_push_new_questions(), toi_push_call(), toi_push_kick(), toi_push_tick(),
  op_take_push(int), op_drop_push(text), op_push_hook_secret(), op_vapid(), op_set_vapid(text, text)
  from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function op_take_push(int), op_drop_push(text), op_push_hook_secret(), op_vapid(), op_set_vapid(text, text)
      to service_role;
  end if;
end $$;
revoke execute on function push_public_key(), save_push(text, text, text, text, boolean), delete_push(text),
  push_handoff_make(text), push_handoff_take(text, text) from public;
grant execute on function push_public_key(), save_push(text, text, text, text, boolean), delete_push(text),
  push_handoff_make(text), push_handoff_take(text, text) to anon, authenticated;

-- ---------------------------------------------------------------- 準備（何度流しても同じ。使えない拡張・Vault があっても止めない）

-- pg_net と notify-push の合言葉を、データベースの中で作る（値はどのファイルにもクエリの結果にも出ない）
do $$ begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'push_hook_secret') then
    perform vault.create_secret(
      encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'),
      'push_hook_secret', 'pg_net と notify-push の合言葉（web-push.sql が作った）');
  end if;
exception when others then raise notice '合言葉を Vault に作れませんでした: %', sqlerrm;
end $$;

-- 毎時0分（JST）。新しい問いの知らせ（question_hour_jst の時だけ）と、朝に回した知らせを送る
do $$ begin
  perform cron.schedule('toi-web-push-hourly', '0 * * * *', 'select public.toi_push_tick()');
exception when others then raise notice '毎時の仕事を pg_cron に組めませんでした: %', sqlerrm;
end $$;
