-- ホーム画面のアプリだけで、LINE と同じことができるようにする（2026-11-01 本人「アプリ側でも単独で成立するように作りかえておいて」）
-- LINE を使わない中高生が、ホーム画面の「なんでポスト」だけで、問いに答える・問いが届く・ノートに残す・載ったら知らせてもらう、をできるようにする。
-- LINE で同じことをしている line-sync.sql・line-reactions.sql を、LINE の ID ではなく端末の印（client_hash）で組み直したもの。
--
-- 流す順: schema.sql → line-notify.sql → line-sync.sql → web-push.sql → このファイル（line-reactions.sql の有無は問わない）。
-- 何度流しても同じ結果になる。秘密の値は持たない。
--
-- できること（LINE のどれと同じか）:
--   答える        問いのページ・今日の問いで書いた答え → この端末だけのノート（line_notes と同じ）
--   みんなに見せる  ノート → その問いへの未承認の返事（立場「中高生」= role_id 'teen'）。運営が承認すると載る（LINE の「みんなに見せる」と同じ）
--   今日の問い     毎日／週1／自分で引くだけ。ジャンルを選べる。選び方は toi_line_pick と同じ
--                 （承認済み・まだ届けていない・自分の問いと相談先が要る言葉を含む問いは除く・選んだジャンルだけ）
--   知らせ（Web Push。中身は種類だけ）:
--     today         今日の問いが届いた（毎日／週1の端末に、question_hour_jst の時に。ほかの端末への「新しい問い（question）」はそのまま）
--     published     アプリから「みんなに見せる」にした答えが載った（line-sync.sql の「載ったよ」と同じ時点）
--     reaction      載った答えに反応が押された（1つの答えにつき1日1通まで。line-reactions.sql と同じ）
--     other_answer  答えた問いに、ほかの人の返事が載った（返事1つにつき1通。line-reactions.sql と同じ）
--
-- 「新しい問いが届きました（question）」の意味の変え方:
--   毎日／週1を選んだ端末には question を送らず、today（その端末の今日の問いが届いた）だけを送る。
--   選んでいない端末・「自分で引くだけ」の端末には、これまでどおり question を送る。
--   どちらも push_subscriptions.questions（「問いの知らせも受け取る」）が切ってあれば送らない。
--
-- 守ること:
--   死にたい・消えたい・いじめられ…などの言葉（line-sync.sql の toi_line_is_sos と同じ判定を使う）は、何より先に断り、
--   ノートにも返事にも残さない（画面は相談先を出す）。承認制はそのまま（返事は approved = false で入る）。
--   大人と中高生を個別につながない（返事は問いの下に並ぶだけ。だれが書いたかは出ない）。
--   名前・メール・LINE の ID は取らない。端末は投函と同じ client_hash（web-push.sql と同じ決まり）。
--   荒らし対策に、端末ごと・全体の回数の上限（toi_app_rate_ok）。
--   ノートは本人の端末だけ。運営が読むのは「みんなに見せる」を選んだもの（answers に未承認で入る）だけ。

create extension if not exists pg_cron;

-- 先に流しておくもの（無ければ止める。判定を2か所に持たないため）
do $$ begin
  if to_regprocedure('public.toi_line_is_sos(text)') is null then
    raise exception 'line-sync.sql を先に流してください（相談先が要る言葉の判定 toi_line_is_sos を共有します）';
  end if;
  if to_regclass('public.push_subscriptions') is null then
    raise exception 'web-push.sql を先に流してください';
  end if;
end $$;

-- アプリから「みんなに見せる」と、この立場で返事に入る（line-sync.sql と同じ）
insert into responder_roles (id, label, sort_order) values ('teen', '中高生', 50)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- 表（どれも非公開。ブラウザからは関数経由でだけ触る）

-- 端末（line_users と同じ役目）。名前などは持たない
create table if not exists app_devices (
  client_hash         text primary key check (toi_push_hash_ok(client_hash)),
  frequency           text not null default 'pull' check (frequency in ('daily', 'weekly', 'pull')),  -- pull: こちらからは届けない
  themes              text[],                                              -- 届く問いのジャンル（themes.id）。null＝ぜんぶ
  freq_chosen         boolean not null default false,                      -- 頻度とジャンルを一度選んだか
  current_question_id uuid references questions(id) on delete set null,    -- 今日の問い
  current_set_at      timestamptz,
  current_via         text check (current_via in ('daily', 'pull')),
  last_prompted_on    date,                                                -- 毎日／週1で最後に届けた日（JST）
  last_seen_at        timestamptz not null default now(),                  -- 30日開いていない端末には届けない
  created_at          timestamptz not null default now()
);

