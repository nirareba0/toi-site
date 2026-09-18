/**
 * core.mjs - 問いコーナー ドメインロジック & 状態遷移モジュール
 * Pure ES Module (DOM非依存、node:test で完全検証可能)
 */

export const TOPICS = ['すべて', '暮らし', '自分', 'もしも'];
export const DEFAULT_TOPIC = '未分類';
export const DEFAULT_NICKNAME = 'ななし';
export const MAX_BODY_LENGTH = 500;

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

export const INITIAL_SEED_QUESTIONS = [
  {
    id: 'seed-1',
    body: '大人も、将来が不安になる？',
    author: 'ゆき',
    topic: '暮らし',
    isSample: true,
    status: 'answered', // pending | waiting | answered | withdrawn
    isPublic: true,
    createdAt: '2026-09-15',
    readByOwner: true,
    replies: [
      {
        id: 'reply-1-1',
        author: 'なかむら',
        role: 'エンジニア・30代',
        body: '正直に言うと、今でも不安になることはあります。ただ子どもの頃と違うのは、「不安があっても今日のご飯は美味しいし、なんとかなる」と切り替える経験が増えたことかもしれません。',
        createdAt: '2026-09-15'
      },
      {
        id: 'reply-1-2',
        author: 'さいとう',
        role: '元高校教員・50代',
        body: '大人も不安になりますよ。むしろ先が見えすぎたり、背負うものが増えたりして立ち止まることもあります。「不安がある＝ちゃんと考えている証拠」だと思って付き合っています。',
        createdAt: '2026-09-15'
      }
    ]
  },
  {
    id: 'seed-2',
    body: '好きなことって、どう見つけた？',
    author: 'そら',
    topic: '自分',
    isSample: true,
    status: 'answered',
    isPublic: true,
    createdAt: '2026-09-14',
    readByOwner: true,
    replies: [
      {
        id: 'reply-2-1',
        author: 'こばやし',
        role: 'デザイナー・20代',
        body: '最初は「好き」というより、「時間を忘れて没頭できたこと」でした。絵を描くのが特別上手いわけじゃなかったけれど、ノートの端に図や文字を並べている時間が一番落ち着いたんです。',
        createdAt: '2026-09-14'
      },
      {
        id: 'reply-2-2',
        author: 'まつだ',
        role: '大学生ボランティア・20代',
        body: '色々試して「これは違ったな」と消去法で残ったものが、結果的に好きなことになりました。探そうと意気込むより、やってみて嫌じゃなかったことを続けるのが近道でした。',
        createdAt: '2026-09-14'
      }
    ]
  },
  {
    id: 'seed-3',
    body: '猫って、暇だなって思うことある？',
    author: 'ぽん',
    topic: 'もしも',
    isSample: true,
    status: 'answered',
    isPublic: true,
    createdAt: '2026-09-13',
    readByOwner: true,
    replies: [
      {
        id: 'reply-3-1',
        author: 'たかはし',
        role: '獣医・40代',
        body: '猫には人間のような「明日の予定」や「昨日の後悔」がないので、ただ「今、日向が気持ちいい」を感じているのだと思います。暇というより、満たされている時間なのかもしれません。',
        createdAt: '2026-09-13'
      },
      {
        id: 'reply-3-2',
        author: 'いとう',
        role: 'カフェ店員・20代',
        body: '時々ぼーっと宙を見つめているのを見ると、「今どんな哲学を巡らせているんだろう」と想像してしまいます。何もしない贅沢を猫から学んでいます。',
        createdAt: '2026-09-13'
      }
    ]
  },
  {
    id: 'seed-4',
    body: 'どうして「ふつう」を気にしてしまうんだろう？',
    author: 'あお',
    topic: '自分',
    isSample: true,
    status: 'answered',
    isPublic: true,
    createdAt: '2026-09-12',
    readByOwner: true,
    replies: [
      {
        id: 'reply-4-1',
        author: 'すずき',
        role: '図書館司書・30代',
        body: '本を読んでいると、時代や場所によって「ふつう」がまったく違うことに気づきます。人は群れで生きる生き物だから気にしてしまうけれど、「ふつう」は誰かが作った一時的な目安にすぎないのかもしれません。',
        createdAt: '2026-09-12'
      },
      {
        id: 'reply-4-2',
        author: 'やまだ',
        role: 'ユースワーカー・40代',
        body: '周りと違うことで安心できない瞬間って誰にでもありますよね。でも、その違和感に気づいて「なんでだろう？」と立ち止まること自体が、自分の輪郭を見つける第一歩だと思います。',
        createdAt: '2026-09-12'
      }
    ]
  },
  {
    id: 'seed-5',
    body: 'もし1日だけ誰かの頭の中をのぞけるなら、誰のがいい？',
    author: 'ミント',
    topic: 'もしも',
    isSample: true,
    status: 'waiting', // 返事待ちサンプル
    isPublic: true,
    createdAt: '2026-09-11',
    readByOwner: true,
    replies: []
  }
];

