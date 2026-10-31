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
| 新しい問いが届きました（`question`） | 1日1回まで・19時ごろ。前の回から新しく載った問いがあるときだけ（受け取らない設定もできる） |

夜21時〜朝7時に出た知らせは朝7時に送る。時刻は `push_settings` の `question_hour_jst`・`quiet_from_jst`・`quiet_until_jst`。

| ファイル | 中身 |
|---|---|
| `web/site.webmanifest`・`web/sw.js` | ホーム画面に置く（アイコン 180/192/512 は `web/assets/`）。sw.js は通知を出し、画面のファイルだけを手元に置く（いつも通信を先に・問いと返事は持たない） |
| `web/js/push.mjs`・`web/assets/tut-*.svg` | 「スマホに知らせてもらう」（`#notify`）: 機種ごとの3枚の手順・通知を受け取る／やめる・iPhone の引き継ぎの番号 |
| `supabase/web-push.sql` | 購読・送る列・引き金（返事の承認・新しい問い）・pg_net で関数を呼ぶ・毎時の pg_cron・引き継ぎの番号 |
| `supabase/functions/notify-push/` | Edge Function。鍵（VAPID）を最初に動いたときに作って Vault に置き、web-push で送る |

iPhone はホーム画面のアプリと Safari で保存場所が分かれる。Safari で出した問いは、Safari の `#notify` で出す8けたの番号（15分）をアプリで入れて引き継ぐ。

**試しの旗**: `?pushtest` を付けて開いた端末にだけ、通知の操作（受付画面・自分への返事・フッターのリンク）が出る。旗の端末では manifest が `site-pushtest.webmanifest`（`start_url` が `./?pushtest`）に替わり、ホーム画面のアイコンからも旗つきで開く。
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