-- 届けた問い（同じ問いを続けて届けない。line_prompts と同じ）
create table if not exists app_prompts (
  id          bigint generated always as identity primary key,
  client_hash text not null references app_devices(client_hash) on delete cascade,
  question_id uuid not null references questions(id) on delete cascade,
  via         text not null check (via in ('daily', 'pull')),
  created_at  timestamptz not null default now()
);
create index if not exists app_prompts_device on app_prompts (client_hash, question_id);

-- 自分だけのノート（line_notes と同じ）
create table if not exists app_notes (
  id                 uuid primary key default gen_random_uuid(),
  client_hash        text not null check (toi_push_hash_ok(client_hash)),
  question_id        uuid references questions(id) on delete set null,
  body               text not null check (char_length(body) between 1 and 2000),
  answer_id          uuid references answers(id) on delete set null,   -- 「みんなに見せる」を選んだら、その返事
  published_notified boolean not null default false,
  created_at         timestamptz not null default now()
);
create index if not exists app_notes_device on app_notes (client_hash, created_at desc);
create index if not exists app_notes_answer on app_notes (answer_id) where answer_id is not null;
create index if not exists app_notes_question on app_notes (question_id) where answer_id is not null;

-- 知らせた記録（反応は1つの答えにつき1日1回、ほかの返事は返事1つにつき1回。line_answer_notices と同じ）
create table if not exists app_answer_notices (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('reaction', 'other_answer')),
  answer_id   uuid not null references answers(id) on delete cascade,
  client_hash text not null,
  day         date not null default (now() at time zone 'Asia/Tokyo')::date,
  created_at  timestamptz not null default now()
);
create unique index if not exists app_answer_notices_once on app_answer_notices (kind, answer_id, client_hash, day);

-- 書いた回数（荒らし対策。ノートを消しても数は減らない）。2日で消す
create table if not exists app_rate (
  id          bigint generated always as identity primary key,
  client_hash text not null,
  action      text not null check (action in ('note', 'share', 'draw')),
  created_at  timestamptz not null default now()
);
create index if not exists app_rate_device on app_rate (client_hash, action, created_at);
create index if not exists app_rate_all on app_rate (action, created_at);

