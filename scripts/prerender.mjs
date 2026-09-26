// 検索エンジン向けに、承認済みの問いと返事から静的ページを書き出す。
//   node scripts/prerender.mjs   →  web/q/index.html, web/q/<id>/index.html, web/sitemap.xml
//
// サイト本体はハッシュルーティング（#question/<id>）なので、検索エンジンからは問いごとのページが見えない。
// GitHub Pages に公開する直前（pages.yml）にだけ実行し、生成物は Git に入れない（.gitignore）。
// 読むのは匿名に公開しているビューだけ（public_questions / public_answers）。
// 問いのニックネームは中高生の投稿なので、検索に載るページには出さない。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../web/js/config.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = join(ROOT, 'web')
const SITE = 'https://nirareba0.github.io/toi-site/'
const SITE_NAME = 'Miacis（ミアキス）問いコーナー'
const OG_IMAGE = SITE + 'assets/toi-corner-miacis.jpg'

// 問いを扱ったラジオの回（YouTube）。問いの id → 回
const radioFile = join(ROOT, 'scripts', 'radio-episodes.json')
const radio = existsSync(radioFile) ? JSON.parse(readFileSync(radioFile, 'utf8')) : {}

async function get(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`)
  return r.json()
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s, n) => { const t = oneLine(s); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const paras = s => String(s ?? '').trim().split(/\n+/).map(p => `<p>${esc(p)}</p>`).join('\n')
const ymd = s => String(s ?? '').slice(0, 10)
// JSON-LD を <script> に埋めるとき、</script> で抜けられないようにする
const ld = obj => JSON.stringify(obj).replace(/</g, '\\u003c')

function page({ path, title, description, body, jsonld }) {
  const url = SITE + path
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="${esc(SITE_NAME)}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${OG_IMAGE}">
  <meta property="og:locale" content="ja_JP">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#244fc7">
  <link rel="icon" href="${SITE}assets/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${SITE}style.css">
  <style>
    .static-wrap{max-width:720px;margin:0 auto;padding:24px 16px 64px}
    .static-wrap h1{font-size:1.5rem;line-height:1.5;margin:.5rem 0 1rem}
    .static-meta{color:#5b6475;font-size:.9rem}
    .static-answer{border-left:4px solid #244fc7;padding:.25rem 0 .25rem 1rem;margin:1.5rem 0}
    .static-answer h2{font-size:1rem;margin:0 0 .5rem}
    .static-list{list-style:none;padding:0}
    .static-list li{padding:.75rem 0;border-bottom:1px solid #e3e6ee}
    .static-actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:2rem 0}
  </style>
${jsonld ? `  <script type="application/ld+json">${ld(jsonld)}</script>\n` : ''}</head>
<body>
  <header class="app-header">
    <div class="header-container">
      <a href="${SITE}" class="brand-link"><img class="brand-motif-icon" src="${SITE}assets/mark.svg" alt="" width="26" height="22"><span class="brand-title">Miacis 問いコーナー</span></a>
    </div>
  </header>
  <main class="static-wrap">
${body}
  </main>
  <footer class="app-footer">
    <div class="footer-container">
      <div class="footer-meta">
        <p class="footer-facility">山梨県韮崎市 青少年育成プラザ Miacis（ミアキス）問いコーナー</p>
        <p class="footer-sub">中高生が問いを書き、スタッフや地域の大人が返事を書く。館内の紙の問いコーナーと、このサイトは同じ問いコーナーです。</p>
      </div>
      <div class="footer-links">
        <a href="${SITE}q/" class="footer-link">問いの一覧</a>
        <a href="${SITE}#about" class="footer-link">この場所について</a>
        <a href="${SITE}#ask" class="footer-link">問いを書く</a>
      </div>
    </div>
  </footer>
</body>
</html>
`
}

const questions = await get('public_questions?select=id,body,theme_label,credit,created_at,answer_count&order=created_at.desc&limit=2000')
const answers = await get('public_answers?select=question_id,body,responder_role,ai_assisted,created_at&order=created_at.asc&limit=5000')
const byQ = new Map()
for (const a of answers) (byQ.get(a.question_id) ?? byQ.set(a.question_id, []).get(a.question_id)).push(a)

mkdirSync(join(WEB, 'q'), { recursive: true })

