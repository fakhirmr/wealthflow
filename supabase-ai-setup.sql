-- ══════════════════════════════════════════════════════════════
-- WealthFlow — Setup Kuota AI (Opsi B: provider terpusat)
-- Jalankan SEKALI di Supabase Dashboard → SQL Editor → New query → Run
-- ══════════════════════════════════════════════════════════════

-- 1) Tabel penghitung pemakaian AI per user per bulan
create table if not exists ai_usage (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  period     text        not null,              -- format 'YYYY-MM'
  count      int         not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, period)
);

-- 2) Row Level Security: user hanya boleh MEMBACA pemakaiannya sendiri.
--    Penulisan hanya dilakukan oleh server (service role) — tidak ada policy tulis,
--    sehingga customer tidak bisa memalsukan jumlah pemakaian dari browser.
alter table ai_usage enable row level security;

drop policy if exists "read own ai usage" on ai_usage;
create policy "read own ai usage"
  on ai_usage for select
  using (auth.uid() = user_id);

-- 3) Kolom plan di user_settings (default 'free'; set 'premium' untuk unlimited)
alter table user_settings add column if not exists ai_plan text not null default 'free';

-- 4) Fungsi increment atomik (dipanggil server setelah request AI sukses)
create or replace function increment_ai_usage(p_user uuid, p_period text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare new_count int;
begin
  insert into ai_usage (user_id, period, count)
  values (p_user, p_period, 1)
  on conflict (user_id, period)
  do update set count = ai_usage.count + 1, updated_at = now()
  returning count into new_count;
  return new_count;
end;
$$;

-- Selesai. Tabel ai_usage & kolom user_settings.ai_plan siap dipakai proxy.
