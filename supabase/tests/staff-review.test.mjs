// supabase/staff-review.sql: 運営の承認を毎日スマホでさばく（運営の端末の登録・下読み・決まった時刻の知らせ・載せる／保留／載せない）
// 本物の Supabase の代わりに PGlite で schema.sql → line-*.sql → web-push.sql → app-standalone.sql → staff-review.sql を流し、Vault・pg_net・LINE への送信だけ差し替える。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { FLAG_CODES } from '../../web/js/staff.mjs';

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
const one = async (sql, params = []) => Object.values((await admin(`select ${sql}`, params))[0] ?? {})[0];
const flags = (text) => one('toi_review_flags($1)', [text]);

const H = (n) => String(n).repeat(32).slice(0, 32);   // 端末の印（32 桁の 16 進）
const A = H('a'), B = H('b'), C = H('c'), S = H('e');
const EP = (n) => `https://fcm.googleapis.com/fcm/send/staff${n}`;
const TOKEN = 'f'.repeat(64), TOKEN2 = '1'.repeat(64), STRANGER = '2'.repeat(64);

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
const LINE_STUB = `
  create or replace function toi_line_api(p_path text, p_body jsonb) returns jsonb language sql as $$ select '{"status":"sent"}'::jsonb $$;
  create or replace function toi_line_send(p_to text, p_text text) returns jsonb language sql as $$ select '{"status":"sent"}'::jsonb $$;
`;

async function question(body = 'なぜ空は青い？', { approved = false, hash = null, at = null, nickname = null } = {}) {
  return (await admin(`insert into questions (body, approved, client_hash, nickname, created_at) values ($1, $2, $3, $4, coalesce($5::timestamptz, now())) returning id`,
    [body, approved, hash, nickname, at]))[0].id;
}
async function reply(q, body = '大人の返事です', { approved = false, hash = null, role = 'staff', at = null } = {}) {
  return (await admin(`insert into answers (question_id, body, approved, client_hash, role_id, created_at) values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now())) returning id`,
    [q, body, approved, hash, role, at]))[0].id;
}
const subscribe = (ep, hash) => anon('select save_push($1, $2, $3, $4, true)', [ep, 'BPk-abc_1', 'au_th-1', hash]);
const outbox = async () => (await admin('select endpoint, kind from push_outbox order by id')).map((r) => [r.endpoint, r.kind]);
const clearOutbox = () => db.exec('delete from push_outbox; delete from net_calls;');
// 未承認をぜんぶ片づける（テストごとに一覧を作り直す）
const clearQueue = () => db.exec(`update answers set rejected_at = now() where not approved and rejected_at is null;
                                  update questions set rejected_at = now() where not approved and rejected_at is null;`);
const pairStart = (token, hash = null) => rpc('staff_pair_start($1, $2)', [token, hash]);
const status = (token, hash = null) => rpc('staff_status($1, $2)', [token, hash]);
const queue = (token) => rpc('staff_queue($1)', [token]);
const decide = (token, kind, id, action) => rpc('staff_decide($1, $2, $3, $4)', [token, kind, id, action]);
const pair = (code, label = null) => one('toi_staff_pair($1, $2)', [code, label]);
const jst = (s) => `${s}+09`;

before(async () => {
  db = new PGlite();
  await db.exec(SUPPORT);
  for (const f of ['schema.sql', 'line-notify.sql', 'line-sync.sql', 'line-reactions.sql']) await db.exec(read(f));
  await db.exec(LINE_STUB);
  await db.exec(read('web-push.sql'));
  await db.exec(read('app-standalone.sql'));
  await db.exec(read('staff-review.sql'));
  await db.exec(read('staff-review.sql'));      // 何度流しても同じ
  await db.exec(read('app-standalone.sql'));    // あとから流し直しても review は残る
  await db.exec(read('web-push.sql'));
  // いつも昼にする（夜に回さない）
  await db.exec(`update push_settings set value = '24' where key = 'quiet_from_jst'; update push_settings set value = '0' where key = 'quiet_until_jst'`);
});

