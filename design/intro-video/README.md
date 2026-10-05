# 導入動画（15秒・1920×1080）

問いコーナーの入口に置く短い動画。中高生向けに、サイトの「なぜ問うの？」（`web/js/app.js` の renderWhy）を
15秒にした。音は無い。canvas 1枚の `reel.html` が正本で、MP4 はそこから書き出す。

| 秒 | 場面 |
|---|---|
| 0–2.2 | 「？」が落ちてくる →「それ、ほんとうに 知ってる？」 |
| 2.2–4.0 | 年号が紀元前400年ごろまで巻き戻る → ソクラテス |
| 4.0–6.6 | お告げ「ソクラテスより賢い者はいない」→「知らないことを、知っている。」（＝不知の自覚） |
| 6.6–9.3 | 「わからない」って言えたら、考えはじめた合図だ！ |
| 9.3–12.4 | 問いの紙と大人の返事 →「見え方が、ふえる。」 |
| 12.4–15 | マーク →「Miacis 問いコーナー」「問いは、世界の見方をふやす。」「きみの「？」、書きにきて。」 |

問いの紙に書いた問いは、館内の付箋（「幸せな家庭ってなに？」「人は1人では生きていけないの？」）と
「なぜ問うの？」の例（「幸せってなに？」「ふつうってなんだろう？」）のほかは、例として置いた文。

## 書き出す

字体は Git に入れない（約10MB）。初回だけ `fonts/` に取る（どちらも OFL。ライセンス文は `fonts/` にある）:

    cd design/intro-video/fonts
    curl -LO https://github.com/google/fonts/raw/main/ofl/zenmarugothic/ZenMaruGothic-Black.ttf
    curl -LO https://github.com/google/fonts/raw/main/ofl/zenmarugothic/ZenMaruGothic-Bold.ttf
    curl -LO https://github.com/google/fonts/raw/main/ofl/delagothicone/DelaGothicOne-Regular.ttf

書き出しは `C:\code\showreel-bench\render.mjs`（仮想時計で1コマずつ撮る）を使う:

    node C:/code/showreel-bench/render.mjs reel.html out/toi-intro.mp4 --duration 15

`out/` は Git に入れない。書き出した MP4 の置き場は個人 Drive の `AIOS/assets/toi-site/intro-video/`。
1コマだけ見るときは `reel.html?t=7.5` をブラウザで開く。
