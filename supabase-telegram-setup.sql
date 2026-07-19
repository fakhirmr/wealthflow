-- ══════════════════════════════════════════════════════════════
-- WealthFlow — Setup Integrasi Telegram (catat keuangan via chat bot)
-- Jalankan SEKALI di Supabase Dashboard → SQL Editor → New query → Run
-- ══════════════════════════════════════════════════════════════

create table if not exists telegram_links (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  chat_id    bigint      unique,
  link_code  text,
  linked     boolean     not null default false,
  created_at timestamptz not null default now()
);

-- RLS: user hanya bisa akses baris miliknya; server (service role) bypass RLS
alter table telegram_links enable row level security;

drop policy if exists "own telegram link" on telegram_links;
create policy "own telegram link"
  on telegram_links for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists telegram_links_code_idx on telegram_links (link_code);
create index if not exists telegram_links_chat_idx on telegram_links (chat_id);

-- Selesai. Tabel telegram_links siap.
