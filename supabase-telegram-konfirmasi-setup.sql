-- ══════════════════════════════════════════════════════════════
-- WealthFlow — Telegram: konfirmasi sebelum simpan + pembatalan borongan
-- Jalankan di Supabase Dashboard → SQL Editor → New query → Run
-- ══════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────
-- 1) Titipan hasil baca yang MENUNGGU persetujuan
--
-- Telegram membatasi callback_data tombol hanya 64 byte, jadi daftar
-- transaksinya tak mungkin dititipkan di tombol. Hasil bacanya disimpan di
-- sini, dan tombolnya cukup membawa id barisnya.
-- ─────────────────────────────────────────────────────────────
create table if not exists telegram_pending (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  chat_id    bigint not null,
  baris      jsonb not null,
  created_at timestamptz not null default now()
);

alter table telegram_pending enable row level security;
-- Hanya server (service role) yang menyentuh tabel ini.

create index if not exists telegram_pending_waktu_idx on telegram_pending (created_at);


-- ─────────────────────────────────────────────────────────────
-- 2) Simpan setelah disetujui
--
-- Menyimpan transaksi dan memotong saldo adalah dua hal yang tak boleh
-- terpisah. Dikerjakan dalam satu fungsi supaya gagal di tengah berarti tak
-- ada yang berubah, bukan catatan yang tak cocok dengan saldo.
-- ─────────────────────────────────────────────────────────────
create or replace function simpan_batch_bot(p_user uuid, p_pending uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_baris jsonb;
  r       jsonb;
  v_wal   uuid;
  v_kat   uuid;
  v_sub   uuid;
  v_nilai numeric;
  v_tipe  text;
  v_jml   int := 0;
  v_ids   uuid[] := '{}';
  v_id    uuid;
begin
  select baris into v_baris from telegram_pending
   where id = p_pending and user_id = p_user
   for update;

  if v_baris is null then
    return jsonb_build_object('ok', false, 'pesan', 'Daftarnya sudah tidak ada. Kirim ulang gambarnya.');
  end if;

  for r in select value from jsonb_array_elements(v_baris) loop
    v_nilai := coalesce((r->>'amount')::numeric, 0);
    continue when v_nilai <= 0;

    v_tipe := case when r->>'type' = 'income' then 'income' else 'expense' end;

    -- Rujukan yang bukan milik pemanggil dikosongkan, jangan dipercaya mentah
    v_wal := nullif(r->>'wallet_id', '')::uuid;
    if v_wal is not null and not exists (select 1 from wallets where id = v_wal and user_id = p_user) then v_wal := null; end if;
    v_kat := nullif(r->>'category_id', '')::uuid;
    if v_kat is not null and not exists (select 1 from categories where id = v_kat and user_id = p_user) then v_kat := null; end if;
    v_sub := nullif(r->>'sub_category_id', '')::uuid;
    if v_sub is not null and not exists (select 1 from categories where id = v_sub and user_id = p_user) then v_sub := null; end if;

    insert into transactions (user_id, type, wallet_id, category_id, sub_category_id, amount, description, date)
    values (p_user, v_tipe, v_wal, v_kat, v_sub, v_nilai,
            coalesce(r->>'description', ''), coalesce((r->>'date')::date, current_date))
    returning id into v_id;

    v_ids := array_append(v_ids, v_id);

    if v_wal is not null then
      update wallets
         set balance = coalesce(balance, 0) + (case when v_tipe = 'income' then v_nilai else -v_nilai end)
       where id = v_wal and user_id = p_user;
    end if;

    v_jml := v_jml + 1;
  end loop;

  delete from telegram_pending where id = p_pending;

  return jsonb_build_object('ok', true, 'jumlah', v_jml, 'ids', to_jsonb(v_ids));
end;
$$;

revoke execute on function public.simpan_batch_bot(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.simpan_batch_bot(uuid, uuid) to service_role;


-- ─────────────────────────────────────────────────────────────
-- 3) Membatalkan BANYAK transaksi sekaligus, saldo ikut dipulihkan
--
-- Dipakai tombol "Batalkan semua" di chat, dan juga untuk membereskan
-- transaksi yang terlanjur masuk sebelum ada layar konfirmasi.
-- ─────────────────────────────────────────────────────────────
create or replace function batalkan_transaksi_batch(p_user uuid, p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t       record;
  v_jml   int := 0;
  v_total numeric := 0;
begin
  for t in
    select * from transactions
     where user_id = p_user and id = any(p_ids)
     for update
  loop
    if t.wallet_id is not null then
      update wallets
         set balance = coalesce(balance, 0) + (case when t.type = 'income' then -1 else 1 end) * coalesce(t.amount, 0)
       where id = t.wallet_id and user_id = p_user;
    end if;
    delete from transactions where id = t.id;
    v_jml := v_jml + 1;
    v_total := v_total + coalesce(t.amount, 0);
  end loop;

  return jsonb_build_object('ok', true, 'jumlah', v_jml, 'total', v_total);
end;
$$;

revoke execute on function public.batalkan_transaksi_batch(uuid, uuid[]) from public, anon;
-- Pengguna login boleh membatalkan miliknya sendiri lewat aplikasi; parameter
-- p_user tetap dicocokkan di dalam, jadi id orang lain tak terjangkau.
grant  execute on function public.batalkan_transaksi_batch(uuid, uuid[]) to authenticated, service_role;

-- Selesai.
