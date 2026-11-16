-- ============================================================
-- RMA Blaster: Phase 3, who wrote what
-- Run this ONCE in Supabase → SQL Editor, after schema.sql.
-- Safe to run again: every statement checks before it creates.
-- ============================================================
--
-- Every time an entry is created or saved, the DATABASE writes one row
-- here per field that changed: which login did it, when, what the field
-- said before and what it says now.
--
-- Why a database trigger and not the app:
--   The login is read from the signed-in session on the server, so the
--   browser cannot claim to be somebody else, and no version of the app
--   (or anything else talking to the database) can skip the log.
--
-- Why it holds up as a record:
--   Team logins can READ this table and nothing else. No insert, no
--   update, no delete. Only the trigger writes to it. The one way around
--   it is the Supabase dashboard itself, which only the project owner
--   can sign in to.
--
-- Not retroactive: edits made before this was run have no author on
-- record. History starts the moment you run it.
-- ============================================================

create table if not exists public.entry_history (
  id          bigint generated always as identity primary key,
  entry_id    bigint not null,        -- no foreign key on purpose: the log outlives the entry
  rma_number  text,
  changed_at  timestamptz not null default now(),
  user_id     uuid,                   -- auth.users id of the login
  user_email  text not null default '',
  action      text not null,          -- 'created' | 'imported' | 'edited'
  field       text not null,          -- database column name
  old_value   text,
  new_value   text
);

create index if not exists entry_history_entry_idx
  on public.entry_history (entry_id, id desc);

alter table public.entry_history enable row level security;

drop policy if exists "team read history" on public.entry_history;
create policy "team read history"
  on public.entry_history for select to authenticated using (true);

-- Belt and braces. With no insert/update/delete policy, RLS already refuses
-- those. TRUNCATE is not covered by RLS at all, so take the rights away too.
revoke insert, update, delete, truncate on public.entry_history from anon, authenticated;

create or replace function public.log_entry_change()
returns trigger
language plpgsql
security definer            -- runs as the table owner, so it can write the log
set search_path = ''        -- when the signed-in user cannot
as $$
declare
  cols text[] := array[
    'status', 'rma_number', 'date', 'dealer', 'make', 'model', 'serial_number',
    'issue_description', 'issue_confirmed', 'warranty_status',
    'course_of_action', 'date_of_resolution', 'how_resolved', 'notes',
    'replaced_from', 'deleted'
  ];
  col    text;
  old_j  jsonb := '{}'::jsonb;
  new_j  jsonb;
  old_v  text;
  new_v  text;
  act    text;
  who_id uuid;
  who    text;
begin
  -- A fault in the logging must never stop someone saving an RMA, so the
  -- whole body is guarded. If it ever trips, the save goes through and the
  -- reason shows up in Supabase → Logs → Postgres.
  begin
    new_j  := to_jsonb(new);
    who_id := auth.uid();
    -- No email means it did not come from a signed-in person: the SQL
    -- editor, the dashboard's table editor, or a service key.
    who    := coalesce(nullif(auth.jwt() ->> 'email', ''), 'system (not via the app)');

    if tg_op = 'UPDATE' then
      old_j := to_jsonb(old);
      act   := 'edited';
    elsif new.email_id is not null then
      -- Came in by email or from a backup file. The text is the dealer's,
      -- not the login's; the login is just whoever had the app open.
      act   := 'imported';
    else
      act   := 'created';
    end if;

    foreach col in array cols loop
      old_v := coalesce(old_j ->> col, '');
      new_v := coalesce(new_j ->> col, '');
      if tg_op = 'INSERT' and col = 'deleted' then
        old_v := 'false';
      end if;

      if old_v is distinct from new_v then
        insert into public.entry_history
          (entry_id, rma_number, user_id, user_email, action, field, old_value, new_value)
        values
          (new.id, new.rma_number, who_id, who, act, col, old_v, new_v);
      end if;
    end loop;
  exception when others then
    raise warning 'entry_history logging failed for entry %: %', new.id, sqlerrm;
  end;

  return null;   -- AFTER trigger: the return value is ignored
end;
$$;

drop trigger if exists entries_log_change on public.entries;
create trigger entries_log_change
  after insert or update on public.entries
  for each row execute function public.log_entry_change();
