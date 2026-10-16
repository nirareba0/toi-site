// supabase/line-sync.sql: 公式LINE「問う応える」と問いサイトの同期
// 本物の Supabase の代わりに PGlite で schema.sql → line-notify.sql → line-sync.sql を流し、LINE との通信と署名・ログインの確かめだけ差し替える。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, '..', f), 'utf8').replace(/^create extension .*$/gm, '');
let db;
let seq = 0;

const admin = async (sql, params = []) => (await db.query(sql, params)).rows;
async function as(role, sql, params = []) {
  await db.exec(`set role ${role}`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); }
}
const anon = (sql, params) => as('anon', sql, params);
const rejects = (p, code) => assert.rejects(p, (e) => e.message.includes(code));

// LINE に送ったもの: [path, 相手（push の to / reply の token）, messages]
const sent = async () => (await admin('select path, body from sent order by id'))
  .map((r) => [r.path, r.body.to ?? r.body.replyToken, r.body.messages]);
const clearSent = () => admin('delete from sent');
const texts = (messages) => messages.map((m) => m.text);
const quick = (m) => (m.quickReply?.items ?? []).map((i) => i.action);

// Webhook に届くイベント
const src = (sub) => ({ type: 'user', userId: sub });
const ev = (sub, body) => ({ webhookEventId: `ev${++seq}`, replyToken: `rt${seq}`, mode: 'active', source: src(sub), timestamp: Date.now(), ...body });
const follow = (sub) => ev(sub, { type: 'follow' });
const say = (sub, text) => ev(sub, { type: 'message', message: { type: 'text', id: String(seq), text } });
const press = (sub, data) => ev(sub, { type: 'postback', postback: { data } });
async function hook(events, signature = 'ok') {
  const body = JSON.stringify({ destination: 'Ubot', events });
  return (await as('service_role', 'select line_webhook($1, $2) as n', [body, signature]))[0].n;
}
// いちばん最後の返し
async function lastReply() {
  const r = (await sent()).filter(([p]) => p === 'reply');
  return r[r.length - 1][2];
}