do $$
declare t text;
begin
  foreach t in array array['app_devices', 'app_prompts', 'app_notes', 'app_answer_notices', 'app_rate'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

-- 送る列に新しい種類を足す（web-push.sql の表。流し直しても同じ）
alter table push_outbox drop constraint if exists push_outbox_kind_check;
alter table push_outbox add constraint push_outbox_kind_check
  check (kind in ('reply', 'question', 'today', 'published', 'reaction', 'other_answer'));

-- ---------------------------------------------------------------- 中で使うもの

-- この端末の印と、引き継ぎで結んだ印（iPhone の Safari で書いたノートも、ホーム画面のアプリで読めるように。web-push.sql の push_hash_links）
create or replace function toi_app_hashes(p_hash text) returns text[]
language sql stable security definer set search_path = public as $$
  select array[p_hash] || coalesce((select array_agg(from_hash) from push_hash_links where to_hash = p_hash), '{}');
$$;

-- 回数の上限。超えていたら false（数えるのは toi_app_rate_log）
--   note  … 1つの端末で1時間に20・1日に60、全体で1時間に1000
--   share … 1つの端末で1日に5、全体で1日に200（運営が読む量を守る）
--   draw  … 1つの端末で1時間に30、全体で1時間に2000
create or replace function toi_app_rate_ok(p_hash text, p_action text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_mine_hour int; v_mine_day int; v_all_hour int; v_all_day int;
begin
  select count(*) filter (where created_at > now() - interval '1 hour'), count(*) into v_mine_hour, v_mine_day
    from app_rate where client_hash = p_hash and action = p_action and created_at > now() - interval '1 day';
  select count(*) filter (where created_at > now() - interval '1 hour'), count(*) into v_all_hour, v_all_day
    from app_rate where action = p_action and created_at > now() - interval '1 day';
  return case p_action
    when 'note'  then v_mine_hour < 20 and v_mine_day < 60 and v_all_hour < 1000
    when 'share' then v_mine_day < 5 and v_all_day < 200
    when 'draw'  then v_mine_hour < 30 and v_all_hour < 2000
    else false end;
end;
$$;

create or replace function toi_app_rate_log(p_hash text, p_action text) returns void
language sql volatile security definer set search_path = public as $$
  insert into app_rate (client_hash, action) values (p_hash, p_action);
$$;

-- 端末の行を用意して、開いた時刻を記す
create or replace function toi_app_device(p_hash text) returns app_devices
language plpgsql volatile security definer set search_path = public as $$
declare d app_devices;
begin
  insert into app_devices (client_hash) values (p_hash)
  on conflict (client_hash) do update set last_seen_at = now()
  returning * into d;
  return d;
end;
$$;

-- 端末（と引き継ぎ先のアプリ）に知らせを1つ足す。today は「問いの知らせも受け取る」を切った端末には送らない。足した数を返す
create or replace function toi_app_push(p_hash text, p_kind text) returns int
language plpgsql volatile security definer set search_path = public as $$
declare v_n int;
begin
  insert into push_outbox (endpoint, kind, send_after)
  select s.endpoint, p_kind, toi_push_send_after(now()) from push_subscriptions s
   where (s.client_hash = p_hash or s.client_hash in (select l.to_hash from push_hash_links l where l.from_hash = p_hash))
     and (p_kind <> 'today' or s.questions);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 問いを1つ選んで「今日の問い」にする（toi_line_pick と同じ選び方）。
-- まだ届けていない承認済みの問いから。自分（と引き継ぎ元）の問い・相談先が要る言葉を含む問いは除く。ジャンルを選んだ端末にはそのジャンルだけ。
-- 全部届けたら、いちばん前に届けたもの
create or replace function toi_app_pick(p_hash text, p_via text) returns questions
language plpgsql volatile security definer set search_path = public as $$
declare
  q questions;
  v_themes text[];
  v_mine text[] := toi_app_hashes(p_hash);
begin
  select themes into v_themes from app_devices where client_hash = p_hash;
  select * into q from questions qq
   where qq.approved and not toi_line_is_sos(qq.body)
     and (v_themes is null or qq.theme_id = any(v_themes))
     and (qq.client_hash is null or not (qq.client_hash = any(v_mine)))
     and not exists (select 1 from app_prompts p where p.client_hash = p_hash and p.question_id = qq.id)
   order by random() limit 1;
  if q.id is null then
    select qq.* into q from questions qq
      join (select question_id, max(created_at) as last_at from app_prompts where client_hash = p_hash group by question_id) p
        on p.question_id = qq.id
     where qq.approved and not toi_line_is_sos(qq.body) and (v_themes is null or qq.theme_id = any(v_themes))
     order by p.last_at limit 1;
  end if;
  if q.id is null then return null; end if;
  insert into app_prompts (client_hash, question_id, via) values (p_hash, q.id, p_via);
  update app_devices set current_question_id = q.id, current_set_at = now(), current_via = p_via where client_hash = p_hash;
  return q;
end;
$$;

-- 画面に返す形（設定と今日の問い）
create or replace function toi_app_today_json(p_hash text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ok', true,
    'prefs', jsonb_build_object(
      'frequency', coalesce(d.frequency, 'pull'),
      'themes', to_jsonb(d.themes),
      'chosen', coalesce(d.freq_chosen, false)),
    'question', case when q.id is null then null else jsonb_build_object(
      'id', q.id, 'body', q.body, 'theme_id', q.theme_id, 'theme_label', t.label,
      'via', d.current_via, 'delivered_at', d.current_set_at,
      'answered', exists (select 1 from app_notes n where n.question_id = q.id and n.client_hash = any(toi_app_hashes(p_hash)))) end)
  from (select p_hash as h) x
  left join app_devices d on d.client_hash = x.h
  left join questions q on q.id = d.current_question_id and q.approved
  left join themes t on t.id = q.theme_id;
$$;

-- 返事にする（「みんなに見せる」）。line-sync.sql の share と同じ決まり
create or replace function toi_app_share(p_hash text, p_note_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_note app_notes;
  v_q    questions;
  v_ans  uuid;
begin
  select * into v_note from app_notes where id = p_note_id and client_hash = any(toi_app_hashes(p_hash));
  if v_note.id is null then return jsonb_build_object('ok', false, 'reason', 'note'); end if;
  if v_note.answer_id is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  if toi_line_is_sos(v_note.body) then return jsonb_build_object('ok', false, 'reason', 'sos'); end if;
  select * into v_q from questions where id = v_note.question_id and approved;
  if v_q.id is null then return jsonb_build_object('ok', false, 'reason', 'question'); end if;
  if not toi_app_rate_ok(p_hash, 'share') then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  insert into answers (question_id, body, role_id, approved, client_hash)
  values (v_q.id, v_note.body, 'teen', false, p_hash)
  returning id into v_ans;
  update app_notes set answer_id = v_ans where id = v_note.id;
  perform toi_app_rate_log(p_hash, 'share');
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------- ブラウザ（anon）から呼ぶ。端末は client_hash（web-push.sql の toi_push_hash_ok の形）

-- 今日の問いと設定（開いたときに呼ぶ）。端末の行はここでは作らない
create or replace function app_today(p_client_hash text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  if not toi_push_hash_ok(p_client_hash) then raise exception 'bad_client_hash'; end if;
  update app_devices set last_seen_at = now() where client_hash = p_client_hash;
  return toi_app_today_json(p_client_hash);
end;
$$;

-- 問いを引く（「別の問い」「問いを引く」。LINE の「問い」と打つのと同じ）
create or replace function app_draw(p_client_hash text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare q questions;
begin
  if not toi_push_hash_ok(p_client_hash) then raise exception 'bad_client_hash'; end if;
  if not toi_app_rate_ok(p_client_hash, 'draw') then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  perform toi_app_device(p_client_hash);
  perform toi_app_rate_log(p_client_hash, 'draw');
  q := toi_app_pick(p_client_hash, 'pull');
  if q.id is null then return toi_app_today_json(p_client_hash) || jsonb_build_object('ok', false, 'reason', 'none'); end if;
  return toi_app_today_json(p_client_hash);
end;
$$;

-- 届く頻度とジャンルを決める。ジャンルは居場所のこと（miacis）を除いた themes の id だけ。空なら「ぜんぶ」。
-- 今日の問いが無い・選んだジャンルに合わないときは、1つ引く（LINE の「まずは1つ、どうぞ」と同じ）
create or replace function app_set_prefs(p_client_hash text, p_frequency text, p_themes text[] default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_themes text[];
  d app_devices;
  v_theme text;
begin
  if not toi_push_hash_ok(p_client_hash) then raise exception 'bad_client_hash'; end if;
  if coalesce(p_frequency, '') not in ('daily', 'weekly', 'pull') then raise exception 'bad_frequency'; end if;
  select nullif(array_agg(t.id order by t.sort_order), '{}') into v_themes
    from themes t where t.id = any(coalesce(p_themes, '{}')) and t.id <> 'miacis';
  perform toi_app_device(p_client_hash);
  update app_devices set frequency = p_frequency, themes = v_themes, freq_chosen = true
   where client_hash = p_client_hash returning * into d;
  select q.theme_id into v_theme from questions q where q.id = d.current_question_id and q.approved;
  if d.current_question_id is null or not found or (v_themes is not null and not (coalesce(v_theme, '') = any(v_themes))) then
    perform toi_app_pick(p_client_hash, 'pull');
  end if;
  return toi_app_today_json(p_client_hash);
end;
$$;

-- 答える: ノートに残す。p_share なら、そのまま「みんなに見せる」（未承認の返事）にもする。
-- 相談先が要る言葉は、端末の印を確かめるより先に断る（ノートにも返事にも残さない。画面が相談先を出す）。
-- 断るときは例外ではなく ok=false で返す（回数の記録まで巻き戻らないように）
create or replace function app_answer(p_client_hash text, p_question_id uuid, p_body text, p_share boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_note app_notes;
  v_share jsonb;
begin
  if toi_line_is_sos(v_body) then return jsonb_build_object('ok', false, 'reason', 'sos'); end if;
  if not toi_push_hash_ok(p_client_hash) then raise exception 'bad_client_hash'; end if;
  if v_body = '' then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;
  if char_length(v_body) > 2000 then return jsonb_build_object('ok', false, 'reason', 'too_long'); end if;
  if not exists (select 1 from questions where id = p_question_id and approved) then
    return jsonb_build_object('ok', false, 'reason', 'question');
  end if;
  if not toi_app_rate_ok(p_client_hash, 'note') then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  perform toi_app_device(p_client_hash);
  insert into app_notes (client_hash, question_id, body) values (p_client_hash, p_question_id, v_body) returning * into v_note;
  perform toi_app_rate_log(p_client_hash, 'note');
  if coalesce(p_share, false) then
    v_share := toi_app_share(p_client_hash, v_note.id);
  end if;
  return jsonb_build_object('ok', true, 'note_id', v_note.id, 'share', v_share);
end;
$$;

-- ノートを「みんなに見せる」にする
create or replace function app_share_note(p_client_hash text, p_note_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  if not toi_push_hash_ok(p_client_hash) then raise exception 'bad_client_hash'; end if;
  return toi_app_share(p_client_hash, p_note_id);
end;
$$;

-- 自分のノート（この端末と、引き継ぎで結んだ Safari の分）
create or replace function app_my_notes(p_client_hash text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not toi_push_hash_ok(p_client_hash) then raise exception 'bad_client_hash'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', n.id, 'body', n.body, 'created_at', n.created_at,
      'question_id', n.question_id, 'question_body', q.body,
      'shared', n.answer_id is not null,
      'published', coalesce(a.approved, false))
      order by n.created_at desc)
    from (select * from app_notes where client_hash = any(toi_app_hashes(p_client_hash)) order by created_at desc limit 300) n
    left join questions q on q.id = n.question_id and q.approved
    left join answers a on a.id = n.answer_id), '[]'::jsonb);
end;
$$;

-- ノートを消す（サイトに送った返事は残る。消したいときは運営へ。line_delete_note と同じ）
create or replace function app_delete_note(p_client_hash text, p_note_id uuid) returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  if not toi_push_hash_ok(p_client_hash) then raise exception 'bad_client_hash'; end if;
  delete from app_notes where id = p_note_id and client_hash = any(toi_app_hashes(p_client_hash));
  return found;
end;
$$;

-- ---------------------------------------------------------------- 毎日／週1の今日の問い（毎時の toi_app_tick が question_hour_jst の時に呼ぶ）

create or replace function toi_app_daily() returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  d record;
  q questions;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_n int := 0;
begin
  for d in
    select client_hash from app_devices
     where last_seen_at > now() - interval '30 days'
       and ((frequency = 'daily'  and (last_prompted_on is null or last_prompted_on < v_today))
         or (frequency = 'weekly' and (last_prompted_on is null or last_prompted_on <= v_today - 7)))
     order by last_prompted_on nulls first, created_at
  loop
    q := toi_app_pick(d.client_hash, 'daily');
    if q.id is null then continue; end if;   -- このジャンルで届けられる問いが無い（開けば「問いを引く」が出る）
    update app_devices set last_prompted_on = v_today where client_hash = d.client_hash;
    perform toi_app_push(d.client_hash, 'today');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

create or replace function toi_app_tick() returns int
language plpgsql volatile security definer set search_path = public as $$
declare v_n int := 0;
begin
  if extract(hour from now() at time zone 'Asia/Tokyo')::int = coalesce(toi_push_setting('question_hour_jst'), '19')::int then
    v_n := toi_app_daily();
  end if;
  delete from app_rate where created_at < now() - interval '2 days';
  return v_n;
end;
$$;

-- 毎日／週1を選んだ端末には「新しい問い（question）」を送らない（today に寄せる）。送る列に入る前に落とす
create or replace function toi_app_outbox_filter() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'question' and exists (
    select 1 from push_subscriptions s join app_devices d on d.client_hash = s.client_hash
     where s.endpoint = new.endpoint and d.frequency in ('daily', 'weekly')) then
    return null;
  end if;
  return new;
end;
$$;
drop trigger if exists push_outbox_app_filter on push_outbox;
create trigger push_outbox_app_filter before insert on push_outbox
  for each row execute function toi_app_outbox_filter();

-- ---------------------------------------------------------------- 載った・反応・ほかの返事（line-sync.sql・line-reactions.sql と同じ時点・同じ頻度）

-- 「みんなに見せる」にした答えが載ったら（返事と問いの両方が承認されたとき）
create or replace function toi_app_on_published() returns trigger
language plpgsql security definer set search_path = public as $$
declare n record;
begin
  for n in
    select an.id, an.client_hash from app_notes an
      join new_rows a on a.id = an.answer_id and a.approved
      join questions q on q.id = an.question_id and q.approved
     where not an.published_notified
  loop
    update app_notes set published_notified = true where id = n.id;
    perform toi_app_push(n.client_hash, 'published');
  end loop;
  return null;
end;
$$;

drop trigger if exists app_published_insert on answers;
create trigger app_published_insert after insert on answers
  referencing new table as new_rows for each statement execute function toi_app_on_published();
drop trigger if exists app_published_update on answers;
create trigger app_published_update after update on answers
  referencing new table as new_rows for each statement execute function toi_app_on_published();

-- 載った答えに反応が押されたら（1つの答えにつき1日1通まで。だれが押したかは知らせない）
create or replace function toi_app_on_reaction() returns trigger
language plpgsql security definer set search_path = public as $$
declare n record;
begin
  for n in
    select distinct an.client_hash, an.answer_id
      from new_rows r
      join app_notes an on an.answer_id = r.target_id
      join answers a on a.id = an.answer_id and a.approved
      join questions q on q.id = an.question_id and q.approved
     where r.target_type = 'answer'
       and r.client_hash is distinct from an.client_hash   -- 自分で押した反応は知らせない
  loop
    insert into app_answer_notices (kind, answer_id, client_hash) values ('reaction', n.answer_id, n.client_hash)
    on conflict do nothing;
    if found then perform toi_app_push(n.client_hash, 'reaction'); end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists app_reaction_insert on reactions;
create trigger app_reaction_insert after insert on reactions
  referencing new table as new_rows for each statement execute function toi_app_on_reaction();

-- 答えた（載った）問いに、ほかの人の返事が載ったら（返事1つにつき1通）
create or replace function toi_app_on_other_answer() returns trigger
language plpgsql security definer set search_path = public as $$
declare n record;
begin
  for n in
    select distinct an.client_hash, a.id as answer_id
      from new_rows a
      join questions q on q.id = a.question_id and q.approved
      join app_notes an on an.question_id = a.question_id and an.answer_id is not null and an.answer_id <> a.id
      join answers mine on mine.id = an.answer_id and mine.approved
     where a.approved
       and a.created_at > mine.created_at   -- 自分が答えるより前からある返事は知らせない（読めている）
       and not exists (select 1 from app_notes own where own.answer_id = a.id and own.client_hash = an.client_hash)
  loop
    insert into app_answer_notices (kind, answer_id, client_hash, day) values ('other_answer', n.answer_id, n.client_hash, '2000-01-01')
    on conflict do nothing;   -- day を固定して、返事1つにつき1回だけ
    if found then perform toi_app_push(n.client_hash, 'other_answer'); end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists app_other_answer_insert on answers;
create trigger app_other_answer_insert after insert on answers
  referencing new table as new_rows for each statement execute function toi_app_on_other_answer();
drop trigger if exists app_other_answer_update on answers;
create trigger app_other_answer_update after update on answers
  referencing new table as new_rows for each statement execute function toi_app_on_other_answer();

-- ---------------------------------------------------------------- 権限

revoke execute on function toi_app_hashes(text), toi_app_rate_ok(text, text), toi_app_rate_log(text, text), toi_app_device(text),
  toi_app_push(text, text), toi_app_pick(text, text), toi_app_today_json(text), toi_app_share(text, uuid),
  toi_app_daily(), toi_app_tick(), toi_app_outbox_filter(), toi_app_on_published(), toi_app_on_reaction(), toi_app_on_other_answer()
  from public, anon, authenticated;
revoke execute on function app_today(text), app_draw(text), app_set_prefs(text, text, text[]),
  app_answer(text, uuid, text, boolean), app_share_note(text, uuid), app_my_notes(text), app_delete_note(text, uuid) from public;
grant execute on function app_today(text), app_draw(text), app_set_prefs(text, text, text[]),
  app_answer(text, uuid, text, boolean), app_share_note(text, uuid), app_my_notes(text), app_delete_note(text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------- 毎時0分（JST の question_hour_jst の時に今日の問いを届ける・古い回数の記録を消す）
do $$ begin
  perform cron.schedule('toi-app-hourly', '0 * * * *', 'select public.toi_app_tick()');
exception when others then raise notice '毎時の仕事を pg_cron に組めませんでした: %', sqlerrm;
end $$;
