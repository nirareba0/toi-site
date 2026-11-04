// web/js/push.mjs と web/sw.js: ホーム画面に置いた「なんでポスト」への通知
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  PUSH_PUBLIC, PUSH_TEST_KEY, pushReady, manifestFor, MANIFEST, MANIFEST_PUSHTEST,
  TUTORIAL, platformOf, isIos, isStandalone, keyToBytes, pushState, subscriptionInput,
  turnOn, turnOff, setQuestions, PUSH_TEXT, PUSH_OPEN, PUSH_KINDS, PUSH_TITLE, noticeFor,
  formatHandoffCode, normalizeHandoffCode, isHandoffCode, ENDPOINT_RE
} from "../js/push.mjs";
import { resolveRoute } from "../js/core.mjs";

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

// P-256 の公開鍵の形（65 バイト・先頭 4）の base64url
const KEY = Buffer.from([4, ...Array.from({ length: 64 }, (_, i) => i)]).toString("base64url");
const FCM = "https://fcm.googleapis.com/fcm/send/abc123:xyz";
const APPLE = "https://web.push.apple.com/QGx-abc_123";

// ブラウザの偽物。permission・購読の有無・ホーム画面から開いたかを変えられる
function fakeWin({ ua = "Mozilla/5.0 (Linux; Android 14)", standalone = false, permission = "default", sub = null, answer = "granted" } = {}) {
  const calls = { subscribe: 0, unsubscribe: 0 };
  let current = sub;
  const makeSub = (endpoint) => ({
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "BPk-abc_1", auth: "au_th-1" } }),
    unsubscribe: async () => { calls.unsubscribe++; current = null; return true; },
  });
  if (current) current = makeSub(current);
  const win = {
    navigator: {
      userAgent: ua, maxTouchPoints: 0,
      serviceWorker: { ready: Promise.resolve({ pushManager: {
        getSubscription: async () => current,
        subscribe: async (opts) => { calls.subscribe++; calls.key = opts.applicationServerKey; current = makeSub(FCM); return current; },
      } }) },
    },
    matchMedia: () => ({ matches: standalone }),
    PushManager: function () {},
    Notification: { permission, requestPermission: async () => { win.Notification.permission = answer; return answer; } },
  };
  return { win, calls };
}

test("試しの旗: ?pushtest で開いた端末を覚え、ほかの端末には出さない。みんなに出すと全員", () => {
  assert.equal(PUSH_PUBLIC, false);
  const s = memoryStorage();
  assert.equal(pushReady({ search: "", storage: s }), false);
  assert.equal(pushReady({ search: "?pushtest", storage: s }), true);
  assert.equal(s.getItem(PUSH_TEST_KEY), "1");
  assert.equal(pushReady({ search: "", storage: s }), true);           // 次からは ?pushtest なしでも
  assert.equal(pushReady({ search: "", storage: memoryStorage(), isPublic: true }), true);
  assert.equal(pushReady({ search: "?pushtest", storage: null }), true); // localStorage が使えなくても URL で
  assert.equal(pushReady({ search: "", storage: memoryStorage(), standalone: true }), true); // ホーム画面のアイコンから開いたとき
  assert.equal(manifestFor(true), MANIFEST_PUSHTEST);
  assert.equal(manifestFor(false), MANIFEST);
  assert.equal(manifestFor(true, true), MANIFEST);
});

test("manifest: 名前・アイコン 180/192/512・試しの版は start_url だけが ?pushtest", () => {
  const m = JSON.parse(fs.readFileSync(path.join(web, MANIFEST), "utf8"));
  const t = JSON.parse(fs.readFileSync(path.join(web, MANIFEST_PUSHTEST), "utf8"));
  assert.equal(m.name, "なんでポスト");
  assert.equal(m.display, "standalone");
  assert.deepEqual([...new Set(m.icons.map((i) => i.sizes))].sort(), ["180x180", "192x192", "512x512"]);
  assert.ok(m.icons.some((i) => i.purpose === "maskable"));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(web, i.src)), i.src);
  assert.equal(t.start_url, "./?pushtest");
  assert.deepEqual({ ...t, start_url: m.start_url }, m);
  for (const steps of Object.values(TUTORIAL)) for (const s of steps) assert.ok(fs.existsSync(path.join(web, s.img)), s.img);
});

test("機種とホーム画面: Android でなければ iPhone の手順。iPad は触れる点で見分ける", () => {
  assert.equal(platformOf("Mozilla/5.0 (Linux; Android 14; Pixel 8)"), "android");
  assert.equal(platformOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "ios");
  assert.equal(platformOf(""), "ios");
  assert.equal(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5), true);
  assert.equal(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0), false);
  assert.equal(isStandalone({ navigator: { standalone: true } }), true);
  assert.equal(isStandalone({ navigator: {}, matchMedia: () => ({ matches: true }) }), true);
  assert.equal(isStandalone({ navigator: {}, matchMedia: () => ({ matches: false }) }), false);
});

