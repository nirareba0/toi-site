// service worker（なんでポスト）: ホーム画面に置いたときの通知と、画面のファイルの手元置き。
// 声のログの sw.js（C:\code\toi-voice-pages）を下敷きにした。
//
// 通知: 届くのは { kind } だけ。文はここで決める（web/js/push.mjs の PUSH_TEXT・PUSH_OPEN と同じ。web/tests/push.test.mjs が突き合わせる）。
//   問いや返事の本文・名前は届かないし、出さない（ロック画面で人に見える）。同じ種類の通知は1つにまとめる（tag）。
// 手元置き: 画面のファイル（html・css・js・mjs・アイコン・manifest）だけ。いつも先に通信で新しい版を取り、つながらないときだけ手元のものを出す
//   （サイトは毎日作り直すので、古い画面を先に出さない）。問いと返事（Supabase）・問いごとのページ（q/）は持たない。
// 画面のファイルの置き場を大きく変えたら CACHE の版を上げる（古い置き場は activate で消える）。
const CACHE = 'nandepost-shell-2026-10-31';
const SHELL = ['./', 'index.html', 'style.css', 'js/app.js', 'js/api.js', 'js/core.mjs', 'js/line.js', 'js/push.mjs', 'js/config.js',
  'site.webmanifest', 'assets/icon-192.png', 'assets/mark-cloud.png'];

const PUSH_TITLE = 'なんでポスト';
const PUSH_TEXT = {
  reply: 'あなたの問いに返事が届きました',
  question: '新しい問いが届きました',
};
const PUSH_OPEN = { reply: '#inbox', question: '#home' };
const PUSH_KINDS = Object.keys(PUSH_TEXT);

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* 読めなければ「返事が届きました」 */ }
  const kind = PUSH_KINDS.includes(data.kind) ? data.kind : 'reply';
  event.waitUntil(self.registration.showNotification(PUSH_TITLE, {
    body: PUSH_TEXT[kind], tag: `nandepost-${kind}`, icon: 'assets/icon-192.png', badge: 'assets/icon-192.png',
    data: { open: PUSH_OPEN[kind] },
  }));
});

// 通知を押したら、開いている画面があればそこへ、無ければ新しく開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.open ?? '#home', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const win = list.find((c) => c.url.startsWith(self.registration.scope));
    if (win) return win.navigate(url).then((c) => (c ?? win).focus()).catch(() => win.focus());
    return self.clients.openWindow(url);
  }));
});

const SHELL_FILE = /\.(html|css|js|mjs|svg|png|webmanifest)$/;

// 画面のファイルか。問いごとのページ（q/）は持たない
function isShell(url) {
  if (url.origin !== self.location.origin) return false;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return false;
  const rest = url.pathname.slice(scope.pathname.length);
  if (rest.startsWith('q/')) return false;
  return rest === '' || SHELL_FILE.test(rest);
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) =>
    // 1つ取れなくても、ほかは置く
    Promise.allSettled(SHELL.map((p) => cache.add(new URL(p, self.registration.scope))))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('nandepost-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isShell(url)) return; // 通信に任せる
  event.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(req, copy)));
    }
    return res;
  }).catch(async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    // 画面の移動（ホーム画面のアイコンから ?pushtest つきで開いたときなど）は、手元のトップを出す
    if (req.mode === 'navigate') {
      const top = await caches.match(new URL('./', self.registration.scope).href);
      if (top) return top;
    }
    throw new Error('offline');
  }));
});
