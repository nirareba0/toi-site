// なんでポストの通知を送る Edge Function（supabase/web-push.sql の toi_push_call が、pg_net で呼ぶ）。
// 声のログの notify-turn（C:\code\toi-voice の supabase/functions/notify-turn/index.ts）を下敷きにした。
// 鍵も合言葉も、人の手で作ったり写したりしない:
//   - 通知の鍵（VAPID）は、最初に動いたときにここで作り、Vault に置く（op_set_vapid）。以後は Vault から読む（op_vapid）
//   - pg_net との合言葉は、web-push.sql がデータベースの中で作って Vault に置いたもの（op_push_hook_secret）と突き合わせる
//   - SUPABASE_URL・SUPABASE_SERVICE_ROLE_KEY は Supabase が最初から入れている
// GET は公開の鍵だけを返す（まだ無ければ作る）。POST は合言葉が合ったときだけ送る。
// 置き方: 名前は notify-push。JWT の確かめは切らない（既定のまま）。pg_net は公開の anon キーを Authorization に付けて呼ぶ（push_settings.anon_key）
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { deliver, checkSecret, ensureVapid, generateVapid } from './deliver.mjs';

// 送り先（Apple・Google など）が困ったときの連絡先。公開の画面の URL にする（メールアドレスは置かない）
const SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'https://nirareba0.github.io/toi-site/';

const env = (name: string) => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${name} がありません`);
  return v;
};

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  try {
    const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    const call = async (fn: string, args: Record<string, unknown> = {}) => {
      const { data, error } = await db.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    };
    const keys = () => ensureVapid({
      get: () => call('op_vapid'),
      set: (k: { publicKey: string; privateKey: string }) => call('op_set_vapid', { p_public: k.publicKey, p_private: k.privateKey }),
      generate: () => generateVapid(),
    });
    if (req.method === 'GET') return Response.json({ publicKey: (await keys()).publicKey });
    if (!checkSecret(req.headers.get('x-push-secret'), await call('op_push_hook_secret'))) return new Response('unauthorized', { status: 401 });
    const k = await keys();
    webpush.setVapidDetails(SUBJECT, k.publicKey, k.privateKey);
    const result = await deliver({
      take: () => call('op_take_push', { p_limit: 100 }),
      send: (sub: unknown, payload: string, options: Record<string, unknown>) => webpush.sendNotification(sub, payload, options),
      drop: (endpoint: string) => call('op_drop_push', { p_endpoint: endpoint }),
    });
    // 数だけを返す・残す（宛先や中身・鍵はログに出さない）
    console.log(JSON.stringify(result));
    return Response.json(result);
  } catch (err) {
    console.error(String((err as Error)?.message ?? err));
    return new Response('error', { status: 500 });
  }
});
