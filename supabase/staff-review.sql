-- 運営の承認を、毎日スマホでさばけるようにする（2026-11-01 本人「問いのスタッフ確認中が面倒だから、確認用に毎日なにか動かして承認するシステム欲しい」→ A を選んだ）
-- 決まった時刻に未承認の問い・返事を下読みし、運営の端末に「承認待ちが届いています」と知らせる。
-- 開くとカードが並び、下読みの見立てつきで「載せる／保留／載せない」を押すだけ。**載せるのは人。自動では載せない。**
--
-- 流す順: schema.sql → line-notify.sql → line-sync.sql → web-push.sql → app-standalone.sql → このファイル。
-- 何度流しても同じ結果になる。秘密の値は持たない（運営の端末の印は、端末が作った乱数のハッシュだけを持つ）。
--
-- 運営の端末の登録（人は秘密を扱わない）:
--   1. 運営のスマホでアプリの #staff を開く → 端末が推測できない印（64 桁の 16 進）を作って手元に置き、DB に6けたの登録コード（10分）をもらう
--   2. 本人が Supabase の SQL Editor（ダッシュボードのログインが本人確認）で  select toi_staff_pair('123456');  を流す
--   3. その端末が運営の端末になる（DB には印のハッシュだけ）。運営用の関数（staff_*）は毎回その印を確かめる
--   外すとき: select * from toi_staff_list();  →  select toi_staff_unpair('<番号>');（'all' で全部）。端末の画面からも外せる
--
-- 下読み（DB の中だけ。外の API キーは使わない。判定は粗い。決めるのは人）:
--   sos      相談先が要る言葉（line-sync.sql の toi_line_is_sos と同じ判定）
--   contact  電話番号・メール・URL・LINE などの ID らしきもの
--   school   学校名らしきもの（〇〇中学校・〇〇高校・〇〇中2年 など）
--   address  住所の番地らしきもの（〇丁目・〇番地・若宮1-2-3・〇〇町〇〇123 など）
--   name     人名らしきもの（〇〇さん・〇〇くん・〇〇先生 など。家族や店員などのよくある呼び方は外す）
--   burst    同じ端末から短い時間に続けて（前後30分に3件以上）
--   どれも無ければ「気になる点なし」。
--
-- 知らせ（Web Push の種類 review。中身は種類だけ。件数・本文・名前は載せない）:
--   push_settings の review_times_jst（既定 07:30,19:30）に、未承認が1件以上あるときだけ、運営の端末へ。
--   夜（quiet_from_jst〜quiet_until_jst）に当たる時刻なら、朝に回す（web-push.sql の toi_push_send_after）。押すと #staff が開く。

create extension if not exists pg_cron;

-- 先に流しておくもの（無ければ止める）
do $$ begin
  if to_regprocedure('public.toi_line_is_sos(text)') is null then
    raise exception 'line-sync.sql を先に流してください（相談先が要る言葉の判定 toi_line_is_sos を共有します）';
  end if;
  if to_regclass('public.push_subscriptions') is null then
    raise exception 'web-push.sql を先に流してください';
  end if;
  if to_regclass('public.app_devices') is null then
    raise exception 'app-standalone.sql を先に流してください';
  end if;
end $$;

-- ---------------------------------------------------------------- 設定・列

insert into push_settings (key, value) values
  ('review_times_jst', '07:30,19:30')   -- 運営に「承認待ち」を知らせる時刻（JST・カンマ区切り）。協力隊の勤務時間の外
on conflict (key) do nothing;

-- 「載せない」の印（消さずに残し、一覧から外す）。載せたら外す
alter table questions add column if not exists rejected_at timestamptz;
alter table answers   add column if not exists rejected_at timestamptz;
-- ブラウザ（anon）には渡さない（schema.sql の列の権限は列ごとに渡しているので、足した列は読めない）

create index if not exists questions_review_idx on questions (created_at) where not approved and rejected_at is null;
create index if not exists answers_review_idx   on answers (created_at)   where not approved and rejected_at is null;
create index if not exists questions_hash_idx   on questions (client_hash, created_at);
create index if not exists answers_hash_idx     on answers (client_hash, created_at);

-- 送る列に運営の知らせを足す（app-standalone.sql と同じ並び。どちらを流し直しても review は残る）
alter table push_outbox drop constraint if exists push_outbox_kind_check;
alter table push_outbox add constraint push_outbox_kind_check
  check (kind in ('reply', 'question', 'today', 'published', 'reaction', 'other_answer', 'review'));

