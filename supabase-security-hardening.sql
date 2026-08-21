-- ══════════════════════════════════════════════════════════════
-- WealthFlow — Penguatan Keamanan (WAJIB sebelum komersial)
-- Jalankan SEKALI di Supabase Dashboard → SQL Editor → New query → Run
-- ══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 1) KRITIS: cegah pengguna memberi dirinya Premium tanpa membayar
--
-- Kolom premium_until & ai_plan ada di user_settings, yang policy-nya mengizinkan
-- pengguna mengubah barisnya sendiri. Tanpa langkah ini, siapa pun bisa membuka
-- konsol peramban lalu menjalankan satu baris perintah untuk memberi dirinya
-- Premium selamanya. RLS TIDAK bisa membatasi per-kolom, jadi hak tulis kolom
-- tersebut dicabut di tingkat GRANT — hanya server (service role) yang boleh.
-- ─────────────────────────────────────────────────────────────

-- Kolom yang boleh diubah pengguna sendiri (sesuaikan bila ada kolom lain):
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ')
    into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'user_settings'
    and column_name not in ('premium_until', 'ai_plan');   -- ini yang dilindungi

  -- Cabut hak tulis menyeluruh, lalu berikan kembali HANYA untuk kolom aman
  execute 'revoke update on public.user_settings from authenticated';
  if cols is not null then
    execute format('grant update (%s) on public.user_settings to authenticated', cols);
  end if;
end $$;

-- Pengguna tetap boleh membaca status premiumnya (untuk ditampilkan di aplikasi)
grant select on public.user_settings to authenticated;


-- ─────────────────────────────────────────────────────────────
-- 2) KRITIS: increment_ai_usage menerima id pengguna sebagai parameter bebas
--    dan berjalan sebagai pemilik. Bila bisa dipanggil dari peramban, seseorang
--    dapat menghabiskan jatah AI pengguna LAIN. Hanya server yang boleh memanggil.
-- ─────────────────────────────────────────────────────────────
revoke execute on function public.increment_ai_usage(uuid, text) from public, anon, authenticated;
grant  execute on function public.increment_ai_usage(uuid, text) to service_role;


-- ─────────────────────────────────────────────────────────────
-- 3) apply_offline_txn: tolak pemanggilan tanpa sesi login.
--    Sebelumnya panggilan anonim menembus sampai ke perintah INSERT, lalu pesan
--    galat basis data membocorkan seluruh struktur tabel transactions.
--    Sekaligus: pastikan dompet & kategori yang dirujuk benar milik pemanggil.
-- ─────────────────────────────────────────────────────────────
create or replace function apply_offline_txn(p_row jsonb, p_wallet uuid, p_delta numeric)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n     int;
  v_uid uuid := auth.uid();
  v_wal uuid;
  v_cat uuid;
  v_sub uuid;
begin
  if v_uid is null then
    raise exception 'auth required' using errcode = '28000';
  end if;

  -- Hanya terima rujukan yang benar-benar milik pemanggil; selain itu dikosongkan
  v_wal := nullif(p_row->>'wallet_id','')::uuid;
  if v_wal is not null and not exists (select 1 from wallets where id = v_wal and user_id = v_uid) then
    v_wal := null;
  end if;

  v_cat := nullif(p_row->>'category_id','')::uuid;
  if v_cat is not null and not exists (select 1 from categories where id = v_cat and user_id = v_uid) then
    v_cat := null;
  end if;

  v_sub := nullif(p_row->>'sub_category_id','')::uuid;
  if v_sub is not null and not exists (select 1 from categories where id = v_sub and user_id = v_uid) then
    v_sub := null;
  end if;

  insert into transactions (id, user_id, type, wallet_id, category_id, sub_category_id, amount, description, date)
  values (
    (p_row->>'id')::uuid,
    v_uid,
    p_row->>'type',
    v_wal, v_cat, v_sub,
    (p_row->>'amount')::numeric,
    coalesce(p_row->>'description',''),
    (p_row->>'date')::date
  )
  on conflict (id) do nothing;

  get diagnostics n = row_count;

  -- Saldo HANYA disesuaikan bila transaksi benar-benar baru tersimpan
  if n > 0 and p_wallet is not null then
    update wallets
       set balance = coalesce(balance, 0) + p_delta
     where id = p_wallet and user_id = v_uid;
  end if;

  return n > 0;
end;
$$;

revoke execute on function public.apply_offline_txn(jsonb, uuid, numeric) from public, anon;
grant  execute on function public.apply_offline_txn(jsonb, uuid, numeric) to authenticated, service_role;


-- ─────────────────────────────────────────────────────────────
-- 4) BUG SALDO: penyesuaian saldo yang aman dari tumpang-tindih
--
-- Aplikasi selama ini membaca saldo dari layar, menghitung, lalu MENIMPA-nya.
-- Bila ada perubahan lain yang belum tampil (dari Telegram, perangkat lain, atau
-- antrean offline), perubahan itu ikut terhapus. Fungsi ini menambah/mengurangi
-- langsung di basis data sehingga perubahan bersamaan tidak saling menghapus.
-- ─────────────────────────────────────────────────────────────
create or replace function adjust_wallet_balance(p_wallet uuid, p_delta numeric)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_new numeric;
begin
  if v_uid is null then
    raise exception 'auth required' using errcode = '28000';
  end if;

  update wallets
     set balance = coalesce(balance, 0) + p_delta
   where id = p_wallet and user_id = v_uid
  returning balance into v_new;

  return v_new;   -- null bila dompet bukan milik pemanggil
end;
$$;

revoke execute on function public.adjust_wallet_balance(uuid, numeric) from public, anon;
grant  execute on function public.adjust_wallet_balance(uuid, numeric) to authenticated, service_role;


-- ─────────────────────────────────────────────────────────────
-- 5) Pastikan tabel pembayaran tak bisa ditulis dari peramban
--    (status 'paid' hanya boleh datang dari webhook terverifikasi)
-- ─────────────────────────────────────────────────────────────
revoke insert, update, delete on public.payments from anon, authenticated;
grant  select on public.payments to authenticated;

-- Selesai.
