-- ══════════════════════════════════════════════════════════════
-- WealthFlow — Setup Payment Gate (Midtrans, prepaid periode)
-- Jalankan SEKALI di Supabase Dashboard → SQL Editor → New query → Run
-- ══════════════════════════════════════════════════════════════

-- 1) Tanggal berakhirnya premium user (null/lampau = free)
alter table user_settings add column if not exists premium_until timestamptz;

-- 2) Log transaksi pembayaran
create table if not exists payments (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null references auth.users(id) on delete cascade,
  order_id                 text        not null unique,
  plan                     text        not null,              -- 'monthly' | 'yearly'
  amount                   numeric     not null,
  status                   text        not null default 'pending', -- pending | paid | failed
  midtrans_transaction_id  text,
  raw_notification         jsonb,
  created_at               timestamptz not null default now(),
  paid_at                  timestamptz
);

-- RLS: user hanya boleh MEMBACA riwayat pembayarannya sendiri.
-- Penulisan hanya oleh server (service role) — tidak ada policy insert/update,
-- sehingga customer tidak bisa memalsukan status "paid" dari browser.
alter table payments enable row level security;

drop policy if exists "read own payments" on payments;
create policy "read own payments"
  on payments for select
  using (auth.uid() = user_id);

create index if not exists payments_user_idx on payments (user_id);
create index if not exists payments_order_idx on payments (order_id);

-- Selesai. Kolom premium_until & tabel payments siap dipakai.
