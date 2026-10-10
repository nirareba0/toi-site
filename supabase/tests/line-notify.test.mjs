// supabase/line-notify.sql: 問いに返事がきたら LINE で知らせる
// 本物の Supabase の代わりに PGlite で schema.sql → line-notify.sql を流し、LINE との通信だけ差し替える。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, '..', f), 'utf8');
let db;

const admin = async (sql, params = []) => (await db.query(sql, params)).rows;
async function anon(sql, params = []) {
  await db.exec('set role anon');
  try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); }
}
const rejects = (p, code) => assert.rejects(p, (e) => e.message.includes(code));
const sent = async () => (await admin('select to_user, body from sent order by id')).map((r) => [r.to_user, r.body]);
const watch = (q, sub) => anon('select watch_question($1, $2) as r', [q, `line-${sub}`]);

async function question(approved = true) {
  return (await admin('insert into questions (body, approved) values ($1, $2) returning id', ['なぜ空は青い？', approved]))[0].id;
}
async function answer(q, approved = true) {
  return (await admin('insert into answers (question_id, body, approved) values ($1, $2, $3) returning id', [q, '光が散らばるから', approved]))[0].id;
}

before(async () => {
  db = new PGlite();
  // Supabase にあるものの代わり（役割・storage・既定の権限）
  await db.exec(`
    create role anon; create role authenticated;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
    create schema storage; create table storage.buckets (id text primary key, name text, public boolean);
  `);
  await db.exec(read('schema.sql').replace(/^create extension .*$/gm, ''));
  await db.exec(read('line-notify.sql').replace(/^create extension .*$/gm, ''));
  // LINE との通信を差し替える: "line-<sub>" を受け取ると <sub>、送った文は sent に残す
  await db.exec(`
    create table sent (id serial, to_user text, body text);
    create or replace function toi_line_verify(p_id_token text) returns text language plpgsql as $$
    begin
      if p_id_token not like 'line-%' then raise exception 'line_login_failed'; end if;
      return substr(p_id_token, 6);
    end; $$;
    create or replace function toi_line_send(p_to text, p_text text) returns jsonb language plpgsql as $$
    begin
      insert into sent (to_user, body) values (p_to, p_text);
      return jsonb_build_object('status', 'sent', 'request_id', 1);
    end; $$;
  `);
});

test('返事を承認すると、待っている人に「返事が届いた」とリンクを1通送る。本文は載せない', async () => {
  const q = await question();
  await watch(q, 'U1');
  const a = await answer(q, false);
  assert.deepEqual(await sent(), []);                       // 未承認のうちは送らない
  await admin('update answers set approved = true where id = $1', [a]);
  const [[to, body]] = await sent();
  assert.equal(to, 'U1');
  assert.match(body, /返事が届いたよ/);
  assert.ok(body.includes(`https://nirareba0.github.io/toi-site/#question/${q}`));
  assert.ok(!body.includes('空') && !body.includes('光'));
  // もう一度更新しても二重に送らない
  await admin('update answers set body = body || $2 where id = $1', [a, '。']);
  assert.equal((await sent()).length, 1);
  assert.equal((await admin('select status from line_notices where answer_id = $1', [a]))[0].status, 'sent');
});

test('まとめて承認しても1人1通。問いが未公開のあいだは送らず、問いを公開したときに送る', async () => {
  await admin('delete from sent');
  const q = await question(false);
  await watch(q, 'U2');
  await answer(q, true);
  await answer(q, true);
  assert.deepEqual(await sent(), []);
  await admin('update questions set approved = true where id = $1', [q]);
  assert.deepEqual((await sent()).map(([to]) => to), ['U2']);
  assert.equal((await admin('select count(*)::int as n from line_notices where line_user_id = $1', ['U2']))[0].n, 2);

  const q2 = await question(true);
  await watch(q2, 'U2');
  await watch(q2, 'U3');
  await admin(`insert into answers (question_id, body, approved) values ($1, 'a', false), ($1, 'b', false)`, [q2]);
  await admin('update answers set approved = true where question_id = $1', [q2]);
  assert.deepEqual((await sent()).slice(1).map(([to]) => to).sort(), ['U2', 'U3']);
});

test('待ち始める前からある返事は知らせない。やめたら送らない', async () => {
  await admin('delete from sent');
  const q = await question();
  await answer(q, true);
  await watch(q, 'U4');
  await watch(q, 'U4');                                     // 2回押しても同じ
  await admin('update answers set body = body where question_id = $1', [q]);
  assert.deepEqual(await sent(), []);
  await anon('select unwatch_question($1, $2)', [q, 'line-U4']);
  await answer(q, true);
  assert.deepEqual(await sent(), []);
});

test('ブラウザ（anon）からは: ID トークンが正しくないと待てない。表と送る関数には触れない。投函はこれまでどおり', async () => {
  const q = await question();
  await rejects(anon('select watch_question($1, $2)', [q, 'bad']), 'line_login_failed');
  await rejects(anon('select watch_question($1, $2)', ['00000000-0000-0000-0000-000000000000', 'line-U5']), 'question_not_found');
  await rejects(anon('select * from line_watches'), 'permission denied');
  await rejects(anon('select * from line_notices'), 'permission denied');
  await rejects(anon('select * from line_settings'), 'permission denied');
  await rejects(anon('select toi_line_send($1, $2)', ['U5', 'x']), 'permission denied');
  await rejects(anon('select toi_line_notify($1)', [q]), 'permission denied');
  await anon(`insert into questions (body) values ('匿名の投函')`);
  await anon(`insert into answers (question_id, body) values ($1, '匿名の返事')`, [q]);
});

test('1人が待てる問いは50まで', async () => {
  for (let i = 0; i < 50; i++) await watch(await question(), 'U6');
  await rejects(watch(await question(), 'U6'), 'too_many_watches');
});