-- ---------------------------------------------------------------- 表（どれも非公開。ブラウザからは関数経由でだけ触る）

-- 運営の端末。印（token）はハッシュだけ。client_hash は通知の宛先を見つけるため（push_subscriptions と同じ印）
create table if not exists staff_devices (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  client_hash  text check (client_hash is null or toi_push_hash_ok(client_hash)),
  label        text check (char_length(label) <= 40),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- 登録コード（コードもハッシュだけ）。1つの印に1つ。10分で切れる
create table if not exists staff_pair_codes (
  code_hash   text primary key,
  token_hash  text not null unique,
  client_hash text,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- 知らせた時刻（同じ時刻に二度知らせない）
create table if not exists staff_review_slots (
  slot       timestamptz primary key,
  pending    int not null,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['staff_devices', 'staff_pair_codes', 'staff_review_slots'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- 下読み（純粋な関数。外へ通信しない）

-- 全角を半角に、いろいろな横棒を「-」に、英字を小文字に（連絡先・番地を見るため）
create or replace function toi_review_ascii(p_text text) returns text
language sql immutable as $$
  select lower(translate(normalize(coalesce(p_text, ''), NFKC), 'ー―‐−–—', '------'));
$$;

-- 文の中の気になる点（sos・contact・school・address・name の順）。無ければ空の配列
create or replace function toi_review_flags(p_text text) returns text[]
language plpgsql immutable as $$
declare
  t  text := normalize(coalesce(p_text, ''), NFKC);   -- 学校名・人名を見る（カタカナの長音を残す）
  a  text := toi_review_ascii(p_text);                -- 連絡先・番地を見る
  digits text;
  m  text[];
  pre text;
  out text[] := '{}';
  -- 学校名の前に付いても、学校を特定しない言葉（取り除いて何も残らなければ学校名ではない）
  school_stop constant text := '(私立|公立|県立|市立|町立|村立|国立|都立|府立|道立|区立|第一志望|第二志望|志望|地元|進学|底辺|名門|強豪|共学|男子|女子|全日制|定時制|通信制|単位制|夜間|附属|付属|併設|現役|中高一貫|中高|小中|一貫|普通|一般|有名|人気|偏差値|受験|入学|卒業|転校|近所|隣|同|別|他|元|新|各|全|某|今|現在|今年|来年|去年|昨年|将来|春から|私|僕|俺|自分|妹|弟|兄|姉|娘|息子|友達|友人|彼氏|彼女)+$';
  -- 単独の「中・高・小」の前に付くと、学校ではない言葉（最高・途中・勉強中 など）
  single_stop constant text := '(最|途|夢|背|日|年|集|熱|心|空|水|地|車|文|手|意|渦|喪|勉強|授業|練習|部活|仕事|準備|試験|休憩|移動|食事|入院|会議|電話|運転|残|円|割|縮|極|大|中|小|高)$';
  -- 「さん・くん・先生」の前に付いても、人の名前ではない呼び方
  name_stop constant text := '(母|父|兄|姉|弟|妹|婆|爺|赤|皆|子|客|店員|店長|医者|大家|神|仏|王|姫|彼|彼女|友達|友|先輩|後輩|担任|校長|教頭|保健|塾|顧問|部長|社長|上司|同僚|駅員|運転手|警察|看護師|隣|近所|大人|生徒|学生|職員|講師|作者|作家|主人|奥|嫁|旦那|親|家族|孫|息子|娘|坊|和尚|住職|屋|犬|猫|英語|数学|国語|理科|社会|音楽|体育|美術|家庭科|技術|書道|担当|新任|女|男|諸|暴|誰|何|各|ママ|パパ|サンタ|ネコ|イヌ)$';
  hira_stop constant text := '^(お?ばあ|お?じい|お?にい|お?ねえ|お?かあ|お?とう|あか|みな|ねこ|いぬ|わんこ)$';
begin
  if t = '' then return out; end if;

  -- 相談先が要る言葉（line-sync.sql と同じ判定）
  if toi_line_is_sos(t) or toi_line_is_sos(p_text) then out := array_append(out, 'sos'); end if;

  -- 連絡先: 電話（区切りを抜いて 0 から始まる 10〜11 けた、+81）・メール・URL・LINE などの ID・@ハンドル
  digits := regexp_replace(a, '[-\s().]', '', 'g');
  if digits ~ '(^|[^0-9])(0[0-9]{9,10}|\+81[0-9]{9,10})([^0-9]|$)'
     or a ~ '[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+'
     or a ~ '(https?://|www\.)'
     or a ~ '[a-z0-9-]+\.(com|net|org|jp|io|me|ly|app|link|gl|be|to|co|ee|info|biz|xyz)([^a-z0-9]|$)'
     or a ~ '(line|ライン|らいん|インスタ|いんすた|instagram|insta|twitter|ツイッター|tiktok|ティックトック|discord|ディスコ|kakao|カカオ|snapchat)[^。\n]{0,8}(id|アイディ|あいでぃ|アカ|垢|交換|追加|フォロー|ふぉろー|dm|@)'
     or a ~ '(^|[^a-z0-9._%+-])@[a-z0-9._]{3,30}'
     or a ~ '(^|[^a-z])id(\s*[:は=]\s*|\s+)@?[a-z0-9._-]{4,}' then
    out := array_append(out, 'contact');
  end if;

  -- 学校名: 〇〇中学校・〇〇高校 など（前の言葉が「県立」「志望」などだけなら外す）、〇〇中2年・〇〇高生 など
  for m in select regexp_matches(t, '([一-龥々ァ-ヶー]{1,10})(中等教育学校|特別支援学校|高等学校|中学校|小学校|高校|中学|小学|高専)', 'g') loop
    pre := regexp_replace(m[1], school_stop, '');
    if pre <> '' then out := array_append(out, 'school'); exit; end if;
  end loop;
  if not ('school' = any(out)) then
    for m in select regexp_matches(t, '([一-龥々]{2,4})(中|高|小)(生|の?[0-9一二三四五六]年)', 'g') loop
      if m[1] !~ single_stop and regexp_replace(m[1], school_stop, '') <> '' then out := array_append(out, 'school'); exit; end if;
    end loop;
  end if;

  -- 住所の番地: 〇丁目・〇番地・〇番〇号・若宮1-2-3・〇〇町〇〇123
  if a ~ '[0-9一二三四五六七八九十]+丁目'
     or a ~ '[0-9]+番地'
     or a ~ '[0-9]+番[0-9]+'
     or a ~ '[一-龥々ァ-ヶ][1-9][0-9]{0,3}-[0-9]{1,4}-[0-9]{1,4}([^0-9-]|$)'
     or a ~ '(市|町|村|区)[一-龥々ァ-ヶ]{1,8}[0-9]{1,5}(番|号|[^0-9年月日時分秒週歳才人名回個円点位%度階組校件本枚台冊曲話歩]|$)' then
    out := array_append(out, 'address');
  end if;

  -- 人名: 漢字・カタカナ・英字（2文字以上）＋さん・くん・君・ちゃん・先生。ひらがなの名前＋ちゃん・くん
  for m in select regexp_matches(t, '([一-龥々ァ-ヶーA-Za-z]{1,6})(さん|くん|君|ちゃん(?!と(し|す|せ|さ|や|で|言|話|見|聞|考|勉|寝|食|起|書|読|守|答|伝|分|わか|でき|向|休|片|払|返|謝|お|[、。!?\s]|$))|先生|せんせい|センセイ)', 'g') loop
    if m[1] !~ '^[A-Za-z]$' and m[1] !~ name_stop then out := array_append(out, 'name'); exit; end if;
  end loop;
  if not ('name' = any(out)) then
    for m in select regexp_matches(t, '(^|[^ぁ-ん])([ぁ-ん]{2,4})(ちゃん(?!と(し|す|せ|さ|や|で|言|話|見|聞|考|勉|寝|食|起|書|読|守|答|伝|分|わか|でき|向|休|片|払|返|謝|お|[、。!?\s]|$))|くん(?![なねだので]))', 'g') loop
      if m[2] !~ hira_stop then out := array_append(out, 'name'); exit; end if;
    end loop;
  end if;

  return out;
end;
$$;

-- 同じ端末から短い時間に続けて（前後30分に、問いと返事を合わせて3件以上）。端末の印が無い・LINE の分は見ない
create or replace function toi_review_burst(p_hash text, p_at timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select toi_push_hash_ok(p_hash) and (
    (select count(*) from questions where client_hash = p_hash and created_at between p_at - interval '30 minutes' and p_at + interval '30 minutes')
  + (select count(*) from answers   where client_hash = p_hash and created_at between p_at - interval '30 minutes' and p_at + interval '30 minutes')
  ) >= 3;
$$;

-- 未承認（載せない印も無い）の数
create or replace function toi_review_pending() returns int
language sql stable security definer set search_path = public as $$
  select ((select count(*) from questions where not approved and rejected_at is null)
        + (select count(*) from answers   where not approved and rejected_at is null))::int;
$$;

-- ---------------------------------------------------------------- 運営の端末かを確かめる

create or replace function toi_staff_hash(p_token text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
$$;

-- 印が運営の端末のものなら、その行を返す（開いた時刻と、通知の宛先の印を記す）。違えば断る
create or replace function toi_staff_device(p_token text, p_client_hash text default null) returns staff_devices
language plpgsql volatile security definer set search_path = public as $$
declare d staff_devices;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then raise exception 'not_staff'; end if;
  update staff_devices
     set last_seen_at = now(),
         client_hash = case when toi_push_hash_ok(p_client_hash) then p_client_hash else client_hash end
   where token_hash = toi_staff_hash(p_token)
  returning * into d;
  if d.id is null then raise exception 'not_staff'; end if;
  return d;
end;
$$;

-- ---------------------------------------------------------------- 運営の知らせ（毎時ではなく5分ごとに見て、決まった時刻に1回）

-- p_now の時点で知らせる時刻に当たっていれば（時刻から1時間のうち・まだ知らせていない）、未承認が1件以上のときだけ運営の端末に review を足す。足した数を返す
create or replace function toi_staff_tick(p_now timestamptz default now()) returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  v_local   timestamp := p_now at time zone 'Asia/Tokyo';
  v_time    text;
  v_slot    timestamptz;
  v_pending int;
  v_n       int := 0;
  v_k       int;
  d         int;
begin
  delete from staff_pair_codes where expires_at < p_now;
  delete from staff_review_slots where slot < p_now - interval '30 days';
  foreach v_time in array string_to_array(coalesce(toi_push_setting('review_times_jst'), ''), ',') loop
    v_time := btrim(v_time);
    continue when v_time !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$';
    foreach d in array array[0, 1] loop   -- 今日と昨日の時刻（日付をまたいで1時間のうちに入るとき）
      v_slot := ((v_local::date - d) + v_time::time) at time zone 'Asia/Tokyo';
      continue when not (v_slot <= p_now and p_now < v_slot + interval '1 hour');
      v_pending := toi_review_pending();
      insert into staff_review_slots (slot, pending) values (v_slot, v_pending) on conflict do nothing;
      continue when not found or v_pending = 0;
      insert into push_outbox (endpoint, kind, send_after)
      select s.endpoint, 'review', toi_push_send_after(p_now) from push_subscriptions s
       where s.client_hash in (select client_hash from staff_devices where client_hash is not null);
      get diagnostics v_k = row_count;
      v_n := v_n + v_k;
    end loop;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------- 本人が SQL Editor で流す（ブラウザからは呼べない）

-- 登録コードの端末を、運営の端末にする
create or replace function toi_staff_pair(p_code text, p_label text default null) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_code text := regexp_replace(normalize(coalesce(p_code, ''), NFKC), '[^0-9]', '', 'g');
  p staff_pair_codes;
  d staff_devices;
begin
  delete from staff_pair_codes where expires_at < now();
  delete from staff_pair_codes where code_hash = encode(sha256(convert_to(v_code, 'UTF8')), 'hex') returning * into p;
  if p.token_hash is null then
    raise exception 'その登録コードは見つかりません（6けたを確かめるか、10分を過ぎたので端末で出し直してください）';
  end if;
  if (select count(*) from staff_devices) >= 10 then
    raise exception '運営の端末は10台までです。select * from toi_staff_list(); で古い端末を確かめて外してください';
  end if;
  insert into staff_devices (token_hash, client_hash, label)
  values (p.token_hash, case when toi_push_hash_ok(p.client_hash) then p.client_hash end, nullif(btrim(coalesce(p_label, '')), ''))
  on conflict (token_hash) do update set last_seen_at = now()
  returning * into d;
  return format('運営の端末にしました（番号 %s）。端末の画面がひとりでに切り替わります。外すときは select toi_staff_unpair(''%s'');',
    left(d.id::text, 8), left(d.id::text, 8));
end;
$$;

-- 運営の端末の一覧（印は出さない）
create or replace function toi_staff_list()
returns table (number text, label text, created_at timestamptz, last_seen_at timestamptz, gets_notice boolean)
language sql stable security definer set search_path = public as $$
  select left(d.id::text, 8), d.label, d.created_at, d.last_seen_at,
         exists (select 1 from push_subscriptions s where s.client_hash = d.client_hash)
    from staff_devices d order by d.created_at;
$$;

-- 外す（番号の先頭4文字以上。'all' で全部）。外した数を返す
create or replace function toi_staff_unpair(p_which text) returns int
language plpgsql volatile security definer set search_path = public as $$
declare v_n int;
begin
  if p_which = 'all' then
    delete from staff_devices;
  elsif coalesce(p_which, '') ~ '^[0-9a-f-]{4,36}$' then
    delete from staff_devices where id::text like p_which || '%';
  else
    raise exception '番号（toi_staff_list の number）か ''all'' を入れてください';
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------- ブラウザ（anon）から呼ぶ。運営用の関数は毎回、端末の印を確かめる

-- 登録コードをもらう（印は端末が作った 64 桁の 16 進。DB にはハッシュだけ）。もう運営の端末なら staff=true
-- 荒らし対策: 待っているコードは全体で50まで（同じ印・同じ端末のコードは出し直すたびに置き換える）
create or replace function staff_pair_start(p_token text, p_client_hash text default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_hash text := toi_staff_hash(p_token);
  v_code text;
  v_exp  timestamptz := now() + interval '10 minutes';
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then raise exception 'bad_token'; end if;
  if exists (select 1 from staff_devices where token_hash = v_hash) then
    return jsonb_build_object('ok', true, 'staff', true);
  end if;
  delete from staff_pair_codes
   where token_hash = v_hash or expires_at < now()
      or (toi_push_hash_ok(p_client_hash) and client_hash = p_client_hash);
  if (select count(*) from staff_pair_codes) >= 50 then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  for i in 1..5 loop
    -- gen_random_uuid() の先頭 8 文字（32 ビットの乱数）から 6 けたを作る
    v_code := lpad((('x' || lpad(substr(gen_random_uuid()::text, 1, 8), 16, '0'))::bit(64)::bigint % 1000000)::text, 6, '0');
    insert into staff_pair_codes (code_hash, token_hash, client_hash, expires_at)
    values (encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), v_hash,
            case when toi_push_hash_ok(p_client_hash) then p_client_hash end, v_exp)
    on conflict (code_hash) do nothing;
    if found then
      return jsonb_build_object('ok', true, 'staff', false, 'code', v_code, 'expires_at', v_exp);
    end if;
  end loop;
  return jsonb_build_object('ok', false, 'reason', 'busy');
end;
$$;

-- この端末は運営の端末か（登録を待っているあいだ、画面が数秒ごとに呼ぶ）。運営の端末なら未承認の数も返す
create or replace function staff_status(p_token text, p_client_hash text default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare d staff_devices;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('staff', false, 'waiting', false);
  end if;
  if not exists (select 1 from staff_devices where token_hash = toi_staff_hash(p_token)) then
    return jsonb_build_object('staff', false,
      'waiting', exists (select 1 from staff_pair_codes where token_hash = toi_staff_hash(p_token) and expires_at >= now()));
  end if;
  d := toi_staff_device(p_token, p_client_hash);
  return jsonb_build_object('staff', true, 'number', left(d.id::text, 8), 'pending', toi_review_pending(),
    'gets_notice', exists (select 1 from push_subscriptions s where s.client_hash = d.client_hash));
end;
$$;

-- 承認待ちの一覧（古い順・200件まで）。下読みの見立てつき
create or replace function staff_queue(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  perform toi_staff_device(p_token);
  return jsonb_build_object('pending', toi_review_pending(), 'items', coalesce((
    select jsonb_agg(x.item order by x.created_at, x.id) from (
      select q.created_at, q.id, jsonb_build_object(
        'kind', 'question', 'id', q.id, 'body', q.body,
        'nickname', nullif(q.nickname, ''), 'theme_label', t.label, 'source', q.source, 'created_at', q.created_at,
        'flags', toi_review_flags(q.body || ' ' || coalesce(q.nickname, ''))
                 || case when toi_review_burst(q.client_hash, q.created_at) then array['burst'] else '{}'::text[] end) as item
        from questions q left join themes t on t.id = q.theme_id
       where not q.approved and q.rejected_at is null
      union all
      select a.created_at, a.id, jsonb_build_object(
        'kind', 'answer', 'id', a.id, 'body', a.body,
        'question_id', a.question_id, 'question_body', q.body, 'question_approved', q.approved,
        'role_label', coalesce(r.label, nullif(a.responder_role, ''), '立場なし'), 'ai_assisted', a.ai_assisted,
        'via', case when a.client_hash = 'line' then 'line' when toi_push_hash_ok(a.client_hash) then 'app' else 'other' end,
        'created_at', a.created_at,
        'flags', toi_review_flags(a.body)
                 || case when toi_review_burst(a.client_hash, a.created_at) then array['burst'] else '{}'::text[] end) as item
        from answers a join questions q on q.id = a.question_id left join responder_roles r on r.id = a.role_id
       where not a.approved and a.rejected_at is null
      order by 1, 2
      limit 200
    ) x), '[]'::jsonb));
end;
$$;

-- 1枚を決める。approve: 載せる（approved = true・approved_at。いまある引き金が「返事が届いた」「載りました」などを知らせる）
--             reject: 載せない（消さずに印を付けて一覧から外す）／restore: 載せないを取り消す／hold: 何もしない（そのまま残す）
-- 載せるのはこの関数だけ（anon は questions・answers を update できない。RLS に update の決まりが無い）
create or replace function staff_decide(p_token text, p_kind text, p_id uuid, p_action text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_n int := 0;
begin
  perform toi_staff_device(p_token);
  if coalesce(p_kind, '') not in ('question', 'answer') then raise exception 'bad_kind'; end if;
  if coalesce(p_action, '') not in ('approve', 'reject', 'restore', 'hold') then raise exception 'bad_action'; end if;
  if p_action = 'hold' then
    return jsonb_build_object('ok', true, 'changed', false, 'pending', toi_review_pending());
  end if;
  if p_kind = 'question' then
    if p_action = 'approve' then
      update questions set approved = true, approved_at = now(), rejected_at = null where id = p_id and not approved;
    elsif p_action = 'reject' then
      update questions set rejected_at = now() where id = p_id and not approved and rejected_at is null;
    else
      update questions set rejected_at = null where id = p_id and not approved and rejected_at is not null;
    end if;
  else
    if p_action = 'approve' then
      update answers set approved = true, approved_at = now(), rejected_at = null where id = p_id and not approved;
    elsif p_action = 'reject' then
      update answers set rejected_at = now() where id = p_id and not approved and rejected_at is null;
    else
      update answers set rejected_at = null where id = p_id and not approved and rejected_at is not null;
    end if;
  end if;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'changed', v_n > 0, 'pending', toi_review_pending());
end;
$$;

-- この端末を運営の端末から外す（端末の画面から）
create or replace function staff_leave(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  delete from staff_devices where token_hash = toi_staff_hash(p_token);
  return jsonb_build_object('ok', true, 'removed', found);
end;
$$;

-- ---------------------------------------------------------------- 権限

revoke execute on function toi_review_ascii(text), toi_review_flags(text), toi_review_burst(text, timestamptz), toi_review_pending(),
  toi_staff_hash(text), toi_staff_device(text, text), toi_staff_tick(timestamptz),
  toi_staff_pair(text, text), toi_staff_list(), toi_staff_unpair(text)
  from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke execute on function toi_staff_pair(text, text), toi_staff_list(), toi_staff_unpair(text) from service_role;
  end if;
end $$;
revoke execute on function staff_pair_start(text, text), staff_status(text, text), staff_queue(text),
  staff_decide(text, text, uuid, text), staff_leave(text) from public;
grant execute on function staff_pair_start(text, text), staff_status(text, text), staff_queue(text),
  staff_decide(text, text, uuid, text), staff_leave(text) to anon, authenticated;

-- ---------------------------------------------------------------- 5分ごと（review_times_jst の時刻に当たったら、運営に知らせる）
do $$ begin
  perform cron.schedule('toi-staff-review', '*/5 * * * *', 'select public.toi_staff_tick()');
exception when others then raise notice '5分ごとの仕事を pg_cron に組めませんでした: %', sqlerrm;
end $$;
