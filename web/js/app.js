/**
 * app.js - Miacis 問いコーナー 本番フロントエンド制御 & ルーティング
 * ES Module (ビルド不要・素の ES Modules)
 */

import {
  DEFAULT_THEMES,
  DEFAULT_NICKNAME,
  MAX_BODY_LENGTH,
  PROMPT_CHIPS,
  createInitialState,
  validateQuestionDraft,
  countCharacters,
  truncateForDisplay,
  activeSiteLinks,
  getPromptHint,
  resolveRoute,
  loadMyQuestions,
  saveMyQuestion,
  removeMyQuestion,
  loadSeenAnswerIds,
  markAnswerAsSeen,
  matchMyQuestions,
  calculateUnreadCount
} from "./core.mjs";

import {
  isConfigured,
  listThemes,
  listQuestions,
  getQuestion,
  getPublicQuestionsByIds,
  postQuestion
} from "./api.js";

// アプリケーション状態
const state = createInitialState();
state.isConfigured = isConfigured();

// DOM 要素参照
const mainContainer = document.getElementById("main-content");
const liveAnnouncer = document.getElementById("live-announcer");
const navInboxBadge = document.getElementById("nav-inbox-badge");
const bottomInboxBadge = document.getElementById("bottom-inbox-badge");
const configBanner = document.getElementById("app-config-banner");
const appDialog = document.getElementById("app-dialog");
const dialogTitle = document.getElementById("dialog-title");
const dialogDesc = document.getElementById("dialog-desc");
const dialogConfirmBtn = document.getElementById("dialog-confirm-btn");
const dialogCancelBtn = document.getElementById("dialog-cancel-btn");

let pendingRemoveQuestionId = null;
let activePromptChipId = null;
let currentRenderedRoute = null;

/**
 * スクリーンリーダー向けアナウンス
 * @param {string} message
 */
function announce(message) {
  if (liveAnnouncer) {
    liveAnnouncer.textContent = "";
    setTimeout(() => {
      liveAnnouncer.textContent = message;
    }, 50);
  }
}

/**
 * 安全な HTML エスケープ
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * ナビゲーションバーの未読バッジ & アクティブ状態更新
 * @param {string} currentRoute
 */
function updateNavigation(currentRoute) {
  const localQuestions = loadMyQuestions(localStorage);
  const seenIds = loadSeenAnswerIds(localStorage);
  const matched = matchMyQuestions(localQuestions, state.publicQuestions);
  const unreadCount = calculateUnreadCount(matched, seenIds);

  if (navInboxBadge) {
    if (unreadCount > 0) {
      navInboxBadge.textContent = String(unreadCount);
      navInboxBadge.hidden = false;
    } else {
      navInboxBadge.hidden = true;
    }
  }

  if (bottomInboxBadge) {
    bottomInboxBadge.hidden = unreadCount === 0;
  }

  // デスクトップナビ
  document.querySelectorAll(".desktop-nav-link").forEach(link => {
    const route = link.getAttribute("data-route");
    if (route === currentRoute || (currentRoute.startsWith("question/") && route === "home")) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });

  // モバイル下部ナビ
  document.querySelectorAll(".bottom-nav-item").forEach(item => {
    const route = item.getAttribute("data-bottom-route");
    if (route === currentRoute || (currentRoute.startsWith("question/") && route === "home")) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });
}

/**
 * データの初期読み込み & 同期
 */
async function syncData() {
  if (configBanner) {
    configBanner.hidden = state.isConfigured;
  }

  if (!state.isConfigured) {
    return;
  }

  try {
    // テーマ一覧
    const themes = await listThemes();
    if (themes && themes.length > 0) {
      state.themes = themes;
    }

    // 公開問い一覧
    const questions = await listQuestions({
      theme: state.selectedThemeId === "all" ? null : state.selectedThemeId
    });
    state.publicQuestions = questions;

    // ローカル投稿のステータス同期
    const localQuestions = loadMyQuestions(localStorage);
    if (localQuestions.length > 0) {
      const ids = localQuestions.map(q => q.id);
      const matchedPubs = await getPublicQuestionsByIds(ids);
      // ローカル問いの表示用キャッシュを更新
      state.matchedQuestions = matchMyQuestions(localQuestions, matchedPubs);
    }
  } catch (err) {
    console.error("データの同期中にエラーが発生しました:", err);
  }
}

/* ==========================================================================
   各画面のレンダラー
   ========================================================================== */

/**
 * 1. ホーム画面 (#home)
 * @param {boolean} [shouldFocusHeading=true]
 */
