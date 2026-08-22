-- ══════════════════════════════════════════════════════════════
-- WealthFlow — Melihat daftar pengguna
-- Cara pakai: Supabase Dashboard → SQL Editor → New query →
--             tempel SALAH SATU blok di bawah → Run
--
-- Catatan zona waktu: tanggal ditampilkan dalam WITA (UTC+8) supaya
-- enak dibaca. TAPI join ke ai_usage memakai bulan UTC, karena
-- api/ai.js & api/telegram.js menulis period dengan
-- toISOString().slice(0,7) yang mengikuti UTC. Kalau di sini dipakai
-- bulan WITA, angka pemakaian AI akan meleset tiap tanggal 1
-- antara pukul 00:00–08:00.
-- ══════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────
-- 1) DAFTAR PENGGUNA LENGKAP  (yang paling sering dipakai)
-- ─────────────────────────────────────────────────────────────
select
  u.email,
  to_char(u.created_at      at time zone 'Asia/Makassar', 'DD Mon YYYY HH24:MI') as daftar_pada,
  to_char(u.last_sign_in_at at time zone 'Asia/Makassar', 'DD Mon YYYY HH24:MI') as terakhir_masuk,
  case when u.email_confirmed_at is null then 'BELUM' else 'ya' end              as email_terverifikasi,
  case
    when s.premium_until > now()
      then 'Premium s/d ' || to_char(s.premium_until at time zone 'Asia/Makassar', 'DD Mon YYYY')
    else 'Gratis'
  end                                                                            as paket,
  coalesce(a.count, 0)                                                           as ai_bulan_ini,
  case when t.linked then 'ya' else '-' end                                      as telegram,
  coalesce(tx.jml, 0)                                                            as jml_transaksi
from auth.users u
left join user_settings  s on s.user_id = u.id
left join telegram_links t on t.user_id = u.id
left join ai_usage       a on a.user_id = u.id
                          and a.period  = to_char(now() at time zone 'UTC', 'YYYY-MM')
left join (
  select user_id, count(*) as jml from transactions group by user_id
) tx on tx.user_id = u.id
order by u.created_at desc;


-- ─────────────────────────────────────────────────────────────
-- 2) RINGKASAN SATU BARIS  (untuk lihat pertumbuhan sekilas)
-- ─────────────────────────────────────────────────────────────
select
  count(*)                                                              as total_user,
  count(*) filter (where u.email_confirmed_at is not null)              as terverifikasi,
  count(*) filter (where s.premium_until > now())                       as premium_aktif,
  count(*) filter (where t.linked)                                      as pakai_telegram,
  count(*) filter (where u.created_at > now() - interval '7 days')      as daftar_7_hari,
  count(*) filter (where u.last_sign_in_at > now() - interval '7 days') as aktif_7_hari
from auth.users u
left join user_settings  s on s.user_id = u.id
left join telegram_links t on t.user_id = u.id;


-- ─────────────────────────────────────────────────────────────
-- 3) PENGGUNA YANG DAFTAR TAPI TIDAK PERNAH MENCATAT
--    Berguna untuk tahu di mana calon pelanggan berhenti.
-- ─────────────────────────────────────────────────────────────
select
  u.email,
  to_char(u.created_at at time zone 'Asia/Makassar', 'DD Mon YYYY HH24:MI') as daftar_pada
from auth.users u
where not exists (select 1 from transactions t where t.user_id = u.id)
order by u.created_at desc;


-- ─────────────────────────────────────────────────────────────
-- 4) PEMBAYARAN YANG MASUK
-- ─────────────────────────────────────────────────────────────
select
  u.email,
  p.order_id,
  p.plan,
  p.amount,
  p.status,
  to_char(p.paid_at at time zone 'Asia/Makassar', 'DD Mon YYYY HH24:MI') as dibayar_pada
from payments p
join auth.users u on u.id = p.user_id
order by p.created_at desc;


-- ─────────────────────────────────────────────────────────────
-- 5) PEMAKAI AI TERBANYAK BULAN INI
--    Kalau ada yang mendekati batas (30 gratis / 500 premium),
--    dialah yang paling mungkin mau naik paket.
-- ─────────────────────────────────────────────────────────────
select
  u.email,
  a.count as pemakaian,
  case when s.premium_until > now() then 500 else 30 end as batas
from ai_usage a
join auth.users u on u.id = a.user_id
left join user_settings s on s.user_id = a.user_id
where a.period = to_char(now() at time zone 'UTC', 'YYYY-MM')
order by a.count desc;
