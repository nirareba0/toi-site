// Supabase の接続先。**anon key は公開してよい鍵**（ブラウザに配られる前提の鍵で、
// 実際のアクセス制御は RLS と列単位の GRANT が行う）。だから Git に入れてよい。
// 秘密にすべきなのは service_role key と DB パスワードで、そちらはここに書かない
// （DB パスワードは macOS キーチェーン `supabase-toi-site-db`）。
export const SUPABASE_URL = "https://btbykfnlsxwmpfcfslxb.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ0YnlrZm5sc3h3bXBmY2ZzbHhiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MTQ0NDAsImV4cCI6MjEwNTI5MDQ0MH0.Fe85o6eT_h6-kq-DvNKe4lN3QJY9YbvMXZ9j9El9CMQ";