/**
 * 文字列の長さを書記素クラスタ（結合絵文字・国旗など）を考慮してカウント
 * Intl.Segmenter が使える環境では grapheme セグメンテーションを使用し、
 * 利用できない環境では Array.from によるフォールバックを行う。
 * @param {string} str
 * @returns {number}
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

export function countCharacters(str) {
  if (!str) return 0;
  return toGraphemes(str).length;
}

/**
 * 一覧・ダイアログなどの短い表示用に本文を切り詰める
 * 書記素クラスタ単位で切るため、結合絵文字・国旗が途中で割れて文字化けしない
 * @param {string} str
 * @param {number} [maxLength=30]
 * @returns {string} 切り詰めた場合は末尾に … が付く
 */
export function truncateForDisplay(str, maxLength = 30) {
  if (!str) return '';
  const graphemes = toGraphemes(str);
  if (graphemes.length <= maxLength) return graphemes.join('');
  return graphemes.slice(0, maxLength).join('') + '…';
}

/**
 * 問いの下書きバリデーション
 * @param {Object} draft
 * @param {string} draft.body
 * @param {string} [draft.nickname]
 * @param {string} [draft.topic]
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

  let topic = (draft?.topic ?? '').trim();
  if (!topic || topic === 'すべて') {
    topic = DEFAULT_TOPIC;
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    normalized: {
      body: rawBody,
      nickname,
      topic
    }
  };
}

/**
 * アプリケーション状態の生成
 * @param {Object} [customSeeds]
 * @returns {Object} state
 */
export function createInitialState(customSeeds = null) {
  const questions = customSeeds ? JSON.parse(JSON.stringify(customSeeds)) : JSON.parse(JSON.stringify(INITIAL_SEED_QUESTIONS));
  return {
    questions,
    currentDraft: null,
    lastSubmittedId: null,
    spotlightIndex: 0,
    selectedTopicFilter: 'すべて'
  };
}

/**
 * 下書きの保存（未送信）
 * @param {Object} state
 * @param {Object} draft
 */
export function setDraft(state, draft) {
  state.currentDraft = draft ? { ...draft } : null;
}

/**
 * プロンプト（書き出しヒント）の選択
 * 本文を勝手に書き換えず、ヒント情報を返す
 * @param {string} chipId
 * @returns {Object|null}
 */
export function getPromptHint(chipId) {
  return PROMPT_CHIPS.find(chip => chip.id === chipId) || null;
}

/**
 * 下書きの提出（インメモリ保存）
 * 二重送信ガード: 送信成功時に currentDraft をクリアし、連続二重送信を防止
 * @param {Object} state
 * @returns {{ ok: boolean, question?: Object, error?: string }}
 */
