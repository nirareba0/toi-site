// supabase/web-push.sql と supabase/functions/notify-push/deliver.mjs: ホーム画面に置いた「なんでポスト」への通知
// 本物の Supabase の代わりに PGlite で schema.sql → line-*.sql → web-push.sql を流し、Vault・pg_net・pg_cron だけ差し替える。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { deliver, checkSecret, ensureVapid, generateVapid, payloadOf, KINDS } from '../functions/notify-push/deliver.mjs';
import { PUSH_KINDS } from '../../web/js/push.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, '..', f), 'utf8').replace(/^create extension .*$/gm, '');
let db;

const admin = async (sql, params = []) => (await db.query(sql, params)).rows;
async function as(role, sql, params = []) {
  await db.exec(`set role ${role}`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); }
}
const anon = (sql, params) => as('anon', sql, params);
const rejects = (p, code) => assert.rejects(p, (e) => e.message.includes(code));

const H = (n) => String(n).repeat(32).slice(0, 32);            // 端末の印（32 桁の 16 進）
const A = H('a'), B = H('b'), C = H('c');
const EP = (n) => `https://fcm.googleapis.com/fcm/send/${n}`;

async function question(hash, approved = true) {
  return (await admin('insert into questions (body, approved, client_hash) values ($1, $2, $3) returning id', ['なぜ空は青い？', approved, hash]))[0].id;
}
async function answer(q, approved = true) {
  return (await admin('insert into answers (question_id, body, approved) values ($1, $2, $3) returning id', [q, '光が散らばるから', approved]))[0].id;
}
const subscribe = (ep, hash, questions = true) =>
  anon('select save_push($1, $2, $3, $4, $5) as r', [ep, 'BPk-abc_1', 'au_th-1', hash, questions]);
const outbox = async () => (await admin('select endpoint, kind, send_after <= now() as due from push_outbox order by id'))
  .map((r) => [r.endpoint, r.kind, r.due]);
const clear = () => db.exec('delete from push_outbox; delete from net_calls;');
const calls = async () => (await admin('select count(*)::int as n from net_calls'))[0].n;
const take = () => as('service_role', 'select op_take_push(100) as r').then((r) => r[0].r);
// いまを昼（JST 12時）か夜（23時）にする。quiet_from を 0〜24 にずらして、時計を動かさずに確かめる
const daytime = () => db.exec(`update push_settings set value = '24' where key = 'quiet_from_jst'; update push_settings set value = '0' where key = 'quiet_until_jst'`);
const night = () => db.exec(`update push_settings set value = '0' where key = 'quiet_from_jst'; update push_settings set value = '0' where key = 'quiet_until_jst'`);

