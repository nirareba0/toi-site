import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_NICKNAME,
  MAX_BODY_LENGTH,
  countCharacters,
  truncateForDisplay,
  validateQuestionDraft,
  resolveRoute,
  loadMyQuestions,
  saveMyQuestion,
  removeMyQuestion,
  loadSeenAnswerIds,
  markAnswerAsSeen,
  matchMyQuestions,
  calculateUnreadCount,
  formatAnswerForPublic,
  activeSiteLinks
} from "../js/core.mjs";

function createMockStorage(initialData = {}) {
  const store = new Map(Object.entries(initialData));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
}

test("1. 投函の入力検証 (validateQuestionDraft)", async (t) => {
  await t.test("空文字および空白文字（改行・タブ等）のみの投稿を拒絶する", () => {
    assert.equal(validateQuestionDraft({ body: "" }).valid, false);
    assert.equal(validateQuestionDraft({ body: "   " }).valid, false);
    assert.equal(validateQuestionDraft({ body: "\n\t  \n" }).valid, false);
    assert.equal(validateQuestionDraft(null).valid, false);
    assert.equal(validateQuestionDraft({}).valid, false);
  });

  await t.test("文字数カウントと境界値検証 (MAX_BODY_LENGTH = 400)", () => {
    // 1文字: 有効
    const res1 = validateQuestionDraft({ body: "あ" });
    assert.equal(res1.valid, true);
    assert.equal(res1.normalized.body, "あ");

    // 400文字: 境界値 有効
    const body400 = "あ".repeat(400);
    const res400 = validateQuestionDraft({ body: body400 });
    assert.equal(res400.valid, true);

    // 401文字: 上限超過 無効
    const body401 = "あ".repeat(401);
    const res401 = validateQuestionDraft({ body: body401 });
    assert.equal(res401.valid, false);
    assert.match(res401.errors.body, /400文字以内で入力してください/);
  });

  await t.test("絵文字・書記素クラスタを1文字として正確にカウントする", () => {
    const familyEmoji = "👨‍👩‍👧‍👦"; // 結合絵文字
    const flagEmoji = "🇯🇵"; // 国旗
    assert.equal(countCharacters(familyEmoji), 1);
    assert.equal(countCharacters(flagEmoji), 1);
    assert.equal(countCharacters("問い？💭✨"), 5);

    const emojiText = "🎉".repeat(400);
    assert.equal(validateQuestionDraft({ body: emojiText }).valid, true);

    const emojiOver = "🎉".repeat(401);
    assert.equal(validateQuestionDraft({ body: emojiOver }).valid, false);
  });

  await t.test("ニックネームの省略時は「だれか」に正規化される", () => {
    const resDefault = validateQuestionDraft({ body: "テストの問い" });
    assert.equal(resDefault.normalized.nickname, DEFAULT_NICKNAME);

    const resEmpty = validateQuestionDraft({ body: "テストの問い", nickname: "  " });
    assert.equal(resEmpty.normalized.nickname, DEFAULT_NICKNAME);

    const resNamed = validateQuestionDraft({ body: "テストの問い", nickname: " ゆき " });
    assert.equal(resNamed.normalized.nickname, "ゆき");
  });

  await t.test("一文のみ・疑問形以外の文章も正常に受理する", () => {
    const statement = "今日は空が青いと思った。";
    const res = validateQuestionDraft({ body: statement });
    assert.equal(res.valid, true);
  });
});

test("2. localStorage による投稿管理 (load/save/remove)", async (t) => {
  await t.test("投稿の新規保存と読み出しができる", () => {
    const storage = createMockStorage();
    assert.deepEqual(loadMyQuestions(storage), []);

    const q1 = { id: "uuid-1", body: "問い1", created_at: "2026-09-18T10:00:00Z" };
    saveMyQuestion(storage, q1);

    const loaded = loadMyQuestions(storage);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, "uuid-1");
    assert.equal(loaded[0].body, "問い1");
  });

  await t.test("既存投稿の更新と並び順を維持する", () => {
    const storage = createMockStorage();
    const q1 = { id: "uuid-1", body: "問い1", created_at: "2026-09-18T10:00:00Z" };
    const q2 = { id: "uuid-2", body: "問い2", created_at: "2026-09-18T11:00:00Z" };
    saveMyQuestion(storage, q1);
    saveMyQuestion(storage, q2);

    const list = loadMyQuestions(storage);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "uuid-2"); // 先頭追加

    // q1 を更新
    saveMyQuestion(storage, { id: "uuid-1", body: "問い1（改）" });
    const updated = loadMyQuestions(storage);
    assert.equal(updated.length, 2);
    const updatedQ1 = updated.find(q => q.id === "uuid-1");
    assert.equal(updatedQ1.body, "問い1（改）");
  });

  await t.test("指定IDの投稿をローカル履歴から削除できる", () => {
    const storage = createMockStorage();
    saveMyQuestion(storage, { id: "uuid-1", body: "問い1" });
    saveMyQuestion(storage, { id: "uuid-2", body: "問い2" });

    removeMyQuestion(storage, "uuid-1");
    const remaining = loadMyQuestions(storage);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "uuid-2");
  });
});