test('流す順: app-standalone.sql が無ければ止まる', async () => {
  const bare = new PGlite();
  await bare.exec(SUPPORT);
  for (const f of ['schema.sql', 'line-notify.sql', 'line-sync.sql']) await bare.exec(read(f));
  await bare.exec(LINE_STUB);
  await bare.exec(read('web-push.sql'));
  await assert.rejects(bare.exec(read('staff-review.sql')), /app-standalone\.sql を先に/);
  await bare.close();
});

test('ブラウザ（anon）から: 運営の表・下読み・登録の関数には触れない。載せない印の列も読めない', async () => {
  for (const t of ['staff_devices', 'staff_pair_codes', 'staff_review_slots']) {
    await rejects(anon(`select * from ${t}`), 'permission denied');
    await rejects(as('authenticated', `select * from ${t}`), 'permission denied');
  }
  for (const f of ["toi_staff_pair('123456')", 'toi_staff_list()', "toi_staff_unpair('all')", 'toi_staff_tick()',
    "toi_review_flags('x')", 'toi_review_pending()', `toi_staff_device('${TOKEN}')`, `toi_review_burst('${A}', now())`]) {
    await rejects(anon(`select ${f}`), 'permission denied');
    await rejects(as('service_role', `select ${f}`), 'permission denied');
  }
  await rejects(anon('select rejected_at from questions'), 'permission denied');
  await rejects(anon('select rejected_at from answers'), 'permission denied');
  // 送る列は review を受け付ける（app-standalone.sql・web-push.sql を流し直したあとも）
  const def = await one(`pg_get_constraintdef(oid) from pg_constraint where conname = 'push_outbox_kind_check'`);
  assert.match(def, /'review'/);
});

test('下読み: 相談先が要る言葉', async () => {
  assert.deepEqual(await flags('もう死にたい'), ['sos']);
  assert.deepEqual(await flags('学校でいじめられてる'), ['sos']);
  assert.deepEqual(await flags('なんで勉強するの？'), []);
  assert.deepEqual(await flags(''), []);
  assert.deepEqual(await flags(null), []);
});

test('下読み: 連絡先（電話・メール・URL・LINE などの ID）', async () => {
  for (const s of ['090-1234-5678 に電話して', '０９０ー１２３４ー５６７８', '連絡は09012345678', '0551(22)1111', '+81 90 1234 5678',
    'abc.def@example.com', 'ｍａｉｌ＠ｅｘａｍｐｌｅ．ｊｐ', 'https://example.com/x', 'www.example.jp', 'lin.ee/abcd', 'youtu.be/xyz',
    'LINEのIDはtoi_post12', 'ライン交換しよ', 'インスタのアカ教えて', '@nandepost_01 フォローして', 'ID: kumo1234', 'id abc_def']) {
    assert.ok((await flags(s)).includes('contact'), s);
  }
  for (const s of ['2026年に生まれた', '100点とった', '3.14 は円周率', 'LINEで知った', 'アイデアがほしい', '電話が苦手', 'ver2.0 になった']) {
    assert.ok(!(await flags(s)).includes('contact'), s);
  }
});

test('下読み: 学校名らしきもの', async () => {
  for (const s of ['韮崎高校に通ってる', '甲陵中学校の2年です', '山梨県立韮崎工業高校', '北杜市立白州中学', '韮崎中2年です', '甲府東高生です',
    '韮崎西中の3年', '穂坂小学校', 'ドルトン東京学園中等教育学校', '甲府高専']) {
    assert.ok((await flags(s)).includes('school'), s);
  }
  for (const s of ['高校ってなんで行くの？', '中学生です', '私立高校と公立高校どっちがいい？', '県立高校に行きたい', '第一志望高校に落ちた',
    '最高の1年だった', '勉強中の1年', '中高一貫校', '男子高校生', '今高校2年', '途中で帰った', '集中できない']) {
    assert.ok(!(await flags(s)).includes('school'), s);
  }
});

