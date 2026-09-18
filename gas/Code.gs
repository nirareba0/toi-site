/**
 * 問う応える — 配布済み QR の飛び先（旧 GAS Web アプリ）を新サイトへ転送するスタブ。
 *
 * 使い方:
 *  1. スプレッドシート「問いサイトデータ」→ 拡張機能 → Apps Script を開く（旧「問いの掲示板」のコード）
 *  2. 旧コードは残したまま、このファイルの内容で doGet を置き換える（旧 doGet は doGet_old に改名して残す）
 *  3. NEW_SITE_URL を新サイトの URL にする
 *  4. デプロイ → デプロイを管理 → 既存のデプロイを編集 → 新バージョン → デプロイ
 *     （URL は変わらない。配布済みの QR はそのまま新サイトに飛ぶ）
 *
 * NEW_SITE_URL が空のあいだは旧 doGet_old にそのまま渡すので、貼るだけなら何も変わらない。
 */
var NEW_SITE_URL = "https://nirareba0.github.io/toi-site/";

function doGet(e) {
  if (!NEW_SITE_URL) {
    return (typeof doGet_old === "function") ? doGet_old(e) : HtmlService.createHtmlOutput("準備中");
  }
  var q = (e && e.parameter && e.parameter.q) ? ("?q=" + encodeURIComponent(e.parameter.q)) : "";
  var target = NEW_SITE_URL + q;
  var html =
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="refresh" content="0; url=' + target + '">' +
    '<title>問う応える</title>' +
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:sans-serif;color:#333;background:#faf8f3}a{color:#c9442a}</style>' +
    '</head><body><p>新しい「問う応える」へ移動します… <a href="' + target + '">開かない場合はこちら</a></p>' +
    '<script>location.replace(' + JSON.stringify(target) + ');</script></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle("問う応える")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
