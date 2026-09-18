// supabase/upload-cards.mjs
// 実物カードのスキャン画像 (54枚のJPG) を private バケット cards にアップロードし、
// questions.card_image にパスを記録するスクリプト。
//
// ==============================================================================
// 重要: 公開 URL (getPublicUrl) は絶対に作成・発行しないこと。
// 実物カードのスキャン画像は中高生の手書き文字を含む非公開資料です。
// バケット 'cards' は private 設定とし、公開側の HTML/JS には一切露出しません。
// 運営スタッフが確認する際は、service_role 権限による署名付き URL
// (createSignedUrl) を都度発行して閲覧する運用とします。
// ==============================================================================

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const customDir = args.find(a => !a.startsWith("--"));

// カード画像ディレクトリの探索
const candidateDirs = [
  customDir,
  resolve(process.cwd(), "cards"),
  resolve(process.cwd(), "supabase/cards"),
  "/Users/nishimuranaoki/Downloads/AIプロダクト/Miacis/問いサイト/cards"
].filter(Boolean);

let cardsDir = null;
for (const dir of candidateDirs) {
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    cardsDir = dir;
    break;
  }
}

if (!cardsDir) {
  if (isDryRun) {
    console.log("[dry-run] カード画像ディレクトリが指定されていません。");
    console.log("使用例: node supabase/upload-cards.mjs [path/to/cards-dir] [--dry-run]");
    process.exit(0);
  } else {
    console.error("エラー: カード画像ディレクトリが見つかりません。パスを指定してください。");
    console.error("使用例: node supabase/upload-cards.mjs [path/to/cards-dir] [--dry-run]");
    process.exit(1);
  }
}

const allEntries = readdirSync(cardsDir);
const jpgFiles = allEntries.filter(f => /\.(jpe?g)$/i.test(f)).sort();

if (isDryRun) {
  console.log(`[dry-run] カード画像ディレクトリ: ${cardsDir}`);
  console.log(`[dry-run] 対象ファイル数: ${jpgFiles.length} 件 (JPG画像)`);
  console.log("[dry-run] 保存先: Storage バケット 'cards' (private)");
  console.log("[dry-run] 認証情報不要モードのため、アップロードおよび questions.card_image の更新はスキップします。");
  process.exit(0);
}

// アップロード実行
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("エラー: 環境変数 SUPABASE_URL および SUPABASE_SERVICE_ROLE_KEY を設定してください。");
  process.exit(1);
}

console.log(`${jpgFiles.length} 件のカード画像を private バケット 'cards' にアップロード中...`);

for (const file of jpgFiles) {
  const filePath = join(cardsDir, file);
  const fileBuffer = readFileSync(filePath);
  const storagePath = file; // バケット内の相対パス

  // Supabase Storage REST API 経由でアップロード (upsert)
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/cards/${encodeURIComponent(storagePath)}`;
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "image/jpeg",
      "x-upsert": "true"
    },
    body: fileBuffer
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    console.error(`失敗 [${file}]: ${err}`);
  } else {
    console.log(`成功 [${file}] -> cards/${storagePath}`);
  }
}

console.log("カード画像のアップロード処理が完了しました。");