async function question(body = 'なぜ空は青い？', approved = true, hash = null) {
  return (await admin('insert into questions (body, approved, client_hash) values ($1, $2, $3) returning id', [body, approved, hash]))[0].id;
}
const user = async (sub) => (await admin('select * from line_users where line_user_id = $1', [sub]))[0];
const notes = (sub) => admin('select * from line_notes where line_user_id = $1 order by created_at', [sub]);

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
    create schema storage; create table storage.buckets (id text primary key, name text, public boolean);
  `);
  await db.exec(read('schema.sql'));
  await db.exec(read('line-notify.sql'));
  await db.exec(read('line-sync.sql'));
  await db.exec(read('line-reactions.sql'));
  // LINE との通信・署名・ログインを差し替える
  await db.exec(`
    create table sent (id serial, path text, body jsonb);
    create or replace function toi_line_api(p_path text, p_body jsonb) returns jsonb language plpgsql as $$
    begin
      insert into sent (path, body) values (p_path, p_body);
      return jsonb_build_object('status', 'sent', 'request_id', 1);
    end; $$;
    create or replace function toi_line_signature_ok(p_body text, p_signature text) returns boolean language sql as $$
      select p_signature = 'ok';
    $$;
    create or replace function toi_line_verify(p_id_token text) returns text language plpgsql as $$
    begin
      if p_id_token not like 'line-%' then raise exception 'line_login_failed'; end if;
      return substr(p_id_token, 6);
    end; $$;
    create or replace function toi_line_send(p_to text, p_text text) returns jsonb language plpgsql as $$
    begin
      insert into sent (path, body) values ('push', jsonb_build_object('to', p_to, 'messages', jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text))));
      return jsonb_build_object('status', 'sent', 'request_id', 1);
    end; $$;
  `);
  await question('なぜ空は青い？');
  await question('友だちってなんだろう？');
  await question('未公開の問い', false);
});

test('友だち追加 → あいさつ → ジャンル → 頻度。頻度を選ぶと、その場で問いが1つ届く', async () => {
  await clearSent();
  assert.equal(await hook([follow('U1')]), 1);
  const [greet, genre] = await lastReply();
  assert.match(greet.text, /人が読んでいません/);
  assert.match(genre.text, /ジャンルを選んで/);
  assert.deepEqual(quick(genre).map((a) => a.data),
    ['a=genre&t=ikikata', 'a=genre&t=ningen', 'a=genre&t=gakko', 'a=genre&t=koi', 'a=genre&t=nichijo', 'a=genre&t=all', 'a=genredone']);
  assert.equal((await user('U1')).following, true);
  assert.equal((await user('U1')).frequency, 'pull');

  await hook([press('U1', 'a=genre&t=all')]);            // 「ぜんぶ」はそのまま決まる → 頻度を聞く
  const [done, freq] = await lastReply();
  assert.match(done.text, /ジャンル：ぜんぶ/);
  assert.deepEqual(quick(freq).map((a) => a.data), ['a=freq&v=daily', 'a=freq&v=weekly', 'a=freq&v=pull']);

  await hook([press('U1', 'a=freq&v=daily')]);
  assert.equal((await user('U1')).frequency, 'daily');
  const [ok, prompt] = await lastReply();
  assert.match(ok.text, /毎日 19時ごろ/);
  assert.match(prompt.text, /「(なぜ空は青い？|友だちってなんだろう？)」/);
  assert.ok(!prompt.text.includes('未公開'));
  assert.ok(quick(prompt).some((a) => a.uri === 'https://liff.line.me/2011967281-zFeBIrmq?view=notes'));
  assert.ok((await user('U1')).current_question_id);
  // 返しは Reply（数えられない）だけ。Push はしていない
  assert.deepEqual((await sent()).map(([p]) => p), ['reply', 'reply', 'reply']);
});

test('ジャンルを選ぶと、そのジャンルの問いだけが届く。押すたびに入れる／外す。無ければ「ありません」', async () => {
  const koi = (await admin(`insert into questions (body, approved, theme_id) values ('好きってなに？', true, 'koi') returning id`))[0].id;
  await admin(`insert into questions (body, approved, theme_id) values ('勉強する意味は？', true, 'gakko')`);
  await hook([follow('G1')]);
  await hook([press('G1', 'a=genre&t=koi')]);
  let [m] = await lastReply();
  assert.match(m.text, /いま：恋・好き/);
  assert.ok(quick(m).find((a) => a.data === 'a=genre&t=koi').label.startsWith('✓'));
  await hook([press('G1', 'a=genre&t=gakko')]);
  await hook([press('G1', 'a=genre&t=gakko')]);          // もう一度押すと外れる
  assert.deepEqual((await user('G1')).themes, ['koi']);
  await hook([press('G1', 'a=genredone')]);
  assert.match((await lastReply())[0].text, /ジャンル：恋・好き/);
  await hook([press('G1', 'a=freq&v=pull')]);
  const prompt = (await lastReply())[1];
  assert.match(prompt.text, /今日の問い（恋・好き）/);
  assert.match(prompt.text, /好きってなに？/);
  assert.equal((await user('G1')).current_question_id, koi);
  // 2回目以降も恋・好きだけ（1つしか無いので同じ問いを繰り返す）
  await hook([press('G1', 'a=next')]);
  assert.match((await lastReply())[0].text, /好きってなに？/);
  // 「ジャンル」と打つと選び直せる。頻度はもう選んだので、決めたら問いが届く
  await hook([say('G1', 'ジャンル')]);
  assert.match((await lastReply())[0].text, /ジャンルを選んで/);
  await hook([press('G1', 'a=genre&t=koi')]);             // 外す → 何も選んでいない＝ぜんぶ
  assert.equal((await user('G1')).themes, null);
  // 問いの無いジャンルだけにすると「ありません」
  await hook([press('G1', 'a=genre&t=ningen')]);
  await hook([press('G1', 'a=genredone')]);
  assert.match((await lastReply())[1].text, /届けられる問いが、いまはありません/);
  await admin(`update line_users set themes = null where line_user_id = 'G1'`);
});

test('トークに打った答えはノートに残る。10分以内に続けて打つと1つのノートに続く', async () => {
  await clearSent();
  const { current_question_id: q } = await user('U1');
  await hook([say('U1', '光が散らばるから？')]);
  const [m] = await lastReply();
  assert.match(m.text, /ノートに残しました/);
  const [n] = await notes('U1');
  assert.equal(n.question_id, q);
  assert.equal(n.body, '光が散らばるから？');
  assert.equal(quick(m)[0].data, `a=share&n=${n.id}`);

  await hook([say('U1', 'でも夕方は赤い')]);
  const all = await notes('U1');
  assert.equal(all.length, 1);
  assert.equal(all[0].body, '光が散らばるから？\nでも夕方は赤い');
});

test('「みんなに見せる」→ 未承認の返事（中高生）としてサイトに入る。承認されたら本人に「載った」と知らせる。1回だけ', async () => {
  await clearSent();
  const [n] = await notes('U1');
  await hook([press('U1', `a=share&n=${n.id}`)]);
  assert.match((await lastReply())[0].text, /スタッフが確かめてから/);
  const [a] = await admin('select * from answers where id = (select answer_id from line_notes where id = $1)', [n.id]);
  assert.equal(a.role_id, 'teen');
  assert.equal(a.approved, false);
  assert.equal(a.body, n.body);
  // 未承認のうちは公開ビューに出ない
  assert.equal((await anon('select count(*)::int as c from public_answers where id = $1', [a.id]))[0].c, 0);

  await hook([press('U1', `a=share&n=${n.id}`)]);
  assert.match((await lastReply())[0].text, /もうサイトに送ってあります/);
  assert.equal((await admin('select count(*)::int as c from answers where role_id = $1', ['teen']))[0].c, 1);

  // ほかの人のノートは見せられない
  await hook([press('U9', `a=share&n=${n.id}`)]);
  assert.equal((await admin('select count(*)::int as c from answers where role_id = $1', ['teen']))[0].c, 1);

  await clearSent();
  await admin('update answers set approved = true where id = $1', [a.id]);
  const pushes = (await sent()).filter(([p]) => p === 'push');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0][1], 'U1');
  assert.match(pushes[0][2][0].text, /サイトに載りました/);
  assert.ok(pushes[0][2][0].text.includes(`#question/${a.question_id}`));
  assert.equal((await anon('select responder_role from public_answers where id = $1', [a.id]))[0].responder_role, '中高生');
  await admin('update answers set body = body where id = $1', [a.id]);
  assert.equal((await sent()).length, 1);
});

