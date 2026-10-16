// web/js/line.js
// 公式LINE「問いポスト」（@803ifgkb・運営 たいど）とつなぐ。
// - 問いに返事がきたら LINE で知らせる（supabase/line-notify.sql）: 「LINE で知らせてもらう」→ LIFF（LINE の中のブラウザ）で ?watch=<問いの id> → watch_question
// - LINE と同期する（supabase/line-sync.sql）: LINE でログインした人の「自分の問い」と「ノート」（LINE で答えたもの）を、端末をまたいで同じにする
// LINE の名前やプロフィールは受け取らない（openid だけ）。

// LINE ログインのチャネルの LIFF。チャネルは公式LINE「問いポスト」と同じプロバイダー「たいど」（1660696937）に置く
// （LINE の ID はプロバイダーごとに違うので、別のプロバイダーだと知らせが届かない）
export const LIFF_ID = "2011967281-zFeBIrmq";
// 試しのあいだは、?linetest で開いた端末にだけボタンを出す（みんなに出すときに true にする）
export const LINE_PUBLIC = false;
const TEST_KEY = "toi.line_test";
// 公式LINE「問いポスト」を友だちに足すリンク（友だちでないと LINE は届かない）
export const FRIEND_URL = "https://line.me/R/ti/p/@803ifgkb";
const LIFF_SDK = "https://static.line-scdn.net/liff/edge/2/sdk.js";
// LINE の中から開ける画面（?view=）。LINE のトークやリッチメニューから https://liff.line.me/<LIFF_ID>?view=notes で来る
const VIEWS = ["notes", "inbox", "ask", "home"];

// ?linetest で開いたら、この端末を試しの端末にする（読み込んだときに1回）
try {
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("linetest")) localStorage.setItem(TEST_KEY, "1");
  // LINE から開いた（?view= ・ ?watch=）端末も。画面を移ると ?view= は消えるので、ここで覚える
  else if (typeof location !== "undefined" && (viewRequest() || watchRequest() || /[?&](liff.state|liffClientId)=/.test(location.search))) localStorage.setItem(TEST_KEY, "1");
} catch {
  // localStorage が使えない
}

export function lineReady() {
  if (!LIFF_ID) return false;
  if (LINE_PUBLIC) return true;
  try {
    return localStorage.getItem(TEST_KEY) === "1" || Boolean(watchRequest()) || Boolean(viewRequest());
  } catch {
    return false;
  }
}

/** 「LINE で知らせてもらう」のリンク。LINE の中でも外でも開ける */
export const watchUrl = (questionId) => `https://liff.line.me/${LIFF_ID}?watch=${encodeURIComponent(questionId)}`;

// ?name= を読む。LIFF のリンクから来た直後は liff.state に入っている（liff.init のあとで ?name= に戻る）
function param(name, search) {
  const q = new URLSearchParams(search);
  if (q.has(name)) return q.get(name);
  const st = q.get("liff.state");
  if (st) return new URLSearchParams(st.replace(/^[^?]*/, "")).get(name);
  return null;
}

/** いまのページが「この問いを LINE で待つ」で開かれたなら、その問いの id */
export function watchRequest(search = location.search) {
  return param("watch", search);
}

/** いまのページが LINE から ?view=notes などで開かれたなら、その画面の名前 */
export function viewRequest(search = location.search) {
  const v = param("view", search);
  return VIEWS.includes(v) ? v : null;
}

let liffPromise = null;
function initLiff() {
  if (!liffPromise) {
    liffPromise = (async () => {
      const liff = window.liff || await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = LIFF_SDK;
        s.onload = () => resolve(window.liff);
        s.onerror = () => reject(new Error("LINE につながらなかった"));
        document.head.appendChild(s);
      });
      await liff.init({ liffId: LIFF_ID });
      return liff;
    })();
    liffPromise.catch(() => { liffPromise = null; });
  }
  return liffPromise;
}

// LINE の外のブラウザでは、前にログインしたときの ID トークンが期限切れのまま残っていることがある
function tokenExpired(liff) {
  const exp = liff.getDecodedIDToken()?.exp;
  return Boolean(exp) && exp * 1000 < Date.now() + 60_000;
}

/**
 * LINE から（LIFF で）来たときに、先に LIFF を起こす。
 * LINE のログインから戻った直後は、行き先（#notes など）が LIFF の liff.state と code に入っていて、
 * liff.init を呼ぶまで元の URL に戻らない。先に呼ばないと、ホームが開いてしまう（2026-10-16「ノートを見る」が効かなかった）
 */
export async function lineBootstrap() {
  if (typeof location === "undefined") return;
  if (!/[?&](liff\.state|liffClientId|liffRedirectUri)=/.test(location.search)) return;
  try {
    await initLiff();
  } catch (e) {
    console.warn("LIFF を起こせませんでした:", e);
  }
}

/** LINE の ID トークン。ログインしていなければ LINE のログイン画面へ移る（戻ってくるまで進まない） */
export async function lineIdToken() {
  const liff = await initLiff();
  if (liff.isLoggedIn() && tokenExpired(liff)) liff.logout();
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: location.href });
    await new Promise(() => {});
  }
  return liff.getIDToken();
}

/**
 * もう LINE でログインしていれば ID トークン、していなければ null（ログイン画面へは移らない）。
 * ID トークンが期限切れのときも null（「LINE とつなぐ」を押し直してもらう）
 */
export async function lineIdTokenIfLoggedIn() {
  if (!lineReady()) return null;
  try {
    const liff = await initLiff();
    if (!liff.isLoggedIn() || tokenExpired(liff)) return null;
    return liff.getIDToken();
  } catch {
    return null;
  }
}