for (const q of questions) {
  const as = byQ.get(q.id) ?? []
  const title = `${clip(q.body, 40)}｜${SITE_NAME}`
  const description = as.length
    ? `韮崎市の中高生の居場所 Miacis（ミアキス）の問いコーナーに届いた問い「${clip(q.body, 40)}」と、大人からの返事${as.length}件。`
    : `韮崎市の中高生の居場所 Miacis（ミアキス）の問いコーナーに届いた問い「${clip(q.body, 60)}」。返事を書いてくれる大人を募集しています。`
  const ep = radio[q.id]
  const body = `    <p class="static-meta">${esc(q.theme_label || '問い')}・${esc(ymd(q.created_at))}${q.credit ? '・ポッドキャストからお借りした問い' : ''}</p>
    <h1>${esc(oneLine(q.body))}</h1>
${as.length ? as.map(a => `    <section class="static-answer">
      <h2>${esc(a.responder_role)}からの返事${a.ai_assisted ? '（AI と一緒に考えた返事）' : ''}</h2>
      ${paras(a.body)}
    </section>`).join('\n') : '    <p>まだ返事はありません。</p>'}
${ep ? `    <p>この問いは、ラジオ「ミアキスの問いコーナー」でも取り上げました：<a href="${esc(ep.url)}">${esc(ep.title)}</a></p>\n` : ''}    <div class="static-actions">
      <a class="btn btn-primary" href="${SITE}#question/${esc(q.id)}">問いコーナーでこの問いを見る</a>
      <a class="btn btn-secondary" href="${SITE}#ask">自分も問いを書く</a>
      <a class="btn btn-secondary" href="${SITE}q/">ほかの問いを見る</a>
    </div>`
  const jsonld = as.length ? {
    '@context': 'https://schema.org',
    '@type': 'QAPage',
    mainEntity: {
      '@type': 'Question',
      name: clip(q.body, 110),
      text: oneLine(q.body),
      answerCount: as.length,
      dateCreated: q.created_at,
      author: { '@type': 'Person', name: '中高生' },
      suggestedAnswer: as.map(a => ({
        '@type': 'Answer',
        text: oneLine(a.body),
        dateCreated: a.created_at,
        url: `${SITE}q/${q.id}/`,
        author: { '@type': 'Person', name: a.responder_role },
      })),
    },
  } : null
  mkdirSync(join(WEB, 'q', q.id), { recursive: true })
  writeFileSync(join(WEB, 'q', q.id, 'index.html'), page({ path: `q/${q.id}/`, title, description, body, jsonld }))
}

// 一覧（テーマごと）
const themes = new Map()
for (const q of questions) (themes.get(q.theme_label || 'そのほか') ?? themes.set(q.theme_label || 'そのほか', []).get(q.theme_label || 'そのほか')).push(q)
const listBody = `    <h1>問いの一覧</h1>
    <p>山梨県韮崎市の中高生の居場所 Miacis（ミアキス）の問いコーナーに届いた問いです。中高生が紙やこのサイトに問いを書き、スタッフや大学生、地域の大人が返事を書いています。いまは${questions.length}件の問いが読めます。</p>
    <p><a class="btn btn-primary" href="${SITE}#ask">問いを書く</a></p>
${[...themes].map(([t, qs]) => `    <h2>${esc(t)}（${qs.length}）</h2>
    <ul class="static-list">
${qs.map(q => `      <li><a href="${SITE}q/${esc(q.id)}/">${esc(clip(q.body, 80))}</a> <span class="static-meta">返事${q.answer_count || 0}件</span></li>`).join('\n')}
    </ul>`).join('\n')}`
writeFileSync(join(WEB, 'q', 'index.html'), page({
  path: 'q/',
  title: `問いの一覧｜${SITE_NAME}`,
  description: `韮崎市の中高生の居場所 Miacis（ミアキス）の問いコーナーに届いた問い${questions.length}件と、大人からの返事。`,
  body: listBody,
  jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: `問いの一覧｜${SITE_NAME}`, url: `${SITE}q/` },
}))

// sitemap
const latest = questions.reduce((m, q) => (q.created_at > m ? q.created_at : m), '')
const urls = [
  { loc: SITE, lastmod: ymd(latest) },
  { loc: `${SITE}q/`, lastmod: ymd(latest) },
  ...questions.map(q => {
    const last = (byQ.get(q.id) ?? []).reduce((m, a) => (a.created_at > m ? a.created_at : m), q.created_at)
    return { loc: `${SITE}q/${q.id}/`, lastmod: ymd(last) }
  }),
]
writeFileSync(join(WEB, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`)

console.log(`問い ${questions.length} 件（返事あり ${questions.filter(q => byQ.has(q.id)).length} 件）、sitemap ${urls.length} URL`)
