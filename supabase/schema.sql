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
  source        text not null default 'web' check (source in ('web','paper','podcast')),
  credit        text,                                       -- 外部から借りた問いの出典（例: 番組名）。公開ビューに出す
  approved      boolean not null default false,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  client_hash   text                                        -- 連投抑制用（IP や端末の一方向ハッシュ）。個人情報は持たない
);

create table if not exists answers (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid not null references questions(id) on delete cascade,
  card_image    text,                                       -- 返事が書かれた実物カード画像のパス（非公開バケット）。公開ビューには出さない
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

drop policy if exists "themes are public" on themes;
create policy "themes are public" on themes    for select to anon, authenticated using (true);
drop policy if exists "read approved questions" on questions;
create policy "read approved questions" on questions for select to anon, authenticated using (approved);
drop policy if exists "read approved answers" on answers;
create policy "read approved answers" on answers   for select to anon, authenticated using (approved);
drop policy if exists "read reactions" on reactions;
create policy "read reactions" on reactions for select to anon, authenticated using (true);

-- 投函: 匿名で insert できるが、approved は必ず false で入る（列は client から送らせない: 下の view/関数経由）
drop policy if exists "post a question" on questions;
create policy "post a question" on questions for insert to anon, authenticated with check (approved = false and source = 'web');
drop policy if exists "post an answer" on answers;
create policy "post an answer" on answers   for insert to anon, authenticated with check (approved = false);
drop policy if exists "react" on reactions;
create policy "react" on reactions for insert to anon, authenticated with check (true);

-- 公開用ビュー: 件数と最新返事をまとめて 1 クエリで一覧を出す
-- 実物カード画像（card_image）は非公開のため公開ビューには含めない
create or replace view public_questions as
select q.id, q.body, coalesce(nullif(q.nickname,''), 'だれか') as nickname, q.theme_id, q.credit, t.label as theme_label,
       q.source, q.created_at,
       (select count(*) from answers a where a.question_id = q.id and a.approved) as answer_count
       -- 反応の件数は公開ビューに出さない（人気の比較を作らない。運営の参考値としてテーブルにだけ残す）
from questions q left join themes t on t.id = q.theme_id
where q.approved;

-- 公開用ビュー: 承認済みの返事のみ公開する
-- 個人情報保護のため回答者の氏名・ニックネーム（nickname）は含めず、立場（responder_role）のみを公開する
create or replace view public_answers as
select a.id, a.question_id, a.body, a.responder_role, a.created_at
from answers a
where a.approved;

-- 実物カード画像（スキャンJPG）保存用プライベートバケット
insert into storage.buckets (id, name, public)
values ('cards', 'cards', false)
on conflict (id) do nothing;
-- バケット 'cards' は public = false (private) として作成。
-- storage.objects に対する anon の select ポリシーは定義しないため、匿名ユーザー (anon) からは直接取得できない。
-- 運営スタッフ確認時は service_role または署名付き URL (createSignedUrl) を都度発行して閲覧する想定。

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

-- ---- 列単位の権限: 匿名には公開ビューに出る列しか渡さない ----
-- ビュー（public_questions / public_answers）はビュー所有者の権限で動くため、
-- ここで anon の列権限を絞ってもビュー経由の閲覧は壊れない。
-- 逆に、これが無いと anon キーで /rest/v1/answers?select=nickname を叩いて氏名が取れてしまう。
revoke select on questions from anon;
grant  select (id, body, nickname, theme_id, source, approved, created_at) on questions to anon;
-- 渡さない列: card_image（非公開バケットのパス）, client_hash, approved_at

revoke select on answers from anon;
grant  select (id, question_id, body, responder_role, approved, created_at) on answers to anon;
-- 渡さない列: nickname（回答者の氏名）, card_image, client_hash, approved_at

revoke select on reactions from anon;
grant  select (id, target_type, target_id, kind, created_at) on reactions to anon;
-- 渡さない列: client_hash

-- ---- 回答者の「立場」はタグだけにする（氏名を入れられないようにする） ----
-- 自由文のままだと、また名前が入る。許可したタグの一覧を持ち、answers はそこを参照する。
create table if not exists responder_roles (
  id          text primary key,     -- 'staff' など ASCII
  label       text not null,        -- 「Miacis のスタッフ」など表示名
  sort_order  int  not null default 100
);

insert into responder_roles (id, label, sort_order) values
  ('staff',       'Miacis のスタッフ',     10),
  ('adult-staff', 'Miacis の大人スタッフ', 20),
  ('univ-staff',  '大学生スタッフ',        30),
  ('univ',        '大学生',                40),
  ('anon',        '匿名',                  90)
on conflict (id) do update set label = excluded.label, sort_order = excluded.sort_order;

alter table answers add column if not exists role_id      text references responder_roles(id);
alter table answers add column if not exists ai_assisted  boolean not null default false;
-- responder_role（自由文）は移行のため残すが、公開ビューは role_id 側だけを見る。

alter table responder_roles enable row level security;
drop policy if exists "roles are public" on responder_roles;
create policy "roles are public" on responder_roles for select to anon, authenticated using (true);

-- 公開ビューを貼り替え: 表示する肩書きはタグの label のみ。氏名は出しようがない。
drop view if exists public_answers;
create view public_answers as
select a.id, a.question_id, a.body,
       coalesce(r.label, '匿名') as responder_role,
       a.ai_assisted,
       a.created_at
from answers a left join responder_roles r on r.id = a.role_id
where a.approved;

revoke select on responder_roles from anon;
grant  select (id, label, sort_order) on responder_roles to anon;
