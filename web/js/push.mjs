// web/js/push.mjs
// ホーム画面に置いた「なんでポスト」に通知を届ける（supabase/web-push.sql・supabase/functions/notify-push）。
// 声のログの notify.mjs（C:\code\toi-voice-pages）を下敷きにした: 「ホーム画面に置く → 開く → 通知を許可」のチュートリアルと、Web Push の購読。
// ブラウザの道具（navigator・Notification・service worker・localStorage）は引数で受け取り、テスト（web/tests/push.test.mjs）で偽物に差し替える。
// 通知に載せるのは種類だけ（「返事が届きました」「新しい問いが届きました」）。問いや返事の本文・名前は載せない（ロック画面で人に見える）。
// 端末の見分けは、投函のときと同じ client_hash（api.js）。名前・メール・LINE の ID は使わない。

// 試しのあいだは、?pushtest で開いた端末にだけ「通知」の操作を出す（みんなに出すときに true にする）。
// ホーム画面に置くこと（manifest・service worker）は、この旗に関係なくいつでもできる
export const PUSH_PUBLIC = false;
export const PUSH_TEST_PARAM = "pushtest";
export const PUSH_TEST_KEY = "toi.push_test";

/**
 * 「通知」の操作を出してよい端末か。?pushtest で開いたら、この端末を覚える（読み込んだときに1回呼ぶ）
 * ホーム画面のアイコンから開いたときも出す（iPhone のホーム画面のアプリは Safari と保存場所が別で、
 * manifest の差し替えが効かないと旗が運ばれない。ホーム画面に置くこと自体が、使うと決めた印なので）
 * @param {{ search?: string, storage?: Storage|null, isPublic?: boolean, standalone?: boolean }} opts
 */
export function pushReady({ search = "", storage = null, isPublic = PUSH_PUBLIC, standalone = false } = {}) {
  if (isPublic || standalone) return true;
  let flagged = false;
  try { flagged = new URLSearchParams(search).has(PUSH_TEST_PARAM); } catch { /* 読めない */ }
  try {
    if (flagged) storage?.setItem(PUSH_TEST_KEY, "1");
    else flagged = storage?.getItem(PUSH_TEST_KEY) === "1";
  } catch { /* localStorage が使えない */ }
  return flagged;
}

// 試しの端末では、ホーム画面に置いたアイコンも ?pushtest つきで開くように、manifest を差し替える
// （iPhone はホーム画面のアプリと Safari で保存場所が分かれるので、旗を URL で運ぶ）。みんなに出したら使わない
export const MANIFEST = "site.webmanifest";
export const MANIFEST_PUSHTEST = "site-pushtest.webmanifest";
export const manifestFor = (ready, isPublic = PUSH_PUBLIC) => (ready && !isPublic ? MANIFEST_PUSHTEST : MANIFEST);

// チュートリアルの3枚（機種ごと）。絵は web/assets/ の svg
export const TUTORIAL = {
  ios: [
    { img: "assets/tut-ios-add.svg", title: "ホーム画面に置く", text: "Safari で開き、下の共有ボタン（□↑）→「ホーム画面に追加」→「追加」。" },
    { img: "assets/tut-open.svg", title: "ホーム画面から開く", text: "置いたアイコン「なんでポスト」から開きます。Safari のままだと通知は届きません。" },
    { img: "assets/tut-allow.svg", title: "通知を許可する", text: "下の「通知を受け取る」を押し、「許可」を選びます。" },
  ],
  android: [
    { img: "assets/tut-android-add.svg", title: "ホーム画面に置く", text: "Chrome で開き、右上の「︙」→「ホーム画面に追加」（「アプリをインストール」のことも）。" },
    { img: "assets/tut-open.svg", title: "ホーム画面から開く", text: "置いたアイコン「なんでポスト」から開きます。" },
    { img: "assets/tut-allow.svg", title: "通知を許可する", text: "下の「通知を受け取る」を押し、「許可」を選びます。" },
  ],
};
export const PLATFORMS = Object.keys(TUTORIAL);
export const PLATFORM_LABELS = { ios: "iPhone（Safari）", android: "Android（Chrome）" };

// 機種を見分ける。Android でなければ iPhone の手順を先に出す（PC でも切り替えて読める）
export const platformOf = (userAgent = "") => (/android/i.test(userAgent) ? "android" : "ios");
// iPad の Safari は Mac のふりをするので、触れる点の数で見る
export const isIos = (ua = "", touch = 0) => /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && touch > 1);

// ホーム画面のアイコンから開いたか（iPhone は navigator.standalone、ほかは display-mode）
export function isStandalone(win) {
  try {
    if (win.navigator?.standalone === true) return true;
    return !!win.matchMedia?.("(display-mode: standalone)").matches;
  } catch { return false; }
}

