(() => {
  'use strict';
  const topics = ['すべて', '自分のこと', '人とのこと', 'これから'];
  const questions = [
    {id:'q1',topic:'これから',title:'好きなことがないと、\n将来って決められない？',body:'進路の紙に「将来の夢」を書くところがあって、手が止まります。好きなことがある人が、ちょっとうらやましいです。大人の人は、どうやって今の仕事を決めたんですか。',replies:[
      {role:'地域で働く大人（例）',title:'私は「好き」より先に、出会いがあった。',body:'高校生の頃、これといって夢はありませんでした。たまたま手伝ったイベントで、人と何かをつくるのが案外楽しいと気づきました。\n\n仕事を決めてから、好きになったこともあります。今は「ちょっと気になる」くらいで、寄り道してもいいのかもしれません。'},
      {role:'ものづくりをしている大人（例）',title:'好きなことを、仕事にしなくてもいいと思う。',body:'私は絵を描くのが好きだけど、仕事にするのは違うなと思いました。好きなことは、休みの日の楽しみにしています。\n\n何をして働くかと、何が好きか。一緒でも、別々でもよさそうです。あなたが大切にしたい時間って、どんな時間でしょう。'}]},
    {id:'q2',topic:'人とのこと',title:'友だちといるのに、ひとりになりたくなる。',body:'友だちのことは好きなのに、放課後は誰とも話したくない日があります。こういう日があってもいいんでしょうか。',replies:[{role:'本を読むのが好きな大人（例）',title:'一緒にいたい日も、一人でいたい日もある。',body:'私にもあります。楽しくても、人と過ごすと少し疲れることがあるんです。\n\n「今日はひとりで帰るね」と言うのに、最初は勇気がいりました。少しずつ伝えるようにしたら、友だちも「実は私も」と話してくれました。'}]},
    {id:'q3',topic:'自分のこと',title:'「自分らしい」って、どういうこと？',body:'人によって言うことも変わるし、昨日と今日で考えが違うこともあります。どれが本当の自分なんでしょう。',replies:[{role:'近所に暮らす大人（例）',title:'変わるところも、私の一部かもしれない。',body:'家にいる自分、仕事中の自分。私もずいぶん違います。どれかひとつが本物というより、全部合わせて自分なのかな、と最近は思っています。\n\n「こういう自分でいなきゃ」を少し手放すと、楽になる日もありました。'}]},
    {id:'q4',topic:'これから',title:'大人になってから、やり直せますか。',body:'今選ぶことで、将来が全部決まってしまう気がします。大人になってから、別の道に進んだことはありますか。',replies:[]}
  ];
  const state = {filter:'すべて', ask:{body:'',topic:'自分のこと',consent:false,step:'write'},reply:{id:null,body:'',role:'',consent:false,step:'write'}, own:[], next:1};
  const main = document.querySelector('#main');
  let activeRoute = 'home';
  let activeId = '';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const find = id => questions.find(q=>q.id===id) || state.own.find(q=>q.id===id);
  const color = topic => topic==='人とのこと'?'pink':topic==='これから'?'blue':'';
  const sample = '<span class="sample">掲載例</span>';
  const back = (href,label) => `<a class="back-link" href="${href}">〈 ${label}</a>`;
  const steps = current => `<div class="steps" aria-label="${current===1?'書く':'確認する'}段階"><span class="${current===1?'current':''}">1 書く</span><span aria-hidden="true">／</span><span class="${current===2?'current':''}">2 確認する</span><span aria-hidden="true">／</span><span>3 置いていく</span></div>`;
  const replyCount = q => q.replies.length?`${q.replies.length}通の返事`:'返事を待っています';
  const title = q => q.title || q.body;
  function focusTitle() {const el = document.querySelector('#page-title'); if(el){el.setAttribute('tabindex','-1');el.focus({preventScroll:true});}}
  function announce(text) {document.querySelector('#announcer').textContent=text;}
  function questionRows() {
    const list = questions.filter(q=>state.filter==='すべて'||q.topic===state.filter);
    return list.map(q=>`<a class="question-row" href="#question/${q.id}"><span class="topic-tag ${color(q.topic)}">${escape(q.topic)}</span><div><h3>${escape(q.title.replace(/\n/g,''))}</h3><p>${escape(q.body)}</p></div><span class="reply-count">${q.replies.length?`${q.replies.length}通の返事`:'返事待ち'} <b aria-hidden="true">↗</b></span></a>`).join('');
  }
  function home() {
    main.innerHTML=`<section class="home-space" aria-labelledby="page-title"><div class="welcome"><p class="place-label">Miacisからつながる、問いの置き場所</p><h1 id="page-title">うまく言えなくても、<br>ここに。</h1><p class="welcome-copy">友だちのこと。これからのこと。<br>ひとこと置いて、いろいろな大人と考えてみよう。<br>ひとつの問いに、ひとつじゃない返事が届きます。</p><a class="button button-yellow" href="#ask">問いを書いてみる <span aria-hidden="true">＋</span></a><p class="quiet-note">名前はいりません。読むだけでも、もちろん。</p></div><div class="paper-scene"><a class="spotlight" href="#question/q1" aria-label="好きなことがないと、将来って決められない？ 2通の返事を読む"><div class="paper-tab"><span>こんな問いが、ありました。</span>${sample}</div><h2>好きなことがないと、<br>将来って決められない？</h2><div class="reply-peek"><small>地域で働く大人から</small>私は「好き」より先に、出会いがあった。</div><div class="reply-peek"><small>ものづくりをしている大人から</small>好きなことを、仕事にしなくてもいいと思う。</div><div class="spotlight-bottom"><span>問いと、ふたりの返事を読む</span><span aria-hidden="true">↗</span></div></a></div></section><section class="home-content" aria-labelledby="questions-heading"><div class="section-head"><h2 id="questions-heading">誰かの問いから、考えてみる。</h2><p>気になる一枚を、ひらいてみよう。<span class="sample">掲載例</span></p></div><div class="filters" aria-label="問いのテーマ">${topics.map(t=>`<button class="filter" data-filter="${t}" aria-pressed="${state.filter===t}">${t}</button>`).join('')}</div><div class="question-list" id="question-list">${questionRows()}</div><div class="origin-strip"><img class="origin-photo" src="assets/sticky-wall.jpg" alt="紙の問いコーナーに寄せられた、手書きの問いが並ぶ色とりどりの付箋"><div><h2>はじまりは、Miacisの片すみ。</h2><p>話しかけるのは、少しむずかしい。<br>そんな日にもことばを置ける、紙の「問いコーナー」。<br>その往復を、ここでも。</p><a class="text-link" href="#about">この場所について</a></div><img class="miacis-logo" src="assets/miacis.png" alt="らしさ、無制限。Miacis"></div></section>`;
  }
  function ask() {
    const d=state.ask, confirming=d.step==='confirm';
    main.innerHTML=`<div class="page-shell">${back('#home','問いを読む')}<div class="writing-layout"><aside class="writing-aside"><h1 id="page-title">${confirming?'このことばを、<br>置いていきますか。':'いま、<br>ひっかかっていること。'}</h1><p>${confirming?'立派な問いになっていなくても大丈夫。<br>もう一度読んで、そのままでも、書き直しても。':'一行でも、まとまらなくても。<br>どう書こうか迷ったら、思いつくところから。'}</p>${steps(confirming?2:1)}<div class="aside-note"><strong>ここは、正解をもらう場所ではありません。</strong><p>違う経験をしてきた大人たちが、自分のことばで返事を書きます。あなたと違う考えも、近い考えもあるかもしれません。</p></div></aside><section class="writing-sheet" aria-label="問いを書く用紙"><div class="sheet-top"><span>あなたからの問い</span><span>名前は書かなくて大丈夫</span></div>${confirming?`<span class="topic-tag ${color(d.topic)}">${escape(d.topic)}</span><p class="preview-body">${escape(d.body)}</p><p class="review-note">名前や学校名など、あなたや誰かが特定される内容は入っていませんか。</p><div class="form-actions"><button class="plain-button" data-action="edit-question">書き直す</button><button class="button button-green" data-action="submit-question">この問いを置く（デモ）</button></div><p class="form-help">これは体験用です。内容は送信されません。</p>`:`<form id="ask-form" novalidate><label class="field-label" for="question-body">あなたの問い</label><textarea id="question-body" class="question-input" maxlength="1000" required placeholder="たとえば、なんで人と比べちゃうんだろう。" aria-describedby="question-hint question-count">${escape(d.body)}</textarea><div class="input-meta"><span id="question-hint">個人がわかる名前や連絡先は書かないでね。</span><span id="question-count">${d.body.length} / 1000</span></div><div class="form-field"><label class="field-label" for="question-topic">近いテーマ<span class="optional">迷ったら、そのままで</span></label><select class="select-field" id="question-topic">${topics.slice(1).map(t=>`<option ${d.topic===t?'selected':''}>${t}</option>`).join('')}</select></div><label class="consent"><input id="question-consent" type="checkbox" ${d.consent?'checked':''} required><span>個人がわかる情報は書いていません。問いと返事が、サイトでみんなに読まれることを確認しました。</span></label><p class="error" id="form-error" role="alert" hidden></p><div class="form-actions"><span></span><button class="button button-green" type="submit">内容を確認する</button></div><p class="form-help">デザイン試作のため、問いは送信されません。再読み込みすると入力は消えます。</p></form>`}</section></div></div>`;
  }
  function detail(id) {
    const q=find(id);if(!q){missing();return;}
    const own=state.own.includes(q);
    main.innerHTML=`<div class="page-shell">${back(own?'#check':'#home',own?'返事の確認に戻る':'問いの一覧に戻る')}<div class="detail-layout"><div><article class="question-paper"><div class="paper-tab"><span>${escape(q.topic)}</span>${own?'<span class="sample">このタブ内のデモ投稿</span>':sample}</div><h1 id="page-title">${escape(title(q))}</h1>${q.title?`<p>${escape(q.body)}</p>`:''}</article><h2 class="replies-heading">${q.replies.length?`届いた、${q.replies.length}通の返事。`:'返事を待っているところです。'}</h2>${q.replies.length?q.replies.map(r=>`<article class="reply-letter"><header>${escape(r.role)}</header>${r.title?`<h3>${escape(r.title)}</h3>`:''}<p>${escape(r.body)}</p><footer>${r.demo?'このタブで書いたデモの返事':'体験用に作成した、架空の返事です'}</footer></article>`).join(''):'<p class="empty-replies">同じ問いを、誰かも考えているかもしれません。<br>デモでは、下のボタンから返事を書く操作を試せます。</p>'}<a class="text-link detail-back" href="#reply/${q.id}">この問いに返事を書く（大人向けデモ）</a></div><aside class="detail-aside"><h2>あなたなら、<br>どう考えますか。</h2><p>ここにあるのは、それぞれの人の経験や考え。<br>しっくりくることばだけ、持って帰っても大丈夫です。</p><a class="button button-green" href="#ask">自分の問いも書いてみる</a><img class="miacis-logo" src="assets/miacis.png" alt="Miacis"></aside></div></div>`;
  }
  function check() {
    main.innerHTML=`<div class="page-shell"><div class="check-heading"><h1 id="page-title">置いていった問いの、そのあと。</h1><p>このタブで書いた問いと、届いた返事を確認できます。<br>デモのため、再読み込みするとここには残りません。</p></div>${state.own.length?state.own.map(q=>`<article class="receipt"><span class="status">${q.replies.length?`返事が ${q.replies.length} 通あります`:'問いを置きました（デモ）'}</span><h2>${escape(q.body)}</h2><p>${q.replies.length?'ひらいて、それぞれのことばを読んでみよう。':'まだ返事はありません。大人からの返信操作も試せます。'}</p><div class="receipt-actions"><a class="button button-green" href="#question/${q.id}">問いと返事をひらく</a><a class="text-link" href="#reply/${q.id}">返事を書く操作を試す</a></div></article>`).join(''):`<section class="empty-state"><h2>あなたの問いは、まだありません。</h2><p>書いてみたいことがあったら、ひとこと置いてみよう。<br>どんな返事が届くのか、掲載例から読むこともできます。</p><a class="button button-green" href="#ask">問いを書いてみる</a><br><a class="text-link" href="#question/q1">問いと返事の例を読む</a></section>`}<p class="check-note">本番の返事の受け取り方は準備中です。この試作に保存機能はありません。</p></div>`;
  }
  function reply(id) {
    const q=find(id);if(!q){missing();return;}
    if(state.reply.id!==id)state.reply={id,body:'',role:'',consent:false,step:'write'};
    const d=state.reply,confirming=d.step==='confirm';
    main.innerHTML=`<div class="page-shell">${back(`#question/${q.id}`,'問いに戻る')}<div class="writing-layout"><aside class="writing-aside"><h1 id="page-title">${confirming?'あなたのことばで、<br>返事を届ける。':'あなたの経験を、<br>ひとつの返事に。'}</h1><p>大人の方へ。教えるよりも、<br>「自分はこうだった」から書いてみませんか。</p>${steps(confirming?2:1)}<div class="aside-note"><strong>この問いへの返事です</strong><p>${escape(title(q))}</p></div></aside><section class="writing-sheet" aria-label="返事を書く用紙" style="border-top-color:var(--pink)"><div class="sheet-top"><span>あなたからの返事</span><span>大人向けデモ</span></div><p class="review-note" style="padding-top:0;border:0;margin-bottom:22px">${escape(title(q))}</p>${confirming?`<p class="paper-tab">${escape(d.role)}</p><p class="preview-body">${escape(d.body)}</p><p class="review-note">「こうするべき」と決めつけず、相手の考え方も大切にできていますか。</p><div class="form-actions"><button class="plain-button" data-action="edit-reply">書き直す</button><button class="button button-green" data-action="submit-reply">この返事を置く（デモ）</button></div>`:`<form id="reply-form" novalidate><label class="field-label" for="reply-body">あなたの返事</label><textarea id="reply-body" class="question-input" maxlength="2000" required placeholder="私にも、こんなことがありました。" aria-describedby="reply-count">${escape(d.body)}</textarea><div class="input-meta"><span>個人を特定できる情報は書かないでください。</span><span id="reply-count">${d.body.length} / 2000</span></div><div class="form-field"><label class="field-label" for="reply-role">あなたを表すひとこと</label><input class="role-input" id="reply-role" type="text" maxlength="40" required placeholder="例：本を読むのが好きな大人" value="${escape(d.role)}" autocomplete="off"></div><label class="consent"><input id="reply-consent" type="checkbox" ${d.consent?'checked':''} required><span>個人情報を含めず、問いを書いた人を否定・評価せずに書きました。返事がサイトで読まれることを確認しました。</span></label><p class="error" id="form-error" role="alert" hidden></p><div class="form-actions"><span></span><button class="button button-green" type="submit">内容を確認する</button></div><p class="form-help">このデモでは、認証なしで返信操作を試せます。内容は送信されません。</p></form>`}</section></div></div>`;
  }
  function success(kind,id) {
    const q=find(id);if(!q){missing();return;}
    const isReply=kind==='reply';
    main.innerHTML=`<div class="page-shell"><section class="success-panel arrived"><div class="success-symbol" aria-hidden="true">${isReply?'↳':'✓'}</div><h1 id="page-title">${isReply?'返事を、置きました。':'問いを、置きました。'}</h1><p>${isReply?'ひとつの問いに、あなたからの視点が加わりました。':'ひとこと書いてくれて、ありがとう。<br>あなたの問いは、「返事を確認」からひらけます。'}</p><div class="receipt"><p>${escape(title(q))}</p><span class="status">このタブの中だけのデモです</span></div><p>内容はどこにも送信されていません。<br>再読み込みすると、問いも返事も消えます。</p><div class="success-actions"><a class="button button-green" href="${isReply?`#question/${q.id}`:'#check'}">${isReply?'問いと返事を読む':'返事の確認へ'}</a><a class="text-link" href="#home">ほかの問いも読んでみる</a></div></section></div>`;
  }
  function about() {
    main.innerHTML=`<div class="page-shell">${back('#home','問いを読む')}<div class="about-layout"><div class="about-copy"><div class="about-heading"><h1 id="page-title">声にしにくいことも、<br>置いていける場所に。</h1><p>韮崎市の中高生の居場所、Miacis。<br>このサイトは、館内にある紙の「問いコーナー」から生まれました。</p></div><h2>話すかわりに、書いてみる。</h2><p>スタッフと話すのは少し苦手。まだ、うまく言えない。そんなときにも、自分の疑問やモヤモヤを出せるように。紙に問いを書き、大人が返事を書く、往復書簡を続けてきました。</p><h2>大人だって、考え中。</h2><p>同じ問いでも、人が違えば、返事も違う。ここではいろいろな大人の経験や考えに出会えます。評価も、成績もありません。読むだけの参加も歓迎です。</p><h2>ことばを置くときの約束。</h2><p>本名、学校名、連絡先など、誰かが特定される情報は書かないでください。問いや返事を通じて、相手を傷つけたり、考えを押しつけたりしないことを大切にします。</p><div class="about-brand"><img src="assets/miacis.png" alt="らしさ、無制限。Miacis"><p>青少年育成プラザ Miacis<br>中高生の「第3の居場所」</p></div><a class="button button-green" href="#ask">問いを書いてみる</a></div><figure class="about-image"><img src="assets/sticky-wall.jpg" alt="幸せな家庭ってなに、人は一人では生きていけないの、などの手書きの問いが並ぶ実物の付箋"><figcaption>実際の紙の問いコーナーに寄せられた問い。<br>サイト内の操作用の問い・返事は、別に作成した架空の例文です。</figcaption></figure></div></div>`;
  }
  function missing() {main.innerHTML=`<section class="route-message"><h1 id="page-title">この問いは、見つかりませんでした。</h1><p>デモの投稿は、ページを再読み込みすると消えます。<br>一覧から、もう一度ひらいてみてください。</p><a class="button button-green" href="#home">問いの一覧へ</a></section>`;}
  function render(focus=true) {
    const hash=location.hash.slice(1)||'home';
    const parts=hash.split('/'); activeRoute=parts[0];activeId=parts[1]||'';
    let validRoute=true;
    if(activeRoute==='ask'){
      validRoute=parts.length===1||(parts.length===2&&parts[1]==='confirm');
      const canConfirm=state.ask.body.trim()&&state.ask.body.length<=1000&&state.ask.consent;
      if(validRoute&&parts[1]==='confirm'&&!canConfirm)history.replaceState(null,'','#ask');
      state.ask.step=validRoute&&parts[1]==='confirm'&&canConfirm?'confirm':'write';
    }else if(activeRoute==='reply'){
      validRoute=!!activeId&&(parts.length===2||(parts.length===3&&parts[2]==='confirm'));
      if(validRoute&&state.reply.id!==activeId)state.reply={id:activeId,body:'',role:'',consent:false,step:'write'};
      const d=state.reply;
      const canConfirm=d.body.trim()&&d.body.length<=2000&&d.role.trim()&&d.role.length<=40&&d.consent;
      if(validRoute&&parts[2]==='confirm'&&!canConfirm)history.replaceState(null,'',`#reply/${activeId}`);
      d.step=validRoute&&parts[2]==='confirm'&&canConfirm?'confirm':'write';
    }else if(['question','sent','replied'].includes(activeRoute)){
      validRoute=parts.length===2&&!!activeId;
    }else{
      validRoute=parts.length===1;
    }
    if(!validRoute){missing();}else switch(activeRoute){case 'home':home();break;case 'ask':ask();break;case 'check':check();break;case 'question':detail(activeId);break;case 'reply':reply(activeId);break;case 'sent':success('question',activeId);break;case 'replied':success('reply',activeId);break;case 'about':about();break;default:missing();}
    const nav=activeRoute==='ask'?'ask':['check','sent'].includes(activeRoute)?'check':'home';
    document.querySelectorAll('[data-nav]').forEach(a=>{if(a.dataset.nav===nav)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    document.title=`${document.querySelector('#page-title')?.textContent||'問いコーナー'} — Miacis`;
    if(focus){window.scrollTo({top:0,behavior:'instant'});focusTitle();}
  }
  function showError(message,id) {const e=document.querySelector('#form-error');e.hidden=false;e.textContent=message;document.getElementById(id)?.focus();}
  main.addEventListener('input',event=>{
    const el=event.target;
    if(el.id==='question-body'){state.ask.body=el.value;document.querySelector('#question-count').textContent=`${el.value.length} / 1000`;}
    if(el.id==='question-topic')state.ask.topic=el.value;
    if(el.id==='question-consent')state.ask.consent=el.checked;
    if(el.id==='reply-body'){state.reply.body=el.value;document.querySelector('#reply-count').textContent=`${el.value.length} / 2000`;}
    if(el.id==='reply-role')state.reply.role=el.value;
    if(el.id==='reply-consent')state.reply.consent=el.checked;
  });
  main.addEventListener('submit',event=>{
    event.preventDefault();
    if(event.target.id==='ask-form'){
      state.ask.body=document.querySelector('#question-body').value;state.ask.topic=document.querySelector('#question-topic').value;state.ask.consent=document.querySelector('#question-consent').checked;
      if(!state.ask.body.trim())return showError('問いをひとこと書いてみてください。','question-body');
      if(state.ask.body.length>1000)return showError('1000文字以内にしてください。','question-body');
      if(!state.ask.consent)return showError('内容の公開と個人情報について確認してください。','question-consent');
      location.hash='ask/confirm';
    }else if(event.target.id==='reply-form'){
      state.reply.body=document.querySelector('#reply-body').value;state.reply.role=document.querySelector('#reply-role').value;state.reply.consent=document.querySelector('#reply-consent').checked;
      if(!state.reply.body.trim())return showError('返事を書いてください。','reply-body');
      if(state.reply.body.length>2000)return showError('2000文字以内にしてください。','reply-body');
      if(!state.reply.role.trim()||state.reply.role.length>40)return showError('あなたを表すひとことを40文字以内で書いてください。','reply-role');
      if(!state.reply.consent)return showError('返事を書くときの約束を確認してください。','reply-consent');
      location.hash=`reply/${state.reply.id}/confirm`;
    }
  });
  main.addEventListener('click',event=>{
    const filter=event.target.closest('[data-filter]');
    if(filter){state.filter=filter.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',b===filter?'true':'false'));document.querySelector('#question-list').innerHTML=questionRows();announce(`${state.filter}の問いを表示しました。`);return;}
    const button=event.target.closest('[data-action]');if(!button)return;
    switch(button.dataset.action){
      case 'edit-question':location.hash='ask';break;
      case 'edit-reply':location.hash=`reply/${state.reply.id}`;break;
      case 'submit-question':{
        const d=state.ask;if(d.step!=='confirm'||!d.body.trim()||!d.consent)return;
        button.disabled=true;const id=`mine-${state.next++}`;state.own.unshift({id,topic:d.topic,body:d.body.trim(),replies:[]});state.ask={body:'',topic:'自分のこと',consent:false,step:'write'};location.hash=`sent/${id}`;break;
      }
      case 'submit-reply':{
        const d=state.reply,q=find(d.id);if(!q||d.step!=='confirm'||!d.body.trim()||!d.role.trim()||!d.consent)return;
        button.disabled=true;q.replies.push({role:d.role.trim(),body:d.body.trim(),demo:true});const id=q.id;state.reply={id:null,body:'',role:'',consent:false,step:'write'};location.hash=`replied/${id}`;break;
      }
    }
  });
  window.addEventListener('hashchange',()=>render());
  render(false);
})();
