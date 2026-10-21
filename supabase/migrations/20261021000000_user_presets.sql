-- Plugin presets saved to the user's account.
--
-- A preset is a named set of params for one plugin (src/audio/pluginPresets).
-- Factory presets ship in the code; only the user's own live here. The browser
-- reads and writes this table directly with the user's session — row-level
-- security is what keeps one user's presets out of another's hands, so every
-- policy below pins user_id to auth.uid().
--
-- `params` is the plugin's param object as the store's whitelist produced it.
-- The store re-normalises it on the way in AND out, so a row written by an
-- older build cannot push an out-of-range value at a kernel.

create table public.user_presets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  plugin_id   text not null check (char_length(plugin_id) between 1 and 80),
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  params      jsonb not null check (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 65536),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Saving under an existing name overwrites, as it did in localStorage.
  unique (user_id, plugin_id, name)
);

create index user_presets_user_plugin_idx on public.user_presets (user_id, plugin_id);

alter table public.user_presets enable row level security;

create policy "user_presets: read own"
  on public.user_presets for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "user_presets: insert own"
  on public.user_presets for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "user_presets: update own"
  on public.user_presets for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "user_presets: delete own"
  on public.user_presets for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.user_presets from anon;
grant select, insert, update, delete on public.user_presets to authenticated;

create trigger user_presets_touch before update on public.user_presets
  for each row execute function public.touch_updated_at();

-- A ceiling so one account cannot fill the table: 1000 presets per user.
create function public.enforce_user_preset_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.user_presets where user_id = new.user_id) >= 1000 then
    raise exception 'Preset limit reached (1000)' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger user_presets_limit before insert on public.user_presets
  for each row execute function public.enforce_user_preset_limit();