test('下読み: 住所の番地らしきもの', async () => {
  for (const s of ['若宮2丁目に住んでる', '藤井町北下條123に家がある', '韮崎市若宮1-2-3', '中央４丁目', '5番地の家', '1番2号']) {
    assert.ok((await flags(s)).includes('address'), s);
  }
  for (const s of ['試合は3-2で勝った', '韮崎市に3年住んでる', '市内2校', '町内で3回', '1番になりたい', '090-1234-5678']) {
    assert.ok(!(await flags(s)).includes('address'), s);
  }
});

test('下読み: 人名らしきもの（粗い）', async () => {
  for (const s of ['田中さんに言われた', '佐藤くんが好き', '山田君と帰った', '鈴木先生がこわい', 'ゆいちゃんと遊んだ', 'ケンタくんって知ってる？',
    'Yukiちゃんが好き', 'ゆいちゃん、元気？', '友達のゆうきくん']) {
    assert.ok((await flags(s)).includes('name'), s);
  }
  for (const s of ['お母さんとけんかした', 'お父さんに怒られた', '店員さんが優しかった', '担任の先生に相談した', '赤ちゃんが泣いてた',
    'おばあちゃんの家', 'お兄ちゃんがうるさい', '友達のAさん', 'ちゃんと勉強したい', 'みんなちゃんとしてる', 'もっとちゃんと。', '教えてくんない？', '看護師さんになりたい',
    '皆さんはどう思う？', 'サンタさんっているの？', 'お客さん']) {
    assert.ok(!(await flags(s)).includes('name'), s);
  }
});

test('下読み: いくつも当たれば決まった順で並ぶ（画面の FLAG_CODES と同じ言葉）', async () => {
  assert.deepEqual(await flags('死にたい。韮崎高校の田中さん、若宮2丁目、090-1234-5678'), ['sos', 'contact', 'school', 'address', 'name']);
  assert.deepEqual(FLAG_CODES, ['sos', 'contact', 'school', 'address', 'name', 'burst']);
});

test('下読み: 同じ端末から前後30分に3件以上は連投。印が無い・LINE の分は見ない', async () => {
  const t0 = '2026-10-01 12:00:00+09';
  const q1 = await question('連投1', { hash: C, at: t0 });
  await question('連投2', { hash: C, at: '2026-10-01 12:10:00+09' });
  assert.equal(await one('toi_review_burst($1, $2)', [C, t0]), false);
  await reply(q1, '連投3', { hash: C, at: '2026-10-01 12:25:00+09', role: 'teen' });
  assert.equal(await one('toi_review_burst($1, $2)', [C, t0]), true);
  assert.equal(await one('toi_review_burst($1, $2)', [C, '2026-10-01 13:30:00+09']), false);
  assert.equal(await one('toi_review_burst($1, $2)', ['line', t0]), false);
  assert.equal(await one('toi_review_burst($1, $2)', [null, t0]), false);
  await clearQueue();
});

test('登録: #staff で6けたのコード → 本人が SQL Editor で toi_staff_pair → 運営の端末になる', async () => {
  await rejects(pairStart('short'), 'bad_token');
  await rejects(pairStart('F'.repeat(64)), 'bad_token');
  assert.deepEqual(await status(TOKEN), { staff: false, waiting: false });
  const r = await pairStart(TOKEN, S);
  assert.equal(r.ok, true);
  assert.equal(r.staff, false);
  assert.match(r.code, /^\d{6}$/);
  assert.ok(new Date(r.expires_at) - Date.now() > 9 * 60 * 1000);
  assert.deepEqual(await status(TOKEN), { staff: false, waiting: true });
  // DB には印もコードもハッシュだけ
  const row = (await admin('select * from staff_pair_codes'))[0];
  assert.notEqual(row.token_hash, TOKEN);
  assert.notEqual(row.code_hash, r.code);
  // 出し直すと、前のコードは使えない
  const again = await pairStart(TOKEN, S);
  assert.equal(await one('count(*)::int from staff_pair_codes'), 1);
  if (again.code !== r.code) await rejects(pair(r.code), '見つかりません');
  await rejects(pair('000000x'), '見つかりません');
  const msg = await pair(again.code.replace(/(\d{3})/, '$1 '), '本人の iPhone');   // 空白が入っていてもよい
  assert.match(msg, /運営の端末にしました（番号 [0-9a-f]{8}）/);
  const s = await status(TOKEN, S);
  assert.equal(s.staff, true);
  assert.match(s.number, /^[0-9a-f]{8}$/);
  assert.equal(typeof s.pending, 'number');
  assert.equal(await one('count(*)::int from staff_pair_codes'), 0);   // コードは1回で消える
  await rejects(pair(again.code), '見つかりません');
  assert.deepEqual(await pairStart(TOKEN), { ok: true, staff: true });
  const list = await admin('select * from toi_staff_list()');
  assert.equal(list.length, 1);
  assert.equal(list[0].label, '本人の iPhone');
  assert.equal(JSON.stringify(list).includes(TOKEN), false);
  const stored = (await admin('select token_hash, client_hash from staff_devices'))[0];
  assert.notEqual(stored.token_hash, TOKEN);
  assert.equal(stored.client_hash, S);
});