test("3. localStorage と public_questions の突き合わせ (matchMyQuestions)", async (t) => {
  await t.test("未承認の投稿は pending（確認中・非公開）として扱われる", () => {
    const myQuestions = [
      { id: "local-unapproved", body: "私の問い", created_at: "2026-09-18T12:00:00Z" }
    ];
    const publicQuestions = []; // 匿名からは未承認行が見えないため空

    const matched = matchMyQuestions(myQuestions, publicQuestions);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].id, "local-unapproved");
    assert.equal(matched[0].status, "pending");
    assert.equal(matched[0].isPublic, false);
    assert.equal(matched[0].answerCount, 0);
  });

  await t.test("承認済み・返事0件の投稿は waiting（公開中・返事待ち）として扱われる", () => {
    const myQuestions = [
      { id: "local-approved", body: "私の問い", created_at: "2026-09-18T12:00:00Z" }
    ];
    const publicQuestions = [
      {
        id: "local-approved",
        body: "私の問い",
        nickname: "ゆき",
        theme_label: "生き方",
        answer_count: 0,
        created_at: "2026-09-18T12:00:00Z"
      }
    ];

    const matched = matchMyQuestions(myQuestions, publicQuestions);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].id, "local-approved");
    assert.equal(matched[0].status, "waiting");
    assert.equal(matched[0].isPublic, true);
    assert.equal(matched[0].answerCount, 0);
    assert.equal(matched[0].theme_label, "生き方");
  });

  await t.test("承認済み・返事ありの投稿は answered（返事が届きました）として扱われる", () => {
    const myQuestions = [
      { id: "local-answered", body: "私の問い", created_at: "2026-09-18T12:00:00Z" }
    ];
    const publicQuestions = [
      {
        id: "local-answered",
        body: "私の問い",
        nickname: "ゆき",
        theme_label: "自分",
        answer_count: 2,
        created_at: "2026-09-18T12:00:00Z"
      }
    ];

    const matched = matchMyQuestions(myQuestions, publicQuestions);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].id, "local-answered");
    assert.equal(matched[0].status, "answered");
    assert.equal(matched[0].isPublic, true);
    assert.equal(matched[0].answerCount, 2);
  });

  await t.test("複数の投稿（未承認・返事待ち・返事あり）が混在しても正しく振り分けられる", () => {
    const myQuestions = [
      { id: "q-pending", body: "未承認の問い" },
      { id: "q-waiting", body: "返事待ちの問い" },
      { id: "q-answered", body: "返事ありの問い" }
    ];
    const publicQuestions = [
      { id: "q-waiting", body: "返事待ちの問い", answer_count: 0 },
      { id: "q-answered", body: "返事ありの問い", answer_count: 1 }
    ];

    const matched = matchMyQuestions(myQuestions, publicQuestions);
    assert.equal(matched[0].status, "pending");
    assert.equal(matched[0].isPublic, false);
    assert.equal(matched[1].status, "waiting");
    assert.equal(matched[1].isPublic, true);
    assert.equal(matched[2].status, "answered");
    assert.equal(matched[2].isPublic, true);
  });
});

test("4. 未読バッジ件数の算出 (calculateUnreadCount)", async (t) => {
  await t.test("未承認および返事待ちでは未読バッジをカウントしない", () => {
    const questions = [
      { id: "q1", status: "pending", answerCount: 0 },
      { id: "q2", status: "waiting", answerCount: 0 }
    ];
    assert.equal(calculateUnreadCount(questions, new Set()), 0);
  });

  await t.test("返事あり（answered）かつ未読の場合のみカウントし、閲覧で既読化される", () => {
    const questions = [
      { id: "q1", status: "pending", answerCount: 0 },
      { id: "q2", status: "answered", answerCount: 1 },
      { id: "q3", status: "answered", answerCount: 2 }
    ];

    // 初回: 2件が未読
    const seen = new Set();
    assert.equal(calculateUnreadCount(questions, seen), 2);

    // q2 を閲覧
    seen.add("q2");
    assert.equal(calculateUnreadCount(questions, seen), 1);

    // q3 を閲覧
    seen.add("q3");
    assert.equal(calculateUnreadCount(questions, seen), 0);
  });
});