function renderHome(shouldFocusHeading = true) {
  const currentSpotlight =
    state.publicQuestions.length > 0
      ? state.publicQuestions[state.spotlightIndex % state.publicQuestions.length]
      : null;

  mainContainer.innerHTML = `
    <div class="home-desktop-grid">
      <!-- 左カラム: コンパクトヒーロー -->
      <section class="home-hero" aria-labelledby="home-heading">
        <div class="home-motif-wrapper" aria-hidden="true">
          <div class="paper-snippets-motif">
            <span class="motif-shape-paper">？</span>
            <span class="motif-shape-quote">“</span>
            <span class="motif-shape-sparkle"></span>
          </div>
        </div>

        <h1 id="home-heading" class="home-h1" tabindex="-1" aria-label="問いは、世界の見方をふやす。">
          <span class="home-h1-line">問いは、</span>
          <span class="home-h1-line">世界の見方をふやす。</span>
        </h1>
        <p class="home-subtitle">自分で問い、誰かの考えにふれる。答えがひとつに決まらなくても、そこから見えてくるものがある。</p>

        <div class="home-cta-row">
          <a href="#ask" class="btn btn-primary home-cta-primary">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9"></path>
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
            </svg>
            問いを書く
          </a>
          <a href="#question-list-title" class="home-cta-secondary" id="anchor-read-first">まずは読んでみる</a>
        </div>

        <!-- スポットライト（承認済みの公開問いのみ循環表示） -->
        ${currentSpotlight ? `
          <div class="spotlight-box" id="spotlight-container" aria-label="ピックアップされた問い">
            <div class="spotlight-header">
              <span class="spotlight-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                </svg>
                ひらいた問い
              </span>
              <button type="button" id="btn-cycle-spotlight" class="btn-cycle-spotlight" aria-label="別の問いをひらく">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
                </svg>
                別の問いをひらく
              </button>
            </div>
            <a href="#question/${currentSpotlight.id}" class="spotlight-body-link">${escapeHtml(currentSpotlight.body)}</a>
            <div class="spotlight-footer">
              <span>投稿: ${escapeHtml(currentSpotlight.nickname || DEFAULT_NICKNAME)}</span>
              <span>•</span>
              <span>${escapeHtml(currentSpotlight.theme_label || "未分類")}</span>
              <span>•</span>
              <span class="reply-count-has-replies">${Number(currentSpotlight.answer_count) > 0 ? `返事 ${currentSpotlight.answer_count}件` : "返事待ち"}</span>
            </div>
          </div>
        ` : ""}
      </section>

      <!-- 右カラム: 問い一覧 -->
      <section class="question-list-section" aria-labelledby="question-list-title">
        <div class="list-header-row">
          <div class="list-title-wrap">
            <h2 id="question-list-title" class="list-section-title">みんなの問い</h2>
          </div>

          <!-- テーマフィルター -->
          <div class="topic-filter-tabs" role="group" aria-label="テーマで絞り込み">
            <button type="button" 
                    class="filter-tab-btn ${state.selectedThemeId === 'all' ? 'active' : ''}" 
                    aria-pressed="${state.selectedThemeId === 'all'}" 
                    data-theme="all">
              すべて
            </button>
            ${state.themes.map(theme => `
              <button type="button" 
                      class="filter-tab-btn ${state.selectedThemeId === theme.id ? 'active' : ''}" 
                      aria-pressed="${state.selectedThemeId === theme.id}" 
                      data-theme="${theme.id}">
                ${escapeHtml(theme.label)}
              </button>
            `).join('')}
          </div>
        </div>

        <!-- 問いカード一覧 -->
        <div class="questions-container" id="questions-list" role="feed" aria-label="公開された問い一覧">
          ${!state.isConfigured ? `
            <div class="card p-lg" style="text-align: center; border-style: dashed;">
              <h3 style="font-size: 1.0625rem; font-weight: 700; color: var(--color-vivid-blue); margin-bottom: 8px;">設定が未完了です</h3>
              <p style="font-size: 0.875rem; color: var(--color-body); margin-bottom: 12px; line-height: 1.6;">
                Supabase の接続情報が設定されていません。<br>
                <code>web/js/config.example.js</code> を <code>web/js/config.js</code> にコピーし、URL と anon key を設定してください。
              </p>
              <p style="font-size: 0.8125rem; color: var(--color-body-muted);">
                設定が完了すると、承認された問いと返事がここに表示されます。
              </p>
            </div>
          ` : state.publicQuestions.length === 0 ? `
            <div class="card p-md" style="text-align: center; color: var(--color-body-muted);">
              該当するテーマの問いはまだありません。
            </div>
          ` : state.publicQuestions.map(q => {
            const answerCount = Number(q.answer_count || 0);
            return `
              <article class="question-card" data-question-id="${q.id}">
                <a href="#question/${q.id}" class="question-card-link" style="text-decoration: none; color: inherit;">
                  <div class="question-card-meta">
                    <span class="badge badge-topic">${escapeHtml(q.theme_label || "未分類")}</span>
                    <span class="question-card-author">${escapeHtml(q.nickname || DEFAULT_NICKNAME)}</span>
                  </div>
                  <h3 class="question-card-body">${escapeHtml(q.body)}</h3>
                  <div class="question-card-footer">
                    <span class="reply-count-tag ${answerCount > 0 ? 'reply-count-has-replies' : ''}">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                      </svg>
                      ${answerCount > 0 ? `返事 ${answerCount}件` : "返事を待っています"}
                    </span>
                    <span class="card-read-more" style="color: var(--color-vivid-blue); font-weight: 600; font-size: 0.75rem;">
                      読む →
                    </span>
                  </div>
                </a>
              </article>
            `;
          }).join('')}
        </div>
      </section>
    </div>
  `;

  if (shouldFocusHeading) {
    const h1 = document.getElementById("home-heading");
    if (h1) h1.focus();
  }

  // スポットライト切り替え
  const cycleBtn = document.getElementById("btn-cycle-spotlight");
  if (cycleBtn) {
    cycleBtn.addEventListener("click", () => {
      if (state.publicQuestions.length > 0) {
        state.spotlightIndex = (state.spotlightIndex + 1) % state.publicQuestions.length;
        renderHome(false);
        const spotlightBox = document.getElementById("spotlight-container");
        if (spotlightBox) {
          spotlightBox.classList.add("paper-settle-animation");
        }
        const current = state.publicQuestions[state.spotlightIndex];
        announce(`別の問いを開きました: ${current.body}`);
      }
    });
  }

  // スムーススクロール
  const anchorRead = document.getElementById("anchor-read-first");
  if (anchorRead) {
    anchorRead.addEventListener("click", (e) => {
      e.preventDefault();
      const listHeading = document.getElementById("question-list-title");
      if (listHeading) {
        listHeading.scrollIntoView({ behavior: "smooth" });
        listHeading.setAttribute("tabindex", "-1");
        listHeading.focus();
      }
    });
  }

  // テーマフィルター
  document.querySelectorAll(".filter-tab-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const selected = btn.getAttribute("data-theme");
      state.selectedThemeId = selected;
      if (state.isConfigured) {
        try {
          state.publicQuestions = await listQuestions({
            theme: selected === "all" ? null : selected
          });
        } catch (e) {
          console.error(e);
        }
      }
      renderHome(false);
      const activeBtn = document.querySelector(`.filter-tab-btn[data-theme="${selected}"]`);
      if (activeBtn) activeBtn.focus();
      announce(`テーマを切り替えました`);
    });
  });
}

