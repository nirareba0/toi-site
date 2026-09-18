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
