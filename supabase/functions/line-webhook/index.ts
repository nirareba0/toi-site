// 公式LINE「問う応える」の Webhook の受け口（Supabase Edge Function）。
// 本文と署名を、そのまま DB の line_webhook()（supabase/line-sync.sql）に渡すだけ。
// 署名の確かめ・返す文・ノートへの保存は DB がやる。ここに秘密は置かない（チャネルシークレットとトークンは Vault）。
//
// 置き方: Dashboard → Edge Functions → 新しく作る（名前 line-webhook）にこのファイルを貼る。
//   「Enforce JWT verification」はオフ（LINE は Supabase の鍵を持っていない。代わりに署名で確かめる）。
//   URL https://btbykfnlsxwmpfcfslxb.supabase.co/functions/v1/line-webhook を LINE Developers の Webhook URL に入れる。

const url = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const res = await fetch(`${url}/rest/v1/rpc/line_webhook`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_body: await req.text(), p_signature: req.headers.get("x-line-signature") ?? "" }),
  });
  if (res.ok) return new Response("ok");
  const text = await res.text();
  console.error("line_webhook", res.status, text);
  return new Response(text.includes("bad_signature") ? "bad signature" : "error", { status: text.includes("bad_signature") ? 401 : 500 });
});
