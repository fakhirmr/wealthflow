-- ══════════════════════════════════════════════════════════════
-- WealthFlow — Setup Fitur Reminder (tagihan/cicilan/apa pun yang harus dibayar)
-- Jalankan SEKALI di Supabase Dashboard → SQL Editor → New query → Run
-- ══════════════════════════════════════════════════════════════

create table if not exists reminders (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  name        text        not null,
  amount      numeric     not null default 0,
  due_date    date,
  recurrence  text        not null default 'monthly',  -- 'once' | 'weekly' | 'monthly' | 'yearly'
  category_id uuid,
  notes       text,
  is_active   boolean     not null default true,
  last_paid   date,
  created_at  timestamptz not null default now()
);

-- Row Level Security: tiap user hanya bisa akses remindernya sendiri
alter table reminders enable row level security;

drop policy if exists "own reminders" on reminders;
create policy "own reminders"
  on reminders for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists reminders_user_due_idx on reminders (user_id, due_date);

-- Selesai. Tabel reminders siap dipakai.
