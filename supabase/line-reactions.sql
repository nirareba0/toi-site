-- LINE から「みんなに見せる」で載った答えに、反応やほかの返事がついたら知らせる（2026-10-16 本人「その回答に反応があったり別の回答を載せてみてその通知が来るか確認したい」）
-- line-sync.sql のあとに流す。何度流しても同じ結果になる。
--
--   反応: サイトで答えに「共感した」「考えさせられた」が押される → その答えを書いた人に LINE で知らせる。1つの答えにつき1日1通まで
--         （反応は匿名で、件数はどこにも出さない。だれが押したかも知らせない。schema.sql の方針のまま）
--   ほかの返事: 自分が答えた問いに、ほかの人の返事が承認されて載る → 知らせる。返事1つにつき1人1通
-- 本文（問い・答え・返事）は LINE に載せない。リンクだけ。

create table if not exists line_answer_notices (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind in ('reaction', 'other_answer')),
  answer_id    uuid not null references answers(id) on delete cascade,  -- reaction: 反応された答え／other_answer: 新しく載った返事
  line_user_id text not null,
  day          date not null default (now() at time zone 'Asia/Tokyo')::date,
  created_at   timestamptz not null default now()
);
create unique index if not exists line_answer_notices_once on line_answer_notices (kind, answer_id, line_user_id, day);
alter table line_answer_notices enable row level security;
revoke all on line_answer_notices from anon, authenticated;

-- 反応が押されたら
create or replace function toi_line_on_reaction() returns trigger
language plpgsql security definer set search_path = public as $$
declare n record;
begin
  for n in
    select distinct ln.line_user_id, ln.question_id, a.id as answer_id
      from new_rows r
      join line_notes ln on ln.answer_id = r.target_id
      join answers a on a.id = ln.answer_id and a.approved
      join questions q on q.id = ln.question_id and q.approved
     where r.target_type = 'answer'
  loop
    insert into line_answer_notices (kind, answer_id, line_user_id) values ('reaction', n.answer_id, n.line_user_id)
    on conflict do nothing;
    if found then
      perform toi_line_push(n.line_user_id, jsonb_build_array(toi_line_text(
        '💬 あなたの答えに、反応が届いたよ（だれが押したかはわかりません）' || chr(10) ||
        toi_line_setting('site_url') || '#question/' || n.question_id)), 'reaction');
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists line_reaction_insert on reactions;
create trigger line_reaction_insert after insert on reactions
  referencing new table as new_rows for each statement execute function toi_line_on_reaction();

-- 自分が答えた問いに、ほかの返事が載ったら
create or replace function toi_line_on_other_answer() returns trigger
language plpgsql security definer set search_path = public as $$
declare n record;
begin
  for n in
    select distinct ln.line_user_id, a.question_id, a.id as answer_id
      from new_rows a
      join questions q on q.id = a.question_id and q.approved
      join line_notes ln on ln.question_id = a.question_id and ln.answer_id is not null and ln.answer_id <> a.id
      join answers mine on mine.id = ln.answer_id and mine.approved
     where a.approved
       and a.created_at > mine.created_at   -- 自分が答えるより前からある返事は知らせない（読めている）
       -- その返事を書いたのが本人なら知らせない
       and not exists (select 1 from line_notes own where own.answer_id = a.id and own.line_user_id = ln.line_user_id)
  loop
    insert into line_answer_notices (kind, answer_id, line_user_id, day) values ('other_answer', n.answer_id, n.line_user_id, '2000-01-01')
    on conflict do nothing;   -- day を固定して、返事1つにつき1回だけ
    if found then
      perform toi_line_push(n.line_user_id, jsonb_build_array(toi_line_text(
        '📮 あなたが答えた問いに、ほかの人の返事が載ったよ' || chr(10) ||
        toi_line_setting('site_url') || '#question/' || n.question_id)), 'other_answer');
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists line_other_answer_insert on answers;
create trigger line_other_answer_insert after insert on answers
  referencing new table as new_rows for each statement execute function toi_line_on_other_answer();
drop trigger if exists line_other_answer_update on answers;
create trigger line_other_answer_update after update on answers
  referencing new table as new_rows for each statement execute function toi_line_on_other_answer();

revoke execute on function toi_line_on_reaction(), toi_line_on_other_answer() from public, anon, authenticated;
