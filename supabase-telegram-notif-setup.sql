-- ══════════════════════════════════════════════════════════════
-- WealthFlow — Telegram: notifikasi terjadwal & tombol aksi
-- Jalankan SEKALI di Supabase Dashboard → SQL Editor → New query → Run
-- ══════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────
-- 1) Saklar notifikasi per pengguna
--    Mengirim pesan tanpa cara mematikannya akan membuat bot terasa
--    mengganggu dan diblokir. Semua menyala secara bawaan, dimatikan
--    lewat perintah /notif di chat.
-- ─────────────────────────────────────────────────────────────
alter table telegram_links add column if not exists notif_tagihan  boolean not null default true;
alter table telegram_links add column if not exists notif_harian   boolean not null default true;
alter table telegram_links add column if not exists notif_mingguan boolean not null default true;

-- Penanda agar satu tagihan tidak diingatkan dua kali di hari yang sama,
-- termasuk bila cron sempat berjalan ulang.
alter table telegram_links add column if not exists notif_terakhir date;


-- ─────────────────────────────────────────────────────────────
-- 2) Tombol "Sudah bayar" di chat
--
-- Bot berjalan dengan service role, jadi auth.uid() kosong dan fungsi
-- auto_bayar_hutang() tidak bisa dipakai di sini. Pemilik disebut sebagai
-- parameter, dan justru karena itu fungsi ini TIDAK BOLEH terjangkau dari
-- peramban: siapa pun bisa memasukkan id orang lain. Hak jalannya hanya
-- untuk service_role.
--
-- Satu pembayaran menyentuh empat tabel, jadi semuanya dikerjakan di dalam
-- satu fungsi supaya tidak pernah setengah jalan.
-- ─────────────────────────────────────────────────────────────
create or replace function bayar_cicilan_bot(p_user uuid, p_debt uuid, p_wallet uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d       record;
  v_bayar numeric;
  v_sisa  numeric;
  v_wal   uuid;
begin
  select * into d from debts
   where id = p_debt and user_id = p_user and status = 'active'
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'pesan', 'Tagihan tidak ditemukan atau sudah lunas.');
  end if;

  v_sisa  := coalesce(d.remaining_amount, 0);
  v_bayar := least(coalesce(nullif(d.monthly_payment, 0), v_sisa), v_sisa);
  if v_bayar <= 0 then
    return jsonb_build_object('ok', false, 'pesan', 'Nilai cicilan belum diisi.');
  end if;

  -- Urutan dompet: yang diminta → dompet auto-pay → dompet hutang
  v_wal := coalesce(p_wallet, d.auto_pay_wallet, d.wallet_id);
  if v_wal is not null and not exists (select 1 from wallets where id = v_wal and user_id = p_user) then
    v_wal := null;
  end if;

  insert into debt_payments (user_id, debt_id, amount, paid_date, wallet_id, notes)
  values (p_user, p_debt, v_bayar, current_date, v_wal, 'Dibayar lewat Telegram');

  if v_wal is not null then
    insert into transactions (user_id, type, wallet_id, category_id, amount, description, date)
    values (p_user, 'expense', v_wal, d.auto_pay_category, v_bayar,
            'Bayar utang: ' || d.name, current_date);

    update wallets set balance = coalesce(balance, 0) - v_bayar
     where id = v_wal and user_id = p_user;
  end if;

  v_sisa := v_sisa - v_bayar;

  update debts
     set remaining_amount = v_sisa,
         status           = case when v_sisa <= 0 then 'paid' else 'active' end,
         due_date         = case when v_sisa <= 0 or d.due_date is null then d.due_date
                                 else (d.due_date + interval '1 month')::date end
   where id = p_debt;

  return jsonb_build_object('ok', true, 'nama', d.name, 'bayar', v_bayar, 'sisa', v_sisa, 'lunas', v_sisa <= 0);
end;
$$;

revoke execute on function public.bayar_cicilan_bot(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.bayar_cicilan_bot(uuid, uuid, uuid) to service_role;


-- ─────────────────────────────────────────────────────────────
-- 3) Tombol "Batal" untuk membatalkan transaksi yang baru dicatat
--    Menghapus transaksi TANPA mengembalikan saldo akan membuat catatan
--    dan saldo berbeda selamanya, jadi keduanya dikerjakan bersama.
-- ─────────────────────────────────────────────────────────────
create or replace function batal_transaksi_bot(p_user uuid, p_txn uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t record;
begin
  select * into t from transactions
   where id = p_txn and user_id = p_user
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'pesan', 'Transaksi sudah tidak ada.');
  end if;

  if t.wallet_id is not null then
    update wallets
       set balance = coalesce(balance, 0) + (case when t.type = 'income' then -1 else 1 end) * coalesce(t.amount, 0)
     where id = t.wallet_id and user_id = p_user;
  end if;

  delete from transactions where id = p_txn and user_id = p_user;

  return jsonb_build_object('ok', true, 'jumlah', t.amount, 'ket', coalesce(t.description, ''));
end;
$$;

revoke execute on function public.batal_transaksi_bot(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.batal_transaksi_bot(uuid, uuid) to service_role;


-- ─────────────────────────────────────────────────────────────
-- 4) Ubah kategori transaksi dari chat
-- ─────────────────────────────────────────────────────────────
create or replace function set_kategori_bot(p_user uuid, p_txn uuid, p_cat uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nama text;
begin
  if not exists (select 1 from transactions where id = p_txn and user_id = p_user) then
    return jsonb_build_object('ok', false, 'pesan', 'Transaksi sudah tidak ada.');
  end if;
  select name into v_nama from categories where id = p_cat and user_id = p_user;
  if v_nama is null then
    return jsonb_build_object('ok', false, 'pesan', 'Kategori tidak dikenal.');
  end if;

  -- Sub-kategori lama dikosongkan: sub milik kategori lain jadi tak nyambung
  update transactions
     set category_id = p_cat, sub_category_id = null
   where id = p_txn and user_id = p_user;

  return jsonb_build_object('ok', true, 'nama', v_nama);
end;
$$;

revoke execute on function public.set_kategori_bot(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.set_kategori_bot(uuid, uuid, uuid) to service_role;

-- Selesai.


-- ─────────────────────────────────────────────────────────────
-- 5) Penjaga update ganda dari Telegram
--
-- Telegram mengirim ULANG update yang sama bila webhook tak menjawab 200
-- tepat waktu. Tanpa penjagaan ini, satu foto mutasi yang lambat diproses
-- membuat bot memulai pekerjaan dari awal berkali-kali dan mengirim
-- "Membaca struk..." tanpa henti sampai Telegram menyerah.
-- ─────────────────────────────────────────────────────────────
create table if not exists telegram_updates (
  update_id  bigint primary key,
  created_at timestamptz not null default now()
);

alter table telegram_updates enable row level security;
-- Hanya server (service role) yang menyentuh tabel ini; tak ada policy untuk
-- peramban, jadi RLS menutup semuanya.

create index if not exists telegram_updates_waktu_idx on telegram_updates (created_at);

-- Selesai.