test('死にたい・消えたいなどには相談先を必ず返し、ノートに残さない', async () => {
  await clearSent();
  const before_ = (await notes('U1')).length;
  for (const t of ['もう死にたい', 'きえたい', '学校でいじめられてる']) {
    await hook([say('U1', t)]);
    const [m] = await lastReply();
    assert.match(m.text, /0120-0-78310/);
    assert.match(m.text, /0120-99-7777/);
  }
  assert.equal((await notes('U1')).length, before_);
});

test('答えている問いが無いときは「問いを引く」へ。「問い」と打つと引ける。文字でないものは断る', async () => {
  await hook([follow('U2')]);
  await hook([say('U2', 'こんにちは')]);
  assert.match((await lastReply())[0].text, /まず問いを1つ引いてみて/);
  assert.equal((await notes('U2')).length, 0);
  await hook([say('U2', '問い')]);
  assert.match((await lastReply())[0].text, /今日の問い/);
  await hook([ev('U2', { type: 'message', message: { type: 'sticker', id: 'x' } })]);
  assert.match((await lastReply())[0].text, /文字だけ/);
});

test('問いは、届けていないものから選ぶ。自分が出した問いと、相談先が要る問いは届けない。全部届けたら前に届けたものから', async () => {
  await hook([follow('U3')]);
  const mine = await question('自分の問い', true, 'h3');
  await admin('insert into line_question_owners (question_id, line_user_id) values ($1, $2)', [mine, 'U3']);
  await question('消えたいと思うのは変？');
  const got = new Set();
  for (let i = 0; i < 5; i++) {
    await hook([press('U3', 'a=next')]);
    got.add((await lastReply())[0].text.match(/「(.+)」/)[1]);
  }
  assert.ok(!got.has('自分の問い') && !got.has('消えたいと思うのは変？') && !got.has('未公開の問い'));
  assert.equal(got.size, 4);   // 承認済みで届けてよいのは4つ（ジャンルのテストで2つ足した）。5回目は前に届けたもの
});

