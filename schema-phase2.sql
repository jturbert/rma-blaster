-- ============================================================
-- RMA Blaster — Phase 2: inbound email queue
-- Run this ONCE in Supabase → SQL Editor, after schema.sql
-- ============================================================
--
-- How ingestion works:
--   Gmail forwards an RMA email → Postmark receives it →
--   Postmark POSTs it to the 'inbound-email' Edge Function →
--   the function drops the raw email + its PDFs into this table
--   (it does NO parsing) → the app parses pending rows using the
--   same PDF parser it has always used, and creates the entries.
--
-- Keeping all parsing in the app means one implementation of the
-- Dune Blue form parser, not two that can drift apart.
-- ============================================================

create table public.pending_emails (
  id            bigint generated always as identity primary key,
  message_id    text unique,          -- original Message-ID header (dedup key)
  subject       text,
  from_address  text,
  sent_at       text,                 -- raw Date header; the app parses it
  text_body     text,                 -- used to recover forwarded-message dates
  attachments   jsonb not null default '[]',  -- [{filename, storagePath, contentType}]
  status        text  not null default 'pending',  -- pending | processed | ignored | error
  error         text,
  entry_id      bigint references public.entries(id) on delete set null,
  received_at   timestamptz default now(),
  processed_at  timestamptz
);

create index pending_status_idx on public.pending_emails (status);

alter table public.pending_emails enable row level security;

-- Signed-in team members can read the queue and mark rows processed.
-- The Edge Function writes with the service-role key, which bypasses RLS.
create policy "team read pending"
  on public.pending_emails for select to authenticated using (true);

create policy "team update pending"
  on public.pending_emails for update to authenticated
  using (true) with check (true);

create policy "team delete pending"
  on public.pending_emails for delete to authenticated using (true);
