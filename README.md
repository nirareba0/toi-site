# toi-site — 問う応える（Miacis 問いコーナー）

中高生が問いを投函し、大人が返事を書く。韮崎のユースセンター Miacis の紙の「問いコーナー」を Web に広げるサイト。
**文書・要件・決定の正本は `~/AIOS/core/projects/toi-site/`。** ここはコードだけ。

| フォルダ | 中身 |
|---|---|
| `web/` | 静的フロントエンド（HTML / CSS / JS。ビルド無し）。Supabase を直接呼ぶ |
| `supabase/` | スキーマ・RLS・シード（`schema.sql`）。`npx supabase` で適用 |
| `gas/` | 既存の Google Apps Script デプロイ（配布済み QR の飛び先）を新サイトへ転送するスタブ |

素材（スキャン・カード画像・写真）は Git に入れない。個人 Drive `AIOS/assets/toi-site/`。
