-- 公式LINE「問う応える」と問いサイトを同期する（2026-10-16 本人「LINEと同期させるシステムを組み切りたい」）
-- 設計: AIOS core/projects/toi-corner/specs/toi-line-sync-20261016.md
--
-- line-notify.sql（返事がきたら知らせる）のあとに流す。何度流しても同じ結果になる。
--
-- できること:
--   LINE → DB   友だち追加・ブロック、トークへの書き込み（＝届いた問いへの答え → 自分だけのノート）、ボタン（次の問い・頻度・みんなに見せる）
--   DB → LINE   トークへの返し（Reply・数えられない）、毎日／週1の問い（Push・cron）、答えがサイトに載った知らせ（Push）
--   サイト ⇄ DB  LINE でログインした人の「自分の問い」と「ノート」を、端末をまたいで同じにする
--
-- しくみ: LINE の Webhook → Edge Function（supabase/functions/line-webhook。本文と署名を渡すだけ）→ line_webhook()。
--   署名の確かめも、返す文も、ここ（DB）でやる。秘密は Vault にだけ置く:
--     line_messaging_token  … Messaging API の長期トークン（line-notify.sql と同じ）
--     line_channel_secret   … Messaging API のチャネルシークレット（Webhook の署名を確かめる）
--   どちらも本人が Dashboard で入れる。Git・Drive に書かない。
--
-- 守ること（specs/toi-line-service-20261011.md §4）:
--   トークは人が読まない。死にたい・消えたいなどの言葉には、仕組みで必ず相談先を返す（ノートにも残さない）。
--   ノートは本人だけ。運営が読むのは「みんなに見せる」を選んだもの（answers に未承認で入る）だけ。
--   LINE から受け取るのは中の ID だけ（名前・アイコンは取らない）。

create extension if not exists pg_cron;

insert into line_settings (key, value) values
  ('liff_id', '2011967281-zFeBIrmq'),
  ('push_monthly_cap', '150'),   -- 毎日／週1の問いを月に何通まで送るか。無料プランは月200通。残りは「返事が届いた」の知らせに取っておく
  ('push_hour_jst', '19')        -- 届く時刻（cron の時刻と合わせる。下の cron.schedule）
on conflict (key) do nothing;

-- LINE から書いた答えを「みんなに見せる」と、この立場で返事に入る（大人の返事と見分けるため）
insert into responder_roles (id, label, sort_order) values ('teen', '中高生', 50)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- 表（どれも非公開。ブラウザからは関数経由でだけ触る）

-- LINE の人。ID は LINE の中の ID（プロバイダー「たいど」の中だけで通じる）だけを持つ
create table if not exists line_users (
  line_user_id        text primary key check (char_length(line_user_id) between 1 and 100),
  frequency           text not null default 'pull' check (frequency in ('daily', 'weekly', 'pull')),  -- pull: こちらからは送らない
  following           boolean not null default false,
  current_question_id uuid references questions(id) on delete set null,  -- いま答えている問い（トークに打った文はこの問いのノートになる）
  current_set_at      timestamptz,
  last_pushed_on      date,                                               -- JST の日付
  created_at          timestamptz not null default now()
);

-- だれが出した問いか（LINE でログインして出した、または「LINE とつなぐ」で結んだもの）
-- 2026-10-16 足した: 届く問いのジャンル（themes.id の配列。null＝ぜんぶ）と、頻度を一度選んだか
-- 本人「登録したときに考えたい問のジャンルとかも答えさせてそのジャンルからしかこないようにしたい」
alter table line_users add column if not exists themes text[];
alter table line_users add column if not exists freq_chosen boolean not null default false;

create table if not exists line_question_owners (
  question_id  uuid primary key references questions(id) on delete cascade,
  line_user_id text not null references line_users(line_user_id) on delete cascade,
  created_at   timestamptz not null default now()
);
create index if not exists line_question_owners_user on line_question_owners (line_user_id);

