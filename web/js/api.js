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
    .select("id, body, nickname, theme_id, theme_label, credit, source, created_at, answer_count")
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
      .select("id, body, nickname, theme_id, theme_label, credit, source, created_at, answer_count")
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
    .select("id, body, nickname, theme_id, theme_label, credit, created_at, answer_count")
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
/**
 * この問いの返事を LINE で待つ（supabase/line-notify.sql の watch_question）。
 * DB が LINE のサーバーで ID トークンを確かめる。問いと LINE の ID のつながりは公開されない
 * @param {string} questionId
 * @param {string} idToken LIFF の ID トークン
 */
export async function watchQuestion(questionId, idToken) {
  if (!sb) {
    throw new Error("Supabase の接続設定が未完了です。config.js を設定してください。");
  }
  const { error } = await sb.rpc("watch_question", { p_question_id: questionId, p_id_token: idToken });
  if (error) throw error;
}

// ---- LINE と同期する（supabase/line-sync.sql）。どれも DB が LINE のサーバーで ID トークンを確かめる ----

async function lineRpc(name, args) {
  if (!sb) {
    throw new Error("Supabase の接続設定が未完了です。config.js を設定してください。");
  }
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}

/**
 * この端末で出した問いを LINE の人に結ぶ（返事がきたら LINE で知らせる対象にもなる）。
 * 端末の印（client_hash）が投函時と同じ問いだけが結ばれる。結んだ数を返す
 * @param {string} idToken
 * @param {Array<string>} ids
 */
export async function linkLineQuestions(idToken, ids) {
  if (!ids || ids.length === 0) return 0;
  return lineRpc("line_link_questions", { p_id_token: idToken, p_ids: ids.slice(0, 200), p_client_hash: await clientHash() });
}

/** LINE の人が出した問い（確認中のものも）。{ id, body, nickname, theme_id, theme_label, approved, answer_count, created_at }[] */
export async function myLineQuestions(idToken) {
  return (await lineRpc("line_my_questions", { p_id_token: idToken })) || [];
}

/** LINE で答えたノート。{ id, body, created_at, question_id, question_body, shared, published }[] */
export async function myLineNotes(idToken) {
  return (await lineRpc("line_my_notes", { p_id_token: idToken })) || [];
}

/**
 * 返事に反応する（共感した / 考えさせられた）。匿名・件数はどこにも出さない。
 * LINE から載った答えなら、書いた人に LINE で「反応が届いた」と知らせる（supabase/line-reactions.sql）。
 * 同じ端末で同じ反応を2回押しても1回（一意の索引）
 * @param {string} answerId
 * @param {'kyokan'|'kangaeta'} kind
 */
export async function reactToAnswer(answerId, kind) {
  if (!sb) {
    throw new Error("Supabase の接続設定が未完了です。config.js を設定してください。");
  }
  const { error } = await sb.from("reactions").insert({
    target_type: "answer",
    target_id: answerId,
    kind,
    client_hash: await clientHash()
  });
  if (error && error.code !== "23505") throw error;   // 23505: もう押してある
}

// ---- スマホへの通知（supabase/web-push.sql）。端末は投函と同じ client_hash で見分ける（名前・メールは送らない） ----

async function pushRpc(name, args) {
  if (!sb) {
    throw new Error("Supabase の接続設定が未完了です。config.js を設定してください。");
  }
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}

/** 通知の公開の鍵（notify-push が最初に動いたときに作る）。まだ無い・読めないときは "" */
export async function pushPublicKey() {
  if (!sb) return "";
  try {
    return (await pushRpc("push_public_key", {})) || "";
  } catch {
    return "";
  }
}

/**
 * 通知の購読を保存する（push.mjs の subscriptionInput の形）。この端末で出した問いに返事が載ったら知らせる
 * @param {{ endpoint: string, p256dh: string, auth: string, questions: boolean }} s
 */
export async function savePush(s) {
  return pushRpc("save_push", {
    p_endpoint: s.endpoint, p_p256dh: s.p256dh, p_auth: s.auth,
    p_client_hash: await clientHash(), p_questions: Boolean(s.questions)
  });
}

/** 通知の購読を消す */
export async function deletePush(endpoint) {
  return pushRpc("delete_push", { p_endpoint: endpoint });
}

