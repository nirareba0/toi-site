// 通知を送る中身（なんでポスト・supabase/web-push.sql）。Edge Function（index.ts）から呼ぶ。Deno でも Node でも動く形にし、
// 送る部分は引数で受け取る（本番は web-push の sendNotification、テストは偽物・supabase/tests/web-push.test.mjs）。
// 声のログの notify-turn（C:\code\toi-voice の supabase/functions/notify-turn/deliver.mjs）を下敷きにした。
// 送るのは { kind } だけ。名前・問いや返事の本文は送らない（ロック画面で人に見える）。中身は push service を通るとき暗号化される（RFC 8291）。

// reply: 自分の問いに返事が載った／question: 新しい問いが載った（web-push.sql）
// today: 今日の問いが届いた／published: 答えが載った／reaction: 載った答えに反応／other_answer: 答えた問いにほかの返事（app-standalone.sql）
// web/js/push.mjs の PUSH_KINDS と同じ。ここに無い種類は「返事」として送ってしまうので、種類を足したら先にこの関数を置き直してから SQL を流す
export const KINDS = ['reply', 'question', 'today', 'published', 'reaction', 'other_answer'];
// 届かなかったら、1日で捨ててもらう（古い知らせは意味がない）
export const TTL_SEC = 24 * 60 * 60;

export const payloadOf = (kind) => JSON.stringify({ kind: KINDS.includes(kind) ? kind : 'reply' });

// 合言葉の確かめ（pg_net から来た呼び出しだけを通す）。長さの違いでも時間が変わらないよう、全部の文字を見る
export function checkSecret(given, expected) {
  if (!expected || typeof given !== 'string') return false;
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= (given.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  return diff === 0;
}

// 通知の鍵（VAPID）を用意する。get(): いまの鍵（op_vapid）。無ければ generate() で作り、set() で置く（op_set_vapid）。
// set は「もうあれば置かずに、いまある鍵を返す」ので、2つ同時に動いても鍵は1組になる。鍵の値はログに出さない
export async function ensureVapid({ get, set, generate }) {
  const have = await get();
  if (have?.publicKey && have?.privateKey) return have;
  const made = await generate();
  const stored = await set(made);
  return stored?.publicKey && stored?.privateKey ? stored : made;
}

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// P-256 の鍵の組を作る。公開の鍵は 65 バイト（87文字）、秘密の鍵は 32 バイト（43文字）の base64url（web-push の形）
export async function generateVapid(subtle = globalThis.crypto.subtle) {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: base64url(raw), privateKey: jwk.d };
}

// take(): 送る列を受け取る（op_take_push）。send(subscription, payload, options): 送る。drop(endpoint): 切れた購読を消す（op_drop_push）
export async function deliver({ take, send, drop }) {
  const rows = (await take()) ?? [];
  const result = { sent: 0, dropped: 0, failed: 0 };
  for (const r of rows) {
    const subscription = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
    try {
      // topic: 同じ種類の知らせがまだ届いていなければ、送り先で新しいもの1つに置き換わる
      await send(subscription, payloadOf(r.kind), { TTL: TTL_SEC, urgency: 'normal', topic: `nandepost-${r.kind}` });
      result.sent += 1;
    } catch (err) {
      // 404・410 は「この購読はもう無い」。消す。ほかの失敗は数えるだけ（中身はログに出さない）
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await drop(r.endpoint);
        result.dropped += 1;
      } else {
        result.failed += 1;
      }
    }
  }
  return result;
}
