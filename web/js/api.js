// 問う応える — Supabase への読み書き。UI はこのモジュールだけを通す。
// 未承認の行は RLS で見えないので、ここでは approved を意識しない。
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

/** 端末ごとの一方向ハッシュ。連投抑制と「同じ反応を二度数えない」ため。個人は特定できない */
async function clientHash() {
  let seed = localStorage.getItem("toi.seed");
  if (!seed) { seed = crypto.randomUUID(); localStorage.setItem("toi.seed", seed); }
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return [...new Uint8Array(buf)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function listThemes() {
  const { data, error } = await sb.from("themes").select("id,label,sort_order").order("sort_order");
  if (error) throw error;
  return data;
}

/** 一覧。theme を渡すと絞る。waiting=true で返事 0 だけ */
export async function listQuestions({ theme = null, waiting = false, limit = 30 } = {}) {
  let q = sb.from("public_questions").select("*").order("created_at", { ascending: false }).limit(limit);
  if (theme) q = q.eq("theme_id", theme);
  if (waiting) q = q.eq("answer_count", 0);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function getQuestion(id) {
  const [{ data: q, error: e1 }, { data: answers, error: e2 }] = await Promise.all([
    sb.from("public_questions").select("*").eq("id", id).single(),
    sb.from("answers").select("id,body,nickname,responder_role,created_at").eq("question_id", id).order("created_at"),
  ]);
  if (e1) throw e1; if (e2) throw e2;
  return { ...q, answers };
}

/** 投函。承認されるまで誰にも見えない。戻り値は無い（RLS で自分の行も読めない） */
export async function postQuestion({ body, nickname = "", theme_id = null }) {
  const { error } = await sb.from("questions").insert({
    body: body.trim(), nickname: nickname.trim() || null, theme_id, source: "web", client_hash: await clientHash(),
  });
  if (error) throw error;
}

export async function postAnswer({ question_id, body, nickname = "", responder_role = "" }) {
  const { error } = await sb.from("answers").insert({
    question_id, body: body.trim(), nickname: nickname.trim() || null, responder_role: responder_role.trim() || null,
    client_hash: await clientHash(),
  });
  if (error) throw error;
}

/** 反応。件数は公開しない（運営の参考値）。同じ端末から二度目は黙って無視 */
export async function react({ target_type, target_id, kind }) {
  const { error } = await sb.from("reactions").insert({ target_type, target_id, kind, client_hash: await clientHash() });
  if (error && error.code !== "23505") throw error;
}
