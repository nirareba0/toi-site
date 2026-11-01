// supabase/app-standalone.sql: ホーム画面のアプリだけで、LINE と同じこと（答える・ノート・みんなに見せる・今日の問い・知らせ）をする
// 本物の Supabase の代わりに PGlite で schema.sql → line-*.sql → web-push.sql → app-standalone.sql を流し、Vault・pg_net・LINE への送信だけ差し替える。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, '..', f), 'utf8').replace(/^create extension .*$/gm, '');
let db;

const admin = async (sql, params = []) => (await db.query(sql, params)).rows;
async function as(role, sql, params = []) {
  await db.exec(`set role ${role}`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); }
}
const anon = (sql, params) => as('anon', sql, params);
const rpc = async (sql, params) => (await anon(`select ${sql} as r`, params))[0].r;
const rejects = (p, code) => assert.rejects(p, (e) => e.message.includes(code));
const count = async (sql, params = []) => (await admin(`select count(*)::int as n from ${sql}`, params))[0].n;

const H = (n) => String(n).repeat(32).slice(0, 32);   // 端末の印（32 桁の 16 進）
const A = H('a'), B = H('b'), C = H('c'), D = H('d');
const EP = (n) => `https://fcm.googleapis.com/fcm/send/app${n}`;

const SUPPORT = `
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
`;

async function question(body = 'なぜ空は青い？', { approved = true, hash = null, theme = null } = {}) {
  return (await admin('insert into questions (body, approved, client_hash, theme_id) values ($1, $2, $3, $4) returning id',
    [body, approved, hash, theme]))[0].id;
}
const subscribe = (ep, hash, questions = true) =>
  anon('select save_push($1, $2, $3, $4, $5)', [ep, 'BPk-abc_1', 'au_th-1', hash, questions]);
const outbox = async () => (await admin('select endpoint, kind from push_outbox order by id')).map((r) => [r.endpoint, r.kind]);
const clearOutbox = () => db.exec('delete from push_outbox; delete from net_calls;');
const answer = (hash, q, body, share = false) => rpc('app_answer($1, $2, $3, $4)', [hash, q, body, share]);
const today = (hash) => rpc('app_today($1)', [hash]);
const prefs = (hash, f, themes = null) => rpc('app_set_prefs($1, $2, $3)', [hash, f, themes]);
const draw = (hash) => rpc('app_draw($1)', [hash]);
const resetRate = () => db.exec('delete from app_rate');

before(async () => {
  db = new PGlite();
  await db.exec(SUPPORT);
  for (const f of ['schema.sql', 'line-notify.sql', 'line-sync.sql', 'line-reactions.sql']) await db.exec(read(f));
  await db.exec(`
    create table line_sent (id serial, path text, body jsonb);
    create or replace function toi_line_api(p_path text, p_body jsonb) returns jsonb language plpgsql as $$
    begin insert into line_sent (path, body) values (p_path, p_body); return '{"status":"sent"}'::jsonb; end; $$;
    create or replace function toi_line_send(p_to text, p_text text) returns jsonb language sql as $$ select '{"status":"sent"}'::jsonb $$;
  `);
  await db.exec(read('web-push.sql'));
  await db.exec(read('app-standalone.sql'));
  await db.exec(read('app-standalone.sql'));   // 何度流しても同じ
  await db.exec(read('web-push.sql'));         // web-push.sql を流し直しても、足した種類と引き金は残る
  // いつも昼にする（夜に回さない）
  await db.exec(`update push_settings set value = '24' where key = 'quiet_from_jst'; update push_settings set value = '0' where key = 'quiet_until_jst'`);
});

test('先に流すもの: line-sync.sql（相談先の判定）が無ければ止まる', async () => {
  const bare = new PGlite();
  await bare.exec(SUPPORT);
  await bare.exec(read('schema.sql'));
  await assert.rejects(bare.exec(read('app-standalone.sql')), /line-sync\.sql を先に/);
  await bare.close();
});

test('ブラウザ（anon）から: 表と中の関数には触れない。印は 32 桁の 16 進だけ', async () => {
  for (const t of ['app_devices', 'app_prompts', 'app_notes', 'app_answer_notices', 'app_rate']) {
    await rejects(anon(`select * from ${t}`), 'permission denied');
  }
  for (const f of ["toi_app_daily()", "toi_app_tick()", `toi_app_push('${A}', 'today')`, `toi_app_pick('${A}', 'pull')`, `toi_app_share('${A}', gen_random_uuid())`]) {
    await rejects(anon(`select ${f}`), 'permission denied');
  }
  for (const f of ['app_today($1)', 'app_draw($1)', 'app_my_notes($1)']) await rejects(rpc(f, ['anon-hash']), 'bad_client_hash');
  await rejects(rpc('app_set_prefs($1, $2, null)', [A, 'hourly']), 'bad_frequency');
});

