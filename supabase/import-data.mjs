// 既存の data.json（旧サイト。69 問・67 返事・カード画像パス）を Supabase 用の SQL に変換する。
//   node supabase/import-data.mjs <data.json> > supabase/seed-legacy.sql
// 方針: 既存分は承認済み（approved=true）で入れる。回答者名は nickname にそのまま入れるが、
//       公開時の名前の扱い（実名／ニックネーム／匿名）は要件確認で決めるまで UI 側で出さない。
import { readFileSync } from "node:fs";

const src = process.argv[2];
if (!src) { console.error("usage: node supabase/import-data.mjs <data.json>"); process.exit(1); }
const d = JSON.parse(readFileSync(src, "utf8"));

const THEME = {
  "生き方・哲学": "ikikata", "人間関係・孤独": "ningen", "学び・学校": "gakko",
  "恋愛・好意": "koi", "日常・モヤモヤ": "nichijo", "Miacisについて": "miacis",
};
const q = s => "'" + String(s ?? "").replace(/'/g, "''") + "'";
const nul = s => (s == null || s === "" ? "null" : q(s));
const uuidFor = legacyId => {
  // 旧 ID（8 桁 hex など）から決定的に UUID を作る。再実行しても同じ行になる
  const h = [...String(legacyId)].reduce((a, c) => ((a * 33) ^ c.charCodeAt(0)) >>> 0, 5381).toString(16).padStart(8, "0");
  return `${h}-0000-4000-8000-${String(legacyId).replace(/[^0-9a-f]/gi, "0").padEnd(12, "0").slice(0, 12)}`;
};
const date = s => {
  if (!s) return "now()";
  let t = new Date(String(s).replace(/\//g, "-").replace(/(\d{4})-(\d{1,2})-(\d{1,2})/, (_, y, m, d) => `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`));
  if (isNaN(t)) { const m = String(s).match(/(\d{1,2})月(\d{1,2})日?/); if (m) t = new Date(`2025-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`); }
  return isNaN(t) ? "now()" : q(t.toISOString());
};

const out = ["begin;"];
for (const x of d.questions ?? []) {
  const theme = THEME[x.category] ?? null;
  out.push(`insert into questions (id, body, nickname, theme_id, card_image, source, approved, approved_at, created_at) values (` +
    `${q(uuidFor(x.id))}, ${q(x.text)}, ${nul(x.author)}, ${theme ? q(theme) : "null"}, ${nul(x.card_image)}, ` +
    `${x.card_image ? "'paper'" : "'web'"}, true, now(), ${date(x.date)}) on conflict (id) do nothing;`);
}
for (const a of d.answers ?? []) {
  out.push(`insert into answers (id, question_id, body, nickname, approved, approved_at, created_at) values (` +
    `${q(uuidFor("a" + a.id))}, ${q(uuidFor(a.question_id))}, ${q(a.text)}, ${nul(a.author)}, true, now(), ${date(a.date)}) on conflict (id) do nothing;`);
}
out.push("commit;");
console.log(out.join("\n"));
console.error(`questions: ${(d.questions ?? []).length}, answers: ${(d.answers ?? []).length}`);
