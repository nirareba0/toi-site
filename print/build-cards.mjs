// 問いカードの組版。文字数で級数を決めず、ブラウザで実測して収まる最大の級数にする。
//   node print/build-cards.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cards = JSON.parse(readFileSync(resolve(here, "cards.json"), "utf8"));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const PAL = ["#fff184", "#ffd9e4", "#cfe6ff", "#fff6e8", "#e6f4e8", "#ffe9c9"];
const LEADS = ["まじめに考えてみない？", "ちょっと考えてみない？", "答えを出さなくていいから、考えてみない？"];
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
  @page { size: A4; margin: 0; }
  html,body{margin:0;background:#fff}
  body{font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN",sans-serif;-webkit-font-smoothing:antialiased;color:#203047}
  .sheet{width:210mm;height:297mm;box-sizing:border-box;display:grid;
         grid-template-columns:90mm 90mm;grid-template-rows:90mm 90mm 90mm;
         justify-content:center;align-content:center}
  .card{position:relative;width:90mm;height:90mm;box-sizing:border-box;padding:10mm 9mm 8mm;
        background:var(--bg);display:flex;flex-direction:column;outline:.2mm dashed #c2c2c2}
  .lead{font-size:9.5pt;font-weight:700;color:#244fc7;letter-spacing:.02em;line-height:1.5}
  /* 問い: 収まる最大の級数を実測で決める。行頭に句読点や閉じ括弧を送らない */
  .qwrap{height:46mm;display:flex;align-items:center;overflow:hidden}
  /* BudouX が入れた <wbr> の位置だけで折る。単語の途中では折らない */
  .q{margin:0;font-weight:800;line-height:1.55;letter-spacing:.005em;
     line-break:strict;word-break:keep-all;overflow-wrap:break-word;text-wrap:pretty}
  .foot{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:4mm;padding-bottom:4mm}
  .meta{font-size:7pt;line-height:1.7;color:#4a5b71}
  .meta .ans{display:block;margin-top:.8mm;color:#6b7c93}
  .qrbox{flex:none;background:#fff;padding:2mm;border-radius:1.5mm}
  .qr{width:20mm;height:20mm;display:block}
  .brand{position:absolute;left:9mm;bottom:4mm;font-size:6.5pt;color:#6b7c93;letter-spacing:.04em}
`;

const cardHtml = (c, i, size, html) => `
  <div class="card" style="--bg:${PAL[i % PAL.length]}">
    <div class="lead">${LEADS[i % LEADS.length]}</div>
    <div class="qwrap"><p class="q" data-i="${i}" style="font-size:${size ?? 20}pt">${html ?? esc(c.body)}</p></div>
    <div class="foot">
      <div class="meta">${c.credit ? `問い：${esc(c.credit)}` : "Miacis の問いコーナーに届いた問い"}<span class="ans">${c.answers ? `${c.answers} 人の大人が答えています` : "まだ誰も答えていません"}</span></div>
      <div class="qrbox"><img class="qr" src="${c.qr}" alt="この問いのページの QR"></div>
    </div>
    <div class="brand">Miacis 問いコーナー ／ 韮崎市</div>
  </div>`;

const doc = (sizes, htmls) => {
  const sheets = [];
  for (let i = 0; i < cards.length; i += 6) {
    sheets.push(`<div class="sheet">${cards.slice(i, i + 6).map((c, j) => cardHtml(c, i + j, sizes?.[i + j], htmls?.[i + j])).join("")}</div>`);
  }
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>問いコーナー スクエアカード</title><style>${CSS}</style></head><body>${sheets.join("")}</body></html>`;
};

// 1回目: 実測して各カードの最大級数を決める
const probe = doc().replace("</body>", `
<script src="vendor/budoux-ja.min.js"></script>
<script>
  window.addEventListener("load", () => {
    // BudouX のカスタム要素に通し、文節の切れ目にだけ <wbr> を入れた HTML を取り出す
    document.querySelectorAll(".q").forEach(q => {
      const el = document.createElement("budoux-ja");
      el.textContent = q.textContent;
      document.body.appendChild(el);
      q.innerHTML = el.innerHTML;
      el.remove();
    });
    const out = [];
    document.querySelectorAll(".q").forEach(q => {
      const box = q.parentElement;
      const fits = () => q.getBoundingClientRect().height <= box.clientHeight + 0.5;
      let size = 22;
      q.style.fontSize = size + "pt";
      while (size > 11 && !fits()) { size -= 0.5; q.style.fontSize = size + "pt"; }
      out[+q.dataset.i] = { size, html: q.innerHTML };
    });
    document.title = JSON.stringify(out);
  });
</script></body>`);
writeFileSync(resolve(here, "__probe.html"), probe);
const dom = execFileSync(CHROME, ["--headless", "--disable-gpu", "--virtual-time-budget=6000", "--dump-dom",
  `file://${resolve(here, "__probe.html")}`], { encoding: "utf8", maxBuffer: 1 << 26 });
const measured = JSON.parse(dom.match(/<title>(\[.*\])<\/title>/s)[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
const sizes = measured.map(m => m.size);
const htmls = measured.map(m => m.html);

writeFileSync(resolve(here, "cards.html"), doc(sizes, htmls));
execFileSync("rm", ["-f", resolve(here, "__probe.html")]);
console.log("級数:", sizes.map((s, i) => `${i + 1}:${s}pt`).join(" "));