test('登録: 10分を過ぎたコードは使えない。待っているコードは全体で50まで', async () => {
  const r = await pairStart(TOKEN2, B);
  await admin(`update staff_pair_codes set expires_at = now() - interval '1 second'`);
  await rejects(pair(r.code), '見つかりません');
  await db.exec(`insert into staff_pair_codes (code_hash, token_hash, expires_at)
                 select md5(g::text), md5('t' || g), now() + interval '10 minutes' from generate_series(1, 50) g`);
  assert.deepEqual(await pairStart(TOKEN2), { ok: false, reason: 'busy' });
  await db.exec('delete from staff_pair_codes');
});

test('一覧: 運営の端末だけが読める。古い順・問いと返事・下読みの見立てつき。載せない印のものは出ない', async () => {
  await clearQueue();
  await rejects(queue(STRANGER), 'not_staff');
  await rejects(queue('nope'), 'not_staff');
  await rejects(decide(STRANGER, 'question', '00000000-0000-0000-0000-000000000000', 'approve'), 'not_staff');
  const q = await question('韮崎高校ってどう？', { at: '2026-10-02 10:00:00+09', nickname: '田中さん' });
  const pub = await question('なぜ空は青い？', { approved: true, at: '2026-10-01 10:00:00+09' });
  const a = await reply(pub, 'ふつうの返事', { at: '2026-10-02 09:00:00+09', role: 'teen', hash: A });
  const l = await reply(q, 'LINE から', { at: '2026-10-02 11:00:00+09', role: 'teen', hash: 'line' });
  const r = await queue(TOKEN);
  assert.equal(r.pending, 3);
  assert.deepEqual(r.items.map((i) => i.id), [a, q, l]);
  const [ia, iq, il] = r.items;
  assert.deepEqual({ kind: ia.kind, body: ia.body, question_body: ia.question_body, question_approved: ia.question_approved, role_label: ia.role_label, via: ia.via, flags: ia.flags },
    { kind: 'answer', body: 'ふつうの返事', question_body: 'なぜ空は青い？', question_approved: true, role_label: '中高生', via: 'app', flags: [] });
  assert.deepEqual({ kind: iq.kind, nickname: iq.nickname, flags: iq.flags }, { kind: 'question', nickname: '田中さん', flags: ['school', 'name'] });
  assert.deepEqual({ via: il.via, question_approved: il.question_approved }, { via: 'line', question_approved: false });
  // 端末の印・ハッシュは返さない
  assert.equal(JSON.stringify(r).includes(A), false);
  await clearQueue();
  assert.deepEqual(await queue(TOKEN), { pending: 0, items: [] });
});

