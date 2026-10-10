// web/js/line.js
// 問いに返事がきたら LINE で知らせる（supabase/line-notify.sql）。知らせは公式LINE「にらレバ_西村」から届く。
// 問いを出した人が「LINE で知らせてもらう」を押す → LIFF（LINE の中のブラウザ）でこのサイトが ?watch=<問いの id> で開く
// → LINE にログインして ID トークンを受け取る → watch_question で、この問いの返事を待つ。
// LINE の名前やプロフィールは受け取らない（openid だけ）。

// にらレバのプロバイダーの LINE ログインのチャネルに作る LIFF。空のあいだは LINE のボタンを出さない
export const LIFF_ID = "";
// 公式LINE「にらレバ_西村」を友だちに足すリンク（友だちでないと LINE は届かない）
export const FRIEND_URL = "https://line.me/R/ti/p/@914vzoom";
const LIFF_SDK = "https://static.line-scdn.net/liff/edge/2/sdk.js";

export const lineReady = () => Boolean(LIFF_ID);

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