test('答える: ノートに残る。空・長すぎ・未公開の問いは ok=false で断る（何も残さない）', async () => {
  await resetRate();
  const q = await question('ふつうってなんだろう？');
  const r = await answer(A, q, '  みんなが決めた平均かな  ');
  assert.equal(r.ok, true);
  assert.deepEqual(await admin('select body, answer_id from app_notes where id = $1', [r.note_id]), [{ body: 'みんなが決めた平均かな', answer_id: null }]);
  assert.deepEqual(await answer(A, q, '   '), { ok: false, reason: 'empty' });
  assert.deepEqual(await answer(A, q, 'あ'.repeat(2001)), { ok: false, reason: 'too_long' });
  const hidden = await question('まだ確認中の問い', { approved: false });
  assert.deepEqual(await answer(A, hidden, 'こたえ'), { ok: false, reason: 'question' });
  assert.equal(await count('app_notes where client_hash = $1', [A]), 1);
  assert.equal(await count('answers where client_hash = $1', [A]), 0);   // みんなに見せていないので返事にはならない
});

test('相談先が要る言葉: 何より先に断る（印が無い端末でも）。ノートにも返事にも残さない', async () => {
  const q = await question();
  const notes = await count('app_notes');
  const answers = await count('answers');
  assert.deepEqual(await answer(A, q, 'もう死にたい', true), { ok: false, reason: 'sos' });
  assert.deepEqual(await answer('anon-hash', q, '学校でいじめられてる', true), { ok: false, reason: 'sos' });
  await rejects(answer('anon-hash', q, 'ふつうの答え'), 'bad_client_hash');
  assert.equal(await count('app_notes'), notes);
  assert.equal(await count('answers'), answers);
});

test('みんなに見せる: 未承認の返事（中高生）になり、承認されるまで載らない。載ったら端末に published を1つ', async () => {
  await resetRate();
  await clearOutbox();
  await subscribe(EP(1), A);
  const q = await question('大人も将来が不安になる？');
  const r = await answer(A, q, 'なると思う。でも慣れる', true);
  assert.deepEqual(r.share, { ok: true });
  const [a] = await admin('select id, role_id, approved, client_hash from answers where id = (select answer_id from app_notes where id = $1)', [r.note_id]);
  assert.deepEqual({ role: a.role_id, approved: a.approved, hash: a.client_hash }, { role: 'teen', approved: false, hash: A });
  assert.equal(await count('public_answers where id = $1', [a.id]), 0);
  assert.deepEqual(await outbox(), []);
  await admin('update answers set approved = true where id = $1', [a.id]);
  assert.equal(await count('public_answers where id = $1 and responder_role = $2', [a.id, '中高生']), 1);
  assert.deepEqual(await outbox(), [[EP(1), 'published']]);
  await admin('update answers set body = body where id = $1', [a.id]);
  assert.deepEqual(await outbox(), [[EP(1), 'published']]);   // 二度は知らせない
  // LINE には何も送らない（LINE の人ではない）
  assert.equal(await count('line_sent'), 0);
});

test('ノートを後から見せる: 2回目は already。ほかの端末のノートは見せられない・消せない・読めない', async () => {
  await resetRate();
  const q = await question();
  const { note_id } = await answer(A, q, 'あとで見せる答え');
  assert.deepEqual(await rpc('app_share_note($1, $2)', [B, note_id]), { ok: false, reason: 'note' });
  assert.deepEqual(await rpc('app_share_note($1, $2)', [A, note_id]), { ok: true });
  assert.deepEqual(await rpc('app_share_note($1, $2)', [A, note_id]), { ok: true, already: true });
  assert.equal(await rpc('app_delete_note($1, $2)', [B, note_id]), false);
  assert.ok(!(await rpc('app_my_notes($1)', [B])).some((n) => n.id === note_id));
  const mine = (await rpc('app_my_notes($1)', [A])).find((n) => n.id === note_id);
  assert.deepEqual({ shared: mine.shared, published: mine.published, q: mine.question_id }, { shared: true, published: false, q });
  assert.equal(await rpc('app_delete_note($1, $2)', [A, note_id]), true);
  assert.equal(await count('answers where id in (select answer_id from app_notes where id = $1)', [note_id]), 0);
  assert.equal(await count('answers where client_hash = $1 and body = $2', [A, 'あとで見せる答え']), 1);   // 送った返事は残る（消すのは運営）
});