test('決める: 載せる → approved と approved_at。いまある引き金が「返事が届いた」「載りました」を知らせる', async () => {
  await clearQueue();
  await clearOutbox();
  await subscribe(EP(1), A);   // 問いを出した端末
  await subscribe(EP(2), B);   // アプリから答えた端末
  const q = await question('ふつうってなに？', { hash: A });
  assert.deepEqual(await decide(TOKEN, 'question', q, 'approve'), { ok: true, changed: true, pending: 0 });
  const qr = (await admin('select approved, approved_at, rejected_at from questions where id = $1', [q]))[0];
  assert.equal(qr.approved, true);
  assert.ok(qr.approved_at);
  // アプリから「みんなに見せる」（未承認の返事になる）
  const shared = await rpc('app_answer($1, $2, $3, true)', [B, q, 'みんなの平均かな']);
  assert.equal(shared.ok, true);
  const ans = (await admin(`select id from answers where question_id = $1`, [q]))[0].id;
  assert.equal((await queue(TOKEN)).pending, 1);
  await clearOutbox();
  const d = await decide(TOKEN, 'answer', ans, 'approve');
  assert.deepEqual(d, { ok: true, changed: true, pending: 0 });
  assert.deepEqual((await outbox()).sort(), [[EP(1), 'reply'], [EP(2), 'published']]);
  // もう一度押しても何も変わらない
  assert.equal((await decide(TOKEN, 'answer', ans, 'approve')).changed, false);
});

test('決める: 保留はそのまま残る。載せないは消さずに印を付けて一覧から外す。取り消せる', async () => {
  await clearQueue();
  const q = await question('保留する問い');
  const r = await question('載せない問い');
  assert.equal((await queue(TOKEN)).pending, 2);
  assert.deepEqual(await decide(TOKEN, 'question', q, 'hold'), { ok: true, changed: false, pending: 2 });
  assert.deepEqual(await decide(TOKEN, 'question', r, 'reject'), { ok: true, changed: true, pending: 1 });
  const row = (await admin('select approved, rejected_at from questions where id = $1', [r]))[0];
  assert.equal(row.approved, false);
  assert.ok(row.rejected_at);
  assert.deepEqual((await queue(TOKEN)).items.map((i) => i.id), [q]);
  assert.deepEqual(await decide(TOKEN, 'question', r, 'restore'), { ok: true, changed: true, pending: 2 });
  await rejects(decide(TOKEN, 'nope', q, 'approve'), 'bad_kind');
  await rejects(decide(TOKEN, 'question', q, 'publish'), 'bad_action');
  // 載せたものは「載せない」にできない（取り下げは Table Editor で）
  await decide(TOKEN, 'question', q, 'approve');
  assert.equal((await decide(TOKEN, 'question', q, 'reject')).changed, false);
  await clearQueue();
});

test('自動で載る道は無い: 運営の関数のほかに approved を変えられない（anon・authenticated の update・insert）', async () => {
  const q = await question('まだ載っていない問い');
  const pub = await question('載っている問い', { approved: true });
  const a = await reply(pub, 'まだ載っていない返事', { role: 'teen', hash: B });
  for (const role of ['anon', 'authenticated']) {
    await as(role, 'update questions set approved = true, approved_at = now() where id = $1', [q]).catch(() => {});
    await as(role, 'update answers set approved = true where id = $1', [a]).catch(() => {});
    await as(role, 'update questions set approved = true').catch(() => {});
    await as(role, 'update answers set approved = true').catch(() => {});
    await rejects(as(role, `insert into questions (body, approved, source) values ('勝手に', true, 'web')`), 'row-level security');
    await rejects(as(role, `insert into answers (question_id, body, approved) values ($1, '勝手に', true)`, [pub]), 'row-level security');
  }
  assert.equal(await one('approved from questions where id = $1', [q]), false);
  assert.equal(await one('approved from answers where id = $1', [a]), false);
  // 運営の端末でない印・外した端末の印では載せられない
  await rejects(decide(STRANGER, 'question', q, 'approve'), 'not_staff');
  await rejects(decide('', 'answer', a, 'approve'), 'not_staff');
  // 下読みや知らせ（toi_staff_tick）は approved に触れない
  await one(`toi_staff_tick('2026-11-02 07:30:00+09')`);
  assert.equal(await one('approved from questions where id = $1', [q]), false);
  assert.equal(await one('approved from answers where id = $1', [a]), false);
  await clearQueue();
});

