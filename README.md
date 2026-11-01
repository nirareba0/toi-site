# toi-site — 問う応える（Miacis 問いコーナー）

山梨県韮崎市の中高生の居場所 **Miacis（ミアキス）** の館内にある、紙の「問いコーナー」を Web に広げるサイト。
中高生が問いを書き、スタッフや地域の大人が返事を書く。館内の紙とこのサイトは同じ問いコーナー。

**文書・要件・決定の正本は `~/AIOS/core/projects/toi-corner/`（2026-10-12 に miacis から移った）。ここはコードだけ。**

## 構成

| フォルダ | 中身 |
|---|---|
| `web/` | 静的フロント（HTML / CSS / 素の ES Modules。ビルド無し）。Supabase を直接読む |
| `supabase/` | スキーマ・RLS・列権限（`schema.sql`）、旧データの移行とカード画像アップロード |
| `gas/` | 配布済み QR の飛び先（旧 Google Apps Script）を新サイトへ転送するスタブ |
| `design/` | 制作過程のデザイン試作4版（履歴。現行は `web/`） |

## 動かす

```sh
cd web && python3 -m http.server 8800 --bind 127.0.0.1
node --test web/tests/          # ドメインロジックのテスト
```

`web/js/config.js` に Supabase の URL と anon key が入っている。
**anon key はブラウザに配られる前提の公開鍵**で、実際のアクセス制御は RLS と列単位の GRANT が行う。

## 設計で守っていること

- **未承認の投稿は匿名から読めない。** RLS で `approved` のものだけ。公開ビュー経由でのみ読む
- **回答者は氏名ではなくタグで表す。** `answers.role_id` が `responder_roles` を参照する。
  自由文ではないので、氏名を書き込めない
- **匿名に渡す列を絞っている。** 氏名・カード画像パス・client_hash はテーブルから直接読めない
- **実物カードのスキャンは非公開バケット。** サイトには出さない
- **AI と一緒に考えた返事は明示する。** `answers.ai_assisted`

## 旧データについて

旧サイトの本文は、OCR の「クレンジング」工程で **AI が書き換えていた**（返事 33/54 枚、問い 10 枚）。
生の OCR と実物カードに突き合わせて直したものが `supabase/data-fixups.json`。
回答者名はこのリポジトリに持たない（sha256 で照合する）。

## 検索に出すしくみ（2026-09-27）

サイト本体はハッシュルーティングなので、検索エンジンからは問いごとのページが見えない。そこで公開のたびに
`scripts/prerender.mjs` が公開ビューから問いと返事を読み、`web/q/<id>/`（問いごとの静的ページ）・`web/q/`（一覧）・`web/sitemap.xml` を書き出す（`pages.yml`、毎日 JST 6:30 にも再実行）。生成物は Git に入れない。

- 静的ページには問いのニックネームを出さない（中高生の投稿が検索に載るため）
- ラジオ「ミアキスの問いコーナー」で扱った問いは `scripts/radio-episodes.json` に足すと、その問いのページから YouTube の回へリンクされる
- Google Search Console（URL プレフィックス `https://nirareba0.github.io/toi-site/`）に登録済み。所有権確認は `web/google89fab6771a349d4e.html`（**消さない**）。sitemap は `sitemap.xml` で送信済み

## LINE とつなぐ（2026-10-11〜）

公式LINE「問う応える」（@803ifgkb・運営 たいど）。設計と置き方の手順は AIOS `core/projects/toi-corner/specs/toi-line-sync-20261016.md`。

| ファイル | 中身 |
|---|---|
| `supabase/line-notify.sql` | 問いに返事がきたら LINE で知らせる |
| `supabase/line-sync.sql` | LINE と同期する: トークで答える → 自分だけのノート、毎日／週1の問い（pg_cron）、「みんなに見せる」→ 未承認の返事、端末をまたいだ「自分の問い」 |
| `supabase/functions/line-webhook/` | Webhook の受け口。本文と署名を `line_webhook()` に渡すだけ |
| `web/js/line.js` | LIFF。試しのあいだは `?linetest` か LINE から開いた端末にだけ出す（`LINE_PUBLIC`） |

秘密（Messaging API のトークンとチャネルシークレット）は Supabase の Vault にだけ置く。テストは `npm run test:db`（PGlite）。

## スマホのホーム画面と通知（2026-10-31〜・試し）

「なんでポスト」をスマホのホーム画面に置け、通知（Web Push）が届く。声のログ（`C:\code\toi-voice` の `work/notify-setup.md`・`C:\code\toi-voice-pages`）と同じ形。
通知に載るのは種類だけ（問いや返事の本文・名前は載らない）。端末は投函と同じ `client_hash` で見分け、名前・メール・LINE の ID は取らない。