export function submitQuestion(state) {
  const draftToSubmit = state.currentDraft;
  if (!draftToSubmit) {
    return { ok: false, error: '提出する下書きがありません。' };
  }

  const validation = validateQuestionDraft(draftToSubmit);
  if (!validation.valid) {
    return { ok: false, error: validation.errors.body || '入力内容に不備があります。' };
  }

  // 重複送信ガード: 同じIDまたは連続二重送信の防止
  const id = `user-q-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const newQuestion = {
    id,
    body: validation.normalized.body,
    author: validation.normalized.nickname,
    topic: validation.normalized.topic,
    isSample: false,
    status: 'pending', // 最初は必ずスタッフ確認中
    isPublic: false,   // 公開前
    createdAt: new Date().toISOString().slice(0, 10),
    readByOwner: false, // 投稿時は未読マーク
    replies: []
  };

  state.questions.unshift(newQuestion);
  state.lastSubmittedId = id;
  state.currentDraft = null; // 下書きクリア

  return { ok: true, question: newQuestion };
}

/**
 * 公開されている問い一覧を取得
 * - pending（確認中）および withdrawn（取り下げ済み）は除外
 * - waiting（公開・返事待ち）および answered（返事あり）のみ
 * @param {Object} state
 * @param {string} [topicFilter='すべて']
 * @returns {Array<Object>}
 */
export function getPublicQuestions(state, topicFilter = 'すべて') {
  return state.questions.filter(q => {
    if (!q.isPublic) return false;
    if (q.status !== 'waiting' && q.status !== 'answered') return false;
    if (topicFilter && topicFilter !== 'すべて') {
      return q.topic === topicFilter;
    }
    return true;
  });
}

/**
 * ユーザーが投稿した問い一覧（「自分への返事」用）を取得
 * @param {Object} state
 * @returns {Array<Object>}
 */
export function getUserQuestions(state) {
  return state.questions.filter(q => !q.isSample);
}

/**
 * IDで問いを取得（全ステータス対象・内部用）
 * @param {Object} state
 * @param {string} id
 * @returns {Object|null}
 */
export function getQuestionById(state, id) {
  return state.questions.find(q => q.id === id) || null;
}

/**
 * 公開詳細ページ用の問い取得ガード
 * isPublic かつ (status === 'waiting' || status === 'answered') の問いのみを返す
 * @param {Object} state
 * @param {string} id
 * @returns {Object|null}
 */
export function getPublicQuestionById(state, id) {
  const q = getQuestionById(state, id);
  if (!q) return null;
  if (!q.isPublic) return null;
  if (q.status !== 'waiting' && q.status !== 'answered') return null;
  return q;
}

/**
 * 受付完了画面で表示可能な問いを取得するガード関数
 * 現在のタブで直前に送信した、確認中かつ非公開のユーザー投稿だけを返す
 * @param {Object} state
 * @param {string} questionId
 * @returns {Object|null}
 */
export function getReceiptQuestion(state, questionId) {
  if (!state || !state.lastSubmittedId || !questionId) {
    return null;
  }
  if (state.lastSubmittedId !== questionId) {
    return null;
  }
  const q = getQuestionById(state, questionId);
  if (!q || q.isSample || q.status !== 'pending' || q.isPublic) {
    return null;
  }
  return q;
}

/**
 * ユーザーの未読返事件数を算出
 * 承認（waiting）のみではカウントせず、実際の大人からの返信（answered）がついたものだけを未読カウント
 * @param {Object} state
 * @returns {number}
 */
export function getUnreadCount(state) {
  return state.questions.filter(q => !q.isSample && !q.readByOwner && q.status === 'answered').length;
}

/**
 * 問いの詳細を開いたときに既読にする
 * @param {Object} state
 * @param {string} id
 */
export function markQuestionAsRead(state, id) {
  const q = getQuestionById(state, id);
  if (q && !q.isSample) {
    q.readByOwner = true;
  }
}

/**
 * デモ操作: スタッフによる問いの承認
 * pending -> waiting に遷移し、公開状態 (isPublic = true) にする
 * @param {Object} state
 * @param {string} questionId
 * @returns {{ ok: boolean, error?: string }}
 */
export function approveQuestion(state, questionId) {
  const q = getQuestionById(state, questionId);
  if (!q) {
    return { ok: false, error: '指定された問いが見つかりません。' };
  }
  if (q.status !== 'pending') {
    return { ok: false, error: `現在のステータス (${q.status}) から承認へは遷移できません。` };
  }

  q.status = 'waiting';
  q.isPublic = true;
  // ユーザーの未読フラグを立てる（通知用）
  if (!q.isSample) {
    q.readByOwner = false;
  }
  return { ok: true, question: q };
}

/**
 * デモ操作: 大人の返信を追加
 * 承認済み（waiting または answered）の問いにのみ返信可能
 * @param {Object} state
 * @param {string} questionId
 * @param {Object} replyData
 * @param {string} replyData.body
 * @param {string} replyData.author
 * @param {string} replyData.role
 * @returns {{ ok: boolean, reply?: Object, error?: string }}
 */
export function addReplyToQuestion(state, questionId, replyData) {
  const q = getQuestionById(state, questionId);
  if (!q) {
    return { ok: false, error: '指定された問いが見つかりません。' };
  }
  if (q.status === 'pending') {
    return { ok: false, error: 'スタッフの確認前の問いには返信できません。まず承認してください。' };
  }
  if (q.status === 'withdrawn') {
    return { ok: false, error: '取り下げ済みの問いには返信できません。' };
  }

  const rawBody = (replyData?.body ?? '').trim();
  if (!rawBody) {
    return { ok: false, error: '返事の本文を入力してください。' };
  }

  const replyId = `reply-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const newReply = {
    id: replyId,
    author: (replyData?.author ?? '').trim() || 'スタッフ',
    role: (replyData?.role ?? '').trim() || '大人サポーター',
    body: rawBody,
    createdAt: new Date().toISOString().slice(0, 10)
  };

  q.replies.push(newReply);
  q.status = 'answered';
  if (!q.isSample) {
    q.readByOwner = false; // 新着返事通知
  }

  return { ok: true, reply: newReply };
}

