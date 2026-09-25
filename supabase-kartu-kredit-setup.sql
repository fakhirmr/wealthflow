-- ══════════════════════════════════════════════════════════════
-- WealthFlow — Tagihan Kartu Kredit
-- Jalankan SEKALI di Supabase Dashboard → SQL Editor → New query → Run
-- ══════════════════════════════════════════════════════════════
--
-- KENAPA TAGIHAN KARTU BUKAN HUTANG BIASA
--
-- Belanja kartu dicatat sebagai pengeluaran dengan wallet_id = dompet kartu,
-- jadi saldo dompet itu menjadi MINUS sebesar yang terutang. Rumus kekayaan
-- bersih menjumlahkan seluruh saldo dompet lalu MENGURANGI sisa hutang:
--
--     kekayaan = Σ saldo dompet + investasi − Σ sisa hutang
--
-- Kalau tagihan kartu ditambahkan sebagai baris hutang biasa, kewajiban yang
-- sama dikurangkan DUA KALI: sekali lewat saldo kartu yang minus, sekali lagi
-- lewat baris hutangnya. Kolom kartu_wallet di bawah menandai baris seperti
-- itu supaya bisa dikecualikan dari pengurangan, tanpa menghilangkannya dari
-- halaman Hutang tempat pengguna memang ingin melihatnya.

-- 1) Penanda & penghubung ke dompet kartu
alter table debts add column if not exists kartu_wallet uuid references wallets(id) on delete set null;
alter table debts add column if not exists periode      text;   -- 'YYYY-MM', periode tagihan

comment on column debts.kartu_wallet is
  'Dompet kartu kredit yang ditagih. Terisi berarti kewajibannya SUDAH terwakili oleh saldo minus dompet itu, jadi baris ini tidak boleh ikut mengurangi kekayaan bersih.';
comment on column debts.periode is
  'Periode tagihan YYYY-MM. Dipakai supaya membaca ulang lembar yang sama memperbarui baris yang ada, bukan membuat baris kedua.';

-- 2) Satu tagihan per kartu per periode.
--    Tanpa ini, membaca ulang lembar yang sama (hal yang wajar dilakukan kalau
--    hasil baca pertama kurang pas) menumpuk tagihan kembar yang diam-diam
--    menggandakan kewajiban di halaman Hutang.
create unique index if not exists debts_kartu_periode_uniq
  on debts (user_id, kartu_wallet, periode)
  where kartu_wallet is not null and periode is not null;

-- 3) Pencarian transaksi saat mendeteksi duplikat.
--    Pencocokan dilakukan per dompet dalam rentang tanggal tagihan; tanpa indeks
--    ini setiap pembacaan lembar memindai seluruh tabel transaksi pengguna.
create index if not exists transactions_wallet_date_idx
  on transactions (user_id, wallet_id, date);

-- Selesai.