| 届く知らせ | いつ |
|---|---|
| あなたの問いに返事が届きました（`reply`） | 返事と問いの両方が承認されたとき（LINE の「返事が届いた」と同じ時点） |
| 新しい問いが届きました（`question`） | 1日1回まで・19時ごろ。前の回から新しく載った問いがあるときだけ（受け取らない設定もできる）。「今日の問い」を毎日／週1にした端末には送らない（下の `today` に寄せる） |
| 今日の問いが届きました（`today`）ほか3つ | 下の「アプリだけで答える」 |

夜21時〜朝7時に出た知らせは朝7時に送る。時刻は `push_settings` の `question_hour_jst`・`quiet_from_jst`・`quiet_until_jst`。

| ファイル | 中身 |
|---|---|
| `web/site.webmanifest`・`web/sw.js` | ホーム画面に置く（アイコン 180/192/512 は `web/assets/`）。sw.js は通知を出し、画面のファイルだけを手元に置く（いつも通信を先に・問いと返事は持たない） |
| `web/js/push.mjs`・`web/assets/tut-*.svg` | 「スマホに知らせてもらう」（`#notify`）: 機種ごとの3枚の手順・通知を受け取る／やめる・iPhone の引き継ぎの番号 |
| `supabase/web-push.sql` | 購読・送る列・引き金（返事の承認・新しい問い）・pg_net で関数を呼ぶ・毎時の pg_cron・引き継ぎの番号 |
| `supabase/functions/notify-push/` | Edge Function。鍵（VAPID）を最初に動いたときに作って Vault に置き、web-push で送る |

iPhone はホーム画面のアプリと Safari で保存場所が分かれる。Safari で出した問いは、Safari の `#notify` で出す8けたの番号（15分）をアプリで入れて引き継ぐ。

**試しの旗**: `?pushtest` を付けて開いた端末と、ホーム画面のアイコンから開いたとき（iPhone のホーム画面のアプリには旗が運ばれないことがあるため・2026-11-01）にだけ、通知の操作（受付画面・自分への返事・フッターのリンク）が出る。旗の端末では manifest が `site-pushtest.webmanifest`（`start_url` が `./?pushtest`）に替わり、ホーム画面のアイコンからも旗つきで開く。
みんなに出すときは `web/js/push.mjs` の `PUSH_PUBLIC` を `true` にする。ホーム画面に置くこと自体は旗に関係なくいつでもできる。

### 本番に出す手順（鍵も合言葉も人は扱わない）

1. SQL Editor で `supabase/web-push.sql` を流す（何度流してもよい）。合言葉（Vault の `push_hook_secret`）と毎時の仕事（`toi-web-push-hourly`）までできる。
   ```sql
   select name from vault.decrypted_secrets where name = 'push_hook_secret';
   select jobname, schedule from cron.job where jobname = 'toi-web-push-hourly';
   ```
2. Edge Function を置く: Dashboard → Edge Functions →「Deploy a new function」→ 名前 `notify-push` で `index.ts` と `deliver.mjs` を置く（CLI なら `supabase functions deploy notify-push --project-ref btbykfnlsxwmpfcfslxb`）。**JWT の確かめは切らない**（既定のまま。pg_net は `push_settings` の公開の anon キーを付けて呼び、関数はそのうえで合言葉を確かめる）。
3. 1回 GET して鍵を作る（返るのは公開の鍵だけ）:
   ```sql
   select net.http_get(url := (select value from push_settings where key = 'function_url'),
     headers := jsonb_build_object('authorization', 'Bearer ' || (select value from push_settings where key = 'anon_key')));
   select status_code, content from net._http_response order by created desc limit 1;  -- 200 と {"publicKey":"…"}（87文字）
   ```
4. このブランチを main に入れて push する（GitHub Pages に出る）。

`web/js/config.js` の anon キーを替えたら、`push_settings` の `anon_key` も替える。

### 確かめ方

