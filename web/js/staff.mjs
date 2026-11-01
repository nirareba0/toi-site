// web/js/staff.mjs
// 運営の承認を、毎日スマホでさばく（supabase/staff-review.sql）。画面に依らない決まりだけをここに置き、web/tests/staff.test.mjs で確かめる。
// 載せるのは人。下読みの見立ては DB が付け（toi_review_flags・toi_review_burst）、ここは色と短い言葉にするだけ。
// 運営の端末の印（64 桁の 16 進）は端末の localStorage にだけ置き、DB にはハッシュだけが残る。

export const STAFF_TOKEN_KEY = "toi.staff_token";

/** 推測できない印を作る（32 バイトの乱数を 16 進で）。getRandomValues は crypto.getRandomValues */
export function makeStaffToken(getRandomValues = (a) => globalThis.crypto.getRandomValues(a)) {
  const bytes = getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const isStaffToken = (t) => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);

/** 端末の印を読む（無ければ作って置く）。localStorage が使えなければ null */
export function loadStaffToken(storage, { create = false, make = makeStaffToken } = {}) {
  try {
    const have = storage?.getItem(STAFF_TOKEN_KEY);
    if (isStaffToken(have)) return have;
    if (!create || !storage) return null;
    const t = make();
    storage.setItem(STAFF_TOKEN_KEY, t);
    return storage.getItem(STAFF_TOKEN_KEY) === t ? t : null;
  } catch {
    return null;
  }
}
export function forgetStaffToken(storage) {
  try { storage?.removeItem(STAFF_TOKEN_KEY); } catch { /* 使えない */ }
}

// 登録コード（6けた）を読みやすく「123 456」に。SQL Editor に貼る1行
export const formatPairCode = (code) => String(code ?? "").replace(/\D/g, "").replace(/^(\d{3})(\d{3})$/, "$1 $2");
export const pairSql = (code) => `select toi_staff_pair('${String(code ?? "").replace(/\D/g, "")}');`;

/** 「10:42 まで」（期限の時刻） */
export function untilText(expiresAt) {
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")} まで`;
}

// 下読みの印（staff-review.sql の toi_review_flags の順 ＋ burst）。tone: danger（赤）・warn（橙）・muted（灰）
export const FLAG_CODES = ["sos", "contact", "school", "address", "name", "burst"];
export const FLAG_INFO = {
  sos: { label: "相談先が要る言葉", tone: "danger", hint: "載せる前に、この子に相談先が届いているかを考える" },
  contact: { label: "連絡先らしきもの", tone: "warn", hint: "電話・メール・URL・LINE などの ID" },
  school: { label: "学校名らしきもの", tone: "warn", hint: "〇〇中・〇〇高校 など" },
  address: { label: "住所らしきもの", tone: "warn", hint: "〇丁目・〇番地・1-2-3 など" },
  name: { label: "人名らしきもの", tone: "warn", hint: "〇〇さん・〇〇くん・〇〇先生 など（粗い）" },
  burst: { label: "同じ端末から連投", tone: "muted", hint: "前後30分に3件以上" },
};
export const CLEAR_FLAG = { code: "clear", label: "気になる点なし", tone: "ok", hint: "" };

/** 印の並び → 画面に出す札。知らない印は出さない。何も無ければ「気になる点なし」 */
export function flagChips(flags) {
  const list = FLAG_CODES.filter((c) => Array.isArray(flags) && flags.includes(c)).map((c) => ({ code: c, ...FLAG_INFO[c] }));
  return list.length ? list : [CLEAR_FLAG];
}

// どこから来たか
export const VIA_LABEL = { line: "LINE から", app: "アプリから", other: "サイト・その他" };
export const SOURCE_LABEL = { web: "サイトから", paper: "紙のカード", podcast: "ラジオ" };
export function originText(item) {
  if (item?.kind === "answer") return VIA_LABEL[item.via] ?? VIA_LABEL.other;
  return SOURCE_LABEL[item?.source] ?? SOURCE_LABEL.web;
}

/** 投稿の時刻「11月1日 19:05」 */
export function postedText(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getMonth() + 1}月${at.getDate()}日 ${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** 件数のバッジ（0 は出さない・100 以上は 99+） */
export const badgeText = (n) => (!Number.isFinite(n) || n <= 0 ? "" : n > 99 ? "99+" : String(Math.floor(n)));

// ---- 1枚ずつ押して次へ（画面の手元の順番。DB は staff_decide が変える） ----
// items: 一覧（古い順）。held: 保留にしたもの（今回はとばし、最後に「もう一度見る」で戻せる）。last: 最後に「載せない」にしたもの（取り消し用）

export function createReview(items = []) {
  return { items: [...items], held: [], done: 0, last: null };
}
export const currentItem = (r) => r.items[0] ?? null;
export const remaining = (r) => r.items.length;

/** 押した結果で次の状態に。approve・reject は一覧から外す。hold は後ろ（held）へ。restore は最後に外したものを先頭に戻す */
export function advance(r, action) {
  const [head, ...rest] = r.items;
  if (action === "restore") {
    if (!r.last) return r;
    return { ...r, items: [r.last, ...r.items], done: Math.max(0, r.done - 1), last: null };
  }
  if (!head) return r;
  if (action === "hold") return { ...r, items: rest, held: [...r.held, head], last: null };
  if (action === "approve") return { ...r, items: rest, done: r.done + 1, last: null };
  if (action === "reject") return { ...r, items: rest, done: r.done + 1, last: head };
  return r;
}

/** 保留にしたものを、もう一度並べる */
export const reviewHeld = (r) => ({ ...r, items: [...r.items, ...r.held], held: [], last: null });

export const STAFF_REASON_TEXT = {
  busy: "いま登録が混み合っています。少し待ってから開き直してください。",
  storage: "この端末では登録できません（ブラウザに保存ができない設定です）。",
  failed: "うまく読み込めませんでした。少し待ってから、もう一度どうぞ。",
};
