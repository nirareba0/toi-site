// web/js/standalone.mjs
// ホーム画面のアプリだけで、LINE と同じことができるようにする（supabase/app-standalone.sql）。
// 問いに答える → この端末だけのノート、「みんなに見せる」→ 未承認の返事（立場「中高生」）、今日の問い（毎日／週1／自分で引くだけ・ジャンル）。
// 画面に依らない決まりだけをここに置き、web/tests/standalone.test.mjs で確かめる。
// 試しのあいだは、?pushtest の端末（push.mjs の pushReady）にだけ出す。

// 相談先が要る言葉。supabase/line-sync.sql の toi_line_is_sos と同じ並び（web/tests/standalone.test.mjs が突き合わせる）。
// 画面は送る前にこれで見て、当たったら何より先に相談先を出し、送らない（DB も同じ判定で断る）
export const SOS_PATTERN = "(死にたい|しにたい|シニタイ|死のう|しのう|消えたい|きえたい|キエタイ|いなくなりたい|生きたくない|いきたくない|生きてる意味|自殺|じさつ|自傷|リスカ|りすか|殺し|ころし|殺す|ころす|殴られ|なぐられ|虐待|ぎゃくたい|いじめられ|イジメられ|消えてしまいたい|もう無理|もうむり)";
const SOS_RE = new RegExp(SOS_PATTERN);
export const isSos = (text) => SOS_RE.test(String(text ?? ""));

// 相談先（line-sync.sql の toi_line_sos_message と同じ）
export const SOS_CONTACTS = [
  { name: "24時間子供SOSダイヤル", tel: "0120-0-78310", when: "いつでも・無料" },
  { name: "チャイルドライン", tel: "0120-99-7777", when: "毎日16時〜21時・無料" },
];
export const SOS_LEAD = "この答えは、ノートにも残さず、だれにも送っていません。いま、つらい気持ちを抱えているなら、話を聞いてくれる人につないでください。";
export const SOS_TAIL = "近くの信頼できる大人に話すのも、立派な一歩です。";
export const telHref = (tel) => `tel:${String(tel).replace(/[^0-9]/g, "")}`;

// 答えの長さ（app_notes.body・answers.body と同じ 2000 字まで）
export const MAX_ANSWER_LENGTH = 2000;

/**
 * 送る前の確かめ。相談先が要る言葉は、空や長さより先に見る
 * @returns {{ ok: true, body: string } | { ok: false, reason: "sos"|"empty"|"too_long" }}
 */
export function checkAnswer(body) {
  const text = String(body ?? "").trim();
  if (isSos(text)) return { ok: false, reason: "sos" };
  if (!text) return { ok: false, reason: "empty" };
  if ([...text].length > MAX_ANSWER_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, body: text };
}

// DB が ok=false で返す理由（app-standalone.sql）と、画面の確かめの理由
export const REASON_TEXT = {
  empty: "ひとことでも書いてから送ってね。",
  too_long: `${MAX_ANSWER_LENGTH}字までにしてね。`,
  question: "この問いには、いま答えられません。ほかの問いでどうぞ。",
  note: "このノートが見つかりませんでした。",
  limit: "たくさん書いてくれてありがとう。少し時間をおいてから、もう一度どうぞ。",
  none: "このジャンルで届けられる問いが、いまはありません。ジャンルを足してみてね。",
  failed: "うまく送れませんでした。少し待ってから、もう一度どうぞ。",
};
export const reasonText = (reason) => REASON_TEXT[reason] ?? REASON_TEXT.failed;

// 届く頻度（app_devices.frequency。LINE の line_users.frequency と同じ3つ）
export const FREQUENCIES = [
  { id: "daily", label: "毎日" },
  { id: "weekly", label: "週に1回" },
  { id: "pull", label: "自分で引くだけ" },
];
export const isFrequency = (f) => FREQUENCIES.some((x) => x.id === f);
export function frequencyText(frequency, hour = 19) {
  if (frequency === "daily") return `毎日 ${hour}時ごろに、問いが1つ届きます。`;
  if (frequency === "weekly") return `週に1回、${hour}時ごろに問いが1つ届きます。`;
  return "こちらからは届けません。「別の問いを引く」で、いつでも1つ引けます。";
}

// 選べるジャンル（居場所のこと＝miacis は館の中の話なので出さない。LINE と同じ）
export const selectableThemes = (themes = []) => themes.filter((t) => t && t.id && t.id !== "miacis");

// ジャンルを押すたびに入れる／外す。空は「ぜんぶ」
export function toggleTheme(selected, id) {
  const now = new Set(selected ?? []);
  if (now.has(id)) now.delete(id); else now.add(id);
  return [...now];
}
export function themesLabel(themes = [], selected) {
  if (!selected || selected.length === 0) return "ぜんぶ";
  const labels = selectableThemes(themes).filter((t) => selected.includes(t.id)).map((t) => t.label);
  return labels.length ? labels.join("・") : "ぜんぶ";
}

// ノートの状態（app_my_notes の shared・published）
export function noteStatus(note) {
  if (note?.published) return { key: "published", label: "サイトに載っています" };
  if (note?.shared) return { key: "shared", label: "サイトに送った・確認中" };
  return { key: "private", label: "" };
}

// 今日の問いの見出しの下の1行（届いた時と、どう届いたか）
export function deliveredText(question, now = new Date()) {
  if (!question?.delivered_at) return "";
  const at = new Date(question.delivered_at);
  if (Number.isNaN(at.getTime())) return "";
  const sameDay = at.toDateString() === now.toDateString();
  const when = sameDay
    ? `今日 ${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`
    : `${at.getMonth() + 1}月${at.getDate()}日`;
  return question.via === "daily" ? `${when}に届いた問い` : `${when}に引いた問い`;
}
