-- ============================================================
-- RMA Blaster — Supabase schema
-- Run this ONCE in your Supabase project:
--   Dashboard → SQL Editor → New query → paste → Run
-- ============================================================

-- RMA entries. Column names are snake_case; the app maps them
-- to/from the camelCase field names used since v1.
create table public.entries (
  id                 bigint generated always as identity primary key,
  email_id           text unique,       -- Gmail message id from v1 (kept for import dedup)
  rma_number         text not null,
  date               text,              -- YYYY-MM-DD (kept as text for v1 compatibility)
  dealer             text default '',
  make               text default '',
  model              text default '',
  serial_number      text default '',
  issue_description  text default '',
  issue_confirmed    text default '',
  warranty_status    text default '',
  course_of_action   text default '',
  date_of_resolution text default '',
  how_resolved       text default '',
  notes              text default '',
  replaced_from      text default '',
  status             text not null default 'Open',
  deleted            boolean not null default false,
  deleted_at         timestamptz,
  imported_at        timestamptz default now(),
  last_modified      timestamptz default now()
);

-- PDF metadata. The file bytes live in the 'rma-pdfs' storage bucket.
create table public.pdfs (
  id           bigint generated always as identity primary key,
  entry_id     bigint not null references public.entries(id) on delete cascade,
  filename     text not null,
  type         text not null default 'rma-form',   -- 'rma-form' | 'invoice'
  storage_path text not null,
  saved_at     timestamptz default now()
);

create index entries_rma_idx  on public.entries (rma_number);
create index entries_del_idx  on public.entries (deleted);
create index pdfs_entry_idx   on public.pdfs (entry_id);

-- Row Level Security: any signed-in team member has full access.
-- Sign-ups are disabled in Auth settings, so "authenticated" means
-- "a user Jim created in the dashboard".
alter table public.entries enable row level security;
alter table public.pdfs    enable row level security;

create policy "team full access entries"
  on public.entries for all to authenticated
  using (true) with check (true);

create policy "team full access pdfs"
  on public.pdfs for all to authenticated
  using (true) with check (true);

-- Private storage bucket for the PDF files themselves.
insert into storage.buckets (id, name, public) values ('rma-pdfs', 'rma-pdfs', false);

create policy "team read pdf files"
  on storage.objects for select to authenticated
  using (bucket_id = 'rma-pdfs');

create policy "team write pdf files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'rma-pdfs');

create policy "team delete pdf files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'rma-pdfs');
