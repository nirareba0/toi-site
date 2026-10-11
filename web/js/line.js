// web/js/line.js
// 問いに返事がきたら LINE で知らせる（supabase/line-notify.sql）。知らせは中高生向けの公式LINE「問う応える」（@803ifgkb・運営 たいど）から届く。
// 問いを出した人が「LINE で知らせてもらう」を押す → LIFF（LINE の中のブラウザ）でこのサイトが ?watch=<問いの id> で開く
// → LINE にログインして ID トークンを受け取る → watch_question で、この問いの返事を待つ。
// LINE の名前やプロフィールは受け取らない（openid だけ）。

// LINE ログインのチャネルの LIFF。チャネルは公式LINE「問う応える」と同じプロバイダー「たいど」（1660696937）に置く
// （LINE の ID はプロバイダーごとに違うので、別のプロバイダーだと知らせが届かない）
export const LIFF_ID = "2011959095-ypYa664R";
// 試しのあいだは、?linetest で開いた端末にだけボタンを出す（みんなに出すときに true にする）
export const LINE_PUBLIC = false;
const TEST_KEY = "toi.line_test";
// 公式LINE「問う応える」を友だちに足すリンク（友だちでないと LINE は届かない）
export const FRIEND_URL = "https://line.me/R/ti/p/@803ifgkb";
const LIFF_SDK = "https://static.line-scdn.net/liff/edge/2/sdk.js";

// ?linetest で開いたら、この端末を試しの端末にする（読み込んだときに1回）
try {
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("linetest")) localStorage.setItem(TEST_KEY, "1");
} catch {
  // localStorage が使えない
}

export function lineReady() {
  if (!LIFF_ID) return false;
  if (LINE_PUBLIC) return true;
  try {
    return localStorage.getItem(TEST_KEY) === "1" || Boolean(watchRequest());
  } catch {
    return false;
  }
}

/** 「LINE で知らせてもらう」のリンク。LINE の中でも外でも開ける */
export const watchUrl = (questionId) => `https://liff.line.me/${LIFF_ID}?watch=${encodeURIComponent(questionId)}`;

/** いまのページが「この問いを LINE で待つ」で開かれたなら、その問いの id */
export function watchRequest(search = location.search) {
  const q = new URLSearchParams(search);
  if (q.has("watch")) return q.get("watch");
  // LIFF のリンクから来た直後は liff.state に入っている（liff.init のあとで ?watch= に戻る）
  const st = q.get("liff.state");
  if (st) return new URLSearchParams(st.replace(/^[^?]*/, "")).get("watch");
  return null;
}

function loadLiff() {
  if (window.liff) return Promise.resolve(window.liff);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LIFF_SDK;
    s.onload = () => resolve(window.liff);
    s.onerror = () => reject(new Error("LINE につながらなかった"));
    document.head.appendChild(s);
  });
}

/** LINE の ID トークン。ログインしていなければ LINE のログイン画面へ移る（戻ってくるまで進まない） */
export async function lineIdToken() {
  const liff = await loadLiff();
  await liff.init({ liffId: LIFF_ID });
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: location.href });
    await new Promise(() => {});
  }
  return liff.getIDToken();
}
