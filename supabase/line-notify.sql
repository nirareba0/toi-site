-- 問いに返事がきたら LINE で知らせる（2026-10-10 本人「問いコーナーで自分が出したものへの回答がきたら『回答きたよ！』って LINE が自動で飛ぶとかできない？」
--   「まずは個人のにらレバの方の公式LINEを整えたいね。問いサイトのシステムを作ってみて」）
-- 送るのは中高生向けの公式LINE「問う応える」（@803ifgkb・Messaging API のチャネル 1660696949・プロバイダー「たいど」1660696937。2026-10-11 に「にらレバ_西村」から替えた）。
-- LINE で送れる相手の ID はプロバイダーごとに違うので、知らせを受けるためのログイン（LINE ログインのチャネルと LIFF）も同じプロバイダーに作る。
--
-- 流れ:
--   1. 問いを出した人が「返事がきたら LINE で知らせて」を押す → LIFF で LINE にログイン → watch_question(問いの id, ID トークン)
--      DB が LINE のサーバーで ID トークンを確かめ、問いと LINE の ID を非公開の表 line_watches でつなぐ
--   2. スタッフが返事を承認する（Table Editor で answers.approved を true）か、問いを承認する
--      → トリガーが、まだ知らせていない承認済みの返事を、その問いを見ている人に1通にまとめて送る（line_notices に残す。二重に送らない）
--   3. 送る文は「返事が届いた」とリンクだけ。問いと返事の本文は LINE に載せない（悩みの問いが通知に出ないように）
--
-- 秘密: Messaging API のチャネルアクセストークンは Vault の 'line_messaging_token'（本人が Dashboard で入れる。Git・Drive に書かない）。
--       無いあいだは送らず、line_notices に no_token と残す。
-- schema.sql のあとに流す。何度流しても同じ結果になる。

create extension if not exists http with schema extensions;
create extension if not exists pg_net;

-- 設定（秘密ではないもの）
create table if not exists line_settings (
  key   text primary key,
  value text not null
);
alter table line_settings enable row level security;
revoke all on line_settings from anon, authenticated;
insert into line_settings (key, value) values
  ('login_channel_id', ''),                                   -- 送り元と同じプロバイダーの LINE ログインのチャネル ID（作ったら入れる）
  ('site_url', 'https://nirareba0.github.io/toi-site/')
on conflict (key) do nothing;

-- だれがどの問いの返事を待っているか（LINE の ID はここにだけ置く。公開しない）
create table if not exists line_watches (
  question_id  uuid not null references questions(id) on delete cascade,
  line_user_id text not null check (char_length(line_user_id) between 1 and 100),
  created_at   timestamptz not null default now(),
  primary key (question_id, line_user_id)
);
alter table line_watches enable row level security;
revoke all on line_watches from anon, authenticated;

-- 知らせた記録（返事 × 人で1行。二重に送らないため）
create table if not exists line_notices (
  id           bigint generated always as identity primary key,
  answer_id    uuid not null references answers(id) on delete cascade,
  line_user_id text not null,
  status       text not null check (status in ('sent', 'no_token', 'failed', 'skipped')),  -- skipped: 待ち始める前からあった返事
  request_id   bigint,                                       -- pg_net の要求 ID（net._http_response で結果を見られる）
  created_at   timestamptz not null default now(),
  unique (answer_id, line_user_id)
);
alter table line_notices enable row level security;
revoke all on line_notices from anon, authenticated;

-- LINE の ID トークンを LINE のサーバーで確かめて、LINE の ID（sub）を返す
create or replace function toi_line_verify(p_id_token text) returns text
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_channel text;
  v_res record;
  v_body jsonb;
begin
  select value into v_channel from line_settings where key = 'login_channel_id';
  if coalesce(v_channel, '') = '' or coalesce(p_id_token, '') = '' or p_id_token !~ '^[A-Za-z0-9_.-]+$' then
    raise exception 'line_login_failed';
  end if;
  select status, content into v_res from extensions.http_post(
    'https://api.line.me/oauth2/v2.1/verify',
    'id_token=' || p_id_token || '&client_id=' || v_channel,
    'application/x-www-form-urlencoded'
  );
  if v_res.status <> 200 then raise exception 'line_login_failed'; end if;
  v_body := v_res.content::jsonb;
  if v_body->>'aud' is distinct from v_channel or coalesce(v_body->>'sub', '') = '' then
    raise exception 'line_login_failed';
  end if;
  return v_body->>'sub';
end;
$$;