// 公開の鍵（base64url）を、subscribe() に渡す形（Uint8Array）にする
export function keyToBytes(base64url) {
  const s = String(base64url ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("通知の鍵の形が正しくありません");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  // P-256 の公開鍵は 65 バイト（先頭が 4）
  if (out.length !== 65 || out[0] !== 4) throw new Error("通知の鍵の形が正しくありません");
  return out;
}

// いまの状態: unsupported（この端末では受け取れない）・needs-home（iPhone でホーム画面から開いていない）・
// no-key（公開の鍵がまだ無い）・denied（端末の設定で止めてある）・on（届く）・off（まだ）
export async function pushState({ win, publicKey }) {
  const nav = win.navigator ?? {};
  if (isIos(nav.userAgent, nav.maxTouchPoints) && !isStandalone(win)) return "needs-home";
  if (!nav.serviceWorker || !win.PushManager || !win.Notification) return "unsupported";
  if (!publicKey) return "no-key";
  if (win.Notification.permission === "denied") return "denied";
  try {
    const reg = await nav.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub && win.Notification.permission === "granted" ? "on" : "off";
  } catch { return "off"; }
}

export const STATE_TEXT = {
  on: "この端末に通知が届きます。",
  off: "",
  "needs-home": "iPhone では、ホーム画面のアイコンから開くと「通知を受け取る」が押せます。",
  unsupported: "このブラウザでは通知を受け取れません。「自分への返事」を開けば、届いた返事を読めます。",
  "no-key": "通知の準備がまだです。準備ができたら、ここから受け取れます。",
  denied: "通知が止まっています。端末の設定 →「通知」→「なんでポスト」で許可してください。",
};

// 保存の層（save_push）に渡す形。宛先は Apple・Google・Mozilla・Microsoft の送り先だけ（web-push.sql の toi_push_endpoint_ok と同じ決まり）
export const ENDPOINT_RE = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|web\.push\.apple\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)\/[!-~]+$/;
export function subscriptionInput(json, { questions = true } = {}) {
  const endpoint = String(json?.endpoint ?? "");
  const p256dh = String(json?.keys?.p256dh ?? "");
  const auth = String(json?.keys?.auth ?? "");
  if (!ENDPOINT_RE.test(endpoint) || endpoint.length > 1000) throw new Error("この端末の通知の宛先は使えません");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{1,100}$/.test(auth)) throw new Error("通知の鍵の形が正しくありません");
  return { endpoint, p256dh, auth, questions: Boolean(questions) };
}

// 「通知を受け取る」を押したとき（ボタンの操作の中で呼ぶ。iPhone は操作の外で許可を聞けない）
export async function turnOn({ win, publicKey, save, questions = true }) {
  const permission = await win.Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await win.navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
  try {
    await save(subscriptionInput(sub.toJSON(), { questions }));
  } catch (err) {
    await sub.unsubscribe().catch(() => {}); // 保存できなければ、端末の購読も残さない
    throw err;
  }
  return "on";
}

// 「新しい問いの知らせ」を切り替える（購読はそのまま、保存の層だけ書き直す）
export async function setQuestions({ win, save, questions }) {
  const reg = await win.navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return "off";
  await save(subscriptionInput(sub.toJSON(), { questions }));
  return "on";
}

// 「通知をやめる」: 保存の層から消してから、端末の購読も外す
export async function turnOff({ win, remove }) {
  const reg = await win.navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return "off";
  await remove(sub.endpoint);
  await sub.unsubscribe().catch(() => {});
  return "off";
}

// 通知の文（web/sw.js にも同じ文を置く。service worker は module で読み込まない端末があるため。web/tests/push.test.mjs が突き合わせる）
export const PUSH_TITLE = "なんでポスト";
export const PUSH_TEXT = {
  reply: "あなたの問いに返事が届きました",
  question: "新しい問いが届きました",
};
// 開く画面（返事は「自分への返事」、新しい問いは「みんなの問い」）
export const PUSH_OPEN = { reply: "#inbox", question: "#home" };
export const PUSH_KINDS = Object.keys(PUSH_TEXT);

// 届いた中身から、出す文と開く画面を決める（sw.js と同じ決まり。知らない種類は「返事」として扱う）
export function noticeFor(data) {
  const kind = PUSH_KINDS.includes(data?.kind) ? data.kind : "reply";
  return { title: PUSH_TITLE, body: PUSH_TEXT[kind], tag: `nandepost-${kind}`, open: PUSH_OPEN[kind] };
}

// 引き継ぎの番号（8けた）を読みやすく「1234 5678」に。入れた番号は数字だけにする
export const formatHandoffCode = (code) => String(code ?? "").replace(/\D/g, "").replace(/^(\d{4})(\d{4})$/, "$1 $2");
export const normalizeHandoffCode = (input) => String(input ?? "").normalize("NFKC").replace(/\D/g, "");
export const isHandoffCode = (input) => /^\d{8}$/.test(normalizeHandoffCode(input));

export const HANDOFF_REASON_TEXT = {
  code: "番号がちがうか、15分を過ぎています。Safari で番号を出し直してください。",
  tries: "何度もまちがえたので、15分ほど待ってからもう一度入れてください。",
  busy: "いま混み合っています。少し待ってからもう一度入れてください。",
};