-- 自分だけのノート（届いた問いに LINE で答えたもの）
create table if not exists line_notes (
  id                 uuid primary key default gen_random_uuid(),
  line_user_id       text not null references line_users(line_user_id) on delete cascade,
  question_id        uuid references questions(id) on delete set null,
  body               text not null check (char_length(body) between 1 and 2000),
  answer_id          uuid references answers(id) on delete set null,   -- 「みんなに見せる」を選んだら、その返事
  published_notified boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists line_notes_user on line_notes (line_user_id, created_at desc);
create index if not exists line_notes_answer on line_notes (answer_id) where answer_id is not null;

-- 届けた問い（同じ問いを続けて届けないため）
create table if not exists line_prompts (
  id           bigint generated always as identity primary key,
  line_user_id text not null references line_users(line_user_id) on delete cascade,
  question_id  uuid not null references questions(id) on delete cascade,
  via          text not null check (via in ('push', 'reply')),
  created_at   timestamptz not null default now()
);
create index if not exists line_prompts_user on line_prompts (line_user_id, question_id);

-- こちらから送った（Push）記録。月の上限を数える
create table if not exists line_pushes (
  id           bigint generated always as identity primary key,
  line_user_id text not null,
  kind         text not null,                                  -- prompt / published
  status       text not null check (status in ('sent', 'no_token', 'failed', 'capped')),
  request_id   bigint,
  created_at   timestamptz not null default now()
);

-- 受け取った Webhook のイベント（LINE が送り直してきても二重に扱わない）
create table if not exists line_events_seen (
  event_id   text primary key,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['line_users', 'line_question_owners', 'line_notes', 'line_prompts', 'line_pushes', 'line_events_seen'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- LINE に送る

-- Messaging API を呼ぶ（pg_net。待たない）。p_path は 'push' か 'reply'。{status, request_id} を返す
create or replace function toi_line_api(p_path text, p_body jsonb) returns jsonb
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
    url := 'https://api.line.me/v2/bot/message/' || p_path,
    body := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token)
  ) into v_req;
  return jsonb_build_object('status', 'sent', 'request_id', v_req);
exception when others then
  return jsonb_build_object('status', 'failed');
end;
$$;

-- トークへの返し（Reply は月の通数に数えられない）
create or replace function toi_line_reply(p_reply_token text, p_messages jsonb) returns jsonb
language sql volatile security definer set search_path = public as $$
  select toi_line_api('reply', jsonb_build_object('replyToken', p_reply_token, 'messages', p_messages));
$$;

-- こちらから送る（Push。月の上限を超えたら送らない）
create or replace function toi_line_push(p_to text, p_messages jsonb, p_kind text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_cap int;
  v_used int;
  v_res jsonb;
begin
  select value::int into v_cap from line_settings where key = 'push_monthly_cap';
  select count(*) into v_used from line_pushes
   where status = 'sent' and created_at >= (date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo');
  if v_used >= coalesce(v_cap, 150) then
    insert into line_pushes (line_user_id, kind, status) values (p_to, p_kind, 'capped');
    return 'capped';
  end if;
  v_res := toi_line_api('push', jsonb_build_object('to', p_to, 'messages', p_messages));
  insert into line_pushes (line_user_id, kind, status, request_id)
  values (p_to, p_kind, v_res->>'status', (v_res->>'request_id')::bigint);
  return v_res->>'status';
end;
$$;

-- ---------------------------------------------------------------- 送る文

create or replace function toi_line_setting(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select value from line_settings where key = p_key;
$$;

-- サイトを LINE の中で開くリンク（view: notes / inbox）
create or replace function toi_line_liff_url(p_view text) returns text
language sql stable security definer set search_path = public as $$
  select 'https://liff.line.me/' || toi_line_setting('liff_id') || '?view=' || p_view;
$$;

create or replace function toi_line_qr_postback(p_label text, p_data text, p_display text default null) returns jsonb
language sql immutable as $$
  select jsonb_build_object('type', 'action', 'action',
    jsonb_strip_nulls(jsonb_build_object('type', 'postback', 'label', p_label, 'data', p_data, 'displayText', coalesce(p_display, p_label))));
$$;

create or replace function toi_line_qr_uri(p_label text, p_uri text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('type', 'action', 'action', jsonb_build_object('type', 'uri', 'label', p_label, 'uri', p_uri));
$$;

-- 文1つ（クイックリプライのボタンは任意。13個まで）
create or replace function toi_line_text(p_text text, p_items jsonb default null) returns jsonb
language sql immutable as $$
  select case when p_items is null or jsonb_array_length(p_items) = 0
    then jsonb_build_object('type', 'text', 'text', p_text)
    else jsonb_build_object('type', 'text', 'text', p_text, 'quickReply', jsonb_build_object('items', p_items)) end;
$$;

create or replace function toi_line_freq_items() returns jsonb
language sql immutable as $$
  select jsonb_build_array(
    toi_line_qr_postback('毎日', 'a=freq&v=daily', '毎日とどけて'),
    toi_line_qr_postback('週に1回', 'a=freq&v=weekly', '週に1回とどけて'),
    toi_line_qr_postback('自分で引くだけ', 'a=freq&v=pull', '自分で引く'));
$$;

-- 死にたい・消えたいなどの言葉（ひらがな・カタカナの書き方も。広めに拾う。外れても相談先を返すだけ）
create or replace function toi_line_is_sos(p_text text) returns boolean
language sql immutable as $$
  select p_text ~ '(死にたい|しにたい|シニタイ|死のう|しのう|消えたい|きえたい|キエタイ|いなくなりたい|生きたくない|いきたくない|生きてる意味|自殺|じさつ|自傷|リスカ|りすか|殺し|ころし|殺す|ころす|殴られ|なぐられ|虐待|ぎゃくたい|いじめられ|イジメられ|消えてしまいたい|もう無理|もうむり)';
$$;

create or replace function toi_line_sos_message() returns jsonb
language sql immutable as $$
  select toi_line_text(
    'このトークは、人が読んでいません。' || chr(10) ||
    'いま、つらい気持ちを抱えているなら、話を聞いてくれる人につないでください。' || chr(10) || chr(10) ||
    '・24時間子供SOSダイヤル 0120-0-78310（いつでも・無料）' || chr(10) ||
    '・チャイルドライン 0120-99-7777（毎日16時〜21時・無料）' || chr(10) || chr(10) ||
    '近くの信頼できる大人に話すのも、立派な一歩です。');
$$;

-- 問いを1つ選んで「いま答えている問い」にする。まだ届けていない承認済みの問いから。全部届けたら、いちばん前に届けたもの
-- ジャンルを選んだ人には、そのジャンルの問いだけ（ジャンルの無い問いは届かない）
create or replace function toi_line_pick(p_sub text, p_via text) returns questions
language plpgsql volatile security definer set search_path = public as $$
declare
  q questions;
  v_themes text[];
begin
  select themes into v_themes from line_users where line_user_id = p_sub;
  select * into q from questions qq
   where qq.approved and not toi_line_is_sos(qq.body)
     and (v_themes is null or qq.theme_id = any(v_themes))
     and not exists (select 1 from line_prompts p where p.line_user_id = p_sub and p.question_id = qq.id)
     and not exists (select 1 from line_question_owners o where o.question_id = qq.id and o.line_user_id = p_sub)
   order by random() limit 1;
  if q.id is null then
    select qq.* into q from questions qq
      join (select question_id, max(created_at) as last_at from line_prompts where line_user_id = p_sub group by question_id) p
        on p.question_id = qq.id
     where qq.approved and (v_themes is null or qq.theme_id = any(v_themes))
     order by p.last_at limit 1;
  end if;
  if q.id is null then return null; end if;
  insert into line_prompts (line_user_id, question_id, via) values (p_sub, q.id, p_via);
  update line_users set current_question_id = q.id, current_set_at = now() where line_user_id = p_sub;
  return q;
end;
$$;

drop function if exists toi_line_prompt_message(text, text);   -- 2026-10-16 ジャンルの引数を足したので、古い形を消す（重なると呼び分けられない）
create or replace function toi_line_prompt_message(p_body text, p_title text default '今日の問い', p_theme text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select toi_line_text(
    '🌱 ' || p_title || coalesce('（' || (select label from themes where id = p_theme) || '）', '') || chr(10) || chr(10) ||
    '「' || p_body || '」' || chr(10) || chr(10) ||
    '思ったことを、このトークにそのまま打ってみて。あなただけのノートに残ります（自分で「みんなに見せる」を選ばないかぎり、だれにも見せません）。',
    jsonb_build_array(
      toi_line_qr_postback('別の問い', 'a=next', '別の問いにする'),
      toi_line_qr_uri('ノートを見る', toi_line_liff_url('notes')),
      toi_line_qr_postback('ジャンル', 'a=genreask', 'ジャンルを変えたい'),
      toi_line_qr_postback('届く頻度', 'a=freqask', '届く頻度を変えたい')));
$$;

-- ジャンルを選ぶボタン（押すたびに入れる／外す。選んでいるものに ✓）。Miacis のことは館の中の話なので出さない
create or replace function toi_line_genre_items(p_sub text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(toi_line_qr_postback(
           case when t.id = any(coalesce(u.themes, '{}')) then '✓ ' else '' end || t.label,
           'a=genre&t=' || t.id, t.label) order by t.sort_order), '[]'::jsonb)
         || jsonb_build_array(
           toi_line_qr_postback('ぜんぶ', 'a=genre&t=all', 'ぜんぶのジャンル'),
           toi_line_qr_postback('これで決める', 'a=genredone', 'これで決める'))
    from themes t left join line_users u on u.line_user_id = p_sub
   where t.id <> 'miacis';
$$;

create or replace function toi_line_genre_now(p_sub text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select string_agg(t.label, '・' order by t.sort_order)
                     from line_users u join themes t on t.id = any(u.themes)
                    where u.line_user_id = p_sub), 'ぜんぶ');
$$;

create or replace function toi_line_genre_message(p_sub text, p_head text default '') returns jsonb
language sql stable security definer set search_path = public as $$
  select toi_line_text(p_head ||
    '考えたい問いのジャンルを選んでね（いくつでも。押すたびに入れる／外す）。' || chr(10) ||
    'いま：' || toi_line_genre_now(p_sub) || chr(10) || '選んだら「これで決める」。',
    toi_line_genre_items(p_sub));
$$;

-- 問いを引いて、その文を返す（無ければ「まだ無い」）
create or replace function toi_line_next_prompt(p_sub text, p_via text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare q questions;
begin
  q := toi_line_pick(p_sub, p_via);
  if q.id is null then
    return toi_line_text('このジャンルで届けられる問いが、いまはありません。ジャンルを足すか、サイトで問いを出してみてね' || chr(10) || toi_line_setting('site_url'),
      jsonb_build_array(toi_line_qr_postback('ジャンル', 'a=genreask', 'ジャンルを変えたい')));
  end if;
  return toi_line_prompt_message(q.body, '今日の問い', q.theme_id);
end;
$$;

-- ---------------------------------------------------------------- Webhook

-- 署名（x-line-signature）を確かめる: チャネルシークレットで本文の HMAC-SHA256 を取り、base64 で比べる
create or replace function toi_line_signature_ok(p_body text, p_signature text) returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'line_channel_secret';
  if coalesce(v_secret, '') = '' or coalesce(p_signature, '') = '' then return false; end if;
  return encode(extensions.hmac(convert_to(p_body, 'UTF8'), convert_to(v_secret, 'UTF8'), 'sha256'), 'base64') = p_signature;
end;
$$;

-- postback の data（a=freq&v=daily のような形）から1つ取り出す
create or replace function toi_line_param(p_data text, p_key text) returns text
language sql immutable as $$
  select split_part(kv, '=', 2) from unnest(string_to_array(coalesce(p_data, ''), '&')) as kv
   where split_part(kv, '=', 1) = p_key limit 1;
$$;

-- イベント1つを扱って、返す文（配列）を返す。返さないときは null
create or replace function toi_line_handle_event(e jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_sub  text := e->'source'->>'userId';
  v_type text := e->>'type';
  v_text text;
  v_data text;
  v_user line_users;
  v_note line_notes;
  v_q    questions;
  v_ans  uuid;
  v_freq text;
begin
  if coalesce(v_sub, '') = '' or e->'source'->>'type' is distinct from 'user' then
    return null;   -- グループ・トークルームには入らない
  end if;

  if v_type = 'unfollow' then
    update line_users set following = false where line_user_id = v_sub;
    return null;
  end if;

  -- 友だち追加・書き込み・ボタン（どれも友だちでないとできない）→ 友だち
  insert into line_users (line_user_id, following) values (v_sub, true)
  on conflict (line_user_id) do update set following = true;
  select * into v_user from line_users where line_user_id = v_sub;

  if v_type = 'follow' then
    return jsonb_build_array(toi_line_text(
      '友だち追加ありがとう。「問う応える」です（運営 たいど）。' || chr(10) || chr(10) ||
      'ここには「問い」が届きます。答えをこのトークに打つと、あなただけのノートに残ります。' ||
      'このトークは人が読んでいません。ほかの人の問いと大人の返事はサイトで読めます。' || chr(10) ||
      toi_line_setting('site_url') || chr(10) || chr(10) ||
      'はじめに、考えたい問いのジャンルを選んでね（あとで変えられます）。'),
      toi_line_genre_message(v_sub));
  end if;

  if v_type = 'postback' then
    v_data := e->'postback'->>'data';
    case toi_line_param(v_data, 'a')
      when 'next' then
        return jsonb_build_array(toi_line_next_prompt(v_sub, 'reply'));
      when 'freqask' then
        return jsonb_build_array(toi_line_text('問いが届く頻度を選んでね。', toi_line_freq_items()));
      when 'genreask' then
        return jsonb_build_array(toi_line_genre_message(v_sub));
      when 'genre' then
        v_freq := toi_line_param(v_data, 't');   -- ここではジャンルの id
        if v_freq = 'all' then
          update line_users set themes = null where line_user_id = v_sub;
          v_data := 'a=genredone';               -- 「ぜんぶ」は、そのまま決める
        elsif exists (select 1 from themes where id = v_freq and id <> 'miacis') then
          update line_users
             set themes = nullif(case when v_freq = any(coalesce(themes, '{}')) then array_remove(themes, v_freq)
                                      else array_append(coalesce(themes, '{}'), v_freq) end, '{}')
           where line_user_id = v_sub;
          return jsonb_build_array(toi_line_genre_message(v_sub));
        else
          return null;
        end if;
      else
        null;   -- 下の case で扱う
    end case;
    case toi_line_param(v_data, 'a')
      when 'genredone' then
        select * into v_user from line_users where line_user_id = v_sub;
        if not v_user.freq_chosen then
          return jsonb_build_array(
            toi_line_text('届く問いのジャンル：' || toi_line_genre_now(v_sub) || chr(10) || '（「ジャンル」と打つと、いつでも変えられます）'),
            toi_line_text('つぎに、問いが届く頻度を選んでね。', toi_line_freq_items()));
        end if;
        return jsonb_build_array(
          toi_line_text('届く問いのジャンル：' || toi_line_genre_now(v_sub) || chr(10) || 'さっそく1つ、どうぞ。'),
          toi_line_next_prompt(v_sub, 'reply'));
      when 'freq' then
        v_freq := toi_line_param(v_data, 'v');
        if v_freq is null or v_freq not in ('daily', 'weekly', 'pull') then return null; end if;
        update line_users set frequency = v_freq, freq_chosen = true where line_user_id = v_sub;
        return jsonb_build_array(
          toi_line_text(case v_freq
            when 'daily'  then '毎日 ' || toi_line_setting('push_hour_jst') || '時ごろに、問いが1つ届きます。'
            when 'weekly' then '週に1回、' || toi_line_setting('push_hour_jst') || '時ごろに問いが1つ届きます。'
            else 'こちらからは送りません。「問い」と打つと、いつでも1つ届きます。' end
            || chr(10) || 'まずは1つ、どうぞ。'),
          toi_line_next_prompt(v_sub, 'reply'));
      when 'share' then
        select * into v_note from line_notes
         where id = nullif(toi_line_param(v_data, 'n'), '')::uuid and line_user_id = v_sub;
        if v_note.id is null then return null; end if;
        if v_note.answer_id is not null then
          return jsonb_build_array(toi_line_text('この答えは、もうサイトに送ってあります。'));
        end if;
        select * into v_q from questions where id = v_note.question_id and approved;
        if v_q.id is null or toi_line_is_sos(v_note.body) then
          return jsonb_build_array(toi_line_text('この答えはサイトに送れませんでした。'));
        end if;
        insert into answers (question_id, body, role_id, approved, client_hash)
        values (v_q.id, v_note.body, 'teen', false, 'line')
        returning id into v_ans;
        update line_notes set answer_id = v_ans where id = v_note.id;
        return jsonb_build_array(toi_line_text(
          'サイトに送りました。スタッフが確かめてから、その問いの下に「中高生」として載ります（名前は出ません）。載ったら知らせます。'));
      else
        return null;
    end case;
  end if;

  if v_type = 'message' then
    if e->'message'->>'type' is distinct from 'text' then
      return jsonb_build_array(toi_line_text('ここでは文字だけ受け取れます。「問い」と打つと、問いが1つ届きます。',
        jsonb_build_array(toi_line_qr_postback('問いを引く', 'a=next', '問いを引く'))));
    end if;
    v_text := btrim(e->'message'->>'text');
    if v_text = '' then return null; end if;

    -- 相談先は、何より先に、必ず返す。ノートには残さない
    if toi_line_is_sos(v_text) then
      return jsonb_build_array(toi_line_sos_message());
    end if;

    if v_text in ('問い', 'とい', '今日の問い', 'きょうの問い', '問いを引く', '次の問い', '別の問い') then
      return jsonb_build_array(toi_line_next_prompt(v_sub, 'reply'));
    end if;
    if v_text in ('頻度', '届く頻度', '設定') then
      return jsonb_build_array(toi_line_text('問いが届く頻度を選んでね。', toi_line_freq_items()));
    end if;
    if v_text in ('ジャンル', 'じゃんる', 'ジャンルを変える') then
      return jsonb_build_array(toi_line_genre_message(v_sub));
    end if;
    if v_text in ('ノート', '自分のノート') then
      return jsonb_build_array(toi_line_text('あなたのノートはここで読めます（LINE でログインした本人だけ）。' || chr(10) || toi_line_liff_url('notes')));
    end if;

    -- 答えている問いが無い（または3日より前）→ 問いを引くように
    if v_user.current_question_id is null or v_user.current_set_at < now() - interval '3 days' then
      return jsonb_build_array(toi_line_text(
        '問いに答えると、ここに打った文があなただけのノートに残ります。まず問いを1つ引いてみて。',
        jsonb_build_array(toi_line_qr_postback('問いを引く', 'a=next', '問いを引く'))));
    end if;

    -- 同じ問いに10分以内に続けて打ったら、1つのノートに続けて書く（まだ見せていないものだけ）
    select * into v_note from line_notes
     where line_user_id = v_sub and question_id = v_user.current_question_id and answer_id is null
       and updated_at > now() - interval '10 minutes'
     order by updated_at desc limit 1;
    if v_note.id is not null and char_length(v_note.body) + 1 + char_length(v_text) <= 2000 then
      update line_notes set body = body || chr(10) || v_text, updated_at = now() where id = v_note.id;
      v_freq := 'つづき';   -- ここでは「続けて書いた」の印
    else
      insert into line_notes (line_user_id, question_id, body)
      values (v_sub, v_user.current_question_id, left(v_text, 2000))
      returning * into v_note;
    end if;

    -- 途中で送ってしまっても、続きをそのまま送れば同じノートにつながる（本人「途中で送ってしまった場合コピーして続きからかける旨もメッセージに」）
    return jsonb_build_array(toi_line_text(
      case when v_freq = 'つづき' then 'ノートの続きに書き足しました。' else 'ノートに残しました。' end || chr(10) ||
      '途中で送ってしまっても大丈夫。10分以内なら、続きをそのまま送ると同じノートにつながります（送った文は長押しでコピーして、直して送り直すこともできます）。' || chr(10) ||
      'ほかの人にも読んでほしいときは「みんなに見せる」を押してね（スタッフが確かめてから、サイトに名前なしで載ります）。',
      jsonb_build_array(
        toi_line_qr_postback('みんなに見せる', 'a=share&n=' || v_note.id, 'みんなに見せる'),
        toi_line_qr_postback('次の問い', 'a=next', '次の問い'),
        toi_line_qr_uri('ノートを見る', toi_line_liff_url('notes')))));
  end if;

  return null;
end;
$$;

-- Edge Function（supabase/functions/line-webhook）が呼ぶ。本文はそのまま（署名を確かめるため）。扱ったイベントの数を返す
create or replace function line_webhook(p_body text, p_signature text) returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  e jsonb;
  v_msgs jsonb;
  v_done int := 0;
begin
  if not toi_line_signature_ok(p_body, p_signature) then
    raise exception 'bad_signature';
  end if;
  for e in select * from jsonb_array_elements(coalesce(p_body::jsonb->'events', '[]'::jsonb)) loop
    -- 送り直されたイベントは1回だけ
    if e ? 'webhookEventId' then
      insert into line_events_seen (event_id) values (e->>'webhookEventId') on conflict do nothing;
      if not found then continue; end if;
    end if;
    if e->>'mode' = 'standby' then continue; end if;
    begin
      v_msgs := toi_line_handle_event(e);
      if v_msgs is not null and coalesce(e->>'replyToken', '') <> '' then
        perform toi_line_reply(e->>'replyToken', v_msgs);
      end if;
      v_done := v_done + 1;
    exception when others then
      raise warning 'line_webhook: % %', e->>'type', sqlerrm;   -- 1件の失敗で、ほかのイベントを落とさない
    end;
  end loop;
  return v_done;
end;
$$;

-- ---------------------------------------------------------------- 毎日／週1の問い（pg_cron が1日1回呼ぶ）

create or replace function toi_line_daily() returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  u record;
  q questions;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_status text;
  v_sent int := 0;
begin
  for u in
    select line_user_id from line_users
     where following
       and ((frequency = 'daily'  and (last_pushed_on is null or last_pushed_on < v_today))
         or (frequency = 'weekly' and (last_pushed_on is null or last_pushed_on <= v_today - 7)))
     order by last_pushed_on nulls first, created_at
  loop
    q := toi_line_pick(u.line_user_id, 'push');
    if q.id is null then exit; end if;
    v_status := toi_line_push(u.line_user_id, jsonb_build_array(toi_line_prompt_message(q.body, '今日の問い', q.theme_id)), 'prompt');
    if v_status = 'capped' then exit; end if;   -- 月の上限。残りの人は来月（「問い」と打てば引ける）
    update line_users set last_pushed_on = v_today where line_user_id = u.line_user_id;
    if v_status = 'sent' then v_sent := v_sent + 1; end if;
  end loop;
  delete from line_events_seen where created_at < now() - interval '7 days';
  return v_sent;
end;
$$;

-- ---------------------------------------------------------------- 「みんなに見せる」がサイトに載ったら知らせる

create or replace function toi_line_on_published() returns trigger
language plpgsql security definer set search_path = public as $$
declare n record;
begin
  for n in
    select ln.id, ln.line_user_id, ln.question_id from line_notes ln
      join new_rows a on a.id = ln.answer_id and a.approved
      join questions q on q.id = ln.question_id and q.approved
     where not ln.published_notified
  loop
    update line_notes set published_notified = true where id = n.id;
    perform toi_line_push(n.line_user_id, jsonb_build_array(toi_line_text(
      '🎉 あなたの答えが、サイトに載りました！' || chr(10) || toi_line_setting('site_url') || '#question/' || n.question_id)), 'published');
  end loop;
  return null;
end;
$$;

drop trigger if exists line_published_insert on answers;
create trigger line_published_insert after insert on answers
  referencing new table as new_rows for each statement execute function toi_line_on_published();
drop trigger if exists line_published_update on answers;
create trigger line_published_update after update on answers
  referencing new table as new_rows for each statement execute function toi_line_on_published();

-- ---------------------------------------------------------------- サイトから呼ぶ（LINE の ID トークンで本人を確かめる）

-- この端末で出した問いを、LINE の人に結ぶ。端末の印（client_hash。ブラウザからは読めない列）が合う問いだけ。
-- 結んだ問いは、返事がきたら LINE で知らせる（watch と同じ。結ぶ前からある返事は知らせない）
create or replace function line_link_questions(p_id_token text, p_ids uuid[], p_client_hash text) returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  v_sub text;
  v_n int;
begin
  v_sub := toi_line_verify(p_id_token);
  if coalesce(p_client_hash, '') = '' or coalesce(array_length(p_ids, 1), 0) = 0 then return 0; end if;
  if array_length(p_ids, 1) > 200 then raise exception 'too_many_questions'; end if;
  insert into line_users (line_user_id) values (v_sub) on conflict do nothing;
  insert into line_question_owners (question_id, line_user_id)
  select q.id, v_sub from questions q
   where q.id = any(p_ids) and q.client_hash = p_client_hash
  on conflict (question_id) do nothing;
  get diagnostics v_n = row_count;
  insert into line_watches (question_id, line_user_id)
  select o.question_id, v_sub from line_question_owners o where o.line_user_id = v_sub and o.question_id = any(p_ids)
  on conflict do nothing;
  insert into line_notices (answer_id, line_user_id, status)
  select a.id, v_sub, 'skipped' from answers a
    join line_question_owners o on o.question_id = a.question_id and o.line_user_id = v_sub
   where a.question_id = any(p_ids) and a.approved
  on conflict (answer_id, line_user_id) do nothing;
  return v_n;
end;
$$;

-- LINE の人が出した問い（まだ確認中のものも、本人には見せる）
create or replace function line_my_questions(p_id_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_sub text;
begin
  v_sub := toi_line_verify(p_id_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', q.id, 'body', q.body, 'nickname', q.nickname, 'theme_id', q.theme_id, 'theme_label', t.label,
      'approved', q.approved, 'created_at', q.created_at,
      'answer_count', (select count(*) from answers a where a.question_id = q.id and a.approved))
      order by q.created_at desc)
    from line_question_owners o join questions q on q.id = o.question_id left join themes t on t.id = q.theme_id
    where o.line_user_id = v_sub), '[]'::jsonb);
end;
$$;

-- 自分のノート
create or replace function line_my_notes(p_id_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_sub text;
begin
  v_sub := toi_line_verify(p_id_token);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', n.id, 'body', n.body, 'created_at', n.created_at,
      'question_id', n.question_id, 'question_body', q.body,
      'shared', n.answer_id is not null,
      'published', coalesce(a.approved, false))
      order by n.created_at desc)
    from (select * from line_notes where line_user_id = v_sub order by created_at desc limit 300) n
    left join questions q on q.id = n.question_id
    left join answers a on a.id = n.answer_id), '[]'::jsonb);
end;
$$;

-- ノートを消す（サイトに送った返事は残る。消したいときは運営へ）
create or replace function line_delete_note(p_id_token text, p_note_id uuid) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare v_sub text;
begin
  v_sub := toi_line_verify(p_id_token);
  delete from line_notes where id = p_note_id and line_user_id = v_sub;
  return found;
end;
$$;

-- ---------------------------------------------------------------- 権限

revoke execute on function toi_line_api(text, jsonb), toi_line_reply(text, jsonb), toi_line_push(text, jsonb, text),
  toi_line_setting(text), toi_line_liff_url(text), toi_line_pick(text, text), toi_line_prompt_message(text, text, text), toi_line_genre_items(text), toi_line_genre_now(text), toi_line_genre_message(text, text),
  toi_line_next_prompt(text, text), toi_line_signature_ok(text, text), toi_line_handle_event(jsonb),
  toi_line_daily(), toi_line_on_published(), line_webhook(text, text)
  from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function line_webhook(text, text) to service_role;
  end if;
end $$;
revoke execute on function line_link_questions(text, uuid[], text), line_my_questions(text), line_my_notes(text),
  line_delete_note(text, uuid) from public;
grant execute on function line_link_questions(text, uuid[], text), line_my_questions(text), line_my_notes(text),
  line_delete_note(text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------- 1日1回（JST 19:00 = UTC 10:00）。push_hour_jst を変えたらここも
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('toi-line-daily', '0 10 * * *', 'select public.toi_line_daily()');
  end if;
end $$;