test("5. 公開側プライバシー保護 (formatAnswerForPublic)", async (t) => {
  await t.test("回答者の氏名・ニックネームを一切含めず、立場（role）のみを出力する", () => {
    const rawAnswer = {
      id: "ans-1",
      question_id: "q-1",
      body: "回答本文です。",
      author: "山田太郎", // 個人情報
      nickname: "やまちゃん", // 個人情報
      responder_role: "Miacis スタッフ",
      created_at: "2026-09-18T15:00:00Z"
    };

    const formatted = formatAnswerForPublic(rawAnswer);
    assert.equal(formatted.id, "ans-1");
    assert.equal(formatted.question_id, "q-1");
    assert.equal(formatted.body, "回答本文です。");
    assert.equal(formatted.role, "Miacis スタッフ");
    assert.equal(formatted.created_at, "2026-09-18T15:00:00Z");

    // author, nickname プロパティが存在しないことを厳格に検証
    assert.equal("author" in formatted, false);
    assert.equal("nickname" in formatted, false);
  });

  await t.test("立場が空の場合はデフォルトの「匿名」を補う", () => {
    const formatted = formatAnswerForPublic({
      id: "ans-2",
      body: "本文",
      responder_role: ""
    });
    assert.equal(formatted.role, "匿名");
  });

  await t.test("AI と一緒に考えた返事であることが公開側に伝わる", () => {
    const withAi = formatAnswerForPublic({
      id: "ans-3", body: "x", responder_role: "Miacis のスタッフ", ai_assisted: true
    });
    assert.equal(withAi.aiAssisted, true);

    const withoutAi = formatAnswerForPublic({
      id: "ans-4", body: "y", responder_role: "Miacis のスタッフ"
    });
    assert.equal(withoutAi.aiAssisted, false);

    // 氏名は何を渡しても公開側に出さない
    const withName = formatAnswerForPublic({
      id: "ans-5", body: "z", nickname: "本名太郎", responder_role: "大学生"
    });
    assert.equal(withName.role, "大学生");
    assert.equal("nickname" in withName, false);
  });
});

test("6. ルーター解決 (resolveRoute)", async (t) => {
  await t.test("定義されたルートを正しく解決する", () => {
    assert.deepEqual(resolveRoute(""), { type: "route", path: "home" });
    assert.deepEqual(resolveRoute("#"), { type: "route", path: "home" });
    assert.deepEqual(resolveRoute("#home"), { type: "route", path: "home" });
    assert.deepEqual(resolveRoute("#ask"), { type: "route", path: "ask", paramId: undefined });
    assert.deepEqual(resolveRoute("#ask/confirm"), { type: "route", path: "ask", paramId: "confirm" });
    assert.deepEqual(resolveRoute("#receipt/xyz-123"), { type: "route", path: "receipt", paramId: "xyz-123" });
    assert.deepEqual(resolveRoute("#inbox"), { type: "route", path: "inbox", paramId: undefined });
    assert.deepEqual(resolveRoute("#question/q-456"), { type: "route", path: "question", paramId: "q-456" });
    assert.deepEqual(resolveRoute("#about"), { type: "route", path: "about", paramId: undefined });
  });

  await t.test("ページ内アンカーは skip として解決され 404 にならない", () => {
    assert.deepEqual(resolveRoute("#main-content"), { type: "skip", path: "main-content" });
    assert.deepEqual(resolveRoute("#question-list-title"), { type: "skip", path: "question-list-title" });
  });

  await t.test("未知のルートは not_found として解決される", () => {
    assert.equal(resolveRoute("#unknown").type, "not_found");
    assert.equal(resolveRoute("#ask/something/else").type, "not_found");
    assert.equal(resolveRoute("#question").type, "not_found"); // paramId 不足
    assert.equal(resolveRoute("#receipt").type, "not_found");  // paramId 不足
  });
});

test("7. 表示用の切り詰め (truncateForDisplay)", () => {
  assert.equal(truncateForDisplay("短い文", 10), "短い文");
  assert.equal(truncateForDisplay("あいうえおかきくけこさしすせそ", 5), "あいうえお…");
  assert.equal(truncateForDisplay("👨‍👩‍👧‍👦🇯🇵💭✨🎉", 3), "👨‍👩‍👧‍👦🇯🇵💭…");
});

test("8. 運営リンク (activeSiteLinks)", async (t) => {
  await t.test("URL が空のときは何も出さない", () => {
    assert.deepEqual(activeSiteLinks({ instagram: "", operator: "" }), []);
    assert.deepEqual(activeSiteLinks({ instagram: "   ", operator: undefined }), []);
  });

  await t.test("https の URL だけを通す（推測や http は出さない）", () => {
    const out = activeSiteLinks({ instagram: "https://www.instagram.com/example/", operator: "example.com" });
    assert.equal(out.length, 1);
    assert.equal(out[0].key, "instagram");
    assert.equal(out[0].label, "Miacis の Instagram");
  });
});