/**
 * 2. 投稿作成画面 (#ask)
 */
function renderAsk() {
  const currentDraft = state.currentDraft || { body: "", nickname: "", theme_id: "" };
  const currentCount = countCharacters(currentDraft.body);
  const isOver = currentCount > MAX_BODY_LENGTH;
  const activeHint = activePromptChipId ? getPromptHint(activePromptChipId) : null;

  mainContainer.innerHTML = `
    <div class="compose-container">
      <div class="compose-header">
        <h1 id="compose-heading" class="compose-h1" tabindex="-1">問いを書く</h1>
        <p class="compose-supporting">まとまっていなくても大丈夫。</p>
      </div>

      <!-- プロンプトチップ（任意のヒント） -->
      <section class="prompt-chips-section" aria-label="書き出しのヒント">
        <div class="prompt-chips-title">書き出しのヒント（選ばなくても書けます）</div>
        <div class="prompt-chips-list" role="group" aria-label="ヒントのキーワード">
          ${PROMPT_CHIPS.map(chip => `
            <button type="button" 
                    class="chip-btn ${activePromptChipId === chip.id ? 'active' : ''}" 
                    data-chip-id="${chip.id}"
                    aria-pressed="${activePromptChipId === chip.id}">
              ${chip.label}
            </button>
          `).join('')}
        </div>
        <div id="chip-hint-area" aria-live="polite">
          ${activeHint ? `
            <div class="chip-hint-box">
              <strong>${activeHint.label}のヒント:</strong> ${activeHint.hint}
            </div>
          ` : ""}
        </div>
      </section>

      <!-- 投稿フォーム -->
      <form id="ask-form" novalidate>
        <div class="form-group">
          <label for="ask-body" class="form-label">
            問い・話してみたいこと <span style="color: var(--color-vivid-blue);">*</span>
          </label>
          <textarea id="ask-body" 
                    name="body" 
                    class="form-textarea" 
                    rows="5" 
                    placeholder="いま気になっていること、ふと思ったこと、言葉にしにくいモヤモヤなど..."
                    aria-describedby="body-helper char-count body-error"
                    required>${escapeHtml(currentDraft.body)}</textarea>
          
          <div class="textarea-footer-row">
            <span id="body-helper" class="exact-helper-text">一文でも送れます。</span>
            <span id="char-count" class="char-counter ${isOver ? 'error' : ''}">
              ${currentCount} / ${MAX_BODY_LENGTH}
            </span>
          </div>
          <div id="body-error" class="error-message-text" role="alert"></div>
        </div>

        <div class="form-group">
          <label for="ask-nickname" class="form-label">
            ニックネーム <span class="form-label-optional">（省略すると「${DEFAULT_NICKNAME}」）</span>
          </label>
          <input type="text" 
                 id="ask-nickname" 
                 name="nickname" 
                 class="form-input" 
                 maxlength="20"
                 placeholder="例: ゆき、ななし"
                 value="${escapeHtml(currentDraft.nickname || '')}">
        </div>

        <div class="form-group">
          <label for="ask-theme" class="form-label">
            テーマ <span class="form-label-optional">（省略可）</span>
          </label>
          <select id="ask-theme" name="theme_id" class="form-select">
            <option value="" ${!currentDraft.theme_id ? 'selected' : ''}>指定なし（未設定）</option>
            ${state.themes.map(t => `
              <option value="${t.id}" ${currentDraft.theme_id === t.id ? 'selected' : ''}>${escapeHtml(t.label)}</option>
            `).join('')}
          </select>
        </div>

        <div class="form-actions" style="margin-top: 24px;">
          <button type="submit" id="btn-to-confirm" class="btn btn-primary btn-block">
            内容を確認する
          </button>
        </div>
      </form>
    </div>
  `;

  const h1 = document.getElementById("compose-heading");
  if (h1) h1.focus();

  const bodyTextarea = document.getElementById("ask-body");
  const nicknameInput = document.getElementById("ask-nickname");
  const themeSelect = document.getElementById("ask-theme");
  const charCountEl = document.getElementById("char-count");
  const bodyErrorEl = document.getElementById("body-error");
  const form = document.getElementById("ask-form");

  function saveFormToDraft() {
    state.currentDraft = {
      body: bodyTextarea.value,
      nickname: nicknameInput.value,
      theme_id: themeSelect.value
    };
  }

  // ヒントチップ
  document.querySelectorAll(".chip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const chipId = btn.getAttribute("data-chip-id");
      activePromptChipId = activePromptChipId === chipId ? null : chipId;
      saveFormToDraft();
      renderAsk();
      const updatedBtn = document.querySelector(`.chip-btn[data-chip-id="${chipId}"]`);
      if (updatedBtn) updatedBtn.focus();
    });
  });

  bodyTextarea.addEventListener("input", () => {
    saveFormToDraft();
    const count = countCharacters(bodyTextarea.value);
    charCountEl.textContent = `${count} / ${MAX_BODY_LENGTH}`;
    if (count > MAX_BODY_LENGTH) {
      charCountEl.classList.add("error");
    } else {
      charCountEl.classList.remove("error");
      bodyErrorEl.textContent = "";
    }
  });

  nicknameInput.addEventListener("input", saveFormToDraft);
  themeSelect.addEventListener("change", saveFormToDraft);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveFormToDraft();

    const validation = validateQuestionDraft(state.currentDraft);
    if (!validation.valid) {
      bodyErrorEl.textContent = validation.errors.body || "入力内容をご確認ください。";
      bodyTextarea.focus();
      announce(validation.errors.body);
      return;
    }

    window.location.hash = "ask/confirm";
  });
}

