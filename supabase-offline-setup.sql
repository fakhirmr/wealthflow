-- ══════════════════════════════════════════════════════════════
-- WealthFlow — Setup Mode Offline (sinkronisasi aman)
-- Jalankan SEKALI di Supabase Dashboard → SQL Editor → New query → Run
-- ══════════════════════════════════════════════════════════════
--
-- Fungsi ini menyimpan transaksi offline DAN menyesuaikan saldo dompet
-- dalam SATU operasi database yang tak bisa terpotong separuh.
--
-- Kenapa perlu: kalau keduanya dilakukan terpisah dari aplikasi, dan aplikasi
-- ditutup tepat di antaranya, pengiriman ulang bisa mengurangi saldo DUA KALI.
-- Dengan "on conflict do nothing", saldo hanya berubah saat transaksi benar-benar
-- baru — jadi dikirim berapa kali pun hasilnya tetap sama (idempoten).

create or replace function apply_offline_txn(p_row jsonb, p_wallet uuid, p_delta numeric)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  insert into transactions (id, user_id, type, wallet_id, category_id, sub_category_id, amount, description, date)
  values (
    (p_row->>'id')::uuid,
    auth.uid(),                                   -- selalu milik pemanggil, tak bisa dipalsukan
    p_row->>'type',
    nullif(p_row->>'wallet_id','')::uuid,
    nullif(p_row->>'category_id','')::uuid,
    nullif(p_row->>'sub_category_id','')::uuid,
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
     where id = p_wallet and user_id = auth.uid();
  end if;

  return n > 0;
end;
$$;

-- Selesai. Fungsi apply_offline_txn siap dipakai.