/** 引き継ぎの番号（8けた・15分）を作る。{ code, expires_at } */
export async function makePushHandoff() {
  return pushRpc("push_handoff_make", { p_client_hash: await clientHash() });
}

/**
 * 引き継ぎの番号を入れて、番号を出した端末（Safari）と結ぶ。
 * { ok: true, questions: [{ id, body, nickname, theme_id, theme_label, created_at }] } か { ok: false, reason }
 */
export async function takePushHandoff(code) {
  return pushRpc("push_handoff_take", { p_code: code, p_client_hash: await clientHash() });
}

/** ノートを1つ消す */
export async function deleteLineNote(idToken, noteId) {
  return lineRpc("line_delete_note", { p_id_token: idToken, p_note_id: noteId });
}

// ---- アプリだけで答える（supabase/app-standalone.sql）。端末は投函と同じ client_hash（名前・メール・LINE の ID は送らない） ----
// どれも断るときは { ok: false, reason } を返す（standalone.mjs の REASON_TEXT）

/** 今日の問いと設定。{ ok, prefs: { frequency, themes, chosen }, question: { id, body, theme_id, theme_label, via, delivered_at, answered } | null } */
export async function appToday() {
  return pushRpc("app_today", { p_client_hash: await clientHash() });
}

/** 問いを引く（別の問い）。返す形は appToday と同じ。無ければ reason: "none" */
export async function appDraw() {
  return pushRpc("app_draw", { p_client_hash: await clientHash() });
}

/** 届く頻度（daily / weekly / pull）とジャンル（themes の id。空は「ぜんぶ」）を決める。返す形は appToday と同じ */
export async function appSetPrefs(frequency, themes) {
  return pushRpc("app_set_prefs", {
    p_client_hash: await clientHash(), p_frequency: frequency, p_themes: themes && themes.length ? themes : null
  });
}

/** 答える → この端末だけのノート。share なら「みんなに見せる」（未承認の返事）にもする。{ ok, note_id, share } */
export async function appAnswer(questionId, body, share = false) {
  return pushRpc("app_answer", {
    p_client_hash: await clientHash(), p_question_id: questionId, p_body: body, p_share: Boolean(share)
  });
}

/** ノートを「みんなに見せる」にする。{ ok, already? } */
export async function appShareNote(noteId) {
  return pushRpc("app_share_note", { p_client_hash: await clientHash(), p_note_id: noteId });
}

/** この端末のノート。{ id, body, created_at, question_id, question_body, shared, published }[] */
export async function appMyNotes() {
  return (await pushRpc("app_my_notes", { p_client_hash: await clientHash() })) || [];
}

/** ノートを1つ消す（サイトに送った返事は残る） */
export async function appDeleteNote(noteId) {
  return pushRpc("app_delete_note", { p_client_hash: await clientHash(), p_note_id: noteId });
}

// ---- 運営の承認（supabase/staff-review.sql）。token は端末の localStorage の印（staff.mjs）。DB はそのハッシュだけを持ち、毎回確かめる ----
// 通知の宛先を見つけるため、端末の client_hash も渡す（投函・通知と同じ印）

/** 登録コードをもらう。{ ok, staff, code?, expires_at? } か { ok: false, reason: "busy" } */
export async function staffPairStart(token) {
  return pushRpc("staff_pair_start", { p_token: token, p_client_hash: await clientHash() });
}

/** この端末は運営の端末か。{ staff: true, number, pending, gets_notice } か { staff: false, waiting } */
export async function staffStatus(token) {
  return pushRpc("staff_status", { p_token: token, p_client_hash: await clientHash() });
}

/** 承認待ちの一覧（古い順）。{ pending, items: [{ kind, id, body, flags, ... }] }。運営の端末でなければ not_staff で断られる */
export async function staffQueue(token) {
  return pushRpc("staff_queue", { p_token: token });
}

/** 1枚を決める。kind: question / answer、action: approve / reject / restore / hold。{ ok, changed, pending } */
export async function staffDecide(token, kind, id, action) {
  return pushRpc("staff_decide", { p_token: token, p_kind: kind, p_id: id, p_action: action });
}

/** この端末を運営の端末から外す */
export async function staffLeave(token) {
  return pushRpc("staff_leave", { p_token: token });
}

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
