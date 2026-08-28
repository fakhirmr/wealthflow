-- ══════════════════════════════════════════════════════════════
-- WealthFlow — Mengembalikan transaksi yang terlanjur masuk
--
-- Dipakai sekali untuk membereskan transaksi mutasi yang masuk sendiri
-- sebelum bot punya layar konfirmasi. Saldo dompet ikut dipulihkan.
--
-- Jalankan BERTAHAP. Jangan langsung menyalin semuanya sekaligus:
-- langkah 2 menghapus data, dan tak ada tombol urungkan di sana.
-- ══════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────
-- LANGKAH 0 — cari id akunmu
-- ─────────────────────────────────────────────────────────────
select id, email from auth.users order by created_at;


-- ─────────────────────────────────────────────────────────────
-- LANGKAH 1 — LIHAT DULU apa yang akan dibatalkan
--
-- Ganti UUID di bawah dengan id dari LANGKAH 0.
--
-- Transaksi dari mutasi bertanggal LAMA (12-16 Agustus), bukan hari ini,
-- jadi tak bisa disaring lewat kolom date. Yang dipakai kolom created_at,
-- yaitu kapan barisnya benar-benar masuk ke basis data.
--
-- Kalau muncul galat "column created_at does not exist", pakai LANGKAH 1B.
-- ─────────────────────────────────────────────────────────────
select t.id,
       t.date          as tanggal_transaksi,
       t.type          as jenis,
       t.amount        as nominal,
       t.description   as keterangan,
       w.name          as dompet,
       t.created_at    as masuk_pada
  from transactions t
  left join wallets w on w.id = t.wallet_id
 where t.user_id = 'GANTI-DENGAN-ID-DARI-LANGKAH-0'
   and t.created_at > now() - interval '6 hours'
 order by t.created_at desc;


-- ─────────────────────────────────────────────────────────────
-- LANGKAH 1B — kalau created_at tidak ada
--
-- Saring dari rentang tanggal mutasinya, lalu PERIKSA SATU per satu dan
-- buang dari daftar yang memang catatanmu sendiri sebelum ini.
-- ─────────────────────────────────────────────────────────────
-- select t.id, t.date, t.type, t.amount, t.description, w.name as dompet
--   from transactions t
--   left join wallets w on w.id = t.wallet_id
--  where t.user_id = 'GANTI-DENGAN-ID-DARI-LANGKAH-0'
--    and t.date between '2026-08-12' and '2026-08-16'
--  order by t.date desc;


-- ─────────────────────────────────────────────────────────────
-- LANGKAH 2 — batalkan, saldo dompet ikut dipulihkan
--
-- Tempel id yang BENAR-BENAR mau dibatalkan dari hasil langkah 1.
-- Fungsinya ada di supabase-telegram-konfirmasi-setup.sql, jadi jalankan
-- berkas itu lebih dulu.
--
-- Hasilnya berupa {"ok": true, "jumlah": N, "total": ...}
-- ─────────────────────────────────────────────────────────────
-- select batalkan_transaksi_batch(
--   'GANTI-DENGAN-ID-DARI-LANGKAH-0',
--   array[
--     'uuid-transaksi-1',
--     'uuid-transaksi-2',
--     'uuid-transaksi-3'
--   ]::uuid[]
-- );


-- ─────────────────────────────────────────────────────────────
-- LANGKAH 3 — pastikan saldo dompet sudah kembali seperti semula
-- ─────────────────────────────────────────────────────────────
-- select name, balance from wallets
--  where user_id = 'GANTI-DENGAN-ID-DARI-LANGKAH-0'
--  order by name;