test('知らせ: 決まった時刻（既定 7:30・19:30）に、未承認があるときだけ運営の端末へ review。1つの時刻に1回', async () => {
  assert.equal(await one(`value from push_settings where key = 'review_times_jst'`), '07:30,19:30');
  await clearQueue();
  await clearOutbox();
  await db.exec('delete from staff_review_slots');
  await subscribe(EP(9), S);   // 運営の端末（登録で client_hash = S）
  await subscribe(EP(3), C);   // ほかの端末
  // 未承認が0件 → 送らない（時刻は使い切る）
  assert.equal(await one(`toi_staff_tick('${jst('2026-11-02 07:30:00')}')`), 0);
  assert.deepEqual(await outbox(), []);
  await question('朝の問い');
  assert.equal(await one(`toi_staff_tick('${jst('2026-11-02 07:45:00')}')`), 0);   // 7:30 の回はもう済んだ
  // 時刻の前・時刻から1時間を過ぎたら送らない
  assert.equal(await one(`toi_staff_tick('${jst('2026-11-02 19:25:00')}')`), 0);
  assert.equal(await one(`toi_staff_tick('${jst('2026-11-02 20:31:00')}')`), 0);
  await db.exec(`delete from staff_review_slots where slot = '${jst('2026-11-02 19:30:00')}'`);
  assert.equal(await one(`toi_staff_tick('${jst('2026-11-02 19:30:00')}')`), 1);
  assert.deepEqual(await outbox(), [[EP(9), 'review']]);   // 運営の端末だけ
  assert.equal(await one(`toi_staff_tick('${jst('2026-11-02 19:35:00')}')`), 0);
  // 外した端末には送らない
  await clearOutbox();
  await db.exec('delete from staff_review_slots');
  await admin(`update push_settings set value = ' 12:00 , nope, 25:00' where key = 'review_times_jst'`);
  const removed = await rpc('staff_leave($1)', [TOKEN2]);
  assert.deepEqual(removed, { ok: true, removed: false });
  assert.equal(await one(`toi_staff_tick('${jst('2026-11-03 12:00:00')}')`), 1);
  await admin(`update push_settings set value = '07:30,19:30' where key = 'review_times_jst'`);
  await clearOutbox();
  await clearQueue();
});

test('知らせ: 夜（21時〜7時）の時刻なら朝7時に回す。日付をまたぐ時刻も1時間のうちなら送る', async () => {
  await clearOutbox();
  await db.exec('delete from staff_review_slots');
  await db.exec(`update push_settings set value = '21' where key = 'quiet_from_jst'; update push_settings set value = '7' where key = 'quiet_until_jst'`);
  await admin(`update push_settings set value = '23:45' where key = 'review_times_jst'`);
  await question('夜の問い');
  assert.equal(await one(`toi_staff_tick('${jst('2026-11-03 00:10:00')}')`), 1);   // 前の日の 23:45 の回
  const row = (await admin('select kind, send_after from push_outbox'))[0];
  assert.equal(row.kind, 'review');
  assert.equal(new Date(row.send_after).toISOString(), new Date(jst('2026-11-03 07:00:00')).toISOString());
  await db.exec(`update push_settings set value = '24' where key = 'quiet_from_jst'; update push_settings set value = '0' where key = 'quiet_until_jst'`);
  await admin(`update push_settings set value = '07:30,19:30' where key = 'review_times_jst'`);
  await clearOutbox();
  await clearQueue();
});

test('外す: 端末の画面から（staff_leave）・本人が SQL Editor で（toi_staff_unpair）。外した印では何もできない', async () => {
  const r = await pairStart(TOKEN2, B);
  await pair(r.code);
  assert.equal((await admin('select * from toi_staff_list()')).length, 2);
  assert.deepEqual(await rpc('staff_leave($1)', [TOKEN2]), { ok: true, removed: true });
  assert.equal((await status(TOKEN2)).staff, false);
  await rejects(queue(TOKEN2), 'not_staff');
  const [{ number }] = await admin('select number from toi_staff_list()');
  await rejects(one(`toi_staff_unpair('x')`), '番号');
  assert.equal(await one('toi_staff_unpair($1)', [number]), 1);
  assert.equal((await status(TOKEN)).staff, false);
  await rejects(queue(TOKEN), 'not_staff');
  assert.equal(await one(`toi_staff_unpair('all')`), 0);
});