| # | すること | 見ること |
|---|---|---|
| 1 | `npm test`・`npm run test:db` | 全部通る（`web/tests/push.test.mjs`・`supabase/tests/web-push.test.mjs`） |
| 2 | Android の Chrome で `https://nirareba0.github.io/toi-site/?pushtest#notify` →「ホーム画面に追加」→ アイコンから開く →「通知を受け取る」→ 許可 | 「この端末に通知が届きます」。`select count(*) from push_subscriptions;` が 1 増える |
| 3 | iPhone（iOS 16.4 以上）の Safari で同じ URL → 共有 →「ホーム画面に追加」→ アイコンから開いて同じ操作 | Safari のままだと「ホーム画面のアイコンから開くと…」と出る（正しい） |
| 4 | 送る列に手で1行: `insert into push_outbox (endpoint, kind) select endpoint, 'reply' from push_subscriptions limit 1;` | 数秒で「あなたの問いに返事が届きました」。押すと「自分への返事」が開く |
| 5 | 旗の端末で問いを出し、Table Editor で返事を足して問いと返事を承認する（昼のうちに） | 「あなたの問いに返事が届きました」 |
| 6 | Edge Functions → notify-push → Logs | `{"sent":1,"dropped":0,"failed":0}` のような数だけ（宛先・中身・鍵は出ない） |

届かないとき: `select status_code from net._http_response order by created desc limit 5;`（401 は合言葉、404 は関数の名前）・`select * from push_outbox;`（夜の分は朝まで残る）。
鍵を替えたいときは Vault の `vapid_public_key`・`vapid_private_key` を消して手順3をもう一度（端末側は「通知をやめる」→「通知を受け取る」で入れ直す）。
通知は Apple・Google などの送り先（push service）を通る。中身は暗号化されて読めないが、「いつ通知が来たか」は送り先に分かる。

## アプリだけで答える（2026-11-01〜・試し）

LINE を使わない人が、ホーム画面の「なんでポスト」だけで、LINE のトークと同じこと（問いが届く・答える・ノートに残す・みんなに見せる・載ったら知らせてもらう）をできる。
LINE の ID の代わりに、端末の `client_hash`（投函・通知と同じ）で見分ける。名前・メール・LINE の ID は取らない。試しのあいだは通知と同じ旗 `?pushtest` の端末にだけ出る（旗のない人の見た目は今のまま）。

| 画面 | できること |
|---|---|
| `#today`（今日の問い） | 届いている問い・答える欄・「別の問いを引く」。はじめは届く頻度（毎日／週1／自分で引くだけ）とジャンルを選ぶ（あとで変えられる）。ホーム画面のアイコンから開くと、通知をまだ聞いていなければ `#notify`、聞き終えていればここから始まる。ホームのいちばん上にも今日の問いが出る |
| `#question/<id>`（問いのページ） | 返事の下に「この問いに答える」。返事への反応のボタンも出る |
| 答える欄 | **書き出してから答える・はじめてから30分**（本人 2026-11-01「ジャーナリングしてから書くことをおすすめしたい。30分以内に書けたもので回答に」）。「はじめる（30分）」を押すと、1. 書き出す（この端末だけ・どこにも送らない）と 2. あなたの答え が開き、残り時間が出る。30分たつと両方とも書けなくなり、そのとき書けているものを残す。「書き出しを答えに写す」「やめて消す」（2回押し）。書きかけは問いごとに localStorage（`toi.answerDraft.<id>`）に置き、残したら消す。時間は画面の決まりで、DB では確かめない。書き出しに相談先が要る言葉があっても相談先を出して送らない。書くと、この端末だけのノートに残る。「みんなに見せる」を選ぶと、その問いへの未承認の返事（立場「中高生」= `role_id 'teen'`）になり、運営が承認すると載る |
| `#notes`（自分のノート） | この端末の答えの一覧。消せる・あとから「みんなに見せる」。iPhone で引き継ぎの番号を入れたら、Safari で書いた分も出る。LINE でログインしていれば、その下に LINE で答えたノート（旗のない LINE の端末は、これまでどおり LINE のノートだけ） |
| 下のナビ | 今日の問い・みんなの問い・問いを書く・ノート・自分への返事（旗の端末だけ5つ） |

| 届く知らせ（Web Push・中身は種類だけ） | いつ | 押すと |
|---|---|---|
| 今日の問いが届きました（`today`） | 毎日／週1の端末に、19時ごろ（`question_hour_jst`）。「問いの知らせも受け取る」を切った端末には送らない | `#today` |
| あなたの答えがサイトに載りました（`published`） | 「みんなに見せる」にした答えと、その問いが承認されたとき | `#notes` |
| あなたの答えに反応が届きました（`reaction`） | 載った答えに反応が押されたとき。1つの答えにつき1日1通まで（自分で押したものは知らせない） | `#notes` |
| あなたが答えた問いに、ほかの返事が載りました（`other_answer`） | 答えて載った問いに、あとから別の返事が載ったとき。返事1つにつき1通 | `#notes` |

守っていること:

- 死にたい・消えたい・いじめられ…などの言葉は、画面が送る前に見つけて、何より先に相談先（24時間子供SOSダイヤル・チャイルドライン）を出す。DB も同じ判定（`line-sync.sql` の `toi_line_is_sos`。`web/js/standalone.mjs` の `SOS_PATTERN` と同じことをテストが確かめる）で断り、ノートにも返事にも残さない
- 承認制のまま（返事は `approved = false` で入る）。大人と中高生を個別につながない
- 荒らし対策: ノートは1つの端末で1時間20・1日60（全体で1時間1000）、みんなに見せるは1つの端末で1日5（全体で1日200）、問いを引くのは1つの端末で1時間30。消しても数は減らない
- 今日の問いの選び方は LINE と同じ（承認済み・まだ届けていない・自分の問いと相談先が要る言葉を含む問いは除く・選んだジャンルだけ）。30日開いていない端末には届けない

| ファイル | 中身 |
|---|---|
| `supabase/app-standalone.sql` | 端末・届けた問い・ノート・知らせた記録・回数の表、ブラウザから呼ぶ関数（`app_today`・`app_draw`・`app_set_prefs`・`app_answer`・`app_share_note`・`app_my_notes`・`app_delete_note`）、毎時の `toi_app_tick`（pg_cron `toi-app-hourly`）、載った・反応・ほかの返事の引き金、送る列の種類を足す |
| `web/js/standalone.mjs` | 画面に依らない決まり（相談先の判定・送る前の確かめ・断りの文・頻度とジャンル） |
| `web/js/app.js` | `#today`・答える欄・`#notes`・ナビ |

### 本番に出す手順（順番を守る）

1. Edge Function `notify-push` を置き直す（`deliver.mjs` が新しい種類を知る。先にしないと、新しい種類が「返事が届きました」で届く）。置き方は上の手順2と同じ。**JWT の確かめは切らない**
2. SQL Editor で `supabase/app-standalone.sql` を流す（`line-sync.sql`・`web-push.sql` のあと。何度流してもよい）。
   ```sql
   select jobname, schedule from cron.job where jobname = 'toi-app-hourly';   -- 0 * * * *
   select pg_get_constraintdef(oid) from pg_constraint where conname = 'push_outbox_kind_check';  -- today などが入っている
   ```
3. このブランチを main に入れて push する（旗 `?pushtest` の端末にだけ出る）
4. 試す: 旗の端末で `#today` → 頻度とジャンルを選ぶ → 答える（「みんなに見せる」にも）→ `#notes` に出る → Table Editor で `answers`（`role_id = 'teen'`）を承認 →「あなたの答えがサイトに載りました」が届く。「死にたい」と打つと相談先が出て、`app_notes` にも `answers` にも増えない
5. 試しのデータを消す: `app_notes`・`answers`（試しの `teen`）・`app_devices`（自分の行は残してよい）

みんなに出すときは `web/js/push.mjs` の `PUSH_PUBLIC` を `true` にする（通知と同時）。

テスト: `web/tests/standalone.test.mjs`・`supabase/tests/app-standalone.test.mjs`。

## 運営の承認を毎日スマホで（2026-11-01〜）

本人「問いのスタッフ確認中が面倒だから、確認用に毎日なにか動かして承認するシステム欲しい」→ A を選んだ形。
決まった時刻に未承認の問い・返事を DB の中で下読みし、運営のスマホに「承認待ちが届いています」と知らせる。開くと `#staff` にカードが古い順に並び、見立てを見ながら「載せる／保留／載せない」を押す。**載せるのは人。自動で載る道は作っていない**（`approved` を変えられるのは運営の端末の印を確かめる `staff_decide` だけ。anon・authenticated の update は RLS で効かない。テストで確かめている）。