test('回数の上限: みんなに見せるは1つの端末で1日5まで、ノートは1時間20まで。消しても数は減らない', async () => {
  await resetRate();
  const q = await question();
  for (let i = 0; i < 5; i++) assert.equal((await answer(C, q, `見せる ${i}`, true)).share.ok, true);
  const sixth = await answer(C, q, '6つめ', true);
  assert.equal(sixth.ok, true);                                   // ノートには残る
  assert.deepEqual(sixth.share, { ok: false, reason: 'limit' });   // 返事にはならない
  for (let i = 0; i < 14; i++) assert.equal((await answer(C, q, `ノート ${i}`)).ok, true);
  for (const n of await rpc('app_my_notes($1)', [C])) await rpc('app_delete_note($1, $2)', [C, n.id]);
  assert.deepEqual(await answer(C, q, '21こめ'), { ok: false, reason: 'limit' });
  assert.equal((await answer(D, q, 'ほかの端末は書ける')).ok, true);
  await resetRate();
});

test('今日の問い: 選んだジャンルだけ。自分の問い・相談先が要る問い・未公開の問いは届かない。全部届けたら前のもの', async () => {
  await resetRate();
  await admin("update themes set label = label");   // themes は schema.sql の初期値
  const own = await question('自分で出した恋の問い', { hash: D, theme: 'koi' });
  await question('消えたいと思ったことある？', { theme: 'koi' });
  await question('確認中の恋の問い', { approved: false, theme: 'koi' });
  const ok1 = await question('好きってどういうこと？', { theme: 'koi' });
  const ok2 = await question('友だちと恋人のちがいは？', { theme: 'koi' });
  assert.deepEqual((await today(D)).question, null);
  assert.deepEqual((await today(D)).prefs, { frequency: 'pull', themes: null, chosen: false });
  const t = await prefs(D, 'daily', ['koi', 'miacis', 'nope']);
  assert.deepEqual(t.prefs, { frequency: 'daily', themes: ['koi'], chosen: true });   // 居場所のこと・無いジャンルは落とす
  const seen = new Set([t.question.id]);
  assert.equal(t.question.via, 'pull');
  assert.equal(t.question.answered, false);
  seen.add((await draw(D)).question.id);
  assert.deepEqual([...seen].sort(), [ok1, ok2].sort());
  assert.ok(!seen.has(own));
  const again = await draw(D);                     // 全部届けた → いちばん前に届けたもの
  assert.equal(again.ok, true);
  assert.ok([ok1, ok2].includes(again.question.id));
  // 答えたら answered
  await answer(D, again.question.id, '答えた');
  assert.equal((await today(D)).question.answered, true);
  // ジャンルに合う問いが無ければ none
  const none = await prefs(H('e'), 'pull', ['gakko']);
  assert.equal(none.question, null);
  const r = await draw(H('e'));
  assert.deepEqual([r.ok, r.reason, r.question], [false, 'none', null]);
});

test('毎日／週1: 決まった時刻に届けて today を送る（問いの知らせを切った端末・自分で引くだけ・30日開いていない端末には送らない）', async () => {
  await resetRate();
  await clearOutbox();
  await admin("update app_devices set frequency = 'pull'");   // ほかのテストで作った端末は外す
  await question('毎日の問い1', { theme: 'gakko' });
  await question('毎日の問い2', { theme: 'gakko' });
  const daily = H('1'), weekly = H('2'), pull = H('3'), quiet = H('4'), stale = H('5');
  for (const [h, f] of [[daily, 'daily'], [weekly, 'weekly'], [pull, 'pull'], [quiet, 'daily'], [stale, 'daily']]) {
    await prefs(h, f, ['gakko']);
    await subscribe(EP(h.slice(0, 3)), h, h !== quiet);
  }
  await admin(`update app_devices set last_seen_at = now() - interval '31 days' where client_hash = $1`, [stale]);
  const before = (await today(daily)).question.id;
  await clearOutbox();
  assert.equal((await admin('select toi_app_daily() as n'))[0].n, 3);   // daily・weekly・quiet（問いは届く。知らせだけ送らない）
  assert.deepEqual((await outbox()).sort(), [[EP(daily.slice(0, 3)), 'today'], [EP(weekly.slice(0, 3)), 'today']].sort());
  const after = await today(daily);
  assert.notEqual(after.question.id, before);
  assert.equal(after.question.via, 'daily');
  // 同じ日にもう一度呼んでも届けない。週1は7日たつまで届けない
  await clearOutbox();
  assert.equal((await admin('select toi_app_daily() as n'))[0].n, 0);
  await admin(`update app_devices set last_prompted_on = last_prompted_on - 1 where client_hash in ($1, $2)`, [daily, weekly]);
  assert.equal((await admin('select toi_app_daily() as n'))[0].n, 1);
  // 毎時の仕事は question_hour_jst の時だけ届ける
  await admin(`update push_settings set value = '99' where key = 'question_hour_jst'`);
  await admin(`update app_devices set last_prompted_on = null`);
  assert.equal((await admin('select toi_app_tick() as n'))[0].n, 0);
  await admin(`update push_settings set value = (extract(hour from now() at time zone 'Asia/Tokyo')::int)::text where key = 'question_hour_jst'`);
  assert.ok((await admin('select toi_app_tick() as n'))[0].n > 0);
  await admin(`update push_settings set value = '19' where key = 'question_hour_jst'`);
});

