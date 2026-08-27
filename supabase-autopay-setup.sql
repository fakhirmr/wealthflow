-- ══════════════════════════════════════════════════════════════
-- WealthFlow — Bayar Otomatis Cicilan
-- Jalankan SEKALI di Supabase Dashboard → SQL Editor → New query → Run
--
-- PENTING, supaya tidak salah paham: ini TIDAK mengirim uang ke bank.
-- Yang otomatis adalah PENCATATANNYA. Saat jatuh tempo lewat, sistem
-- mencatat cicilan itu sebagai sudah dibayar, memotong saldo dompet yang
-- dipilih, dan memajukan jatuh tempo ke bulan berikutnya. Pembayaran ke
-- bank tetap urusan autodebet bank atau dibayar sendiri oleh pengguna.
-- ══════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────
-- 1) Kolom penyimpan pengaturan
-- ─────────────────────────────────────────────────────────────
alter table debts add column if not exists auto_pay          boolean not null default false;
alter table debts add column if not exists auto_pay_wallet   uuid;
alter table debts add column if not exists auto_pay_category uuid;
alter table debts add column if not exists auto_pay_last     date;   -- jatuh tempo terakhir yang sudah diproses


-- ─────────────────────────────────────────────────────────────
-- 2) Mesin pencatatnya
--
-- Satu cicilan menyentuh EMPAT tabel: debt_payments, transactions, wallets,
-- dan debts. Kalau dijalankan dari peramban sebagai empat panggilan terpisah,
-- koneksi yang putus di tengah meninggalkan catatan hutang yang tidak sinkron
-- dengan saldo. Karena itu semuanya dikerjakan di dalam SATU fungsi: seluruh
-- isinya jadi satu transaksi basis data, gagal berarti tak ada yang berubah.
--
-- Kunci baris (for update) dipakai supaya dua perangkat yang membuka aplikasi
-- pada saat bersamaan tidak mencatat cicilan yang sama dua kali.
-- ─────────────────────────────────────────────────────────────
create or replace function auto_bayar_hutang()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  d         record;
  v_bayar   numeric;
  v_sisa    numeric;
  v_tempo   date;
  v_putar   int;
  v_jml     int := 0;
  v_total   numeric := 0;
  v_nama    text[] := '{}';
begin
  if v_uid is null then
    raise exception 'auth required' using errcode = '28000';
  end if;

  for d in
    select * from debts
     where user_id = v_uid
       and type = 'hutang'
       and status = 'active'
       and auto_pay = true
       and auto_pay_wallet is not null
       and due_date is not null
       and due_date <= current_date
       and coalesce(remaining_amount, 0) > 0
       and coalesce(monthly_payment, 0) > 0
     for update
  loop
    v_sisa  := coalesce(d.remaining_amount, 0);
    v_tempo := d.due_date;
    v_putar := 0;

    -- Menyusul tunggakan bulan-bulan yang terlewat, misalnya setelah aplikasi
    -- lama tak dibuka. Dibatasi 12 putaran supaya data yang aneh (tanggal jatuh
    -- tempo bertahun lalu) tidak menghasilkan ratusan catatan sekaligus.
    while v_tempo <= current_date and v_sisa > 0 and v_putar < 12 loop

      -- Jangan proses ulang jatuh tempo yang sudah pernah dicatat
      if d.auto_pay_last is not null and v_tempo <= d.auto_pay_last then
        v_tempo := (v_tempo + interval '1 month')::date;
        v_putar := v_putar + 1;
        continue;
      end if;

      v_bayar := least(coalesce(d.monthly_payment, 0), v_sisa);
      exit when v_bayar <= 0;

      insert into debt_payments (user_id, debt_id, amount, paid_date, wallet_id, notes)
      values (v_uid, d.id, v_bayar, v_tempo, d.auto_pay_wallet, 'Bayar otomatis');

      insert into transactions (user_id, type, wallet_id, category_id, amount, description, date)
      values (v_uid, 'expense', d.auto_pay_wallet, d.auto_pay_category, v_bayar,
              'Bayar utang: ' || d.name || ' (otomatis)', v_tempo);

      update wallets
         set balance = coalesce(balance, 0) - v_bayar
       where id = d.auto_pay_wallet and user_id = v_uid;

      v_sisa  := v_sisa - v_bayar;
      v_total := v_total + v_bayar;
      v_jml   := v_jml + 1;

      update debts
         set remaining_amount = v_sisa,
             status           = case when v_sisa <= 0 then 'paid' else 'active' end,
             auto_pay_last    = v_tempo,
             due_date         = case when v_sisa <= 0 then v_tempo
                                     else (v_tempo + interval '1 month')::date end
       where id = d.id;

      -- Supaya penjagaan auto_pay_last ikut terbaca di putaran berikutnya
      d.auto_pay_last := v_tempo;

      v_tempo := (v_tempo + interval '1 month')::date;
      v_putar := v_putar + 1;
    end loop;

    if v_jml > 0 and not (d.name = any(v_nama)) then
      v_nama := array_append(v_nama, d.name);
    end if;
  end loop;

  return jsonb_build_object('jumlah', v_jml, 'total', v_total, 'nama', to_jsonb(v_nama));
end;
$$;

revoke execute on function public.auto_bayar_hutang() from public, anon;
grant  execute on function public.auto_bayar_hutang() to authenticated;

-- Selesai.