| できること | 中身 |
|---|---|
| 運営の端末の登録 | 端末が推測できない印（64 桁の 16 進）を作って localStorage に置き、DB はそのハッシュだけを持つ。登録は本人が SQL Editor で1行流す（ダッシュボードのログインが本人確認）。人は秘密の値を見ない・写さない |
| 下読み（外の API は使わない） | 相談先が要る言葉（`toi_line_is_sos`）・連絡先（電話・メール・URL・LINE などの ID）・学校名・住所の番地・人名（さん・くん・先生など。粗い）・同じ端末から前後30分に3件以上。どれも無ければ「気になる点なし」。判定は `toi_review_flags`（純粋な関数）と `toi_review_burst` |
| 決まった時刻の知らせ | `push_settings` の `review_times_jst`（既定 `07:30,19:30`。協力隊の勤務時間の外）に、未承認が1件以上あるときだけ運営の端末へ Push の種類 `review`。件数・本文・名前は載せない。夜21時〜朝7時に当たる時刻なら朝7時に回す。押すと `#staff` |
| `#staff` | 1枚ずつ: 問い・返事の本文、どの問いへの返事か（問いがまだ確認中ならそう出る）、立場・どこから来たか・投稿時刻、下読みの札（赤＝相談先、橙＝個人の情報らしきもの、灰＝連投、緑＝なし）。「載せる」＝ `approved = true`・`approved_at`（いまある引き金が「返事が届きました」「載りました」などを知らせる）、「保留」＝そのまま残す、「載せない」＝消さずに `rejected_at` を付けて一覧から外す（直前の1枚は「取り消す」で戻せる）。0件なら「承認待ちはありません」 |
| ヘッダーの「承認」 | 運営の端末だけに出る（件数のバッジ）。ほかの人の見た目は変わらない。運営でない端末で `#staff`（いちばん下の「運営の方へ」）を開いても、登録コードの画面しか出ない（コードは SQL Editor で登録しないと効かない） |

| ファイル | 中身 |
|---|---|
| `supabase/staff-review.sql` | `rejected_at` の列、`staff_devices`・`staff_pair_codes`・`staff_review_slots`（どれも非公開）、下読み、5分ごとの `toi_staff_tick`（pg_cron `toi-staff-review`）、本人が流す `toi_staff_pair`・`toi_staff_list`・`toi_staff_unpair`、ブラウザから呼ぶ `staff_pair_start`・`staff_status`・`staff_queue`・`staff_decide`・`staff_leave`、送る列の種類 `review` |
| `web/js/staff.mjs` | 画面に依らない決まり（印・登録コードの見せ方・札の色と言葉・1枚ずつの順番） |
| `web/js/app.js` | `#staff`・ヘッダーの「承認」 |

### 本番に出す手順（「アプリだけで答える」を含めた全体の順番）

1. Edge Function `notify-push` を置き直す（`deliver.mjs` が `today` などと `review` を知る。先にしないと新しい種類が「返事が届きました」で届く）。**JWT の確かめは切らない**
2. SQL Editor で `supabase/app-standalone.sql` を流す（まだなら。何度流してもよい）
3. SQL Editor で `supabase/staff-review.sql` を流す（`web-push.sql`・`app-standalone.sql` のあと。何度流してもよい）。
   ```sql
   select jobname, schedule from cron.job where jobname = 'toi-staff-review';   -- */5 * * * *
   select value from push_settings where key = 'review_times_jst';              -- 07:30,19:30
   select pg_get_constraintdef(oid) from pg_constraint where conname = 'push_outbox_kind_check';  -- review が入っている
   ```
4. このブランチを main に入れて push する（GitHub Pages に出る）
5. 下の「運営の端末の登録」をする

時刻を変えるとき: `update push_settings set value = '07:30,19:30' where key = 'review_times_jst';`（JST・カンマ区切り）。

### 運営の端末の登録（本人がすること）

1. 運営のスマホで、ホーム画面の「なんでポスト」のアイコンから開き、`https://nirareba0.github.io/toi-site/#staff` に行く（ホーム画面のアプリにはアドレスバーが無いので、いちばん下の「運営の方へ」から。iPhone はホーム画面のアプリと Safari が別の端末になるので、通知を受け取るほうで）。6けたの登録コード（10分有効）と、SQL Editor に貼る1行が出る
2. パソコンなどで Supabase のダッシュボードにログイン → SQL Editor で、画面に出た1行を流す: `select toi_staff_pair('123456');`（名前を付けるなら `select toi_staff_pair('123456', '本人の iPhone');`）
3. スマホの画面がひとりでに「承認待ち」に切り替わる。上に「この端末に『承認待ち』の知らせを届ける」と出ていたら押して、通知を受け取る（`#notify`）
4. 確かめ: `select * from toi_staff_list();`（`gets_notice` が true なら知らせが届く）

外すとき: `select * from toi_staff_list();` で番号を見て `select toi_staff_unpair('<番号>');`（全部なら `'all'`）。スマホの `#staff` の「この端末について」からも外せる。運営の端末は10台まで。

確かめ方（本番）: 登録した端末で未承認の問いがある状態にして、`select toi_staff_tick(now());` を時刻の1時間のうちに流す（その時刻の回がまだなら、運営の端末へ `review` が入る）。または `insert into push_outbox (endpoint, kind) select endpoint, 'review' from push_subscriptions where client_hash in (select client_hash from staff_devices);` で数秒で届く。

テスト: `web/tests/staff.test.mjs`・`supabase/tests/staff-review.test.mjs`。
