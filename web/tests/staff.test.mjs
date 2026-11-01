// web/js/staff.mjs: 運営の承認を毎日スマホでさばく（supabase/staff-review.sql の画面側の決まり）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  STAFF_TOKEN_KEY, makeStaffToken, isStaffToken, loadStaffToken, forgetStaffToken, formatPairCode, pairSql, untilText,
  FLAG_CODES, FLAG_INFO, CLEAR_FLAG, flagChips, originText, postedText, badgeText,
  createReview, currentItem, remaining, advance, reviewHeld
} from "../js/staff.mjs";
import { PUSH_KINDS, PUSH_OPEN, PUSH_TEXT } from "../js/push.mjs";
import { resolveRoute } from "../js/core.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test("端末の印: 32 バイトの乱数を 64 桁の 16 進に。形の違うものは印ではない", () => {
  const t = makeStaffToken((a) => a.fill(171));
  assert.equal(t, "ab".repeat(32));
  assert.equal(isStaffToken(t), true);
  assert.equal(isStaffToken(makeStaffToken()), true);
  assert.notEqual(makeStaffToken(), makeStaffToken());
  for (const bad of ["", "ab", "AB".repeat(32), "g".repeat(64), null, undefined, 123]) assert.equal(isStaffToken(bad), false, String(bad));
});

test("端末の印を読む: 無ければ作って localStorage に置く（create のときだけ）。使えなければ null", () => {
  const s = memoryStorage();
  assert.equal(loadStaffToken(s), null);
  const t = loadStaffToken(s, { create: true });
  assert.equal(isStaffToken(t), true);
  assert.equal(s.getItem(STAFF_TOKEN_KEY), t);
  assert.equal(loadStaffToken(s, { create: true }), t);   // 2回目は同じ印
  assert.equal(loadStaffToken(memoryStorage({ [STAFF_TOKEN_KEY]: "nope" })), null);
  assert.equal(loadStaffToken(null, { create: true }), null);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => {} };
  assert.equal(loadStaffToken(broken, { create: true }), null);
  const noSave = { getItem: () => null, setItem: () => {} };   // 置いても残らない（プライベートブラウズなど）
  assert.equal(loadStaffToken(noSave, { create: true }), null);
  forgetStaffToken(s);
  assert.equal(loadStaffToken(s), null);
});

test("登録コード: 「123 456」と見せ、SQL Editor に貼る1行は数字だけ", () => {
  assert.equal(formatPairCode("012345"), "012 345");
  assert.equal(formatPairCode("12345"), "12345");
  assert.equal(pairSql("012345"), "select toi_staff_pair('012345');");
  assert.equal(pairSql("01'2; drop"), "select toi_staff_pair('012');");
  assert.equal(untilText(new Date(2026, 10, 1, 9, 5)), "9:05 まで");
  assert.equal(untilText("nope"), "");
});

test("下読みの札: 決まった順・知らない印は出さない・何も無ければ「気になる点なし」", () => {
  assert.deepEqual(FLAG_CODES, Object.keys(FLAG_INFO));
  assert.deepEqual(flagChips([]), [CLEAR_FLAG]);
  assert.deepEqual(flagChips(null), [CLEAR_FLAG]);
  assert.deepEqual(flagChips(["nope"]), [CLEAR_FLAG]);
  assert.deepEqual(flagChips(["burst", "name", "sos"]).map((c) => c.code), ["sos", "name", "burst"]);
  assert.equal(flagChips(["sos"])[0].tone, "danger");
  assert.equal(flagChips(["contact"])[0].tone, "warn");
  assert.equal(flagChips(["burst"])[0].tone, "muted");
  for (const c of FLAG_CODES) assert.ok(FLAG_INFO[c].label.length <= 10, c);   // 390px で1行に並ぶ短さ
  // DB の下読み（staff-review.sql）と同じ言葉
  const sql = read("supabase/staff-review.sql");
  for (const c of FLAG_CODES) assert.ok(sql.includes(`'${c}'`), c);
});

test("どこから来たか・時刻・件数のバッジ", () => {
  assert.equal(originText({ kind: "answer", via: "line" }), "LINE から");
  assert.equal(originText({ kind: "answer", via: "app" }), "アプリから");
  assert.equal(originText({ kind: "answer", via: "x" }), "サイト・その他");
  assert.equal(originText({ kind: "question", source: "paper" }), "紙のカード");
  assert.equal(originText({ kind: "question" }), "サイトから");
  assert.equal(postedText(new Date(2026, 10, 1, 19, 5).toISOString()), "11月1日 19:05");
  assert.equal(postedText("x"), "");
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(-1), "");
  assert.equal(badgeText(NaN), "");
  assert.equal(badgeText(7), "7");
  assert.equal(badgeText(120), "99+");
});

test("1枚ずつ: 載せる・載せないで次へ。保留は後ろに回り、最後にもう一度見られる。載せないは直前の1枚だけ取り消せる", () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
  let r = createReview(items);
  assert.equal(currentItem(r).id, 1);
  assert.equal(remaining(r), 3);
  r = advance(r, "approve");
  assert.equal(currentItem(r).id, 2);
  r = advance(r, "hold");
  assert.equal(currentItem(r).id, 3);
  assert.deepEqual(r.held.map((i) => i.id), [2]);
  r = advance(r, "reject");
  assert.equal(currentItem(r), null);
  assert.equal(r.done, 2);
  assert.equal(r.last.id, 3);
  r = advance(r, "restore");
  assert.equal(currentItem(r).id, 3);
  assert.equal(r.done, 1);
  assert.equal(advance(r, "restore"), r);   // 2回は戻せない
  r = advance(r, "approve");
  assert.equal(currentItem(r), null);
  r = reviewHeld(r);
  assert.deepEqual(r.items.map((i) => i.id), [2]);
  assert.deepEqual(r.held, []);
  assert.equal(advance(createReview([]), "approve").items.length, 0);
  assert.equal(advance(r, "nope"), r);
  assert.deepEqual(items.map((i) => i.id), [1, 2, 3]);   // 元の並びは変えない
});

test("知らせ review: 文は件数も本文も持たない。押すと #staff。送る列・Edge Function・画面の種類がそろっている", async () => {
  assert.equal(PUSH_TEXT.review, "承認待ちが届いています");
  assert.equal(/[0-9０-９]/.test(PUSH_TEXT.review), false);
  assert.equal(PUSH_OPEN.review, "#staff");
  assert.deepEqual(resolveRoute("#staff"), { type: "route", path: "staff", paramId: undefined });
  assert.equal(resolveRoute("#staff/x").type, "not_found");
  for (const f of ["supabase/staff-review.sql", "supabase/app-standalone.sql"]) {
    const m = read(f).match(/push_outbox_kind_check\s+check \(kind in \(([^)]+)\)\)/);
    assert.ok(m, f);
    assert.deepEqual(m[1].split(",").map((s) => s.trim().replace(/'/g, "")), PUSH_KINDS, f);
  }
  const { KINDS } = await import("../../supabase/functions/notify-push/deliver.mjs");
  assert.deepEqual(KINDS, PUSH_KINDS);
});

test("staff-review.sql: 秘密の値を持たない。既定の時刻は 7:30 と 19:30（勤務時間の外）", () => {
  const sql = read("supabase/staff-review.sql");
  assert.match(sql, /\('review_times_jst', '07:30,19:30'\)/);
  assert.equal(/eyJ[A-Za-z0-9_-]{20,}/.test(sql), false);
  assert.equal(/sk_|service_role_key|secret\s*=/.test(sql), false);
});
