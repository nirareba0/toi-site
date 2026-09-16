-- 問う応える — Supabase スキーマ（初版 2026-09-16）
-- 方針: 投函・返事は匿名で受け、承認（approved）されたものだけを公開する。
--       未承認の行は RLS により匿名ユーザーから一切見えない。承認は管理画面（Table Editor）で行う。

create extension if not exists pgcrypto;

-- テーマ（旧「カテゴリ」）。気分・場面で選べる短い語にする
create table if not exists themes (
  id          text primary key,             -- 'ikikata' など ASCII
  label       text not null,                -- 「生き方」など表示名
  sort_order  int  not null default 100
);

create table if not exists questions (
  id            uuid primary key default gen_random_uuid(),
  body          text not null check (char_length(body) between 1 and 400),
  nickname      text check (char_length(nickname) <= 20),   -- 任意。空なら「だれか」
  theme_id      text references themes(id),
  card_image    text,                                       -- 実物カード画像のパス（assets）。任意
  source        text not null default 'web' check (source in ('web','paper')),
  approved      boolean not null default false,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  client_hash   text                                        -- 連投抑制用（IP や端末の一方向ハッシュ）。個人情報は持たない
);

create table if not exists answers (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid not null references questions(id) on delete cascade,
  body          text not null check (char_length(body) between 1 and 2000),
  nickname      text check (char_length(nickname) <= 20),
  responder_role text check (char_length(responder_role) <= 30),  -- 「地域で働く人」「以前同じことで悩んだ人」など。名前の代わりに立場を出す
  approved      boolean not null default false,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  client_hash   text
);

-- 共感などの軽い反応。匿名・件数のみ
create table if not exists reactions (
  id          bigint generated always as identity primary key,
  target_type text not null check (target_type in ('question','answer')),
  target_id   uuid not null,
  kind        text not null check (kind in ('kyokan','kangaeta')),  -- 共感した / 考えさせられた
  client_hash text,
  created_at  timestamptz not null default now()
);
create unique index if not exists reactions_once on reactions (target_type, target_id, kind, client_hash);

create index if not exists questions_public_idx on questions (approved, created_at desc);
create index if not exists answers_by_question_idx on answers (question_id, approved, created_at);

-- ---- RLS: 匿名（anon）は承認済みだけ読める。投函・返事・反応は insert のみ ----
alter table themes    enable row level security;
alter table questions enable row level security;
alter table answers   enable row level security;
alter table reactions enable row level security;

create policy "themes are public"        on themes    for select to anon, authenticated using (true);
create policy "read approved questions"  on questions for select to anon, authenticated using (approved);
create policy "read approved answers"    on answers   for select to anon, authenticated using (approved);
create policy "read reactions"           on reactions for select to anon, authenticated using (true);

-- 投函: 匿名で insert できるが、approved は必ず false で入る（列は client から送らせない: 下の view/関数経由）
create policy "post a question"          on questions for insert to anon, authenticated with check (approved = false and source = 'web');
create policy "post an answer"           on answers   for insert to anon, authenticated with check (approved = false);
create policy "react"                    on reactions for insert to anon, authenticated with check (true);

-- 公開用ビュー: 件数と最新返事をまとめて 1 クエリで一覧を出す
create or replace view public_questions as
select q.id, q.body, coalesce(nullif(q.nickname,''), 'だれか') as nickname, q.theme_id, t.label as theme_label,
       q.card_image, q.source, q.created_at,
       (select count(*) from answers a where a.question_id = q.id and a.approved) as answer_count
       -- 反応の件数は公開ビューに出さない（人気の比較を作らない。運営の参考値としてテーブルにだけ残す）
from questions q left join themes t on t.id = q.theme_id
where q.approved;

-- 承認は service_role（管理画面）だけ。anon には update/delete のポリシーを作らない。
-- 投函後の状態は公開側では 3 つ: 受けとった（未承認）→ 大人へ渡している（承認済み・返事 0）→ 返事が届いた（返事 1 以上）。

insert into themes (id, label, sort_order) values
 ('ikikata',   '生き方',     10),
 ('ningen',    '人との関係', 20),
 ('gakko',     '学校・勉強', 30),
 ('koi',       '恋・好き',   40),
 ('nichijo',   '日常のモヤモヤ', 50),
 ('miacis',    'Miacis のこと', 60)
on conflict (id) do nothing;
