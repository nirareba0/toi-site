// web/js/api.js
// Supabase への読み書きモジュール。
// - RLS 準拠: 未承認の問いは anon から一切 select できない。
// - 投函時はクライアント生成の UUID を渡し、returning minimal で insert する。
// - 公開ビュー public_questions / public_answers のみを参照し、カード画像や回答者氏名は取得しない。
// - config.js が存在しない場合は安全に未設定状態を返し、白画面クラッシュを防ぐ。

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { DEFAULT_THEMES, formatAnswerForPublic } from "./core.mjs";

let config = null;
try {
  config = await import("./config.js");
} catch {
  // config.js が存在しないかロードに失敗した場合
  config = null;
}

export function isConfigured() {
  return Boolean(
    config &&
    config.SUPABASE_URL &&
    config.SUPABASE_ANON_KEY &&
    !config.SUPABASE_URL.includes("xxxxxxxxxxxx") &&
    !config.SUPABASE_ANON_KEY.includes("eyJ...")
  );
}

let sb = null;
if (isConfigured()) {
  try {
    sb = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: { persistSession: false }
    });
  } catch (e) {
    console.warn("Supabase クライアントの初期化に失敗しました:", e);
    sb = null;
  }
}

/** 端末ごとの一方向ハッシュ（連投抑制用。個人情報は持たない） */
async function clientHash() {
  try {
    let seed = typeof localStorage !== 'undefined' ? localStorage.getItem("toi.seed") : null;
    if (!seed && typeof crypto !== 'undefined') {
      seed = crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem("toi.seed", seed);
      }
    }
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
      return [...new Uint8Array(buf)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // ignore
  }
  return "anon-hash";
}

/**
 * テーマ一覧を取得
 * @returns {Promise<Array<{ id: string, label: string }>>}
 */
export async function listThemes() {
  if (!sb) return [...DEFAULT_THEMES];
  try {
    const { data, error } = await sb.from("themes").select("id,label,sort_order").order("sort_order");
    if (error || !data || data.length === 0) return [...DEFAULT_THEMES];
    return data;
  } catch {
    return [...DEFAULT_THEMES];
  }
}

/**
 * 公開された問い一覧（public_questions ビュー）を取得
 * @param {Object} [options]
 * @param {string|null} [options.theme]
 * @param {number} [options.limit=50]
 * @returns {Promise<Array<Object>>}
 */
export async function listQuestions({ theme = null, limit = 50 } = {}) {
  if (!sb) return [];
  let query = sb
    .from("public_questions")
    .select("id, body, nickname, theme_id, theme_label, source, created_at, answer_count")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (theme && theme !== "all") {
    query = query.eq("theme_id", theme);
  }

  const { data, error } = await query;
  if (error) {
    console.error("問い一覧の取得に失敗しました:", error);
    throw error;
  }
  return data || [];
}

/**
 * 問いの詳細と承認済みの返事（public_answers ビュー）を取得
 * 個人情報保護のため回答者の nickname は取得せず、立場（responder_role）のみを返す
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getQuestion(id) {
  if (!sb || !id) return null;
  const [{ data: question, error: errQ }, { data: answers, error: errA }] = await Promise.all([
    sb
      .from("public_questions")
      .select("id, body, nickname, theme_id, theme_label, source, created_at, answer_count")
      .eq("id", id)
      .maybeSingle(),
    sb
      .from("public_answers")
      .select("id, question_id, body, responder_role, ai_assisted, created_at")
      .eq("question_id", id)
      .order("created_at", { ascending: true })
  ]);

  if (errQ) {
    console.error(`問い [${id}] の取得に失敗しました:`, errQ);
    throw errQ;
  }
  if (!question) return null;

  const sanitizedAnswers = (answers || []).map(formatAnswerForPublic);
  return {
    ...question,
    answers: sanitizedAnswers
  };
}

/**
 * 複数のIDに一致する公開済みの問いを取得（インボックスの突き合わせ用）
 * @param {Array<string>} ids
 * @returns {Promise<Array<Object>>}
 */
export async function getPublicQuestionsByIds(ids = []) {
  if (!sb || !ids || ids.length === 0) return [];
  const { data, error } = await sb
    .from("public_questions")
    .select("id, body, nickname, theme_id, theme_label, created_at, answer_count")
    .in("id", ids);

  if (error) {
    console.error("公開問いの突き合わせ取得に失敗しました:", error);
    throw error;
  }
  return data || [];
}

/**
 * 問いを新規投函する
 * RLS により未承認行は anon から select できないため、returning minimal 相当で実行する
 * @param {Object} params
 * @param {string} params.id クライアント側で生成した UUID
 * @param {string} params.body
 * @param {string} [params.nickname]
 * @param {string|null} [params.theme_id]
 */
export async function postQuestion({ id, body, nickname = "", theme_id = null }) {
  if (!sb) {
    throw new Error("Supabase の接続設定が未完了です。config.js を設定してください。");
  }

  const { error } = await sb.from("questions").insert({
    id,
    body: body.trim(),
    nickname: nickname.trim() || null,
    theme_id: theme_id || null,
    source: "web",
    approved: false, // anon insert ポリシーの条件 (approved = false and source = 'web')
    client_hash: await clientHash()
  });

  if (error) {
    console.error("問いの投函に失敗しました:", error);
    throw error;
  }
}
