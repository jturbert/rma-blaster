-- ============================================================
-- RMA Blaster: Phase 4, flags
-- Run this ONCE in Supabase → SQL Editor, after schema-phase3.sql.
-- Safe to run again.
-- ============================================================
--
-- Two things:
--   1. Adds a "flags" column to entries. It holds the ticked flags as
--      one comma-separated string of keys, e.g. "in-store,needs-repair".
--      The list of flags itself lives in flags.js, not here, so adding
--      a flag later needs no database change.
--   2. Replaces the history function from phase 3 with the same thing
--      plus 'flags' in its column list, so ticking or unticking a flag
--      is recorded against the login like any other change.
--
-- Existing entries are not touched: they simply start with no flags.
-- ============================================================

alter table public.entries
  add column if not exists flags text not null default '';

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
    'replaced_from', 'flags', 'deleted'
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
  -- reason shows up in Supabase, Logs, Postgres.
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

-- Tell the API layer about the new column straight away. Supabase normally
-- notices by itself; this just removes the wait.
notify pgrst, 'reload schema';
