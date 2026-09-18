/**
 * core.mjs - 問いコーナー ドメインロジック & データ変換モジュール
 * Pure ES Module (DOM 非依存。node:test で完全検証可能)
 */

export const DEFAULT_THEMES = [
  { id: 'ikikata', label: '生き方' },
  { id: 'ningen', label: '人との関係' },
  { id: 'gakko', label: '学校・勉強' },
  { id: 'koi', label: '恋・好き' },
  { id: 'nichijo', label: '日常のモヤモヤ' },
  { id: 'miacis', label: 'Miacis のこと' },
];

export const DEFAULT_NICKNAME = 'だれか';
export const MAX_BODY_LENGTH = 400; // PostgreSQL schema check (between 1 and 400) に準拠

export const PROMPT_CHIPS = [
  {
    id: 'why',
    label: 'なんでだろう',
    hint: '「なんで月曜日の朝は起きるのがつらいんだろう？」など、日頃の素朴な疑問'
  },
  {
    id: 'whatif',
    label: 'もしも',
    hint: '「もし学校に昼寝の時間があったらどうなるだろう？」など、空想やもしもの話'
  },
  {
    id: 'moyamoya',
    label: 'ちょっとモヤモヤ',
    hint: '「みんなが笑ってる話題に、自分だけ笑えなかった」など、言葉にしにくい気持ち'
  }
];

export const LOCAL_STORAGE_MY_QUESTIONS_KEY = 'toi.my_questions';
export const LOCAL_STORAGE_SEEN_KEY = 'toi.seen_answers';

/**
 * 文字列の長さを書記素クラスタ（結合絵文字・国旗など）を考慮して分解
 * @param {string} str
 * @returns {Array<string>}
 */
export function toGraphemes(str) {
  if (!str) return [];
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(segmenter.segment(str), seg => seg.segment);
    } catch {
      // フォールバックへ
    }
  }
  return Array.from(str);
}

/**
 * 書記素クラスタ単位で文字数をカウント
 * @param {string} str
 * @returns {number}
 */
export function countCharacters(str) {
  if (!str) return 0;
  return toGraphemes(str).length;
}

/**
 * 一覧やダイアログなどの短い表示用に本文を安全に切り詰める
 * 書記素クラスタ単位で切るため、絵文字や国旗が途中で割れない
 * @param {string} str
 * @param {number} [maxLength=30]
 * @returns {string}
 */
export function truncateForDisplay(str, maxLength = 30) {
  if (!str) return '';
  const graphemes = toGraphemes(str);
  if (graphemes.length <= maxLength) return graphemes.join('');
  return graphemes.slice(0, maxLength).join('') + '…';
}

/**
 * 問いの投函下書きバリデーション
 * @param {Object} draft
 * @param {string} draft.body
 * @param {string} [draft.nickname]
 * @param {string} [draft.theme_id]
 * @returns {{ valid: boolean, errors: Object, normalized: Object }}
 */
export function validateQuestionDraft(draft) {
  const errors = {};
  const rawBody = draft?.body ?? '';
  const trimmedBody = rawBody.trim();
  const charCount = countCharacters(rawBody);

  if (!trimmedBody) {
    errors.body = '問いの本文を入力してください（空白のみの投稿はできません）。';
  } else if (charCount > MAX_BODY_LENGTH) {
    errors.body = `問いの本文は${MAX_BODY_LENGTH}文字以内で入力してください（現在${charCount}文字）。`;
  }

  const rawNickname = (draft?.nickname ?? '').trim();
  const nickname = rawNickname || DEFAULT_NICKNAME;
  const theme_id = (draft?.theme_id ?? '').trim() || null;

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    normalized: {
      body: rawBody,
      nickname,
      theme_id
    }
  };
}

/**
 * 書き出しヒントの取得
 * @param {string} chipId
 * @returns {Object|null}
 */
export function getPromptHint(chipId) {
  return PROMPT_CHIPS.find(chip => chip.id === chipId) || null;
}

/**
 * 画面内アンカー（ページ内スクロール用ハッシュ）
 */
export const IN_PAGE_ANCHORS = ['main-content', 'question-list-title'];