/**
 * 問いの取り下げ
 * 公開を取り消し、ステータスを withdrawn にする
 * @param {Object} state
 * @param {string} questionId
 * @returns {{ ok: boolean, error?: string }}
 */
export function withdrawQuestion(state, questionId) {
  const q = getQuestionById(state, questionId);
  if (!q) {
    return { ok: false, error: '指定された問いが見つかりません。' };
  }
  if (q.status === 'withdrawn') {
    return { ok: false, error: 'すでにこの問いは取り下げられています。' };
  }

  q.status = 'withdrawn';
  q.isPublic = false;
  return { ok: true, question: q };
}

/**
 * 「別の問いをひらく」: 公開済みのシード問い（サンプル）のみを順繰りに切り替える
 * ※ ユーザーの未承認・保留中ポストは決して表示しない
 * @param {Object} state
 * @returns {Object|null}
 */
export function getNextSpotlightQuestion(state) {
  const sampleApproved = state.questions.filter(q => q.isSample && q.isPublic && (q.status === 'waiting' || q.status === 'answered'));
  if (sampleApproved.length === 0) return null;

  state.spotlightIndex = (state.spotlightIndex + 1) % sampleApproved.length;
  return sampleApproved[state.spotlightIndex];
}

/**
 * 現在のスポットライト対象シード問いを取得
 * @param {Object} state
 * @returns {Object|null}
 */
export function getCurrentSpotlightQuestion(state) {
  const sampleApproved = state.questions.filter(q => q.isSample && q.isPublic && (q.status === 'waiting' || q.status === 'answered'));
  if (sampleApproved.length === 0) return null;
  const index = state.spotlightIndex % sampleApproved.length;
  return sampleApproved[index];
}

/**
 * 画面遷移ではなく、同じページ内の要素へ移動するためのハッシュ
 * リンクの既定動作を止めていても、新しいタブで開く・URLを直接指定する経路では
 * ルーターに届くため、404 にせず skip として扱う
 */
export const IN_PAGE_ANCHORS = ['main-content', 'question-list-title'];

/**
 * ハッシュ文字列からルーティングのアクションを判定する
 * ページ内アンカー（IN_PAGE_ANCHORS）は 404 とせず skip アクションとして解決する
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
