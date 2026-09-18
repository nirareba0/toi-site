# 館内チラシ（A4）

`flyer.html` が原本。PDF は Chrome で書き出す（ビルドツール無し）。

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --no-pdf-header-footer --print-to-pdf=flyer.pdf "file://$PWD/flyer.html"
```

- `qr-site.svg` / `qr-site.png` — サイト https://nirareba0.github.io/toi-site/ の QR（誤り訂正 H）。`python3 -c "import segno; ..."` で生成
- `miacis-logo.png` — `web/assets/` と同じもの
- `fonts/IBMPlexMono-Regular.ttf` — URL とアカウント名にだけ使う欧文（OFL）。和文は Hiragino Sans（macOS 標準）

## 設計の要点

- 見出しはサイトと同じ「問いは、世界の見方をふやす。」。館内ボードのポスターの言葉「モヤモヤや疑問、なんでも問いてね。」を添えて、紙とサイトが同じ場所だと分かるようにした
- 中央は掲示板の見立て。付箋の色は実物の付箋（黄・桃・水色）から。載せている問いと返事は**サイトで公開済みの実物**（創作ではない）
- 印刷ではぼかし影が頼れないので、影は使わず薄い縁だけ
- QR は 46mm。A4 では 1 つだけにして迷わせない。Instagram は文字で
- 色はサイトのトークン（`web/style.css`）に合わせる。Miacis の深緑はロゴにだけ

## スクエアカード（A4 に 6 枚）

`cards.html` → `cards.pdf`。90mm 角のカードを 2×3 で 2 シート、計 12 枚。破線で切って各所に貼る想定。

- **QR はカードごとに、その問いの詳細ページへ直接飛ぶ**（`#question/<id>`）。読んだ人がその場で
  大人の返事を読めるので、「考えてみない？」から「他の人はこう考えた」までが一息でつながる
- 載せる問いと配色は `cards.json` で決まる。生成し直すときは `print/qr/` の QR も作り直す
- 地色は実物の付箋の色から。QR は白地に載せる（地色の上だと読み取りが落ちる）
- 問いの半分は館内に届いた実物、半分は
  **永井玲衣×長井優希乃『Wナガイと哲学対話』（J-WAVE）のエピソードタイトルからお借りしたもの**。
  カード上でもサイト上でも出典を明記する