-- LINE に1通送る（pg_net で、承認の操作を待たせずに送る）。{status, request_id} を返す
create or replace function toi_line_send(p_to text, p_text text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_token text;
  v_req bigint;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'line_messaging_token';
  if coalesce(v_token, '') = '' then
    return jsonb_build_object('status', 'no_token');
  end if;
  select net.http_post(
    url := 'https://api.line.me/v2/bot/message/push',
    body := jsonb_build_object('to', p_to, 'messages', jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text))),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token)
  ) into v_req;
  return jsonb_build_object('status', 'sent', 'request_id', v_req);
exception when others then
  return jsonb_build_object('status', 'failed');
end;
$$;

-- 問い1つについて、まだ知らせていない承認済みの返事を、待っている人に1通ずつまとめて知らせる
create or replace function toi_line_notify(p_question_id uuid) returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  w record;
  v_url text;
  v_res jsonb;
  v_sent int := 0;
begin
  if not exists (select 1 from questions where id = p_question_id and approved) then
    return 0;   -- 問いが公開されてから知らせる（リンク先で読めるように）
  end if;
  select value || '#question/' || p_question_id into v_url from line_settings where key = 'site_url';
  for w in
    select lw.line_user_id, array_agg(a.id) as answer_ids
    from line_watches lw
    join answers a on a.question_id = lw.question_id and a.approved
    where lw.question_id = p_question_id
      and not exists (select 1 from line_notices n where n.answer_id = a.id and n.line_user_id = lw.line_user_id)
    group by lw.line_user_id
  loop
    v_res := toi_line_send(w.line_user_id,
      '📮 あなたの問いに返事が届いたよ！' || chr(10) || '「問う応える」で読めます' || chr(10) || v_url);
    insert into line_notices (answer_id, line_user_id, status, request_id)
    select x, w.line_user_id, v_res->>'status', (v_res->>'request_id')::bigint from unnest(w.answer_ids) as x
    on conflict (answer_id, line_user_id) do nothing;
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end;
$$;

-- 返事・問いが承認されたら知らせる（文1つにつき問いごとに1回。何件まとめて承認しても1人1通）
create or replace function toi_line_on_answers() returns trigger
language plpgsql security definer set search_path = public as $$
declare q uuid;
begin
  for q in select distinct question_id from new_rows where approved loop
    perform toi_line_notify(q);
  end loop;
  return null;
end;
$$;

create or replace function toi_line_on_questions() returns trigger
language plpgsql security definer set search_path = public as $$
declare q uuid;
begin
  for q in select id from new_rows where approved loop
    perform toi_line_notify(q);
  end loop;
  return null;
end;
$$;

drop trigger if exists line_notify_answers_insert on answers;
create trigger line_notify_answers_insert after insert on answers
  referencing new table as new_rows for each statement execute function toi_line_on_answers();
drop trigger if exists line_notify_answers_update on answers;
create trigger line_notify_answers_update after update on answers
  referencing new table as new_rows for each statement execute function toi_line_on_answers();
drop trigger if exists line_notify_questions_update on questions;
create trigger line_notify_questions_update after update on questions
  referencing new table as new_rows for each statement execute function toi_line_on_questions();

-- 問いを出した人が呼ぶ: この問いの返事を LINE で待つ
create or replace function watch_question(p_question_id uuid, p_id_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_sub text;
begin
  if not exists (select 1 from questions where id = p_question_id) then
    raise exception 'question_not_found';
  end if;
  v_sub := toi_line_verify(p_id_token);
  if not exists (select 1 from line_watches where question_id = p_question_id and line_user_id = v_sub) then
    if (select count(*) from line_watches where line_user_id = v_sub) >= 50 then
      raise exception 'too_many_watches';
    end if;
    insert into line_watches (question_id, line_user_id) values (p_question_id, v_sub);
    -- 待ち始める前からある返事は知らせない（いま画面で読める）
    insert into line_notices (answer_id, line_user_id, status)
    select a.id, v_sub, 'skipped' from answers a where a.question_id = p_question_id and a.approved
    on conflict (answer_id, line_user_id) do nothing;
  end if;
  return jsonb_build_object('watching', true);
end;
$$;

-- 知らせをやめる
create or replace function unwatch_question(p_question_id uuid, p_id_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  delete from line_watches where question_id = p_question_id and line_user_id = toi_line_verify(p_id_token);
  return jsonb_build_object('watching', false);
end;
$$;

-- 権限: ブラウザ（anon）から呼べるのは watch / unwatch だけ
revoke execute on function toi_line_verify(text), toi_line_send(text, text), toi_line_notify(uuid),
  toi_line_on_answers(), toi_line_on_questions() from public, anon, authenticated;
revoke execute on function watch_question(uuid, text), unwatch_question(uuid, text) from public;
grant execute on function watch_question(uuid, text), unwatch_question(uuid, text) to anon, authenticated;