test("公開の鍵: 65 バイトの P-256 だけを通す", () => {
  const bytes = keyToBytes(KEY);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
  assert.throws(() => keyToBytes("abc"), /鍵の形/);
  assert.throws(() => keyToBytes("a+b/"), /鍵の形/);
  assert.throws(() => keyToBytes(""), /鍵の形/);
});

test("いまの状態: iPhone の Safari は needs-home、鍵が無ければ no-key、許可と購読があれば on", async () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
  assert.equal(await pushState({ win: fakeWin({ ua: iphone }).win, publicKey: KEY }), "needs-home");
  assert.equal(await pushState({ win: fakeWin({ ua: iphone, standalone: true }).win, publicKey: KEY }), "off");
  assert.equal(await pushState({ win: { navigator: {} }, publicKey: KEY }), "unsupported");
  assert.equal(await pushState({ win: fakeWin().win, publicKey: "" }), "no-key");
  assert.equal(await pushState({ win: fakeWin({ permission: "denied" }).win, publicKey: KEY }), "denied");
  assert.equal(await pushState({ win: fakeWin({ permission: "granted", sub: FCM }).win, publicKey: KEY }), "on");
});

test("保存する形: 宛先は Apple・Google・Mozilla・Microsoft の送り先だけ。鍵は base64url だけ", () => {
  const keys = { p256dh: "BPk-abc_1", auth: "au_th-1" };
  assert.deepEqual(subscriptionInput({ endpoint: APPLE, keys }, { questions: false }),
    { endpoint: APPLE, p256dh: "BPk-abc_1", auth: "au_th-1", questions: false });
  assert.equal(subscriptionInput({ endpoint: FCM, keys }).questions, true);
  for (const ok of [FCM, APPLE, "https://updates.push.services.mozilla.com/wpush/v2/gAAA", "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA"]) {
    assert.ok(ENDPOINT_RE.test(ok), ok);
  }
  for (const bad of ["http://fcm.googleapis.com/x", "https://example.com/push", "https://fcm.googleapis.com.evil.example/x", "https://web.push.apple.com/", ""]) {
    assert.throws(() => subscriptionInput({ endpoint: bad, keys }), /宛先/, bad);
  }
  assert.throws(() => subscriptionInput({ endpoint: FCM, keys: { p256dh: "a b", auth: "x" } }), /鍵の形/);
});

test("受け取る: 許可 → 購読 → 保存。保存できなければ端末の購読も外す。断られたら保存しない", async () => {
  const { win, calls } = fakeWin();
  const saved = [];
  assert.equal(await turnOn({ win, publicKey: KEY, save: async (s) => saved.push(s), questions: false }), "on");
  assert.equal(calls.subscribe, 1);
  assert.equal(calls.key.length, 65);
  assert.deepEqual(saved, [{ endpoint: FCM, p256dh: "BPk-abc_1", auth: "au_th-1", questions: false }]);

  const broken = fakeWin();
  await assert.rejects(turnOn({ win: broken.win, publicKey: KEY, save: async () => { throw new Error("db"); } }), /db/);
  assert.equal(broken.calls.unsubscribe, 1);

  const no = fakeWin({ answer: "denied" });
  const none = [];
  assert.equal(await turnOn({ win: no.win, publicKey: KEY, save: async (s) => none.push(s) }), "denied");
  assert.deepEqual(none, []);
  assert.equal(no.calls.subscribe, 0);
});

test("新しい問いの知らせの切り替えと、やめる（保存の層から消してから端末の購読を外す）", async () => {
  const { win, calls } = fakeWin({ permission: "granted", sub: FCM });
  const saved = [];
  assert.equal(await setQuestions({ win, save: async (s) => saved.push(s), questions: false }), "on");
  assert.equal(saved[0].questions, false);
  const removed = [];
  assert.equal(await turnOff({ win, remove: async (e) => removed.push(e) }), "off");
  assert.deepEqual(removed, [FCM]);
  assert.equal(calls.unsubscribe, 1);
  assert.equal(await turnOff({ win, remove: async () => assert.fail("購読が無いのに消さない") }), "off");
});