/**
 * 3. 投稿内容確認画面 (#ask/confirm)
 */
function renderConfirm() {
  if (!state.currentDraft || !state.currentDraft.body.trim()) {
    window.location.hash = "ask";
    return;
  }

  const validation = validateQuestionDraft(state.currentDraft);
  if (!validation.valid) {
    window.location.hash = "ask";
    return;
  }
  const normalized = validation.normalized;
  const themeObj = state.themes.find(t => t.id === normalized.theme_id);
  const themeLabel = themeObj ? themeObj.label : "指定なし";

  mainContainer.innerHTML = `
    <div class="preview-container">
      <div class="compose-header">
        <h1 id="confirm-heading" class="compose-h1" tabindex="-1">内容を確認する</h1>
        <p class="compose-supporting">送る前に、文章と公開範囲を確認できます。</p>
      </div>

      <!-- 送信エラーメッセージ領域 -->
      <div id="submit-error-box" class="card" style="display: none; background-color: var(--color-danger-bg); border-color: var(--color-danger); color: var(--color-danger); padding: 12px 16px; margin-bottom: 20px;" role="alert"></div>

      <!-- 紙片プレビュー -->
      <div class="paper-sheet-card" aria-label="投稿内容のプレビュー">
        <div class="preview-badge-row">
          <span class="badge badge-topic">${escapeHtml(themeLabel)}</span>
          <span class="badge badge-status-pending">スタッフ確認待ち（予定）</span>
        </div>
        <div class="preview-body-text">${escapeHtml(normalized.body)}</div>
        <div class="preview-meta-row">
          <span>表示される名前: <strong>${escapeHtml(normalized.nickname)}</strong></span>
        </div>
      </div>

      <!-- 届く相手と公開基準の明示 -->
      <div class="transparent-audience-notice">
        <div class="transparent-audience-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          公開と確認について
        </div>
        <p>公開されると、このサイトを見る人が読めます。スタッフの確認前は公開されません。</p>
      </div>

      <!-- 同意チェックボックス -->
      <label class="checkbox-agree-label">
        <input type="checkbox" id="confirm-agree-checkbox" class="checkbox-agree-input">
        <span>公開内容と注意事項を確認しました</span>
      </label>

      <!-- 操作ボタン -->
      <div class="preview-actions-row">
        <a href="#ask" id="btn-back-to-edit" class="btn btn-secondary">
          ← 直す
        </a>
        <button type="button" id="btn-final-submit" class="btn btn-primary" disabled>
          問いを送る
        </button>
      </div>
    </div>
  `;

  const h1 = document.getElementById("confirm-heading");
  if (h1) h1.focus();

  const agreeCheckbox = document.getElementById("confirm-agree-checkbox");
  const finalSubmitBtn = document.getElementById("btn-final-submit");
  const errorBox = document.getElementById("submit-error-box");

  agreeCheckbox.addEventListener("change", () => {
    finalSubmitBtn.disabled = !agreeCheckbox.checked;
  });

  finalSubmitBtn.addEventListener("click", async () => {
    if (!agreeCheckbox.checked) return;

    // 二重送信防止: ボタン無効化 & スピナー表示
    finalSubmitBtn.disabled = true;
    finalSubmitBtn.textContent = "送信中...";
    errorBox.style.display = "none";

    if (!isConfigured()) {
      errorBox.textContent = "設定が未完了です。Supabase の接続情報（web/js/config.js）を設定するまで投函はできません。";
      errorBox.style.display = "block";
      finalSubmitBtn.disabled = false;
      finalSubmitBtn.textContent = "問いを送る";
      announce("設定が未完了のため送信できませんでした。");
      return;
    }

    // クライアント側で UUID を生成（RLS により returning が取得できないため）
    const newId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `web-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    try {
      await postQuestion({
        id: newId,
        body: normalized.body,
        nickname: normalized.nickname,
        theme_id: normalized.theme_id
      });

      // 成功時のみ localStorage に保存
      saveMyQuestion(localStorage, {
        id: newId,
        body: normalized.body,
        nickname: normalized.nickname,
        theme_id: normalized.theme_id,
        theme_label: themeLabel,
        created_at: new Date().toISOString()
      });

      state.lastSubmittedId = newId;
      state.currentDraft = null; // 下書きクリア

      // 受付画面へ遷移
      window.location.hash = `receipt/${newId}`;
    } catch (err) {
      console.error("投函エラー:", err);
      // 下書きは破棄せず画面にエラーを出して再試行可能にする
      errorBox.textContent = `通信に失敗しました (${err.message || "エラーが発生しました"})。下書きは保存されています。もう一度お試しください。`;
      errorBox.style.display = "block";
      finalSubmitBtn.disabled = false;
      finalSubmitBtn.textContent = "問いを送る";
      announce("通信エラーが発生しました。");
    }
  });
}

/**
 * 4. 受付完了画面 (#receipt/:id)
 * @param {string} questionId
 */
function renderReceipt(questionId) {
  const localQuestions = loadMyQuestions(localStorage);
  const matchedQuestion = localQuestions.find(q => q.id === questionId);

  if (!matchedQuestion && state.lastSubmittedId !== questionId) {
    mainContainer.innerHTML = `
      <div class="card p-lg text-center" style="max-width: 500px; margin: 2rem auto;">
        <h2 tabindex="-1">受付情報が見つかりません</h2>
        <p>指定された問いが存在しないか、この端末で直前に送信された問いではありません。</p>
        <div style="margin-top: 1rem;"><a href="#home" class="btn btn-primary">ホームへ戻る</a></div>
      </div>
    `;
    const heading = mainContainer.querySelector("h2");
    if (heading) heading.focus();
    return;
  }

  const bodyText = matchedQuestion ? matchedQuestion.body : "あなたの問いをお預かりしました。";

  mainContainer.innerHTML = `
    <div class="receipt-container">
      <div class="receipt-card paper-settle-animation" aria-labelledby="receipt-heading">
        <div class="receipt-icon-wrap" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>

        <h1 id="receipt-heading" class="receipt-title" tabindex="-1">問いを受け付けました</h1>
        <p class="receipt-status-text">スタッフが確認中です</p>
        <p class="receipt-sub-notice">まだ公開されていません</p>

        <div class="receipt-preview-snippet">
          <div style="font-size: 0.75rem; color: var(--color-body-muted); margin-bottom: 4px;">お預かりした問い:</div>
          <div>${escapeHtml(bodyText)}</div>
        </div>

        <div class="receipt-actions">
          <a href="#inbox" class="btn btn-primary btn-block">
            自分への返事を見に行く
          </a>
          <a href="#home" class="btn btn-secondary btn-block">
            みんなの問いへ戻る
          </a>
        </div>
      </div>
    </div>
  `;

  const h1 = document.getElementById("receipt-heading");
  if (h1) h1.focus();

  announce("問いを受け付けました。スタッフが確認中です。");
}

/**
 * 5. 自分への返事 / インボックス (#inbox)
 */
async function renderInbox() {
  const localQuestions = loadMyQuestions(localStorage);
  const seenIds = loadSeenAnswerIds(localStorage);

  let publicQuestionsForUser = [];
  if (isConfigured() && localQuestions.length > 0) {
    try {
      publicQuestionsForUser = await getPublicQuestionsByIds(localQuestions.map(q => q.id));
    } catch (e) {
      console.error(e);
    }
  }

  const userQuestions = matchMyQuestions(localQuestions, publicQuestionsForUser);

  mainContainer.innerHTML = `
    <div class="inbox-container">
      <div class="inbox-header">
        <h1 id="inbox-heading" class="inbox-h1" tabindex="-1">自分への返事</h1>
        <p class="inbox-desc">あなたが送った問いの確認状況や、届いた大人からの返事を読めます。</p>
      </div>

      <div class="inbox-list" id="inbox-questions-list">
        ${userQuestions.length === 0 ? `
          <div class="card" style="text-align: center; padding: 36px 20px;">
            <p style="font-size: 1rem; color: var(--color-body); font-weight: 600; margin-bottom: 8px;">まだ投稿した問いがありません</p>
            <p style="font-size: 0.875rem; color: var(--color-body-muted); margin-bottom: 20px;">「問いを書く」から自由に言葉を置いてみてください。</p>
            <a href="#ask" class="btn btn-primary">問いを書く</a>
          </div>
        ` : userQuestions.map(q => {
          let statusBadgeHtml = "";
          let statusExplain = "";

          if (q.status === "pending") {
            statusBadgeHtml = '<span class="badge badge-status-pending">スタッフ確認中</span>';
            statusExplain = "スタッフが内容を確認しています。まだ公開されていません。";
          } else if (q.status === "waiting") {
            statusBadgeHtml = '<span class="badge badge-status-waiting">公開中・返事待ち</span>';
            statusExplain = "公開されました。大人の返事を待っています。";
          } else if (q.status === "answered") {
            statusBadgeHtml = '<span class="badge badge-status-answered">返事が届きました</span>';
            statusExplain = `大人から ${q.answerCount} 件の返事が届いています。クリックして読めます。`;
          }

          const isUnread = !seenIds.has(q.id) && q.status === "answered";
          const isPubliclyViewable = q.isPublic;

          return `
            <article class="inbox-card ${isUnread ? 'has-unread' : ''}">
              <div class="inbox-card-top">
                <div>
                  ${statusBadgeHtml}
                  <span class="badge badge-topic" style="margin-left: 4px;">${escapeHtml(q.theme_label)}</span>
                </div>
                ${isUnread ? '<span class="badge" style="background-color: var(--color-vivid-blue); color: #fff;">新着返信</span>' : ""}
              </div>

              ${isPubliclyViewable ? `
                <a href="#question/${q.id}" class="inbox-body-link">
                  ${escapeHtml(q.body)}
                </a>
              ` : `
                <div class="inbox-body-text">
                  ${escapeHtml(q.body)}
                </div>
              `}

              <p class="inbox-status-explain">${statusExplain}</p>

              <div class="inbox-card-actions">
                ${isPubliclyViewable ? `
                  <a href="#question/${q.id}" class="btn btn-secondary btn-sm">
                    ${q.status === 'answered' ? '返事を読む' : '公開ページを見る'}
                  </a>
                ` : `
                  <span class="inbox-status-tag">確認中（まだ公開されていません）</span>
                `}
                <button type="button" class="btn btn-outline btn-sm btn-remove-local" data-id="${q.id}">
                  一覧から消す
                </button>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    </div>
  `;

  const h1 = document.getElementById("inbox-heading");
  if (h1) h1.focus();

  // 端末内一覧からの削除
  document.querySelectorAll(".btn-remove-local").forEach(btn => {
    btn.addEventListener("click", () => {
      const qId = btn.getAttribute("data-id");
      openRemoveDialog(qId);
    });
  });
}

/**
 * 6. 問い詳細画面 (#question/:id)
 * @param {string} questionId
 */
async function renderDetail(questionId) {
  mainContainer.innerHTML = `
    <div class="detail-container">
      <div class="card p-lg text-center" style="max-width: 500px; margin: 2rem auto;">
        <p style="color: var(--color-body-muted);">読み込み中...</p>
      </div>
    </div>
  `;

  let question = null;
  if (isConfigured()) {
    try {
      question = await getQuestion(questionId);
    } catch (e) {
      console.error(e);
    }
  }

  if (!question) {
    mainContainer.innerHTML = `
      <div class="card p-lg text-center" style="max-width: 500px; margin: 2rem auto;">
        <h1 id="detail-not-found-heading" tabindex="-1" style="font-family: var(--font-heading); font-size: 1.25rem; font-weight: 800; margin-bottom: 8px;">問いが見つかりません</h1>
        <p style="font-size: 0.9375rem; color: var(--color-body-muted); margin-bottom: 20px;">この問いは存在しないか、まだ公開されていない可能性があります。</p>
        <div><a href="#home" class="btn btn-primary">みんなの問いに戻る</a></div>
      </div>
    `;
    const h1 = document.getElementById("detail-not-found-heading");
    if (h1) h1.focus();
    return;
  }

  // 閲覧時に既読マーク
  markAnswerAsSeen(localStorage, questionId);
  updateNavigation(`question/${questionId}`);

  const answerCount = (question.answers || []).length;
  let statusBadgeHtml = answerCount > 0
    ? `<span class="badge badge-status-answered">返事 ${answerCount}件</span>`
    : '<span class="badge badge-status-waiting">返事を待っています</span>';

  mainContainer.innerHTML = `
    <div class="detail-container">
      <a href="#home" class="detail-back-link">
        ← みんなの問いに戻る
      </a>

      <!-- 問いの紙片 -->
      <article class="question-sheet" aria-labelledby="question-detail-title">
        <div class="question-sheet-top">
          <span class="badge badge-topic">${escapeHtml(question.theme_label || "未分類")}</span>
          ${statusBadgeHtml}
        </div>

        <h1 id="question-detail-title" class="question-sheet-h1" tabindex="-1">
          ${escapeHtml(question.body)}
        </h1>

        <div class="question-sheet-author">
          投稿者: <strong>${escapeHtml(question.nickname || DEFAULT_NICKNAME)}</strong>
        </div>
      </article>

      <!-- 届いている大人の返事セクション (立場のみ表示、氏名・ニックネームは非表示) -->
      <section class="replies-section" aria-labelledby="replies-title">
        <h2 id="replies-title" class="replies-title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
          </svg>
          届いている大人の返事
        </h2>

        ${answerCount === 0 ? `
          <div class="no-replies-yet">
            <p style="font-weight: 600; margin-bottom: 4px;">まだ返事は届いていません</p>
            <p style="font-size: 0.8125rem;">スタッフや大人があなたの問いを読んで返事を考えています。</p>
          </div>
        ` : `
          <div class="replies-list">
            ${question.answers.map(reply => `
              <div class="reply-card">
                <div class="reply-header">
                  <div class="reply-author-info">
                    <!-- 個人情報保護のため回答者の氏名・ニックネームは出さず立場のみを公開 -->
                    <span class="reply-author-role">${escapeHtml(reply.role)}</span>
                    ${reply.aiAssisted ? '<span class="reply-ai-note" title="この返事は AI と一緒に考えられました">AI と一緒に考えた返事</span>' : ''}
                  </div>
                </div>
                <div class="reply-body">${escapeHtml(reply.body)}</div>
              </div>
            `).join('')}
          </div>
        `}
      </section>
    </div>
  `;

  const h1 = document.getElementById("question-detail-title");
  if (h1) h1.focus();
}

/**
 * 7. この場所について (#about)
 */
function renderAbout() {
  mainContainer.innerHTML = `
    <div class="about-container">
      <article class="about-article">
        <h1 id="about-heading" class="about-h1" tabindex="-1">この場所について</h1>

        <h2 class="about-subtitle">Miacis（ミアキス）のこと</h2>
        <p class="about-p">
          山梨県韮崎市にある、中高生のための居場所です。学校でも家でもない「第3の居場所」として、
          放課後に立ち寄って勉強したり、話したり、なにもしないで過ごしたりできます。
          常駐するスタッフが、日々そこにいます。
        </p>
        <div class="about-brand">
          <img src="assets/miacis-logo.png" width="1200" height="1012" loading="lazy" decoding="async"
               alt="らしさ、無制限。青少年育成プラザ Miacis">
          <p>青少年育成プラザ Miacis（ミアキス）<br>山梨県韮崎市</p>
        </div>

        <h2 class="about-subtitle">館内に、紙の問いコーナーがあります</h2>
        <p class="about-p">
          このサイトは、思いつきで始まったものではありません。
          Miacis の館内には、ホワイトボードにカードを貼っていく「問いコーナー」が実際にあります。
          中高生が気になっていることを書いて貼ると、スタッフや大学生、地域の大人が
          それぞれの考えを書いて返す。その往復が、年間100件ほど続いてきました。
        </p>
        <figure class="about-figure">
          <img src="assets/toi-corner-miacis.jpg" width="1200" height="900" loading="lazy" decoding="async"
               alt="Miacis 館内のホワイトボードに設置された問いコーナー。「にしむの問いコーナー モヤモヤや疑問、なんでも問いてね。」のポスターの下に、問いのカードと大人からの返事のカードが並んで貼られている">
          <figcaption>館内の問いコーナー。返事は「大学生の回答」「ニシムーの回答」のように、書いた人ごとに並んでいます。</figcaption>
        </figure>
        <figure class="about-figure">
          <img src="assets/toi-corner-notes.jpg" width="900" height="1273" loading="lazy" decoding="async"
               alt="問いコーナーに寄せられた付箋。「幸せな家庭ってなに？」「人は1人では生きていけないの？」などの手書きの問いが並んでいる">
          <figcaption>寄せられた問い。うまく言えていなくても、ひとことでも、そのまま貼られています。</figcaption>
        </figure>

        <h2 class="about-subtitle">紙から、このサイトへ</h2>
        <p class="about-p">
          紙のよさは、その場で書けて、誰かの字がそのまま残ることです。
          でも館内に来ないと読めないし、返事が貼られたことにも気づきにくい。
          だからこのサイトをつくりました。
        </p>
        <p class="about-p">
          <strong>館内の紙に書いても、このサイトから書いても、どちらでも同じ問いコーナーです。</strong>
          ここからなら、自分のスマホで、家からでも、名前を出さずに書けます。
          返事が届いたかどうかも、あとから自分で確かめられます。
        </p>

        <h2 class="about-subtitle">問いは、世界の見方をふやす。</h2>
        <p class="about-p">
          学校や普段の生活では、「正しい答え」を早く出すことが求められがちです。けれど世の中には、
          すぐに答えが出ないことや、人によって見え方がまったく違うことがたくさんあります。
        </p>
        <p class="about-p">
          「大人も将来が不安になる？」「ふつうってなんだろう？」<br>
          そんな素朴な疑問やモヤモヤをここに投げかけると、いろいろな経験をもつ地域の大人たちが、
          それぞれの視点で返事を持ち寄ります。
        </p>

        <h2 class="about-subtitle">ひとことでも、まとまっていなくても。</h2>
        <p class="about-p">
          立派な哲学的な問いである必要はありません。一文だけでも、疑問の形になっていなくても大丈夫です。
          あなたの投げかけたひとことが、誰かにとっての新しい見方のきっかけになります。
        </p>

        ${(() => {
          const links = activeSiteLinks();
          if (links.length === 0) return "";
          return `
        <h2 class="about-subtitle">運営について</h2>
        <p class="about-p">
          この問いコーナーは、Miacis のスタッフと地域の大人が続けています。
          ふだんの Miacis の様子や、運営している人のことは、こちらから見られます。
        </p>
        <ul class="about-links">
          ${links.map(l => `
            <li><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer" class="about-link">
              ${escapeHtml(l.label)}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </a></li>
          `).join("")}
        </ul>`;
        })()}

        <div style="margin-top: 28px;">
          <a href="#ask" class="btn btn-primary">問いを書いてみる</a>
        </div>
      </article>
    </div>
  `;

  const h1 = document.getElementById("about-heading");
  if (h1) h1.focus();
}

/* ==========================================================================
   モーダルダイアログ制御
   ========================================================================== */

function openRemoveDialog(questionId) {
  const localQuestions = loadMyQuestions(localStorage);
  const q = localQuestions.find(item => item.id === questionId);
  if (!q) return;

  pendingRemoveQuestionId = questionId;
  dialogTitle.textContent = "端末の履歴から消しますか？";
  dialogDesc.textContent = `「${truncateForDisplay(q.body, 30)}」をお使いのブラウザの履歴から削除します。`;

  if (typeof appDialog.showModal === "function") {
    appDialog.showModal();
  } else {
    appDialog.setAttribute("open", "");
  }
}

function closeRemoveDialog() {
  pendingRemoveQuestionId = null;
  if (typeof appDialog.close === "function") {
    appDialog.close();
  } else {
    appDialog.removeAttribute("open");
  }
}

dialogCancelBtn.addEventListener("click", closeRemoveDialog);

dialogConfirmBtn.addEventListener("click", () => {
  if (pendingRemoveQuestionId) {
    removeMyQuestion(localStorage, pendingRemoveQuestionId);
    closeRemoveDialog();
    updateNavigation("inbox");
    renderInbox();
    announce("端末の履歴から削除しました。");
  }
});

appDialog.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeRemoveDialog();
});

/* ==========================================================================
   ルーター (Hash Routing)
   ========================================================================== */

async function handleRouting() {
  const rawHash = window.location.hash.replace(/^#\/?/, "");
  const resolution = resolveRoute(window.location.hash);

  if (resolution.type === "skip") {
    if (!currentRenderedRoute) {
      renderHome(false);
      currentRenderedRoute = "home";
    }
    const target = document.getElementById(resolution.path) || mainContainer;
    if (target) {
      if (!target.hasAttribute("tabindex")) {
        target.setAttribute("tabindex", "-1");
      }
      target.focus();
      if (target !== mainContainer) {
        target.scrollIntoView({ behavior: "smooth" });
      }
    }
    return;
  }

  currentRenderedRoute = resolution.path;
  updateNavigation(rawHash || "home");

  if (resolution.type === "route") {
    if (resolution.path === "home") {
      renderHome();
    } else if (resolution.path === "ask") {
      if (resolution.paramId === "confirm") {
        renderConfirm();
      } else {
        renderAsk();
      }
    } else if (resolution.path === "receipt") {
      renderReceipt(resolution.paramId);
    } else if (resolution.path === "inbox") {
      await renderInbox();
    } else if (resolution.path === "question") {
      await renderDetail(resolution.paramId);
    } else if (resolution.path === "about") {
      renderAbout();
    }
  } else {
    // 404
    mainContainer.innerHTML = `
      <div class="card p-lg text-center" style="max-width: 500px; margin: 2rem auto;">
        <h2>ページが見つかりません</h2>
        <p>指定されたURLは存在しないか、移動した可能性があります。</p>
        <div style="margin-top: 1rem;"><a href="#home" class="btn btn-primary">トップへ戻る</a></div>
      </div>
    `;
    const heading = mainContainer.querySelector("h2");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus();
    }
  }
}

// スキップリンク
const skipLink = document.querySelector(".skip-link");
if (skipLink) {
  skipLink.addEventListener("click", (e) => {
    e.preventDefault();
    if (mainContainer) {
      mainContainer.focus();
    }
  });
}

// 初期化と起動
window.addEventListener("hashchange", handleRouting);

function renderFooterLinks() {
  const container = document.querySelector(".footer-links");
  if (!container) return;
  for (const l of activeSiteLinks()) {
    if (container.querySelector(`a[href="${l.url}"]`)) continue;
    const a = document.createElement("a");
    a.href = l.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "footer-link external-link";
    a.textContent = l.label;
    container.appendChild(a);
  }
}

async function boot() {
  renderFooterLinks();
  await syncData();
  await handleRouting();
}

// api.js がトップレベル await を持つため、このモジュールの評価は DOMContentLoaded より
// 後になることがある。その場合 DOMContentLoaded は二度と発火しないので、読み込み済みなら直接起動する。
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
