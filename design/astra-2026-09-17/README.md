# Miacis 問いコーナー — Astra design prototype

> `assets/sticky-wall.jpg`（実物の付箋写真）は中高生の手書きのため Git に入れていない。
> 新しく clone したときは個人 Drive `AIOS/assets/toi-site/design-web/sticky-wall.jpg` から置く。


2026-09-17 / One direction, designed and implemented from scratch.

## 設計

「ここに置いていく、小さな手紙」。館内QRから来た中高生が、誰かの問いと複数の大人の返事をすぐ読め、その隣で自分の問いを書ける場所。

Miacisロゴの深緑 `#155F3C`・桃色 `#F6CBD5`、実物付箋の黄 `#FFF184`、紙 `#FFFEFA`、部屋の地色 `#EEF1E9`、文字 `#243B30` の6色。ゴシックの読みやすい本文と、詰めすぎない見出しを同一ファミリーで統一。Hiragino Kaku Gothic ProN / Yu Gothic / Meiryo / sans-serif、外部フォントなし。

ホームは深緑の場所に、問いの黄色い紙とふたりの返信を重ねる。単なる飾りでなく「一問に複数の視点」という価値を最初に示す。その下は余白を持った行形式の問い一覧。画面全体を同じカードに分割しない。紙の質感を写真加工で偽装せず、Miacisロゴと実物付箋の写真を文脈のある場所に置く。

投稿は一枚の筆記用紙。記入→確認→完了の3段階で、確認から戻っても本文・テーマ・同意を保持。名前やアカウント入力を求めない。スマートフォンでは常設の下部ナビから読む・書く・返事を確認に入れる。

動きは紙を選ぶhover 220ms、ボタン押下150ms、投稿完了時の到着400ms。自動ループ、入場時の大量reveal、装飾パララックスなし。reduced-motionではすべてのanimationとtransitionを停止し、内容は常時表示。

## 動かす

このディレクトリで `python3 -m http.server 8769 --bind 127.0.0.1`。ブラウザで `http://127.0.0.1:8769/` を開く。

- `#home`: 問い一覧・テーマ絞り込み。
- `#ask`: 投稿。確認後「この問いを置く（デモ）」でタブ内メモリに追加。
- `#check`: 自分の問いと返事の確認。ここから自分の問いへの大人の返信操作も試せる。
- `#question/q1`: 問い詳細、複数の返事。
- `#reply/q1`: 大人の返信。確認→完了→問い詳細に表示。
- `#ask/confirm` / `#reply/q1/confirm`: 確認段階をブラウザ履歴にも記録。URLに本文や個人情報は含めない。ブラウザの戻る・進むで入力内容を保ったまま段階を移動できる。空ドラフトで確認URLを直接開いた場合や送信後に確認へ戻った場合は、記入画面に戻す。
- `#about`: Miacis、紙の問いコーナー、書くときの約束。

フォームID: `ask-form`, `question-body`, `question-topic`, `question-consent`, `reply-form`, `reply-body`, `reply-role`, `reply-consent`。確認送信は `data-action="submit-question"` / `data-action="submit-reply"`。本文 `main#main`、各画面 `h1#page-title`。

## デモの境界

ネットワーク送信・Cookie・localStorage・sessionStorage・認証・本番接続なし。問いと返事はタブ内メモリのみ、再読み込みで消える。投稿や返信の完了表示にもこの境界を明示。本番の受取リンク、モデレーション、回答者認証は未実装。質問・返信例文は新しく作成した架空の例で、実在の投稿者や大人の発言ではない。

素材はユーザーの許可済み原画像をコピー。`assets/miacis.png` はMiacis宣材写真フォルダ、`assets/sticky-wall.jpg` はDrive AIOS/assets/toi-site/design-web。ロゴ加工なし。実物付箋の写真は架空の操作データとは区別して由来を明記。顔写真・回答者署名画像なし。

ユーザー入力はHTMLエスケープして描画。空白のみ・文字数・必須同意を検査。未知のhashと消えたデモIDは回復導線を表示。キーボードフォーカス可視、画面変更はh1へ移動、フィルタはフォーカス保持してaria-live通知。親エージェントによる実ブラウザ検証と第三者レビューを実施予定。