test("通知の文: 種類だけ。知らない種類は「返事」。開く画面は返事 → #inbox、問い → #home", () => {
  assert.deepEqual(PUSH_KINDS, ["reply", "question", "today", "published", "reaction", "other_answer", "review"]);
  assert.deepEqual(noticeFor({ kind: "reply" }), { title: "なんでポスト", body: "あなたの問いに返事が届きました", tag: "nandepost-reply", open: "#inbox" });
  assert.deepEqual(noticeFor({ kind: "question" }), { title: "なんでポスト", body: "新しい問いが届きました", tag: "nandepost-question", open: "#home" });
  assert.deepEqual(noticeFor({ kind: "today" }), { title: "なんでポスト", body: "今日の問いが届きました", tag: "nandepost-today", open: "#today" });
  assert.deepEqual(noticeFor({ kind: "published" }), { title: "なんでポスト", body: "あなたの答えがサイトに載りました", tag: "nandepost-published", open: "#notes" });
  // 本文・名前を持たない（種類の文だけ）
  for (const k of PUSH_KINDS) assert.ok(!/[「」]/.test(PUSH_TEXT[k]), k);
  assert.equal(noticeFor({ kind: "nope" }).body, PUSH_TEXT.reply);
  assert.equal(noticeFor(null).body, PUSH_TEXT.reply);
  for (const r of ["#inbox", "#home"]) assert.equal(resolveRoute(r).type, "route");
  assert.deepEqual(resolveRoute("#notify"), { type: "route", path: "notify", paramId: undefined });
});

test("sw.js が出す文と開く画面は push.mjs と同じ（service worker を動かして確かめる）", async () => {
  const listeners = {};
  const shown = [];
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    registration: { scope: "https://nirareba0.github.io/toi-site/", showNotification: async (title, opts) => shown.push({ title, opts }) },
    location: { origin: "https://nirareba0.github.io" },
  };
  vm.runInNewContext(fs.readFileSync(path.join(web, "sw.js"), "utf8"), { self, URL, caches: {}, fetch: () => {} });
  assert.ok(listeners.push && listeners.notificationclick && listeners.fetch);
  for (const kind of [...PUSH_KINDS, "nope", undefined]) {
    let wait;
    listeners.push({ data: { json: () => ({ kind }) }, waitUntil: (p) => { wait = p; } });
    await wait;
    const want = noticeFor({ kind });
    const got = shown.pop();
    assert.equal(got.title, PUSH_TITLE);
    assert.equal(got.opts.body, want.body);
    assert.equal(got.opts.tag, want.tag);
    assert.equal(got.opts.data.open, want.open);
    // 本文や名前を持つ欄が無い
    assert.deepEqual(Object.keys(got.opts).sort(), ["badge", "body", "data", "icon", "tag"]);
  }
  // 中身が読めなくても「返事」として出す
  let wait;
  listeners.push({ data: { json: () => { throw new Error("bad"); } }, waitUntil: (p) => { wait = p; } });
  await wait;
  assert.equal(shown.pop().opts.body, PUSH_TEXT.reply);
  assert.deepEqual(PUSH_OPEN, {
    reply: "#inbox", question: "#home", today: "#today", published: "#notes", reaction: "#notes", other_answer: "#notes",
    review: "#staff",
  });
});

test("引き継ぎの番号: 8けた。全角や空白・ハイフンが混じっても数字だけにする", () => {
  assert.equal(formatHandoffCode("01234567"), "0123 4567");
  assert.equal(normalizeHandoffCode("０１２３ ４５６７"), "01234567");
  assert.equal(normalizeHandoffCode("0123-4567"), "01234567");
  assert.equal(isHandoffCode("0123 4567"), true);
  assert.equal(isHandoffCode("1234567"), false);
  assert.equal(isHandoffCode("123456789"), false);
});

test("アプリにする（#app）: ルート・手順・LINE の中のブラウザ・外で開く URL", async (t) => {
  const { INSTALL_STEPS, isInAppBrowser, externalUrl, PLATFORMS } = await import("../js/push.mjs");
  await t.test("#app のルートがある", () => {
    assert.deepEqual(resolveRoute("#app"), { type: "route", path: "app", paramId: undefined });
  });
  await t.test("機種ごとに「置く→アイコンから開く」の2つ。絵はどれもある", () => {
    for (const p of PLATFORMS) {
      assert.equal(INSTALL_STEPS[p].length, 2);
      for (const s of INSTALL_STEPS[p]) assert.ok(fs.existsSync(path.join(web, s.img)), s.img);
    }
  });
  await t.test("LINE・Instagram の中のブラウザを見分ける。Safari・Chrome は違う", () => {
    assert.equal(isInAppBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.17.0"), true);
    assert.equal(isInAppBrowser("Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36 Line/14.17.0/IAB"), true);
    assert.equal(isInAppBrowser("Mozilla/5.0 (iPhone) Instagram 300.0"), true);
    assert.equal(isInAppBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1"), false);
    assert.equal(isInAppBrowser("Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36"), false);
    assert.equal(isInAppBrowser("Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/130.0 Mobile Safari/537.36 Online/1"), false);
  });
  await t.test("外で開く URL は ?openExternalBrowser=1 を足し、#app を残す", () => {
    assert.equal(externalUrl("https://nirareba0.github.io/toi-site/#app"), "https://nirareba0.github.io/toi-site/?openExternalBrowser=1#app");
    assert.equal(externalUrl("https://nirareba0.github.io/toi-site/?pushtest#app"), "https://nirareba0.github.io/toi-site/?pushtest=&openExternalBrowser=1#app");
  });
});
