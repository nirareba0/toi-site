// web/js/standalone.mjs: ホーム画面のアプリだけで答える（supabase/app-standalone.sql）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SOS_PATTERN, isSos, SOS_CONTACTS, telHref, checkAnswer, MAX_ANSWER_LENGTH, reasonText, REASON_TEXT,
  FREQUENCIES, isFrequency, frequencyText, selectableThemes, toggleTheme, themesLabel, noteStatus, deliveredText
} from "../js/standalone.mjs";
import { resolveRoute } from "../js/core.mjs";
import { PUSH_KINDS, PUSH_OPEN } from "../js/push.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

test("相談先が要る言葉: line-sync.sql の toi_line_is_sos と同じ並び（判定を2か所でずらさない）", () => {
  const m = read("supabase/line-sync.sql").match(/function toi_line_is_sos[\s\S]*?p_text ~ '([^']+)'/);
  assert.ok(m, "line-sync.sql に toi_line_is_sos が無い");
  assert.equal(SOS_PATTERN, m[1]);
  for (const t of ["もう死にたい", "きえたい…", "学校でいじめられてる", "もうむり"]) assert.equal(isSos(t), true, t);
  for (const t of ["空はなぜ青い？", "", null, undefined]) assert.equal(isSos(t), false, String(t));
});

test("相談先の番号: line-sync.sql の文と同じ。電話のリンクは数字だけ", () => {
  const sql = read("supabase/line-sync.sql");
  for (const c of SOS_CONTACTS) {
    assert.ok(sql.includes(c.name) && sql.includes(c.tel), c.name);
  }
  assert.equal(telHref("0120-0-78310"), "tel:0120078310");
});

test("送る前の確かめ: 相談先が要る言葉は、空や長さより先に。前後の空白は落とす", () => {
  assert.deepEqual(checkAnswer("  わからないけど、こう思う  "), { ok: true, body: "わからないけど、こう思う" });
  assert.deepEqual(checkAnswer("   "), { ok: false, reason: "empty" });
  assert.deepEqual(checkAnswer("あ".repeat(MAX_ANSWER_LENGTH)), { ok: true, body: "あ".repeat(MAX_ANSWER_LENGTH) });
  assert.deepEqual(checkAnswer("あ".repeat(MAX_ANSWER_LENGTH + 1)), { ok: false, reason: "too_long" });
  assert.deepEqual(checkAnswer("死にたい" + "あ".repeat(MAX_ANSWER_LENGTH + 1)), { ok: false, reason: "sos" });
  assert.equal(MAX_ANSWER_LENGTH, 2000);   // app_notes.body・answers.body の上限
});

test("断りの文: DB の理由ぜんぶに文がある。知らない理由は「うまく送れませんでした」", () => {
  const sql = read("supabase/app-standalone.sql");
  const reasons = new Set([...sql.matchAll(/'reason', '([a-z_]+)'/g)].map((m) => m[1]));
  reasons.delete("sos");   // 相談先は文ではなく、相談先の欄を出す
  assert.ok(reasons.size >= 4);
  for (const r of reasons) assert.ok(REASON_TEXT[r], r);
  assert.equal(reasonText("nope"), REASON_TEXT.failed);
});

test("届く頻度とジャンル: LINE と同じ3つ。居場所のこと（miacis）は選ばせない。空は「ぜんぶ」", () => {
  assert.deepEqual(FREQUENCIES.map((f) => f.id), ["daily", "weekly", "pull"]);
  assert.equal(isFrequency("weekly"), true);
  assert.equal(isFrequency("hourly"), false);
  assert.match(frequencyText("daily", 19), /毎日 19時ごろ/);
  assert.match(frequencyText("pull"), /こちらからは届けません/);
  const themes = [{ id: "ikikata", label: "生き方" }, { id: "koi", label: "恋・好き" }, { id: "miacis", label: "居場所のこと" }];
  assert.deepEqual(selectableThemes(themes).map((t) => t.id), ["ikikata", "koi"]);
  assert.deepEqual(toggleTheme([], "koi"), ["koi"]);
  assert.deepEqual(toggleTheme(["koi", "ikikata"], "koi"), ["ikikata"]);
  assert.equal(themesLabel(themes, null), "ぜんぶ");
  assert.equal(themesLabel(themes, []), "ぜんぶ");
  assert.equal(themesLabel(themes, ["koi", "ikikata"]), "生き方・恋・好き");
  assert.equal(themesLabel(themes, ["miacis"]), "ぜんぶ");
});

test("ノートの状態と、今日の問いの届いた時", () => {
  assert.equal(noteStatus({ shared: true, published: true }).key, "published");
  assert.equal(noteStatus({ shared: true, published: false }).key, "shared");
  assert.equal(noteStatus({}).key, "private");
  const now = new Date(2026, 10, 1, 20, 0);
  assert.equal(deliveredText({ via: "daily", delivered_at: new Date(2026, 10, 1, 19, 0).toISOString() }, now), "今日 19:00に届いた問い");
  assert.equal(deliveredText({ via: "pull", delivered_at: new Date(2026, 9, 30, 8, 5).toISOString() }, now), "10月30日に引いた問い");
  assert.equal(deliveredText({ via: "pull" }, now), "");
});

test("画面: #today がある。知らせを押すと今日の問い・自分のノートが開く", () => {
  assert.deepEqual(resolveRoute("#today"), { type: "route", path: "today", paramId: undefined });
  assert.equal(resolveRoute("#today/x").type, "not_found");
  for (const k of PUSH_KINDS) assert.equal(resolveRoute(PUSH_OPEN[k]).type, "route", k);
  assert.equal(PUSH_OPEN.today, "#today");
  for (const k of ["published", "reaction", "other_answer"]) assert.equal(PUSH_OPEN[k], "#notes");
});

test("送る列の種類（app-standalone.sql の check）・Edge Function・画面の種類がそろっている", async () => {
  const m = read("supabase/app-standalone.sql").match(/push_outbox_kind_check\s+check \(kind in \(([^)]+)\)\)/);
  assert.ok(m);
  const kinds = m[1].split(",").map((s) => s.trim().replace(/'/g, ""));
  assert.deepEqual(kinds, PUSH_KINDS);
  const { KINDS } = await import("../../supabase/functions/notify-push/deliver.mjs");
  assert.deepEqual(KINDS, PUSH_KINDS);
});