test('署名が合わなければ受け付けない。同じイベントが送り直されても1回だけ扱う。ブロックで止まる', async () => {
  await rejects(hook([follow('U4')], 'bad'), 'bad_signature');
  assert.equal(await user('U4'), undefined);
  const e = follow('U4');
  assert.equal(await hook([e]), 1);
  assert.equal(await hook([e]), 0);
  assert.equal(await hook([]), 0);   // LINE Developers の「検証」ボタン
  await hook([ev('U4', { type: 'unfollow' })]);
  assert.equal((await user('U4')).following, false);
});

test('毎日／週1の問い: 選んだ人にだけ1日1通。ブロックした人・自分で引く人には送らない。月の上限で止まる', async () => {
  await clearSent();
  await admin('delete from line_users');
  for (const [sub, f] of [['D1', 'daily'], ['W1', 'weekly'], ['P1', 'pull'], ['X1', 'daily']]) {
    await admin('insert into line_users (line_user_id, following, frequency) values ($1, $2, $3)', [sub, sub !== 'X1', f]);
  }
  assert.equal(await admin('select toi_line_daily() as n').then((r) => r[0].n), 2);
  assert.deepEqual((await sent()).map(([p, to]) => `${p}:${to}`).sort(), ['push:D1', 'push:W1']);
  assert.match((await sent())[0][2][0].text, /今日の問い/);

  // 同じ日にもう一度動いても送らない
  assert.equal(await admin('select toi_line_daily() as n').then((r) => r[0].n), 0);
  // 次の日: 毎日の人だけ。週1の人は7日たってから
  await admin(`update line_users set last_pushed_on = last_pushed_on - 1`);
  assert.equal(await admin('select toi_line_daily() as n').then((r) => r[0].n), 1);
  await admin(`update line_users set last_pushed_on = last_pushed_on - 7 where line_user_id = 'W1'`);
  assert.equal(await admin('select toi_line_daily() as n').then((r) => r[0].n), 1);

  // 月の上限
  await admin(`update line_settings set value = (select count(*) from line_pushes where status = 'sent')::text where key = 'push_monthly_cap'`);
  await admin(`update line_users set last_pushed_on = null`);
  assert.equal(await admin('select toi_line_daily() as n').then((r) => r[0].n), 0);
  assert.equal((await admin(`select count(*)::int as c from line_pushes where status = 'capped'`))[0].c, 1);
  await admin(`update line_settings set value = '150' where key = 'push_monthly_cap'`);
});

test('サイト: この端末で出した問いを LINE に結ぶと、別の端末（LINE の中）でも自分の問いが見え、返事を知らせる', async () => {
  await clearSent();
  const q1 = await question('結ぶ問い（確認中）', false, 'hashA');
  const q2 = await question('結ぶ問い（公開）', true, 'hashA');
  await admin('insert into answers (question_id, body, approved) values ($1, $2, true)', [q2, '前からある返事']);
  const other = await question('ほかの端末の問い', false, 'hashB');

  // 端末の印が合わない問いは結べない
  assert.equal((await anon('select line_link_questions($1, $2, $3) as n', ['line-S1', [q1, q2, other], 'hashA']))[0].n, 2);
  assert.equal((await anon('select line_link_questions($1, $2, $3) as n', ['line-S2', [q1], 'hashA']))[0].n, 0);   // もう結ばれている
  await rejects(anon('select line_link_questions($1, $2, $3)', ['bad', [q1], 'hashA']), 'line_login_failed');

  const mine = (await anon('select line_my_questions($1) as r', ['line-S1']))[0].r;
  assert.deepEqual(mine.map((q) => [q.body, q.approved, Number(q.answer_count)]).sort(),
    [['結ぶ問い（公開）', true, 1], ['結ぶ問い（確認中）', false, 0]]);
  assert.deepEqual((await anon('select line_my_questions($1) as r', ['line-S2']))[0].r, []);

  // 結ぶ前からある返事は知らせない。新しい返事は知らせる
  assert.deepEqual(await sent(), []);
  await admin('insert into answers (question_id, body, approved) values ($1, $2, true)', [q2, '新しい返事']);
  assert.deepEqual((await sent()).map(([p, to]) => `${p}:${to}`), ['push:S1']);
});

