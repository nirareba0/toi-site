/**
 * 問う応える — 「ことばの余白」デザイン試作プロトタイプ
 *
 * 【重要規定】
 * 1. 本番実装ではなく、ローカルで触れる1方向のデザイン試作。
 * 2. ネットワーク通信、Supabase、LocalStorage、Cookie等は一切使用しない（メモリ内のみ保持）。
 * 3. ユーザー入力はすべて textContent またはサニタイズして描画し、XSSを防止。
 * 4. 画面遷移時はハッシュルーティングで行い、主見出しへフォーカスを移動してアクセシビリティを担保。
 */

(() => {
  'use strict';

  // ==========================================================================
  // 架空の例文データ（実在の投稿に見せず、短く本質的な3件）
  // ==========================================================================
  const SAMPLE_QUESTIONS = [
    {
      id: 'q1',
      theme: '自分のこと',
      title: '好きなことって、どうやって見つけるんだろう。',
      body: '将来の夢や好きなことを聞かれるたびに、何も浮かばなくて困ります。みんなは何をきっかけに決めているんでしょうか。',
      hasReply: true,
      respondent: '地域で暮らす大人（例）',
      reply: '「まだない」のも、今の自分のかたち。\n\n自分の場合は、中高生の頃に好きだったことと、今仕事にしていることは全然違います。当時はただ、放課後に川沿いを歩く時間が好きでした。無理に「これだ」と決めなくても、嫌じゃないことや、やっていて疲れないことの周りをなんとなくうろうろしているうちに、少しずつ見えてくるものもある気がします。'
    },
    {
      id: 'q2',
      theme: '人とのこと',
      title: '友だちの会話に、うまく入れない日がある。',
      body: 'グループのみんなで話しているとき、急に入り口がわからなくなって黙ってしまうことがあります。無理に合わせるべきでしょうか。',
      hasReply: true,
      respondent: '地域で暮らす大人（例）',
      reply: '自分の場合は、無理に話そうとせず「今日は聞く側でいよう」と心の中で決めていました。ずっと同じテンションでいられる人ばかりじゃないですし、ただそこにいて相槌を打っているだけでも、居場所としてはちゃんと成り立っていることも多いです。話したくなったら一言返すくらいで十分だと思います。'
    },
    {
      id: 'q3',
      theme: 'これから',
      title: 'これからどう生きていくか、まだ何も思いつかない。',
      body: '進路の希望を書く紙をもらったけれど、何も書きたいことがありません。大人の人は、今の道に進むことをいつ決めたんですか。',
      hasReply: false,
      respondent: null,
      reply: null
    }
  ];

  // ==========================================================================
  // メモリ内状態管理（タブをリロードすると破棄、ページ遷移では保持）
  // ==========================================================================
  const appState = {
    filter: 'すべて',
    draftQuestion: {
      theme: '',
      body: '',
      agreed: false
    },
    statusDemoChoice: 'waiting', // 'waiting' | 'replied' | 'rejected'
    adultReplyDraft: {
      targetId: 'q3',
      body: '',
      respondentRole: '地域で暮らす大人（例）',
      agreed: false
    },
    adultReplyStep: 'form' // 'form' | 'confirm' | 'complete'
  };

  // ==========================================================================
  // ユーティリティ
  // ==========================================================================
  function escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function focusMainHeading() {
    // 画面遷移後、主見出しにフォーカスを移動（支援技術への配慮）
    setTimeout(() => {
      const heading = document.getElementById('main-heading');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus();
      }
    }, 50);
  }

  function updateNavActive(route) {
    const navLinks = document.querySelectorAll('.nav-link, .header-action a');
    navLinks.forEach((link) => {
      const linkRoute = link.getAttribute('data-route');
      if (linkRoute === route || (route === '' && linkRoute === 'home')) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  // ==========================================================================
  // 画面レンダラー
  // ==========================================================================
  const mainContainer = document.getElementById('main-content');

  /**
   * 1. ホーム画面
   */
  function renderHome(focusHeading = true) {
    const filteredList = appState.filter === 'すべて'
      ? SAMPLE_QUESTIONS
      : SAMPLE_QUESTIONS.filter(q => q.theme === appState.filter);

    const categories = ['すべて', '自分のこと', '人とのこと', 'これから'];

    mainContainer.innerHTML = `
      <div class="layout-container">
        <!-- ヒーローセクション -->
        <section class="hero-section" aria-labelledby="main-heading">
          <div class="hero-grid">
            <!-- 左側: コピーと主操作 -->
            <div class="hero-lead">
              <h1 id="main-heading" class="hero-title">まだ答えのない、
その気持ちから。</h1>
              <p class="hero-description">ふと浮かんだ疑問も、うまく言えないモヤモヤも。
いろいろな大人が、いっしょに考えます。</p>
              
              <div class="hero-cta-group">
                <a href="#ask" class="btn btn-primary btn-lg">問いを書いてみる</a>
                <a href="#questions-section" class="btn btn-secondary btn-lg">みんなの問いを読む</a>
              </div>
              <p class="hero-note">読むだけでも、だいじょうぶ。</p>
            </div>

            <!-- 右側: 記憶に残る1つの構図（淡いラベンダーの面と淡い緑の返事の帯） -->
            <div class="hero-visual-card" aria-label="問いと返事の構図見本">
              <svg class="visual-quote-symbol" width="36" height="28" viewBox="0 0 36 28" fill="none" aria-hidden="true">
                <path d="M12 4C6 8 6 20 12 24" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
                <path d="M24 4C30 8 30 20 24 24" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
              </svg>
              <span class="visual-quote-theme">自分のこと</span>
              <p class="visual-question-text">好きなことって、
どうやって
見つけるんだろう。</p>
              <div class="visual-reply-strip">
                <span class="visual-reply-label">届いた返事の一節</span>
                <p class="visual-reply-text">「まだない」のも、今の自分のかたち。</p>
              </div>
              <a href="#detail?id=q1" class="visual-action-link">
                問いと返事を読む
                <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>
        </section>

        <!-- 問い一覧セクション -->
        <section id="questions-section" class="questions-section" aria-labelledby="questions-list-title">
          <div class="section-header-wrap">
            <h2 id="questions-list-title" class="section-title">みんなの問い</h2>
            <p class="section-desc">気になる問いから、のぞいてみてください。</p>
            
            <!-- フィルタUI -->
            <div class="filter-tabs" role="group" aria-label="テーマによる絞り込み">
              ${categories.map(cat => `
                <button type="button" 
                        class="filter-btn" 
                        data-filter="${escapeHTML(cat)}" 
                        aria-pressed="${appState.filter === cat ? 'true' : 'false'}">
                  ${escapeHTML(cat)}
                </button>
              `).join('')}
            </div>
          </div>

          <!-- 問いリスト -->
          ${filteredList.length > 0 ? `
            <ul class="questions-list" aria-label="問い一覧">
              ${filteredList.map(q => `
                <li class="question-row">
                  <div>
                    <span class="question-meta-theme">${escapeHTML(q.theme)}</span>
                  </div>
                  <div class="question-content-wrap">
                    <h3 class="question-item-title">
                      <a href="#detail?id=${escapeHTML(q.id)}">${escapeHTML(q.title)}</a>
                    </h3>
                    <p class="question-item-preview">${escapeHTML(q.body)}</p>
                  </div>
                  <div class="question-status-wrap">
                    ${q.hasReply 
                      ? `<span class="status-badge status-replied">
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                            <circle cx="6" cy="6" r="4" fill="currentColor"/>
                          </svg>
                          返事あり
                        </span>`
                      : `<span class="status-badge status-waiting">
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                            <circle cx="6" cy="6" r="3.5" stroke="currentColor" stroke-width="1.2"/>
                          </svg>
                          返事待ち
                        </span>`
                    }
                  </div>
                </li>
              `).join('')}
            </ul>
          ` : `
            <div class="empty-state" role="status">
              <p class="empty-state-text">このテーマに当てはまる問いは、現在まだありません。</p>
              <button type="button" class="btn btn-secondary btn-sm" id="reset-filter-btn">「すべて」に戻す</button>
            </div>
          `}
        </section>

        <!-- ホーム下部: Miacisの由来セクション（装飾最小の2文） -->
        <section class="origin-section" aria-labelledby="origin-heading">
          <div class="origin-card">
            <h2 id="origin-heading" class="origin-title">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M7 5C4.5 7.5 4.5 12.5 7 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                <path d="M13 5C15.5 7.5 15.5 12.5 13 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
              Miacis の問いコーナーから。
            </h2>
            <p class="origin-text">
              山梨県韮崎市にある中高生の居場所「青少年育成プラザ Miacis」で、紙のカードに書かれた問いからこの対話は始まりました。
              ここでは、いろいろな大人が自分の経験や考えを返します。
            </p>
          </div>
        </section>
      </div>
    `;

    // フィルタボタンのイベント
    const filterButtons = mainContainer.querySelectorAll('.filter-btn');
    filterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        appState.filter = btn.getAttribute('data-filter');
        renderHome(false);
        const selected = mainContainer.querySelector('.filter-btn[aria-pressed="true"]');
        if (selected) selected.focus({ preventScroll: true });
      });
    });

    const resetBtn = document.getElementById('reset-filter-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        appState.filter = 'すべて';
        renderHome(false);
        mainContainer.querySelector('.filter-btn').focus({ preventScroll: true });
      });
    }

    if (focusHeading) focusMainHeading();
  }

  /**
   * 2. 問い詳細画面
   */
  function renderDetail(questionId) {
    const question = SAMPLE_QUESTIONS.find(q => q.id === questionId);

    if (!question) {
      mainContainer.innerHTML = `
        <div class="reading-container">
          <h1 id="main-heading">該当する問いが見つかりませんでした</h1>
          <p style="margin: 20px 0 32px;">指定されたURLの問いは存在しないか、移動した可能性があります。</p>
          <a href="#home" class="btn btn-secondary">問いの一覧へ戻る</a>
        </div>
      `;
      focusMainHeading();
      return;
    }

    mainContainer.innerHTML = `
      <div class="reading-container">
        <nav class="back-nav-wrap" aria-label="パンくずリスト">
          <a href="#home" class="back-link">
            <span aria-hidden="true">←</span> 問いの一覧へ戻る
          </a>
        </nav>

        <article class="detail-view">
          <header class="detail-header">
            <span class="detail-theme-badge">${escapeHTML(question.theme)}</span>
            <h1 id="main-heading" class="detail-title">${escapeHTML(question.title)}</h1>
          </header>

          <!-- 問いの面（淡いラベンダー） -->
          <section class="question-surface" aria-label="中高生からの問い">
            <div class="surface-label">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M5 3C3 5 3 11 5 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
              <span>問い</span>
            </div>
            <p class="surface-body">${escapeHTML(question.body)}</p>
          </section>

          <!-- 向かい合う括弧のシンボル・余白 -->
          <div class="dialogue-divider" aria-hidden="true">
            <svg class="dialogue-symbol" width="32" height="24" viewBox="0 0 32 24" fill="none">
              <path d="M10 4C5 8 5 16 10 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <path d="M22 4C27 8 27 16 22 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </div>

          <!-- 返事の面（淡い緑） -->
          ${question.hasReply ? `
            <section class="reply-surface" aria-label="大人からの返事">
              <div class="surface-label">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M11 3C13 5 13 11 11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <span>返事</span>
              </div>
              <div class="reply-respondent">${escapeHTML(question.respondent)}</div>
              <p class="reply-body">${escapeHTML(question.reply)}</p>
            </section>
          ` : `
            <section class="reply-surface-empty" aria-label="返事の状態">
              <div class="surface-label">
                <span>返事</span>
              </div>
              <p class="reply-body" style="color: var(--color-text-muted);">
                返事はまだ届いていません。届く時期は約束できません。
              </p>
            </section>
          `}

          <!-- 相談導線 -->
          <aside class="detail-consult-box">
            <p>
              ※ ここは、すぐに返事をする相談窓口ではありません。<br>
              困りごとや気持ちを今すぐ相談したいときは、専門の相談窓口をご利用ください。<br>
              <a href="https://www.mhlw.go.jp/mamorouyokokoro/soudan/sns/" target="_blank" rel="noopener noreferrer">
                相談先を探す（外部サイト）
              </a>
            </p>
          </aside>

          <div style="margin-top: 16px;">
            <a href="#home" class="btn btn-secondary">問いの一覧へ戻る</a>
          </div>
        </article>
      </div>
    `;

    focusMainHeading();
  }

  /**
   * 3. 問いを書く画面
   */
  function renderAsk() {
    const draft = appState.draftQuestion;

    mainContainer.innerHTML = `
      <div class="reading-container">
        <header style="margin-bottom: 24px;">
          <h1 id="main-heading" style="font-size: clamp(1.75rem, 4vw, 2.25rem); margin-bottom: 12px;">問いを投函する</h1>
          <p style="color: var(--color-text-muted);">ひとことからでも、書いてみてください。</p>
        </header>

        <!-- 冒頭注意文（非公開相談を約束せず、公開掲示板の提案である旨） -->
        <aside class="form-header-note" aria-label="投函時の注意">
          <div class="form-header-title">誰が読むの？</div>
          <p class="form-header-desc">
            名前や学校名は書かずに送れます。運営が読み、確認した問いと返事をこのサイトに公開します。
          </p>
          <p class="form-header-desc" style="color: var(--color-text);">
            すぐに返事をする相談窓口ではありません。
            今、誰かに話したいときは
            <a href="https://www.mhlw.go.jp/mamorouyokokoro/soudan/sns/" target="_blank" rel="noopener noreferrer" style="text-decoration: underline; color: var(--color-primary);">
              SNS相談窓口（外部リンク）
            </a>
            をご利用ください。
          </p>
        </aside>

        <!-- エラーメッセージ表示エリア（バリデーション失敗時に動的注入） -->
        <div id="form-error-container" style="margin-top: 20px;"></div>

        <form id="ask-form" class="form-view" style="margin-top: 24px;" novalidate>
          <!-- 本文textarea（必須、max 500） -->
          <div class="form-group form-group-body">
            <label for="question-body" class="form-label">
              いま、頭にあること
              <span class="label-required">必須</span>
            </label>
            <textarea id="question-body" aria-required="true"
                      class="form-textarea" 
                      maxlength="500" 
                      rows="5"
                      placeholder="ここに、いま頭にあることを。"
                      aria-describedby="char-counter-desc">${escapeHTML(draft.body)}</textarea>
            <div class="form-textarea-footer">
              <span id="char-counter-desc">500文字以内で書いてください</span>
              <span class="char-counter" id="char-count">0 / 500</span>
            </div>
          </div>

          <!-- テーマ選択（任意） -->
          <div class="form-group">
            <label for="question-theme" class="form-label">
              テーマ
              <span class="label-optional">任意</span>
            </label>
            <select id="question-theme" class="form-select">
              <option value="" ${draft.theme === '' ? 'selected' : ''}>指定なし</option>
              <option value="自分のこと" ${draft.theme === '自分のこと' ? 'selected' : ''}>自分のこと</option>
              <option value="人とのこと" ${draft.theme === '人とのこと' ? 'selected' : ''}>人とのこと</option>
              <option value="これから" ${draft.theme === 'これから' ? 'selected' : ''}>これから</option>
            </select>
          </div>

          <!-- 公開同意チェックボックス（必須、初期値false） -->
          <div class="form-group">
            <label class="form-checkbox-label" for="agree-check">
              <input type="checkbox" id="agree-check" aria-required="true" class="form-checkbox" ${draft.agreed ? 'checked' : ''}>
              <span class="checkbox-text">
                内容が運営によって確認された後、このWebサイト上に返事とともに公開されることに同意します。
              </span>
            </label>
          </div>

          <!-- 操作ボタン -->
          <div class="form-actions">
            <button type="submit" class="btn btn-primary btn-lg">内容を確認する</button>
            <a href="#home" class="btn btn-ghost">やめる</a>
          </div>
        </form>
      </div>
    `;

    const textarea = document.getElementById('question-body');
    const themeSelect = document.getElementById('question-theme');
    const agreeCheck = document.getElementById('agree-check');
    const charCount = document.getElementById('char-count');
    const form = document.getElementById('ask-form');
    const errorContainer = document.getElementById('form-error-container');

    // 文字数カウント更新
    function updateCharCount() {
      const len = textarea.value.length;
      charCount.textContent = `${len} / 500`;
      if (len > 500) {
        charCount.style.color = 'var(--color-error)';
      } else {
        charCount.style.color = 'var(--color-text-muted)';
      }
    }
    updateCharCount();

    // 入力時にメモリ下書きをリアルタイム同期（途中で他画面へ移っても保持）
    textarea.addEventListener('input', () => {
      appState.draftQuestion.body = textarea.value;
      updateCharCount();
    });
    themeSelect.addEventListener('change', () => {
      appState.draftQuestion.theme = themeSelect.value;
    });
    agreeCheck.addEventListener('change', () => {
      appState.draftQuestion.agreed = agreeCheck.checked;
    });

    // 送信・バリデーション処理
    form.addEventListener('submit', (e) => {
      e.preventDefault();

      const bodyVal = textarea.value;
      const trimmedBody = bodyVal.trim();
      const isAgreed = agreeCheck.checked;

      const errors = [];

      if (trimmedBody.length === 0) {
        errors.push({
          message: '「いま、頭にあること」を入力してください（空白のみは不可です）。',
          targetId: 'question-body'
        });
      } else if (bodyVal.length > 500) {
        errors.push({
          message: '本文は500文字以内で入力してください。',
          targetId: 'question-body'
        });
      }

      if (!isAgreed) {
        errors.push({
          message: '公開についての確認に同意のチェックを入れてください。',
          targetId: 'agree-check'
        });
      }

      if (errors.length > 0) {
        errorContainer.innerHTML = `
          <div class="form-error-alert" role="alert" tabindex="-1" id="error-summary">
            <div class="form-error-title">入力内容をご確認ください</div>
            <ul class="form-error-list">
              ${errors.map(err => `<li><a href="#${err.targetId}" style="text-decoration: underline; color: inherit;">${escapeHTML(err.message)}</a></li>`).join('')}
            </ul>
          </div>
        `;

        // エラー要約または最初のエラー要素にフォーカス
        const firstErrorElem = document.getElementById(errors[0].targetId);
        if (firstErrorElem) {
          firstErrorElem.focus();
        } else {
          document.getElementById('error-summary').focus();
        }
        return;
      }

      // バリデーション成功: 下書きを確定して確認画面へ遷移
      appState.draftQuestion.body = bodyVal;
      appState.draftQuestion.theme = themeSelect.value;
      appState.draftQuestion.agreed = isAgreed;

      window.location.hash = '#confirm';
    });

    focusMainHeading();
  }

  /**
   * 4. 確認画面
   */
  function renderConfirm() {
    const draft = appState.draftQuestion;

    // もし直接アクセスされて本文が空なら作成画面へ戻す
    if (!draft.body || draft.body.trim().length === 0 || !draft.agreed) {
      window.location.hash = '#ask';
      return;
    }

    mainContainer.innerHTML = `
      <div class="reading-container">
        <header style="margin-bottom: 24px;">
          <h1 id="main-heading" style="font-size: clamp(1.75rem, 4vw, 2.25rem); margin-bottom: 12px;">投函内容の確認</h1>
          <p style="color: var(--color-text-muted);">まだ投函は完了していません。以下の内容をご確認ください。</p>
        </header>

        <!-- プレビュー表示（XSS対策: textContent で挿入） -->
        <div class="confirm-preview-box">
          <div class="preview-theme">
            テーマ: <span id="confirm-theme-text"></span>
          </div>
          <div class="preview-body" id="confirm-body-text"></div>
        </div>

        <!-- 個人情報確認と公開範囲 -->
        <aside class="confirm-guidance">
          <h3>個人情報の再確認</h3>
          <p>
            名前や学校名、自分や友達が特定される情報が含まれていないか、もう一度お確かめください。<br>
            送信された問いは運営スタッフが確認した後、このWebサイト上に返事とともに公開されます。
          </p>
          <p style="color: var(--color-text);">
            ※ ここは、すぐに返事をする相談窓口ではありません。
          </p>
        </aside>

        <!-- 操作ボタン -->
        <div class="form-actions">
          <button type="button" class="btn btn-primary btn-lg" id="btn-submit-demo">投函後の画面を見る（デモ）</button>
          <a href="#ask" class="btn btn-secondary btn-lg">書き直す</a>
        </div>
      </div>
    `;

    // 安全に textContent で値を注入
    document.getElementById('confirm-theme-text').textContent = draft.theme || '指定なし';
    document.getElementById('confirm-body-text').textContent = draft.body;

    document.getElementById('btn-submit-demo').addEventListener('click', () => {
      // 送信APIやストレージへの保存は行わず、完了例画面へ
      window.location.hash = '#complete';
    });

    focusMainHeading();
  }

  /**
   * 5. 完了例画面（投函後の表示例）
   */
  function renderComplete() {
    mainContainer.innerHTML = `
      <div class="reading-container">
        <div class="complete-card">
          <span class="complete-badge">デザイン試作 · 投函後の表示例</span>
          <h1 id="main-heading" class="complete-title">投函後の表示例</h1>
          
          <p class="complete-desc">
            ※ この画面は「投函完了後に表示される画面」のデザイン見本です。実際の投函・保存は行われていません。
          </p>

          <div class="complete-spec-box">
            <h2 class="spec-box-title">本番での確認導線について</h2>
            <p class="spec-box-text">
              本番では、ここに自分の問いを確認するための秘密の「控えリンク」を表示します。中高生がパスワードやアカウントを作らなくても、そのリンクを保存しておくことで、後日返事が届いたかどうかを確認できる仕様を想定しています。
            </p>
          </div>

          <aside class="detail-consult-box" style="margin-top: 0;">
            <p>
              <strong>ご注意</strong><br>
              ここは、すぐに返事をする相談窓口ではありません。運営が内容を確認し、地域の大人と対話を重ねるため、返事には時間がかかります。
            </p>
          </aside>

          <div class="form-actions" style="margin-top: 8px;">
            <a href="#status" class="btn btn-primary">返事を確認する（デモ）</a>
            <a href="#home" class="btn btn-secondary">トップへ戻る</a>
          </div>
        </div>
      </div>
    `;

    focusMainHeading();
  }

  /**
   * 6. 返事を確認（ステータス確認デモ）
   */
  function renderStatus() {
    mainContainer.innerHTML = `
      <div class="reading-container">
        <header style="margin-bottom: 24px;">
          <h1 id="main-heading" style="font-size: clamp(1.75rem, 4vw, 2.25rem); margin-bottom: 12px;">問いの状況を確認する</h1>
          <p style="color: var(--color-text-muted);">
            公開されている一覧とは別に、自分が過去に投函した問いの状態を確認する場所です。
          </p>
        </header>

        <!-- 試作切り替えコントローラー -->
        <section class="status-control-box" aria-labelledby="demo-ctrl-title">
          <h2 id="demo-ctrl-title" style="font-size: 0.875rem; font-weight: 600; color: var(--color-text-muted);">
            【試作デモ】状態の切り替え見本
          </h2>
          <div class="status-select-wrap">
            <label for="status-state-select" class="status-select-label">確認したい状態を選択:</label>
            <select id="status-state-select" class="form-select" style="max-width: 240px;">
              <option value="waiting" ${appState.statusDemoChoice === 'waiting' ? 'selected' : ''}>運営の確認待ち</option>
              <option value="replied" ${appState.statusDemoChoice === 'replied' ? 'selected' : ''}>返事が届いた</option>
              <option value="rejected" ${appState.statusDemoChoice === 'rejected' ? 'selected' : ''}>公開見送り</option>
            </select>
          </div>
          <p style="font-size: 0.8125rem; color: var(--color-text-muted);">
            ※ 本番では秘密の控えURLから各個人の状態が表示されます。この試作では3つの状態を切り替えてご確認いただけます。
          </p>
        </section>

        <!-- 状態表示エリア -->
        <div id="status-display-container" aria-live="polite"></div>
      </div>
    `;

    const container = document.getElementById('status-display-container');
    const select = document.getElementById('status-state-select');

    function updateStatusView() {
      const choice = appState.statusDemoChoice;

      if (choice === 'waiting') {
        container.innerHTML = `
          <div class="status-result-card">
            <span class="status-step-badge badge-waiting">運営の確認待ち</span>
            <h2 class="status-display-title">運営が確認するのを待っています</h2>
            <p class="status-display-desc">
              問いを受け取った後の状態です。まだ公開されていません。運営が内容を確認してから、公開するかどうかを決めます。
            </p>
            <div class="detail-consult-box">
              <p>
                <strong>大切なお知らせ</strong><br>
                ここは、すぐに返事をする相談窓口ではありません。確認が完了し、大人の返事が届くまでには日数がかかります。届く時期を約束することはできませんのでご了承ください。
              </p>
            </div>
          </div>
        `;
      } else if (choice === 'replied') {
        container.innerHTML = `
          <div class="status-result-card">
            <span class="status-step-badge badge-replied">返事が届いた</span>
            <h2 class="status-display-title">大人からの返事が届きました</h2>
            <p class="status-display-desc">
              あなたの問いに対して、地域で暮らす大人から視点や経験の言葉が届いています。サイト上で公開されています。
            </p>
            <div style="margin-top: 12px;">
              <a href="#detail?id=q1" class="btn btn-primary">
                届いた問いと返事を読む（例）
                <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>
        `;
      } else if (choice === 'rejected') {
        container.innerHTML = `
          <div class="status-result-card">
            <span class="status-step-badge badge-rejected">公開見送り</span>
            <h2 class="status-display-title" style="color: var(--color-error);">今回は公開を見送りました</h2>
            <p class="status-display-desc">
              個人がわかる内容（名前や学校名、特定される出来事など）を含むため、この例では公開を見送っています。
            </p>
            <p class="status-display-desc" style="color: var(--color-text-muted);">
              特定の個人がわからないように書き直して、もう一度投函することができます。
            </p>
            <div style="margin-top: 12px;">
              <a href="#ask" class="btn btn-secondary">内容を直してもう一度書く</a>
            </div>
          </div>
        `;
      }
    }

    updateStatusView();

    select.addEventListener('change', () => {
      appState.statusDemoChoice = select.value;
      updateStatusView();
    });

    focusMainHeading();
  }

  /**
   * 7. 大人の返信（フッターからアクセスする試作デモ）
   */
  function renderAdultReply() {
    const targetQuestion = SAMPLE_QUESTIONS.find(q => q.id === appState.adultReplyDraft.targetId) || SAMPLE_QUESTIONS[2];

    if (appState.adultReplyStep === 'complete') {
      mainContainer.innerHTML = `
        <div class="reading-container">
          <div class="complete-card">
            <span class="complete-badge">大人の返信 · 完了表示例</span>
            <h1 id="main-heading" class="complete-title">返信後の表示例</h1>
            <p class="complete-desc">
              ※ これは返信フローのデザイン試作デモです。実際のデータ送信は行われていません。
            </p>
            <div class="complete-spec-box">
              <h2 class="spec-box-title">本番での返信プロセスについて</h2>
              <p class="spec-box-text">
                本番環境では、事前の登録・運営による本人確認を経た大人のみが返信画面にログインできます。送信された返信も即時公開ではなく、運営が安心・安全のガイドラインを確認した後に掲載されます。
              </p>
            </div>
            <div class="form-actions">
              <button type="button" class="btn btn-secondary" id="btn-adult-reset">もう一度返信デモを試す</button>
              <a href="#home" class="btn btn-primary">トップへ戻る</a>
            </div>
          </div>
        </div>
      `;

      document.getElementById('btn-adult-reset').addEventListener('click', () => {
        window.location.hash = '#adult-reply';
      });

      focusMainHeading();
      return;
    }

    if (appState.adultReplyStep === 'confirm') {
      mainContainer.innerHTML = `
        <div class="reading-container">
          <header style="margin-bottom: 24px;">
            <h1 id="main-heading" style="font-size: clamp(1.75rem, 4vw, 2.25rem); margin-bottom: 12px;">返信内容の確認（デモ）</h1>
            <p style="color: var(--color-text-muted);">以下の内容で返信例を表示します。</p>
          </header>

          <div class="confirm-preview-box">
            <div class="preview-theme">返信先: 「${escapeHTML(targetQuestion.title)}」</div>
            <div class="preview-theme">立場・肩書き: <span id="adult-confirm-role"></span></div>
            <div class="preview-body" id="adult-confirm-body" style="margin-top: 16px;"></div>
          </div>

          <aside class="confirm-guidance">
            <h3>運営確認について</h3>
            <p>本番では運営スタッフが内容を確認した後、中高生の問いの下に返事として掲載されます。</p>
          </aside>

          <div class="form-actions">
            <button type="button" class="btn btn-primary btn-lg" id="btn-adult-complete-demo">送信後の画面を見る（デモ）</button>
            <button type="button" class="btn btn-secondary btn-lg" id="btn-adult-back-form">書き直す</button>
          </div>
        </div>
      `;

      document.getElementById('adult-confirm-role').textContent = appState.adultReplyDraft.respondentRole || '地域で暮らす大人（例）';
      document.getElementById('adult-confirm-body').textContent = appState.adultReplyDraft.body;

      document.getElementById('btn-adult-complete-demo').addEventListener('click', () => {
        window.location.hash = '#adult-reply?step=complete';
      });

      document.getElementById('btn-adult-back-form').addEventListener('click', () => {
        window.location.hash = '#adult-reply';
      });

      focusMainHeading();
      return;
    }

    // デフォルト: 返信入力フォーム
    mainContainer.innerHTML = `
      <div class="reading-container">
        <header style="margin-bottom: 24px;">
          <h1 id="main-heading" style="font-size: clamp(1.75rem, 4vw, 2.25rem); margin-bottom: 12px;">大人として返事を書く方へ</h1>
          <p style="color: var(--color-text-muted);">
            中高生が投げかけた問いに、地域の大人として自らの経験や視点を持ち寄る場所です。
          </p>
        </header>

        <section class="adult-hero-box" aria-label="大人の返信についての説明">
          <p style="font-size: 0.9375rem; line-height: 1.8; color: var(--color-text);">
            正解を教えたり指導したりするのではなく、「自分の場合はこうだった」「こんな見方もある」という一人の大人としての実感を届けることを大切にしています。<br>
            ※ 本番では事前に登録・確認された大人が返信を行います。この画面は返信体験の試作デモです。
          </p>
        </section>

        <section class="adult-target-question" aria-labelledby="adult-target-title">
          <span style="font-size: 0.75rem; font-weight: 600; color: var(--color-text-muted); display: block; margin-bottom: 8px;">
            返信対象の問い（返事待ち）
          </span>
          <h2 id="adult-target-title" style="font-size: 1.125rem; font-weight: 600; margin-bottom: 8px;">
            ${escapeHTML(targetQuestion.title)}
          </h2>
          <p style="font-size: 0.9375rem; color: var(--color-text-muted); line-height: 1.7;">
            ${escapeHTML(targetQuestion.body)}
          </p>
        </section>

        <div id="adult-error-container"></div>

        <form id="adult-reply-form" class="form-view" novalidate>
          <div class="form-group">
            <label for="adult-role" class="form-label">
              あなたの立場・肩書き（例）
              <span class="label-optional">任意</span>
            </label>
            <input type="text" id="adult-role" class="form-select" style="max-width: 100%;" 
                   value="${escapeHTML(appState.adultReplyDraft.respondentRole)}"
                   placeholder="地域で暮らす大人、近隣で働く人 など">
          </div>

          <div class="form-group">
            <label for="adult-body" class="form-label">
              返事のことば
              <span class="label-required">必須</span>
            </label>
            <textarea id="adult-body" aria-required="true" class="form-textarea" rows="6" maxlength="500"
                      placeholder="押しつけにならず、一人の大人の実感や経験として伝えてみてください。">${escapeHTML(appState.adultReplyDraft.body)}</textarea>
            <div class="form-textarea-footer">
              <span>500文字以内</span>
              <span class="char-counter" id="adult-char-count">0 / 500</span>
            </div>
          </div>

          <div class="form-group">
            <label class="form-checkbox-label" for="adult-agree">
              <input type="checkbox" id="adult-agree" aria-required="true" class="form-checkbox" ${appState.adultReplyDraft.agreed ? 'checked' : ''}>
              <span class="checkbox-text">
                中高生に向けた安心・丁寧な言葉遣いを心がけ、運営による確認後に公開されることに同意します。
              </span>
            </label>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-primary btn-lg">返信内容を確認する</button>
            <a href="#home" class="btn btn-ghost">トップへ戻る</a>
          </div>
        </form>
      </div>
    `;

    const bodyText = document.getElementById('adult-body');
    const roleInput = document.getElementById('adult-role');
    const agreeCheck = document.getElementById('adult-agree');
    const charCounter = document.getElementById('adult-char-count');
    const form = document.getElementById('adult-reply-form');
    const errBox = document.getElementById('adult-error-container');

    function updateAdultChar() {
      const len = bodyText.value.length;
      charCounter.textContent = `${len} / 500`;
    }
    updateAdultChar();

    bodyText.addEventListener('input', () => {
      appState.adultReplyDraft.body = bodyText.value;
      updateAdultChar();
    });
    roleInput.addEventListener('input', () => {
      appState.adultReplyDraft.respondentRole = roleInput.value;
    });
    agreeCheck.addEventListener('change', () => {
      appState.adultReplyDraft.agreed = agreeCheck.checked;
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();

      const val = bodyText.value.trim();
      const isAgreed = agreeCheck.checked;
      const errors = [];

      if (!val) {
        errors.push({ msg: '返事のことばを入力してください。', id: 'adult-body' });
      } else if (bodyText.value.length > 500) {
        errors.push({ msg: '返事は500文字以内で入力してください。', id: 'adult-body' });
      }
      if (!isAgreed) {
        errors.push({ msg: '同意のチェックを入れてください。', id: 'adult-agree' });
      }

      if (errors.length > 0) {
        errBox.innerHTML = `
          <div class="form-error-alert" role="alert" style="margin-bottom: 20px;">
            <div class="form-error-title">入力内容をご確認ください</div>
            <ul class="form-error-list">
              ${errors.map(err => `<li>${escapeHTML(err.msg)}</li>`).join('')}
            </ul>
          </div>
        `;
        document.getElementById(errors[0].id).focus();
        return;
      }

      appState.adultReplyDraft.body = bodyText.value;
      appState.adultReplyDraft.respondentRole = roleInput.value;
      appState.adultReplyDraft.agreed = isAgreed;
      window.location.hash = '#adult-reply?step=confirm';
    });

    focusMainHeading();
  }

  /**
   * 8. この場所について画面
   */
  function renderAbout() {
    mainContainer.innerHTML = `
      <div class="reading-container">
        <header style="margin-bottom: 32px;">
          <h1 id="main-heading" style="font-size: clamp(1.875rem, 4.5vw, 2.5rem); margin-bottom: 16px;">この場所について</h1>
          <p style="font-size: 1.125rem; line-height: 1.9; color: var(--color-text-muted);">
            韮崎市 青少年育成プラザ Miacis（ミアキス）の「問いコーナー」から生まれたWeb試作です。
          </p>
        </header>

        <section style="display: flex; flex-direction: column; gap: 24px; font-size: 1.0625rem; line-height: 1.9;">
          <div class="origin-card" style="margin: 0; max-width: 100%;">
            <h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 12px;">紙のカードから始まった対話</h2>
            <p>
              Miacisの館内には、中高生がふと浮かんだ疑問を手書きのカードに書いて投函し、それを読んだ大人が返事を書いて掲示板に返す「問いコーナー」があります。<br>
              すぐに答えを出すことや、誰かの意見を押しつけるのではなく、異なる世代や視点を持つ人同士がことばを交わす大切な居場所となっています。
            </p>
          </div>

          <div style="background-color: var(--color-surface-question); border-radius: 12px; padding: 32px; border: 1px solid #DCE2F0;">
            <h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 12px;">デザイン方針「ことばの余白」</h2>
            <p style="color: var(--color-text);">
              このWeb試作では、SNSのようなランキングやリアクション競争、過剰な装飾を排し、落ち着いてことばに向き合える静かな余白を大切に設計しています。<br>
              向かい合う2つの括弧のシンボルは、問いと返事が互いを尊重しながら寄り添うかたちを表現しています。
            </p>
          </div>

          <div style="background-color: var(--color-white); border-radius: 12px; padding: 32px; border: 1px solid var(--color-border);">
            <h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 12px;">利用にあたっての約束</h2>
            <ul style="padding-left: 20px; display: flex; flex-direction: column; gap: 8px; color: var(--color-text-muted);">
              <li>名前や学校名などの個人情報は書かないで投函します。</li>
              <li>すべての問いと返事は、安全と安心のため運営が確認した後に公開されます。</li>
              <li>ここは即時対応の相談窓口ではありません。悩んでいるときは専門の相談窓口を利用してください。</li>
            </ul>
          </div>

          <div style="margin-top: 16px;">
            <a href="#home" class="btn btn-primary">ホームに戻る</a>
          </div>
        </section>
      </div>
    `;

    focusMainHeading();
  }

  // ==========================================================================
  // ルーター本体
  // ==========================================================================
  function router() {
    const rawHash = window.location.hash.slice(1);
    const [path, query] = rawHash.split('?');

    // ページ内アンカー（#questions-section）への配慮
    if (path === 'questions-section') {
      updateNavActive('home');
      // ホームが表示されていなければ描画
      if (!document.getElementById('questions-section')) {
        renderHome(false);
      }
      const section = document.getElementById('questions-section');
      if (section) {
        const title = document.getElementById('questions-list-title');
        title.setAttribute('tabindex', '-1');
        title.focus({ preventScroll: true });
        section.scrollIntoView({ behavior: 'auto' });
      }
      return;
    }

    // 画面遷移時は最上部へスクロール
    window.scrollTo(0, 0);

    switch (path) {
      case '':
      case 'home':
        updateNavActive('home');
        renderHome();
        break;

      case 'detail': {
        updateNavActive('home');
        const urlParams = new URLSearchParams(query || '');
        const id = urlParams.get('id') || 'q1';
        renderDetail(id);
        break;
      }

      case 'ask':
        updateNavActive('ask');
        renderAsk();
        break;

      case 'confirm':
        updateNavActive('ask');
        renderConfirm();
        break;

      case 'complete':
        updateNavActive('ask');
        renderComplete();
        break;

      case 'status':
        updateNavActive('status');
        renderStatus();
        break;

      case 'adult-reply': {
        const step = new URLSearchParams(query || '').get('step') || 'form';
        const draft = appState.adultReplyDraft;
        if (['confirm', 'complete'].includes(step) && (!draft.body.trim() || !draft.agreed)) {
          window.location.replace('#adult-reply');
          return;
        }
        appState.adultReplyStep = ['confirm', 'complete'].includes(step) ? step : 'form';
        updateNavActive('adult-reply');
        renderAdultReply();
        break;
      }

      case 'about':
        updateNavActive('about');
        renderAbout();
        break;

      default:
        updateNavActive('home');
        renderHome();
        break;
    }
  }

  // In-page focus links must not change the route hash.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    const href = link?.getAttribute('href');
    if (!['#main-heading', '#question-body', '#agree-check'].includes(href)) return;
    const target = document.getElementById(href.slice(1));
    if (!target) return;
    event.preventDefault();
    if (href === '#main-heading') target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
  });

  // ルーティングイベントリスナー
  window.addEventListener('hashchange', router);

  // 初期実行
  router();
})();
