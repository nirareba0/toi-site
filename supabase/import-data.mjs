// supabase/import-data.mjs
// 旧 data.json（69問・67返事）と supabase/data-fixups.json から Supabase REST 経由でデータを移行する。
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const customPath = args.find(a => !a.startsWith("--"));

// data.json の探索パス
const candidateDataPaths = [
  customPath,
  resolve(process.cwd(), "data.json"),
  resolve(__dirname, "data.json"),
  resolve(__dirname, "../data.json"),
  process.env.DATA_JSON_PATH,
  "/Users/nishimuranaoki/Downloads/AIプロダクト/Miacis/問いサイト/data.json",
  "/Users/nishimuranaoki/Library/CloudStorage/GoogleDrive-naoki.nishimura@kawarabe.com/マイドライブ/開発・AIプロダクト/AIproduct/問いサイト/data.json"
].filter(Boolean);

let dataPath = null;
for (const p of candidateDataPaths) {
  if (existsSync(p)) {
    dataPath = p;
    break;
  }
}

if (!dataPath) {
  console.error("エラー: data.json が見つかりません。パスを引数で指定してください。");
  console.error("使用例: node supabase/import-data.mjs [path/to/data.json] [--dry-run]");
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(dataPath, "utf8"));
} catch (e) {
  console.error(`エラー: ${dataPath} の読み込みに失敗しました: ${e.message}`);
  process.exit(1);
}

const fixupsPath = resolve(__dirname, "data-fixups.json");
const hasFixups = existsSync(fixupsPath);

if (!hasFixups) {
  if (isDryRun) {
    console.log(`[dry-run] data.json を読み込みました (問い: ${(data.questions ?? []).length}件, 返事: ${(data.answers ?? []).length}件)`);
    console.log(`[dry-run] fixups がありません (${fixupsPath} が見つかりません)。`);
    console.log("[dry-run] 回答者名→立場のマッピング情報がないため、安全のためデータの変換・投入は行わず停止します（回答者名は出力しません）。");
    process.exit(0);
  } else {
    console.error(`エラー: fixups がありません (${fixupsPath} が見つかりません)。処理を中止します。`);
    process.exit(1);
  }
}

let fixups;
try {
  fixups = JSON.parse(readFileSync(fixupsPath, "utf8"));
} catch (e) {
  console.error(`エラー: ${fixupsPath} の解析に失敗しました: ${e.message}`);
  process.exit(1);
}

const responderRoles = fixups.responderRoles ?? {};
const questionBodyFixes = fixups.questionBodyFixes ?? {};
const answerBodyFixes = fixups.answerBodyFixes ?? {};
const dropQuestions = new Set((fixups.dropQuestions ?? []).map(String));
const answerCards = fixups.answerCards ?? {};
const questionCardFixes = fixups.questionCardFixes ?? {};

// 統合: drop 側の問いを消し、その返事を keep 側に付け替える
const mergeInto = new Map();   // drop id -> keep id
for (const m of fixups.mergeQuestions ?? []) {
  for (const d of m.drop ?? []) {
    mergeInto.set(String(d), String(m.keep));
    dropQuestions.add(String(d));
  }
}

// 立場が未確定（__CONFIRM__）のまま投入しない
const unconfirmed = Object.entries(fixups.responderRoles ?? {})
  .filter(([, role]) => String(role).includes("__CONFIRM__"));
if (unconfirmed.length > 0) {
  console.error("エラー: 回答者の立場が未確定のままです。推測で公開しないため中止します。");
  console.error("       data-fixups.json の responderRoles から __CONFIRM__ を消し、本人が決めた立場を書いてください:");
  for (const [name, role] of unconfirmed) console.error(`  - ${name}: ${role}`);
  process.exit(1);
}

// 回答者名が responderRoles にすべて定義されているか検証
const unmappedAuthors = new Set();
for (const a of data.answers ?? []) {
  if (dropQuestions.has(String(a.question_id))) continue;
  const author = (a.author ?? "").trim();
  if (author && !(author in responderRoles)) {
    unmappedAuthors.add(author);
  }
}

if (unmappedAuthors.size > 0) {
  console.error("エラー: responderRoles にマッピングされていない回答者名が存在します。勝手に推測せず、fixups に立場を追加してください:");
  for (const name of unmappedAuthors) {
    console.error(`  - ${name}`);
  }
  process.exit(1);
}

const THEME = {
  "生き方・哲学": "ikikata",
  "人間関係・孤独": "ningen",
  "学び・学校": "gakko",
  "恋愛・好意": "koi",
  "日常・モヤモヤ": "nichijo",
  "Miacisについて": "miacis",
};

// 旧IDから決定的なUUIDを生成（何度実行しても同一IDになる）
const uuidFor = legacyId => {
  const h = [...String(legacyId)].reduce((a, c) => ((a * 33) ^ c.charCodeAt(0)) >>> 0, 5381).toString(16).padStart(8, "0");
  return `${h}-0000-4000-8000-${String(legacyId).replace(/[^0-9a-f]/gi, "0").padEnd(12, "0").slice(0, 12)}`;
};

