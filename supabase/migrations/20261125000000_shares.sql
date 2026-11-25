-- Shared before / after listens (`/s/<id>`).
--
-- A share is two MP3s of the same span — the dry audio and the audio through
-- the sender's Plugin Chain — plus the chain itself (the saved-chain JSON,
-- src/audio/pluginPresets/pluginChain.js), a title and a note. Anyone with the
-- link can listen and open it in the editor; nobody can LIST shares.
--
-- How the link stays unlisted:
--   · the table has no select policy for anon: a share is read through
--     `get_share(id)`, which returns one row for one id and nothing else;
--   · the bucket is public for DOWNLOAD by exact path (that is how the listen
--     page streams the audio) but has no select policy on storage.objects, so
--     the storage API cannot list it;
--   · ids are 12 random base62 characters (~71 bits), made by the browser.
--
-- Writing order (src/api/shares.js): insert the row (ready = false) → upload
-- `<id>/dry.mp3` and `<id>/wet.mp3`, which the storage policy allows only for
-- the row's owner while it is not ready → mark it ready. `get_share` returns
-- ready rows only, so a half-made share is never served. Deleting goes the
-- other way: the objects first (their policy checks the row), then the row.
--
-- Creating one needs Pro, checked HERE (`has_paid_plan`), not only in the UI:
-- the processed MP3 is downloadable from the listen page, so a share is a way
-- to export the chain's output, which is a Pro feature (`pluginChainApply`).

-- ─── plan check ──────────────────────────────────────────────────────────────

-- ⚠ MIRRORS server/lib/plans.js (ENTITLED_STATUSES, PAID_PLANS): a paid plan
-- is a subscription in one of these statuses. Change both together.
create function public.has_paid_plan(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = uid
      and s.plan = 'pro'
      and s.status in ('active', 'trialing', 'past_due')
  );
$$;

revoke all on function public.has_paid_plan(uuid) from public, anon;
grant execute on function public.has_paid_plan(uuid) to authenticated;

-- ─── shares ──────────────────────────────────────────────────────────────────

create table public.shares (
  id            text primary key check (id ~ '^[A-Za-z0-9]{12}$'),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title         text not null check (char_length(btrim(title)) between 1 and 80),
  note          text not null default '' check (char_length(note) <= 500),
  -- The saved-chain params ({ slots: [...] }). Re-checked by every plugin's
  -- own whitelist when the editor loads it, like a saved preset.
  chain         jsonb not null check (jsonb_typeof(chain) = 'object' and pg_column_size(chain) <= 65536),
  seconds       real not null check (seconds > 0 and seconds <= 600),
  -- Gated RMS of each take, for the player's "Match levels".
  level_off_db  real,
  level_on_db   real,
  ready         boolean not null default false,
  created_at    timestamptz not null default now()
);

create index shares_user_id_idx on public.shares (user_id, created_at desc);

alter table public.shares enable row level security;

create policy "shares: read own"
  on public.shares for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "shares: insert own, paid plan"
  on public.shares for insert
  to authenticated
  with check ((select auth.uid()) = user_id and not ready and public.has_paid_plan((select auth.uid())));

-- Only `ready` can change, and only to true (column grant below).
create policy "shares: mark own ready"
  on public.shares for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id and ready);

create policy "shares: delete own"
  on public.shares for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.shares from anon, authenticated;
grant select, delete on public.shares to authenticated;
grant insert (id, title, note, chain, seconds, level_off_db, level_on_db) on public.shares to authenticated;
grant update (ready) on public.shares to authenticated;

-- A ceiling so one account cannot fill the bucket: 50 shares per user
-- (at most 50 × 2 × ~15 MB). Deleting one frees its place.
create function public.enforce_share_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.shares where user_id = new.user_id) >= 50 then
    raise exception 'Share limit reached (50). Delete an old share first.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger shares_limit before insert on public.shares
  for each row execute function public.enforce_share_limit();

-- One share by its id, for anyone with the link (the listen page, the editor's
-- "Open in crisp.fm"). Never the owner's id.
create function public.get_share(share_id text)
returns table (
  id text, title text, note text, chain jsonb, seconds real,
  level_off_db real, level_on_db real, created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.title, s.note, s.chain, s.seconds, s.level_off_db, s.level_on_db, s.created_at
  from public.shares s
  where s.id = share_id and s.ready;
$$;

revoke all on function public.get_share(text) from public;
grant execute on function public.get_share(text) to anon, authenticated;

-- ─── storage ─────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shares', 'shares', true, 26214400, array['audio/mpeg'])
on conflict (id) do nothing;

-- Upload: `<share id>/dry.mp3` or `<share id>/wet.mp3`, by the share's owner,
-- while the share is not yet ready.
create policy "shares bucket: owner uploads before ready"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'shares'
    and storage.filename(name) in ('dry.mp3', 'wet.mp3')
    and array_length(storage.foldername(name), 1) = 1
    and exists (
      select 1 from public.shares s
      where s.id = (storage.foldername(name))[1]
        and s.user_id = (select auth.uid())
        and not s.ready
    )
  );

-- Delete: the share's owner, while the row still exists (objects go first).
create policy "shares bucket: owner deletes"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'shares'
    and exists (
      select 1 from public.shares s
      where s.id = (storage.foldername(name))[1]
        and s.user_id = (select auth.uid())
    )
  );

-- ⚠ Deleting an ACCOUNT cascades to its share rows but not to their objects
-- (storage has no foreign key to them). The objects can no longer be found
-- without the ids; sweep `shares/` for folders with no row when accounts are
-- deleted (docs/user-accounts.md).