before(async () => {
  db = new PGlite();
  // Supabase にあるものの代わり（役割・storage・既定の権限・Vault・pg_net）
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
    create schema storage; create table storage.buckets (id text primary key, name text, public boolean);
    create schema vault;
    create table vault.secrets (name text primary key, secret text not null);
    create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(p_secret text, p_name text, p_description text default '') returns uuid language sql as $$
      insert into vault.secrets (name, secret) values (p_name, p_secret); select gen_random_uuid();
    $$;
    create schema net;
    create table public.net_calls (id serial, url text, headers jsonb);
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
      returns bigint language sql as $$ insert into public.net_calls (url, headers) values (url, headers) returning id::bigint $$;
  `);
  await db.exec(read('schema.sql'));
  await db.exec(read('line-notify.sql'));
  await db.exec(read('line-sync.sql'));
  await db.exec(read('line-reactions.sql'));
  // LINE には送らない（このテストは通知だけを見る）
  await db.exec(`
    create or replace function toi_line_api(p_path text, p_body jsonb) returns jsonb language sql as $$ select '{"status":"sent"}'::jsonb $$;
    create or replace function toi_line_send(p_to text, p_text text) returns jsonb language sql as $$ select '{"status":"sent"}'::jsonb $$;
  `);
  // はじめて流す前から載っている問いと返事（入れた途端に知らせない）
  const old = await question(A);
  await answer(old);
  await db.exec(read('web-push.sql'));
  await db.exec(read('web-push.sql'));   // 何度流しても同じ
  await daytime();
});

test('はじめて流したとき: いま載っている返事・問いは知らせ終えたことに。合言葉は Vault の中で1つだけ作る', async () => {
  assert.equal((await admin('select count(*)::int as n from push_answers_seen'))[0].n, 1);
  assert.equal((await admin('select count(*)::int as n from push_questions_seen'))[0].n, 1);
  const s = await admin(`select secret from vault.secrets where name = 'push_hook_secret'`);
  assert.equal(s.length, 1);
  assert.match(s[0].secret, /^[0-9a-f]{64}$/);
});

test('自分の問いに返事が載ったら、その端末に「reply」を1つ。本文・名前は列に持たない。Edge Function を合言葉つきで呼ぶ', async () => {
  await clear();
  await subscribe(EP(1), A);
  await subscribe(EP(2), B);
  const q = await question(A);
  const a = await answer(q, false);
  assert.deepEqual(await outbox(), []);                 // 未承認のうちは知らせない
  await admin('update answers set approved = true where id = $1', [a]);
  assert.deepEqual(await outbox(), [[EP(1), 'reply', true]]);
  assert.deepEqual((await admin(`select column_name from information_schema.columns where table_name = 'push_outbox' order by ordinal_position`))
    .map((r) => r.column_name), ['id', 'endpoint', 'kind', 'send_after', 'created_at']);
  const [call] = await admin('select url, headers from net_calls');
  assert.equal(call.url, 'https://btbykfnlsxwmpfcfslxb.supabase.co/functions/v1/notify-push');
  assert.equal(call.headers['x-push-secret'], (await admin(`select secret from vault.secrets where name = 'push_hook_secret'`))[0].secret);
  assert.match(call.headers.authorization, /^Bearer eyJ/);
  // もう一度更新しても二重に知らせない
  await admin('update answers set body = body || $2 where id = $1', [a, '。']);
  assert.equal((await outbox()).length, 1);
});

test('問いが未公開のあいだは知らせず、問いを公開したときに知らせる。まとめて承認しても1つ', async () => {
  await clear();
  const q = await question(A, false);
  await answer(q, true);
  await answer(q, true);
  assert.deepEqual(await outbox(), []);
  await admin('update questions set approved = true where id = $1', [q]);
  assert.deepEqual(await outbox(), [[EP(1), 'reply', true]]);
});

test('印の無い問い・紙の問い・LINE の印（line）には知らせない。購読より前に載った返事も知らせない', async () => {
  await clear();
  for (const hash of [null, 'line', 'anon-hash']) await answer(await question(hash));
  assert.deepEqual(await outbox(), []);
  const q = await question(C);
  await answer(q);
  await subscribe(EP(3), C);
  await admin('update answers set body = body where question_id = $1', [q]);
  assert.deepEqual(await outbox(), []);
});

test('夜（21時〜7時）に載った返事は、朝7時に送る（いまは呼ばない）', async () => {
  await clear();
  await night();
  try {
    await answer(await question(A));
    assert.deepEqual(await outbox(), [[EP(1), 'reply', false]]);
    assert.equal(await calls(), 0);
    assert.deepEqual(await take(), []);                 // まだ渡さない
  } finally {
    await daytime();
  }
  // 朝7時の計算（JST）
  await db.exec(`update push_settings set value = '21' where key = 'quiet_from_jst'; update push_settings set value = '7' where key = 'quiet_until_jst'`);
  try {
    const at = async (iso) => (await admin('select toi_push_send_after($1::timestamptz) as t', [iso]))[0].t.toISOString();
    assert.equal(await at('2026-10-31T13:30:00+09:00'), '2026-10-31T04:30:00.000Z');   // 昼はそのまま
    assert.equal(await at('2026-10-31T22:10:00+09:00'), '2026-10-31T22:00:00.000Z');   // 夜 → 翌朝7時（JST）
    assert.equal(await at('2026-11-01T03:00:00+09:00'), '2026-10-31T22:00:00.000Z');   // 明け方 → その朝7時
  } finally {
    await daytime();
  }
  await admin('delete from push_outbox');
});

test('Edge Function が受け取る: 同じ端末・同じ種類は1つにまとめ、宛先と種類と鍵だけを返す。受け取ったら消える', async () => {
  await clear();
  const q = await question(A);
  await answer(q);
  await answer(q);
  assert.equal((await outbox()).length, 2);
  const rows = await take();
  assert.deepEqual(rows, [{ kind: 'reply', endpoint: EP(1), p256dh: 'BPk-abc_1', auth: 'au_th-1' }]);
  assert.deepEqual(await outbox(), []);
  await as('service_role', 'select op_drop_push($1)', [EP(3)]);
  assert.equal((await admin('select count(*)::int as n from push_subscriptions where endpoint = $1', [EP(3)]))[0].n, 0);
});

test('新しい問いの知らせ: 決まった時刻（19時）だけ。前の回から新しく載った問いがあるときだけ。自分の問いだけなら送らない。切った端末にも送らない', async () => {
  await clear();
  await admin('select toi_push_new_questions()');        // ここまでの問いは知らせ終えたことに
  await clear();
  await subscribe(EP(4), C, false);                       // 新しい問いの知らせは切ってある
  await question(A, false);
  assert.equal((await admin('select toi_push_new_questions() as n'))[0].n, 0);   // 未公開の問いは数えない
  await question(A);                                       // A が出した問いだけ
  await admin('select toi_push_new_questions()');
  assert.deepEqual(await outbox(), [[EP(2), 'question', true]]);   // B（EP2）にだけ。A（EP1）は自分の問い、C は切ってある
  await clear();
  await admin('select toi_push_new_questions()');
  assert.deepEqual(await outbox(), []);                    // 同じ問いで二度は送らない
  // 時刻が合わなければ毎時の仕事は問いを数えない
  await admin(`update push_settings set value = '99' where key = 'question_hour_jst'`);
  await question(B);
  assert.equal((await admin('select toi_push_tick() as n'))[0].n, 0);
  await admin(`update push_settings set value = (extract(hour from now() at time zone 'Asia/Tokyo')::int)::text where key = 'question_hour_jst'`);
  assert.equal((await admin('select toi_push_tick() as n'))[0].n, 1);
  assert.deepEqual(await outbox(), [[EP(1), 'question', true]]);
  await admin(`update push_settings set value = '19' where key = 'question_hour_jst'`);
});

test('ブラウザ（anon）から: 宛先は push service だけ・印は 32 桁の 16 進だけ。表と送る関数には触れない', async () => {
  await rejects(subscribe('https://example.com/push', A), 'bad_endpoint');
  await rejects(subscribe('http://fcm.googleapis.com/fcm/send/x', A), 'bad_endpoint');
  await rejects(subscribe(EP(9), 'anon-hash'), 'bad_client_hash');
  await rejects(anon('select save_push($1, $2, $3, $4, true)', [EP(9), 'a b', 'x', A]), 'bad_push_key');
  for (const t of ['push_subscriptions', 'push_outbox', 'push_hash_links', 'push_handoffs', 'push_settings', 'push_answers_seen']) {
    await rejects(anon(`select * from ${t}`), 'permission denied');
  }
  for (const f of ['op_take_push(1)', 'op_vapid()', 'op_push_hook_secret()', 'toi_push_tick()', 'toi_push_new_questions()', 'toi_push_call()']) {
    await rejects(anon(`select ${f}`), 'permission denied');
  }
  assert.equal((await anon('select push_public_key() as k'))[0].k, null);   // 鍵ができるまでは null
  // 問いの投函はこれまでどおり（引き金が anon の操作を止めない）。返事の直接の書き込みは schema.sql で塞いだ（関数経由だけ）
  await anon(`insert into questions (body, client_hash) values ('匿名の投函', $1)`, [A]);
  await rejects(anon(`insert into answers (question_id, body) values ((select id from questions where approved limit 1), '匿名の返事')`), 'row-level security');
  // 同じ宛先で入れ直すと置き換わる。消すと消える
  await subscribe(EP(9), A, false);
  await subscribe(EP(9), B, true);
  assert.deepEqual(await admin('select client_hash, questions from push_subscriptions where endpoint = $1', [EP(9)]), [{ client_hash: B, questions: true }]);
  await anon('select delete_push($1)', [EP(9)]);
  assert.equal((await admin('select count(*)::int as n from push_subscriptions where endpoint = $1', [EP(9)]))[0].n, 0);
});

test('通知の鍵: 1組だけ置く（2回目は前の鍵を返す）。置いたら画面が公開の鍵を読める', async () => {
  const pub = 'B' + 'x'.repeat(86), priv = 'y'.repeat(43);
  await rejects(as('service_role', 'select op_set_vapid($1, $2)', ['short', priv]), 'bad_vapid_key');
  const first = (await as('service_role', 'select op_set_vapid($1, $2) as r', [pub, priv]))[0].r;
  assert.deepEqual(first, { publicKey: pub, privateKey: priv });
  const second = (await as('service_role', 'select op_set_vapid($1, $2) as r', ['C' + 'x'.repeat(86), 'z'.repeat(43)]))[0].r;
  assert.deepEqual(second, first);
  assert.equal((await anon('select push_public_key() as k'))[0].k, pub);
});

test('引き継ぎ: Safari で番号 → ホーム画面のアプリで入れると、Safari で出した問いを返し、その返事もアプリに知らせる', async () => {
  await clear();
  const S = H('d'), P = H('e');                              // Safari の印・ホーム画面のアプリの印
  const q = await question(S, false);                        // Safari で出した（まだ確認中）
  await subscribe(EP(5), P);                                 // アプリで通知を受け取る
  const { code } = (await anon('select push_handoff_make($1) as r', [S]))[0].r;
  assert.match(code, /^\d{8}$/);
  assert.equal((await admin('select count(*)::int as n from push_handoffs where code_hash = $1', [code])).at(0).n, 0); // 番号そのものは持たない
  const got = (await anon('select push_handoff_take($1, $2) as r', [`${code.slice(0, 4)} ${code.slice(4)}`, P]))[0].r;
  assert.equal(got.ok, true);
  assert.deepEqual(got.questions.map((x) => x.id), [q]);
  assert.equal(got.questions[0].body, 'なぜ空は青い？');
  // 番号は1回だけ
  assert.deepEqual((await anon('select push_handoff_take($1, $2) as r', [code, P]))[0].r, { ok: false, reason: 'code' });
  // Safari で出した問いに返事が載ると、アプリに知らせる
  await answer(q);
  await admin('update questions set approved = true where id = $1', [q]);
  assert.deepEqual(await outbox(), [[EP(5), 'reply', true]]);
  // 新しい問いの知らせは、引き継いだ自分の問いだけなら送らない
  await clear();
  await admin('select toi_push_new_questions()');
  assert.ok(!(await outbox()).some(([ep]) => ep === EP(5)));
});

test('引き継ぎの総当たり: 1つの端末は15分に5回まで、全体で60回まで。まちがいは ok=false で返す', async () => {
  await admin('delete from push_handoff_tries');
  const T = H('f');
  for (let i = 0; i < 5; i++) {
    assert.deepEqual((await anon('select push_handoff_take($1, $2) as r', ['00000000', T]))[0].r, { ok: false, reason: 'code' });
  }
  assert.deepEqual((await anon('select push_handoff_take($1, $2) as r', ['00000000', T]))[0].r, { ok: false, reason: 'tries' });
  await admin(`insert into push_handoff_tries (client_hash) select '${H('9')}' from generate_series(1, 60)`);
  assert.deepEqual((await anon('select push_handoff_take($1, $2) as r', ['00000000', H('8')]))[0].r, { ok: false, reason: 'busy' });
  await admin('delete from push_handoff_tries');
  await rejects(anon('select push_handoff_make($1)', ['line']), 'bad_client_hash');
});

test('LINE の知らせ（line-notify.sql）と並んで動く: LINE で待っている問いでも、端末への通知も足される', async () => {
  await clear();
  const q = await question(A);
  await admin('insert into line_watches (question_id, line_user_id) values ($1, $2)', [q, 'U1']);
  await answer(q);
  assert.equal((await admin('select count(*)::int as n from line_notices where line_user_id = $1', ['U1']))[0].n, 1);
  assert.deepEqual(await outbox(), [[EP(1), 'reply', true]]);
});

// ---------------------------------------------------------------- deliver.mjs（Edge Function の中身）

test('deliver: 中身は {kind} だけ。404・410 は購読を消し、ほかの失敗は数えるだけ', async () => {
  assert.deepEqual(KINDS, PUSH_KINDS);
  assert.equal(payloadOf('question'), '{"kind":"question"}');
  assert.equal(payloadOf('nope'), '{"kind":"reply"}');
  const sent = [], dropped = [];
  const rows = [
    { kind: 'reply', endpoint: EP(1), p256dh: 'p', auth: 'a' },
    { kind: 'question', endpoint: EP(2), p256dh: 'p', auth: 'a' },
    { kind: 'reply', endpoint: EP(3), p256dh: 'p', auth: 'a' },
  ];
  const result = await deliver({
    take: async () => rows,
    send: async (sub, payload, options) => {
      if (sub.endpoint === EP(2)) throw Object.assign(new Error('gone'), { statusCode: 410 });
      if (sub.endpoint === EP(3)) throw Object.assign(new Error('boom'), { statusCode: 500 });
      sent.push([sub, payload, options]);
    },
    drop: async (ep) => dropped.push(ep),
  });
  assert.deepEqual(result, { sent: 1, dropped: 1, failed: 1 });
  assert.deepEqual(sent[0][0], { endpoint: EP(1), keys: { p256dh: 'p', auth: 'a' } });
  assert.equal(sent[0][1], '{"kind":"reply"}');
  assert.equal(sent[0][2].topic, 'nandepost-reply');
  assert.deepEqual(dropped, [EP(2)]);
  assert.deepEqual(await deliver({ take: async () => null, send: assert.fail, drop: assert.fail }), { sent: 0, dropped: 0, failed: 0 });
});

test('deliver: 合言葉の突き合わせと、鍵を1組だけ作る', async () => {
  assert.equal(checkSecret('abc', 'abc'), true);
  assert.equal(checkSecret('abd', 'abc'), false);
  assert.equal(checkSecret('ab', 'abc'), false);
  assert.equal(checkSecret(null, 'abc'), false);
  assert.equal(checkSecret('abc', null), false);
  const made = await generateVapid();
  assert.match(made.publicKey, /^[A-Za-z0-9_-]{87}$/);
  assert.match(made.privateKey, /^[A-Za-z0-9_-]{43}$/);
  let stored = null;
  const keys = () => ensureVapid({ get: async () => stored, set: async (k) => (stored ??= k), generate: generateVapid });
  const k1 = await keys();
  const k2 = await keys();
  assert.deepEqual(k1, k2);
});
