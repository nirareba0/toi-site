/**
 * tests/core.test.mjs - 状態遷移・バリデーション・公開範囲のユニットテスト
 * 実行方法: node --test tests/core.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  validateQuestionDraft,
  countCharacters,
  submitQuestion,
  getPublicQuestions,
  getUserQuestions,
  getQuestionById,
  getPublicQuestionById,
  getUnreadCount,
  markQuestionAsRead,
  approveQuestion,
  addReplyToQuestion,
  withdrawQuestion,
  getNextSpotlightQuestion,
  getReceiptQuestion,
  resolveRoute,
  setDraft,
  getPromptHint,
  MAX_BODY_LENGTH
} from '../core.mjs';

test('バリデーション: 空白のみの投稿を拒否する', () => {
  const resultEmpty = validateQuestionDraft({ body: '' });
  assert.equal(resultEmpty.valid, false);
  assert.ok(resultEmpty.errors.body);

  const resultSpaces = validateQuestionDraft({ body: '   \n\t  ' });
  assert.equal(resultSpaces.valid, false);
  assert.ok(resultSpaces.errors.body);
});

test('バリデーション: 500文字上限と絵文字・結合絵文字・国旗の文字数カウントと境界テスト', () => {
  // 500文字ちょうどの投稿は有効
  const exact500 = 'あ'.repeat(MAX_BODY_LENGTH);
  const result500 = validateQuestionDraft({ body: exact500 });
  assert.equal(result500.valid, true);
  assert.equal(countCharacters(exact500), 500);

  // 501文字は無効
  const over501 = 'あ'.repeat(MAX_BODY_LENGTH + 1);
  const result501 = validateQuestionDraft({ body: over501 });
  assert.equal(result501.valid, false);
  assert.ok(result501.errors.body.includes('500文字以内で入力してください（現在501文字）。'));

  // 通常の絵文字（サロゲートペア）のカウント
  const emojiStr = '🐱✨🌸';
  assert.equal(countCharacters(emojiStr), 3);

  // 国旗絵文字（Regional Indicator Symbol ペア）が見た目の1文字としてカウントされること
  assert.equal(countCharacters('🇯🇵'), 1);
  assert.equal(countCharacters('🇺🇸'), 1);
  assert.equal(countCharacters('🇫🇷'), 1);

  // 結合絵文字（ZWJ sequence, 肌色修飾子など）が見た目の1文字としてカウントされること
  assert.equal(countCharacters('👨‍👩‍👧‍👦'), 1); // 家族
  assert.equal(countCharacters('🧑‍💻'), 1); // エンジニア
  assert.equal(countCharacters('👍🏽'), 1); // スキンモディファイア
  assert.equal(countCharacters('🏳️‍🌈'), 1); // レインボーフラッグ

  // 日本語と国旗・結合絵文字の混在
  const mixedStr = 'こんにちは🇯🇵👨‍👩‍👧‍👦';
  assert.equal(countCharacters(mixedStr), 7);
  const mixedDraft = validateQuestionDraft({ body: mixedStr });
  assert.equal(mixedDraft.valid, true);

  // 境界テスト: 499文字 + 国旗 (1文字) = 500文字 (有効)
  const boundaryFlag500 = 'あ'.repeat(499) + '🇯🇵';
  assert.equal(countCharacters(boundaryFlag500), 500);
  assert.equal(validateQuestionDraft({ body: boundaryFlag500 }).valid, true);

  // 境界テスト: 500文字 + 国旗 (1文字) = 501文字 (無効・501文字エラー)
  const boundaryFlag501 = 'あ'.repeat(500) + '🇯🇵';
  assert.equal(countCharacters(boundaryFlag501), 501);
  const resFlag501 = validateQuestionDraft({ body: boundaryFlag501 });
  assert.equal(resFlag501.valid, false);
  assert.ok(resFlag501.errors.body.includes('500文字以内で入力してください（現在501文字）。'));

  // 境界テスト: 499文字 + 結合絵文字 (1文字) = 500文字 (有効)
  const boundaryZwb500 = 'あ'.repeat(499) + '👨‍👩‍👧‍👦';
  assert.equal(countCharacters(boundaryZwb500), 500);
  assert.equal(validateQuestionDraft({ body: boundaryZwb500 }).valid, true);

  // 境界テスト: 500文字 + 結合絵文字 (1文字) = 501文字 (無効・501文字エラー)
  const boundaryZwb501 = 'あ'.repeat(500) + '👨‍👩‍👧‍👦';
  assert.equal(countCharacters(boundaryZwb501), 501);
  const resZwb501 = validateQuestionDraft({ body: boundaryZwb501 });
  assert.equal(resZwb501.valid, false);
  assert.ok(resZwb501.errors.body.includes('500文字以内で入力してください（現在501文字）。'));

  // 境界テスト: 国旗のみ500文字 (有効)
  const allFlags500 = '🇯🇵'.repeat(500);
  assert.equal(countCharacters(allFlags500), 500);
  assert.equal(validateQuestionDraft({ body: allFlags500 }).valid, true);

  // 境界テスト: 国旗のみ501文字 (無効)
  const allFlags501 = '🇯🇵'.repeat(501);
  assert.equal(countCharacters(allFlags501), 501);
  const resAllFlags501 = validateQuestionDraft({ body: allFlags501 });
  assert.equal(resAllFlags501.valid, false);
  assert.ok(resAllFlags501.errors.body.includes('500文字以内で入力してください（現在501文字）。'));
});

test('文字数カウント: Intl.Segmenter 非対応環境でのフォールバック動作', () => {
  const originalSegmenter = Intl.Segmenter;
  try {
    delete Intl.Segmenter;
    // Intl.Segmenter がない環境でも countCharacters は例外を出さず Array.from でカウント
    assert.equal(countCharacters('こんにちは'), 5);
    assert.equal(countCharacters(''), 0);
    assert.equal(countCharacters(null), 0);
    assert.equal(countCharacters('🐱✨'), 2);
  } finally {
    Intl.Segmenter = originalSegmenter;
  }
});

test('バリデーション: 一文のみ、および非疑問文の投稿を受け付ける', () => {
  const statement = '最近、部活に行きたくない。';
  const res = validateQuestionDraft({ body: statement });
  assert.equal(res.valid, true);
  assert.equal(res.normalized.body, statement);
  assert.equal(res.normalized.nickname, 'ななし');
  assert.equal(res.normalized.topic, '未分類');
});

test('プロンプト選択: 書き出しヒント選択によって下書きが勝手に改変されない', () => {
  const state = createInitialState();
  const originalDraft = { body: '私の疑問', nickname: 'テスト太郎', topic: '自分' };
  setDraft(state, originalDraft);

  // ヒントを取得
  const hint = getPromptHint('why');
  assert.ok(hint);
  assert.equal(hint.label, 'なんでだろう');

  // stateの下書きは変更されていない
  assert.equal(state.currentDraft.body, '私の疑問');
  assert.equal(state.currentDraft.nickname, 'テスト太郎');
});

test('公開範囲: 投稿直後(pending)の問いは公開一覧に含まれない', () => {
  const state = createInitialState();
  const initialPublicCount = getPublicQuestions(state).length;

  setDraft(state, { body: 'これは新しいユーザーの問いです', nickname: 'ユースA' });
  const submitRes = submitQuestion(state);
  assert.equal(submitRes.ok, true);
  assert.equal(submitRes.question.status, 'pending');
  assert.equal(submitRes.question.isPublic, false);

  // 公開一覧に含まれていないことを確認
  const publicQuestions = getPublicQuestions(state);
  assert.equal(publicQuestions.length, initialPublicCount);
  assert.equal(publicQuestions.some(q => q.id === submitRes.question.id), false);

  // ユーザーの問い一覧には含まれる
  const userQuestions = getUserQuestions(state);
  assert.equal(userQuestions.length, 1);
  assert.equal(userQuestions[0].id, submitRes.question.id);
});

test('承認フロー: pending から承認(waiting)を経て公開され、返信が可能になる', () => {
  const state = createInitialState();
  setDraft(state, { body: '大人って自由ですか？', nickname: '中学生B' });
  const submitRes = submitQuestion(state);
  const qId = submitRes.question.id;

  // 未承認の状態で返信しようとするとエラー
  const preReplyRes = addReplyToQuestion(state, qId, {
    author: 'スタッフ1',
    role: 'スタッフ',
    body: '自由でもあり、責任もあります。'
  });
  assert.equal(preReplyRes.ok, false);
  assert.ok(preReplyRes.error.includes('確認前'));

  // 承認実行
  const approveRes = approveQuestion(state, qId);
  assert.equal(approveRes.ok, true);
  assert.equal(approveRes.question.status, 'waiting');
  assert.equal(approveRes.question.isPublic, true);

  // 公開一覧に現れることを確認
  const publicQuestions = getPublicQuestions(state);
  assert.ok(publicQuestions.some(q => q.id === qId));

  // 承認されたので返信が可能になる
  const replyRes = addReplyToQuestion(state, qId, {
    author: 'なかむら',
    role: 'エンジニア・30代',
    body: '自分の時間を自分で決められるという意味では自由です！'
  });
  assert.equal(replyRes.ok, true);
  assert.equal(replyRes.reply.author, 'なかむら');

  // ステータスが answered に更新される
  const updatedQ = state.questions.find(q => q.id === qId);
  assert.equal(updatedQ.status, 'answered');
  assert.equal(updatedQ.replies.length, 1);
});

test('不正な状態遷移の拒否', () => {
  const state = createInitialState();
  // すでに answered の seed-1 に対する再承認は不可
  const invApprove = approveQuestion(state, 'seed-1');
  assert.equal(invApprove.ok, false);
  assert.ok(invApprove.error.includes('遷移できません'));

  // 存在しない問いへの返信や承認は不可
  assert.equal(approveQuestion(state, 'non-existent').ok, false);
  assert.equal(addReplyToQuestion(state, 'non-existent', { body: 'テスト' }).ok, false);
});

test('取り下げ: 取り下げた問いは即座に公開一覧から除外される', () => {
  const state = createInitialState();
  // seed-1 は最初 answered かつ public
  const initialPublic = getPublicQuestions(state);
  assert.ok(initialPublic.some(q => q.id === 'seed-1'));

  // 取り下げ実行
  const withdrawRes = withdrawQuestion(state, 'seed-1');
  assert.equal(withdrawRes.ok, true);
  assert.equal(withdrawRes.question.status, 'withdrawn');
  assert.equal(withdrawRes.question.isPublic, false);

  // 公開一覧から消えていること
  const updatedPublic = getPublicQuestions(state);
  assert.equal(updatedPublic.some(q => q.id === 'seed-1'), false);

  // 二重取り下げは拒否
  const doubleWithdraw = withdrawQuestion(state, 'seed-1');
  assert.equal(doubleWithdraw.ok, false);

  // 取り下げ済みの問いには返信できない
  const replyToWithdrawn = addReplyToQuestion(state, 'seed-1', { body: '返信試行' });
  assert.equal(replyToWithdrawn.ok, false);
  assert.ok(replyToWithdrawn.error.includes('取り下げ済み'));
});

test('二重送信ガード: 送信後に下書きがクリアされ、同じ下書きが二重送信されない', () => {
  const state = createInitialState();
  setDraft(state, { body: '一回だけの問い', nickname: 'ななし' });

  const res1 = submitQuestion(state);
  assert.equal(res1.ok, true);
  assert.equal(state.currentDraft, null);

  // 2回目の送信試行は下書きが存在しないためエラー
  const res2 = submitQuestion(state);
  assert.equal(res2.ok, false);
  assert.equal(res2.error, '提出する下書きがありません。');
});

test('スポットライト機能: 「別の問いをひらく」は公開承認済みサンプルのみを切り替え、未承認ユーザー投稿を含めない', () => {
  const state = createInitialState();
  // 未承認のユーザー問いを追加
  setDraft(state, { body: '未承認ユーザーの秘密の問い' });
  submitQuestion(state);

  const seenIds = new Set();
  for (let i = 0; i < 10; i++) {
    const q = getNextSpotlightQuestion(state);
    assert.ok(q);
    assert.equal(q.isSample, true);
    assert.equal(q.isPublic, true);
    assert.notEqual(q.status, 'pending');
    seenIds.add(q.id);
  }
  // シードのうち公開されているものが循環する
  assert.ok(seenIds.size >= 3);
});

test('公開詳細ガード (getPublicQuestionById): 公開承認済みのみ取得でき、確認中・取り下げ済みは除外される', () => {
  const state = createInitialState();
  // 公開済みのシード問いは取得できる
  assert.ok(getPublicQuestionById(state, 'seed-1'));
  assert.equal(getPublicQuestionById(state, 'seed-1').status, 'answered');
  assert.ok(getPublicQuestionById(state, 'seed-5'));
  assert.equal(getPublicQuestionById(state, 'seed-5').status, 'waiting');

  // 未承認(pending)のユーザー投稿は取得不可(null)
  setDraft(state, { body: '確認中の非公開問い' });
  const submitRes = submitQuestion(state);
  assert.equal(submitRes.ok, true);
  assert.equal(getPublicQuestionById(state, submitRes.question.id), null);

  // 承認後は取得可能になる
  approveQuestion(state, submitRes.question.id);
  assert.ok(getPublicQuestionById(state, submitRes.question.id));

  // 取り下げ後は再度取得不可(null)になる
  withdrawQuestion(state, submitRes.question.id);
  assert.equal(getPublicQuestionById(state, submitRes.question.id), null);

  // 存在しないIDは null
  assert.equal(getPublicQuestionById(state, 'unknown-id'), null);
});

test('二重送信ガード詳細: 下書き消費後の再提出呼び出しは2件目の投稿を作成しない', () => {
  const state = createInitialState();
  const initialLength = state.questions.length;
  setDraft(state, { body: '1回限りの提出テスト' });

  // 初回送信
  const firstRes = submitQuestion(state);
  assert.equal(firstRes.ok, true);
  assert.equal(state.questions.length, initialLength + 1);

  // 下書きが空のままの再送信試行
  const repeatRes = submitQuestion(state);
  assert.equal(repeatRes.ok, false);
  assert.equal(repeatRes.error, '提出する下書きがありません。');
  // 投稿数は増えていない
  assert.equal(state.questions.length, initialLength + 1);
});

test('未読バッジ回帰検証: 承認(waiting)のみでは未読とならず、実際の返信(answered)のみをカウントする', () => {
  const state = createInitialState();
  assert.equal(getUnreadCount(state), 0);

  // 1. ユーザーが問いを投稿 (pending)
  setDraft(state, { body: '大人の返信テスト' });
  const submitRes = submitQuestion(state);
  const qId = submitRes.question.id;
  assert.equal(getUnreadCount(state), 0);

  // 2. スタッフが承認 (waiting) -> この段階ではまだ返信がないため未読カウントは 0 のまま
  approveQuestion(state, qId);
  assert.equal(getUnreadCount(state), 0);

  // 3. スタッフ/大人が返信を追加 (answered) -> 未読カウントが 1 になる
  const replyRes = addReplyToQuestion(state, qId, {
    author: 'やまだ',
    role: 'ユースワーカー',
    body: 'お返事です。'
  });
  assert.equal(replyRes.ok, true);
  assert.equal(getUnreadCount(state), 1);

  // 4. 問い詳細を開いて既読化
  markQuestionAsRead(state, qId);
  assert.equal(getUnreadCount(state), 0);
});

test('ルーター解決 (resolveRoute): スキップリンク(#main-content)で404にならずskip判定される', () => {
  // スキップリンクは skip アクションとして解決され、404 (not_found) にならない
  assert.deepEqual(resolveRoute('#main-content'), { type: 'skip', path: 'main-content' });
  assert.deepEqual(resolveRoute('main-content'), { type: 'skip', path: 'main-content' });
  assert.deepEqual(resolveRoute('#/main-content'), { type: 'skip', path: 'main-content' });

  // 通常の主要ルート解決
  assert.deepEqual(resolveRoute(''), { type: 'route', path: 'home' });
  assert.deepEqual(resolveRoute('#'), { type: 'route', path: 'home' });
  assert.deepEqual(resolveRoute('#home'), { type: 'route', path: 'home' });
  assert.deepEqual(resolveRoute('#ask'), { type: 'route', path: 'ask', paramId: undefined });
  assert.deepEqual(resolveRoute('#ask/confirm'), { type: 'route', path: 'ask', paramId: 'confirm' });
  assert.deepEqual(resolveRoute('#receipt/user-123'), { type: 'route', path: 'receipt', paramId: 'user-123' });
  assert.deepEqual(resolveRoute('#inbox'), { type: 'route', path: 'inbox', paramId: undefined });
  assert.deepEqual(resolveRoute('#question/seed-1'), { type: 'route', path: 'question', paramId: 'seed-1' });
  assert.deepEqual(resolveRoute('#about'), { type: 'route', path: 'about', paramId: undefined });

  // 未知のルートは not_found
  assert.deepEqual(resolveRoute('#unknown-route'), { type: 'not_found', path: 'unknown-route' });
  assert.deepEqual(resolveRoute('#foo/bar'), { type: 'not_found', path: 'foo' });
  assert.deepEqual(resolveRoute('#ask/unexpected'), { type: 'not_found', path: 'ask' });
  assert.deepEqual(resolveRoute('#question/seed-1/unexpected'), { type: 'not_found', path: 'question' });
  assert.deepEqual(resolveRoute('#receipt'), { type: 'not_found', path: 'receipt' });
});

test('受付画面ガード (getReceiptQuestion): 直前に送信したユーザー投稿のみ受け付け、サンプルや他IDは除外', () => {
  const state = createInitialState();

  // 1. 初期状態（未送信）: 何を指定しても null
  assert.equal(getReceiptQuestion(state, 'seed-1'), null);
  assert.equal(getReceiptQuestion(state, 'user-q-1'), null);
  assert.equal(getReceiptQuestion(state, ''), null);
  assert.equal(getReceiptQuestion(state, null), null);

  // 2. ユーザーが1件目を送信
  setDraft(state, { body: '1回目の投稿です', nickname: 'ななし' });
  const submitRes1 = submitQuestion(state);
  assert.equal(submitRes1.ok, true);
  const qId1 = submitRes1.question.id;

  // 直前の投稿IDであれば取得可能
  const receiptQ1 = getReceiptQuestion(state, qId1);
  assert.ok(receiptQ1);
  assert.equal(receiptQ1.id, qId1);
  assert.equal(receiptQ1.body, '1回目の投稿です');

  // サンプル投稿のIDを指定しても取得不可（誤って受付完了と表示しない）
  assert.equal(getReceiptQuestion(state, 'seed-1'), null);
  assert.equal(getReceiptQuestion(state, 'seed-2'), null);

  // 存在しないIDや無効なIDを指定しても取得不可
  assert.equal(getReceiptQuestion(state, 'non-existent-id'), null);

  // 3. ユーザーが2件目を送信
  setDraft(state, { body: '2回目の投稿です', nickname: 'ななし' });
  const submitRes2 = submitQuestion(state);
  assert.equal(submitRes2.ok, true);
  const qId2 = submitRes2.question.id;

  // 最新（2件目）の投稿IDは取得可能
  const receiptQ2 = getReceiptQuestion(state, qId2);
  assert.ok(receiptQ2);
  assert.equal(receiptQ2.id, qId2);
  assert.equal(receiptQ2.body, '2回目の投稿です');

  // 1件目の投稿IDは「直前の送信」ではなくなったため取得不可
  assert.equal(getReceiptQuestion(state, qId1), null);

  // 4. サンプル投稿が lastSubmittedId に偽装された場合でもガードされること
  state.lastSubmittedId = 'seed-1';
  assert.equal(getReceiptQuestion(state, 'seed-1'), null);

  // 5. 受付は確認中かつ非公開の間だけ表示できる
  state.lastSubmittedId = qId2;
  approveQuestion(state, qId2);
  assert.equal(getReceiptQuestion(state, qId2), null);

  addReplyToQuestion(state, qId2, { author: 'スタッフ', role: 'スタッフ', body: '返事です。' });
  assert.equal(getReceiptQuestion(state, qId2), null);

  withdrawQuestion(state, qId2);
  assert.equal(getReceiptQuestion(state, qId2), null);
});