/**
 * ハッシュ文字列からルーティングのアクションを判定する
 * @param {string} hash
 * @returns {{ type: 'route' | 'skip' | 'not_found', path: string, paramId?: string }}
 */
export function resolveRoute(hash) {
  const clean = (hash || '').replace(/^#\/?/, '').split('?')[0];
  if (!clean || clean === 'home') {
    return { type: 'route', path: 'home' };
  }
  if (IN_PAGE_ANCHORS.includes(clean)) {
    return { type: 'skip', path: clean };
  }
  const segments = clean.split('/');
  const [routePath, paramId] = segments;
  const validRoutes = ['ask', 'receipt', 'inbox', 'question', 'about'];
  const validSegmentCount = (
    (routePath === 'ask' && (segments.length === 1 || (segments.length === 2 && paramId === 'confirm')))
    || (['inbox', 'about'].includes(routePath) && segments.length === 1)
    || (['receipt', 'question'].includes(routePath) && segments.length === 2 && Boolean(paramId))
  );
  if (validRoutes.includes(routePath) && validSegmentCount) {
    return { type: 'route', path: routePath, paramId };
  }
  return { type: 'not_found', path: routePath };
}

/**
 * localStorage から自分が投函した問いの一覧を読み出す
 * @param {Storage|Object} storage
 * @returns {Array<Object>}
 */
export function loadMyQuestions(storage) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LOCAL_STORAGE_MY_QUESTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * localStorage に新しく投函した問いを保存する
 * @param {Storage|Object} storage
 * @param {Object} question
 * @returns {Array<Object>}
 */
export function saveMyQuestion(storage, question) {
  if (!storage || !question || !question.id) return [];
  const current = loadMyQuestions(storage);
  const exists = current.some(q => q.id === question.id);
  const updated = exists
    ? current.map(q => (q.id === question.id ? { ...q, ...question } : q))
    : [question, ...current];
  try {
    storage.setItem(LOCAL_STORAGE_MY_QUESTIONS_KEY, JSON.stringify(updated));
  } catch {
    // quota exceeded など
  }
  return updated;
}

/**
 * localStorage から特定の問いを削除（ローカル取り下げ）する
 * @param {Storage|Object} storage
 * @param {string} id
 * @returns {Array<Object>}
 */
export function removeMyQuestion(storage, id) {
  if (!storage || !id) return [];
  const current = loadMyQuestions(storage);
  const updated = current.filter(q => q.id !== id);
  try {
    storage.setItem(LOCAL_STORAGE_MY_QUESTIONS_KEY, JSON.stringify(updated));
  } catch {
    // ignore
  }
  return updated;
}

/**
 * 閲覧済み（既読）問いIDの読み込み
 * @param {Storage|Object} storage
 * @returns {Set<string>}
 */
export function loadSeenAnswerIds(storage) {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(LOCAL_STORAGE_SEEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

/**
 * 問いIDを既読として記録する
 * @param {Storage|Object} storage
 * @param {string} id
 */
export function markAnswerAsSeen(storage, id) {
  if (!storage || !id) return;
  const seen = loadSeenAnswerIds(storage);
  seen.add(id);
  try {
    storage.setItem(LOCAL_STORAGE_SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // ignore
  }
}

/**
 * 自分のローカル投稿と Supabase の public_questions を突き合わせる
 * - public_questions に存在する場合: 承認済み (waiting または answered)
 * - 存在しない場合: 未承認・確認中 (pending, 非公開)
 * @param {Array<Object>} myQuestions
 * @param {Array<Object>} publicQuestions
 * @returns {Array<Object>}
 */
export function matchMyQuestions(myQuestions = [], publicQuestions = []) {
  const publicMap = new Map();
  for (const pq of publicQuestions) {
    if (pq && pq.id) {
      publicMap.set(pq.id, pq);
    }
  }

  return myQuestions.map(localQ => {
    const pub = publicMap.get(localQ.id);
    if (pub) {
      const answerCount = Number(pub.answer_count || 0);
      const status = answerCount > 0 ? 'answered' : 'waiting';
      return {
        ...localQ,
        body: pub.body || localQ.body,
        nickname: pub.nickname || localQ.nickname,
        theme_id: pub.theme_id || localQ.theme_id,
        theme_label: pub.theme_label || localQ.theme_label || '未分類',
        isPublic: true,
        status, // 'waiting' | 'answered'
        answerCount,
        createdAt: pub.created_at || localQ.created_at
      };
    }

    return {
      ...localQ,
      isPublic: false,
      status: 'pending', // 確認中（まだ公開されていません）
      answerCount: 0,
      theme_label: localQ.theme_label || '未分類',
      createdAt: localQ.created_at
    };
  });
}

/**
 * 未読返事件数の算出
 * 承認され、返事が1件以上あり、かつ未閲覧のものをカウント
 * @param {Array<Object>} matchedQuestions
 * @param {Set<string>} seenIds
 * @returns {number}
 */
export function calculateUnreadCount(matchedQuestions = [], seenIds = new Set()) {
  return matchedQuestions.filter(q => q.status === 'answered' && !seenIds.has(q.id)).length;
}

/**
 * 公開用返事オブジェクトのフォーマット
 * 【重要】回答者の氏名・ニックネーム（nickname）を一切含めず、立場（role）のみを公開する
 * @param {Object} answer
 * @returns {{ id: string, question_id: string, body: string, role: string, created_at: string }}
 */
export function formatAnswerForPublic(answer) {
  return {
    id: answer.id,
    question_id: answer.question_id,
    body: answer.body || '',
    role: (answer.responder_role || '').trim() || '匿名',
    aiAssisted: Boolean(answer.ai_assisted),
    created_at: answer.created_at || ''
  };
}

/**
 * アプリケーション状態の生成
 * @returns {Object}
 */
export function createInitialState() {
  return {
    currentDraft: null,
    lastSubmittedId: null,
    selectedThemeId: 'all',
    spotlightIndex: 0,
    publicQuestions: [],
    themes: [...DEFAULT_THEMES],
    myQuestions: [],
    seenAnswerIds: new Set(),
    isConfigured: false,
    isLoading: false,
    errorMessage: null
  };
}

/**
 * 運営まわりの外部リンク。
 * **URL を入れるまで画面に出ない。** 空のまま公開しても、リンク切れは起きない。
 * 中高生が見るサイトなので、確認できていない URL を推測で入れないこと。
 */
export const SITE_LINKS = {
  instagram: "https://www.instagram.com/miacis_1009/",   // Miacis の公式アカウント
  operator: "https://nirareba0.github.io/",             // にしむ（運営者）のサイト
  podcast: "https://podcasts.apple.com/jp/podcast/id1805591539"  // 問いをお借りしたポッドキャスト
};

/**
 * 問いの出典（credit）から、その出どころの URL を引く。
 * 一致しない出典はリンクにしない（推測のリンクを貼らないため）
 */
export const CREDIT_LINKS = {
  "永井玲衣×長井優希乃『Wナガイと哲学対話』（J-WAVE）": "https://podcasts.apple.com/jp/podcast/id1805591539",
  "NHK Eテレ「Ｑ〜こどものための哲学」": "https://www.nhk.jp/p/q-phil/ts/EQJ8Y1YQJ4/",
  "永井玲衣『水中の哲学者たち』（晶文社）": "https://www.shobunsha.co.jp/?p=6703"
};

export function creditLink(credit) {
  return CREDIT_LINKS[String(credit || "").trim()] || null;
}

/**
 * 設定されているリンクだけを {key, url, label} の配列で返す
 * @returns {Array<{key: string, url: string, label: string}>}
 */
export function activeSiteLinks(links = SITE_LINKS) {
  const label = { instagram: "Miacis の Instagram", operator: "にしむ（運営者）のサイト",
                  podcast: "『Wナガイと哲学対話』（問いをお借りした番組）" };
  return Object.entries(links)
    .filter(([, url]) => typeof url === "string" && /^https:\/\//.test(url.trim()))
    .map(([key, url]) => ({ key, url: url.trim(), label: label[key] ?? key }));
}