const parseDate = s => {
  if (!s) return new Date().toISOString();
  let t = new Date(String(s).replace(/\//g, "-").replace(/(\d{4})-(\d{1,2})-(\d{1,2})/, (_, y, m, d) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`));
  if (isNaN(t)) {
    const m = String(s).match(/(\d{1,2})月(\d{1,2})日?/);
    if (m) t = new Date(`2025-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}T00:00:00Z`);
  }
  return isNaN(t) ? new Date().toISOString() : t.toISOString();
};

const questionsToInsert = [];
const modifiedQuestions = [];
for (const q of data.questions ?? []) {
  if (dropQuestions.has(String(q.id))) continue;
  let body = q.text ?? "";
  if (questionBodyFixes[q.id]) {
    body = questionBodyFixes[q.id];
    modifiedQuestions.push({ id: q.id, original: q.text, fixed: body });
  }
  const theme_id = THEME[q.category] ?? null;
  const createdAt = parseDate(q.date);
  questionsToInsert.push({
    id: uuidFor(q.id),
    body,
    nickname: q.author || null,
    theme_id,
    card_image: Object.prototype.hasOwnProperty.call(questionCardFixes, q.id)
      ? questionCardFixes[q.id]
      : (q.card_image || null),
    source: q.card_image ? "paper" : "web",
    approved: true,
    approved_at: createdAt,
    created_at: createdAt
  });
}

const answersToInsert = [];
const modifiedAnswers = [];
const seenAnswerIds = new Set();
for (const a of data.answers ?? []) {
  const rawQid = String(a.question_id);
  const qid = mergeInto.get(rawQid) ?? rawQid;      // 統合先に付け替える
  if (dropQuestions.has(qid)) continue;              // 付け替えた先も消えているなら捨てる
  if (seenAnswerIds.has(a.id)) continue;             // 統合で重複した同一の返事は1件にする
  seenAnswerIds.add(a.id);
  let body = a.text ?? "";
  if (answerBodyFixes[a.id]) {
    body = answerBodyFixes[a.id];
    modifiedAnswers.push({ id: a.id, original: a.text, fixed: body });
  }
  const author = (a.author ?? "").trim();
  const responder_role = author ? (responderRoles[author] ?? null) : null;
  const createdAt = parseDate(a.date);
  answersToInsert.push({
    id: uuidFor("a" + a.id),
    question_id: uuidFor(mergeInto.get(String(a.question_id)) ?? String(a.question_id)),
    body,
    nickname: null, // nickname は一切入れない（null）
    card_image: answerCards[a.id] ?? null,
    responder_role,
    approved: true,
    approved_at: createdAt,
    created_at: createdAt
  });
}

if (isDryRun) {
  console.log(`[dry-run] 完了: 投入予定の問い ${questionsToInsert.length} 件, 返事 ${answersToInsert.length} 件`);
  console.log(`[dry-run] 除外された問い (drop + merge): ${dropQuestions.size} 件`);
  console.log(`[dry-run] 統合 (mergeQuestions): ${(fixups.mergeQuestions ?? []).length} 組 / 返事の付け替え: ${mergeInto.size} 件`);
  console.log(`[dry-run] 返事に紐づけたカード画像 (answerCards): ${Object.keys(answerCards).length} 件`);
  console.log(`[dry-run] 本文修正 (questionBodyFixes): ${modifiedQuestions.length} 件`);
  for (const m of modifiedQuestions) {
    console.log(`  - 問い [${m.id}]: "${m.original}" -> "${m.fixed}"`);
  }
  console.log(`[dry-run] 本文修正 (answerBodyFixes): ${modifiedAnswers.length} 件`);
  for (const m of modifiedAnswers) {
    console.log(`  - 返事 [${m.id}]: "${m.original}" -> "${m.fixed}"`);
  }
  console.log(`[dry-run] 回答者の立場マッピング (responderRoles): ${Object.keys(responderRoles).length} 件適用`);
  process.exit(0);
}

// REST 経由での投入実行
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("エラー: 環境変数 SUPABASE_URL および SUPABASE_SERVICE_ROLE_KEY を設定してください。");
  process.exit(1);
}

async function insertBatch(table, rows, chunkSize = 50) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=ignore-duplicates"
      },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${table} の投入に失敗しました (status ${res.status}): ${errText}`);
    }
  }
}

try {
  console.log(`Supabase REST へ問い ${questionsToInsert.length} 件を投入中...`);
  await insertBatch("questions", questionsToInsert);
  console.log(`Supabase REST へ返事 ${answersToInsert.length} 件を投入中...`);
  await insertBatch("answers", answersToInsert);
  console.log("投入が正常に完了しました。");
} catch (e) {
  console.error(`投入失敗: ${e.message}`);
  process.exit(1);
}