test('「新しい問い（question）」は、毎日／週1の端末には送らず today に寄せる。ほかの端末にはこれまでどおり', async () => {
  await clearOutbox();
  await admin('select toi_push_new_questions()');
  await clearOutbox();
  const daily = H('6'), plain = H('7');
  await prefs(daily, 'daily');
  await subscribe(EP(6), daily);
  await subscribe(EP(7), plain);
  await question('新しく載った問い');
  await admin('select toi_push_new_questions()');
  const got = await outbox();
  assert.ok(got.some(([ep, k]) => ep === EP(7) && k === 'question'));
  assert.ok(!got.some(([ep]) => ep === EP(6)));
  // 自分で引くだけに替えたら、また question が届く
  await prefs(daily, 'pull');
  await clearOutbox();
  await question('もう1つ載った問い');
  await admin('select toi_push_new_questions()');
  assert.ok((await outbox()).some(([ep, k]) => ep === EP(6) && k === 'question'));
});

test('反応: 載った答えに反応がつくと reaction（1つの答えにつき1日1通・自分で押したものは知らせない）', async () => {
  await resetRate();
  const W = H('8');
  await subscribe(EP(8), W);
  const q = await question();
  const { note_id } = await answer(W, q, '反応される答え', true);
  const [{ answer_id }] = await admin('select answer_id from app_notes where id = $1', [note_id]);
  await admin('update answers set approved = true where id = $1', [answer_id]);
  await clearOutbox();
  const react = (kind, hash) => anon(`insert into reactions (target_type, target_id, kind, client_hash) values ('answer', $1, $2, $3)`, [answer_id, kind, hash]);
  await react('kyokan', W);                     // 自分で押した
  assert.deepEqual(await outbox(), []);
  await react('kyokan', H('9'));
  await react('kangaeta', H('9'));
  await react('kyokan', A);
  assert.deepEqual(await outbox(), [[EP(8), 'reaction']]);
});

test('ほかの返事: 答えた（載った）問いに、あとから別の返事が載ると other_answer（返事1つにつき1通）', async () => {
  await resetRate();
  const W = H('0');
  await subscribe(EP(0), W);
  const q = await question('ほかの返事を待つ問い');
  const earlier = (await admin(`insert into answers (question_id, body, approved, created_at) values ($1, '前からある返事', true, now() - interval '1 hour') returning id`, [q]))[0].id;
  const { note_id } = await answer(W, q, 'わたしの答え', true);
  await admin('update answers set approved = true where id = (select answer_id from app_notes where id = $1)', [note_id]);
  await clearOutbox();
  await admin('update answers set body = body where id = $1', [earlier]);   // 前からある返事は知らせない
  assert.deepEqual(await outbox(), []);
  const later = (await admin(`insert into answers (question_id, body, approved) values ($1, '大人の返事', false) returning id`, [q]))[0].id;
  assert.deepEqual(await outbox(), []);
  await admin('update answers set approved = true where id = $1', [later]);
  await admin('update answers set body = body where id = $1', [later]);
  assert.deepEqual(await outbox(), [[EP(0), 'other_answer']]);
});

test('iPhone の引き継ぎ: Safari で書いたノートもアプリで読める。Safari で見せた答えが載ると、アプリに知らせる', async () => {
  await resetRate();
  await clearOutbox();
  const S = H('f'), P = H('e');
  const q = await question();
  const { note_id } = await answer(S, q, 'Safari で書いた答え', true);
  await subscribe(EP('e'), P);
  const { code } = (await anon('select push_handoff_make($1) as r', [S]))[0].r;
  assert.equal((await anon('select push_handoff_take($1, $2) as r', [code, P]))[0].r.ok, true);
  assert.ok((await rpc('app_my_notes($1)', [P])).some((n) => n.id === note_id));
  await admin('update answers set approved = true where id = (select answer_id from app_notes where id = $1)', [note_id]);
  assert.deepEqual(await outbox(), [[EP('e'), 'published']]);
});