test('サイト: ノートは本人だけが読めて消せる。ブラウザから表と Webhook には触れない', async () => {
  await hook([follow('N1')]);
  await hook([press('N1', 'a=next')]);
  await hook([say('N1', 'わたしの答え')]);
  const list = (await anon('select line_my_notes($1) as r', ['line-N1']))[0].r;
  assert.equal(list.length, 1);
  assert.equal(list[0].body, 'わたしの答え');
  assert.ok(list[0].question_body);
  assert.equal(list[0].shared, false);
  assert.deepEqual((await anon('select line_my_notes($1) as r', ['line-N2']))[0].r, []);

  assert.equal((await anon('select line_delete_note($1, $2) as ok', ['line-N2', list[0].id]))[0].ok, false);
  assert.equal((await anon('select line_delete_note($1, $2) as ok', ['line-N1', list[0].id]))[0].ok, true);
  assert.deepEqual((await anon('select line_my_notes($1) as r', ['line-N1']))[0].r, []);

  for (const t of ['line_users', 'line_notes', 'line_question_owners', 'line_prompts', 'line_pushes', 'line_events_seen']) {
    await rejects(anon(`select * from ${t}`), 'permission denied');
  }
  await rejects(anon('select line_webhook($1, $2)', ['{"events":[]}', 'ok']), 'permission denied');
  await rejects(anon('select toi_line_daily()'), 'permission denied');
  await rejects(anon('select toi_line_push($1, $2, $3)', ['U1', '[]', 'x']), 'permission denied');
});

test('載った答えに反応が押されたら、書いた人に知らせる。1つの答えにつき1日1通。だれが押したかは載せない', async () => {
  await hook([follow('R1')]);
  await hook([press('R1', 'a=next')]);
  await hook([say('R1', '反応のテスト')]);
  const [n] = await notes('R1');
  await hook([press('R1', `a=share&n=${n.id}`)]);
  const { answer_id: a } = (await notes('R1'))[0];
  await admin('update answers set approved = true where id = $1', [a]);
  await clearSent();

  await anon(`insert into reactions (target_type, target_id, kind, client_hash) values ('answer', $1, 'kyokan', 'h1')`, [a]);
  const p = (await sent()).filter(([path]) => path === 'push');
  assert.deepEqual(p.map(([, to]) => to), ['R1']);
  assert.match(p[0][2][0].text, /反応が届いたよ/);
  assert.ok(p[0][2][0].text.includes(`#question/${n.question_id}`));
  assert.ok(!p[0][2][0].text.includes('反応のテスト'));
  // 同じ日の2つ目の反応では送らない
  await anon(`insert into reactions (target_type, target_id, kind, client_hash) values ('answer', $1, 'kangaeta', 'h2')`, [a]);
  assert.equal((await sent()).length, 1);
  // 大人の返事・問いへの反応では送らない
  await clearSent();
  const q = (await admin('select question_id from answers where id = $1', [a]))[0].question_id;
  const adult = (await admin(`insert into answers (question_id, body, approved, created_at) values ($1, '昔の返事', true, now() - interval '1 day') returning id`, [q]))[0].id;
  await anon(`insert into reactions (target_type, target_id, kind, client_hash) values ('answer', $1, 'kyokan', 'h3'), ('question', $2, 'kyokan', 'h3')`, [adult, q]);
  assert.deepEqual((await sent()).filter(([, to]) => to === 'R1'), []);   // 問いを待っている人への「返事が届いた」は別
});

test('自分が答えた問いに、ほかの返事が載ったら知らせる。前からある返事・自分の返事では送らない', async () => {
  const [n] = await notes('R1');
  await clearSent();
  const b = (await admin(`insert into answers (question_id, body, approved) values ($1, '大人の新しい返事', false) returning id`, [n.question_id]))[0].id;
  assert.deepEqual(await sent(), []);                       // 未承認のうちは送らない
  await admin('update answers set approved = true where id = $1', [b]);
  const p = (await sent()).filter(([path, to]) => path === 'push' && to === 'R1');
  assert.equal(p.length, 1);
  assert.match(p[0][2][0].text, /ほかの人の返事が載ったよ/);
  await admin('update answers set body = body where id = $1', [b]);   // 二重に送らない
  assert.equal((await sent()).filter(([path, to]) => path === 'push' && to === 'R1').length, 1);
  // 前からある返事（昔の返事）を直しても送らない
  await clearSent();
  await admin(`update answers set body = body where body = '昔の返事'`);
  assert.deepEqual((await sent()).filter(([, to]) => to === 'R1'), []);
});
