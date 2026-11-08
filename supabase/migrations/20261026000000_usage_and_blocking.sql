-- Usage history and account blocking — the tools for dealing with a signed-in
-- account that abuses server processing.
--
--   usage_events          one row per SERVED server-processing request
--                         (mastering, spot effects, analyses), written ONLY by
--                         the API server (service role). Refusals are not
--                         stored here; they are in the server's request log.
--   profiles.blocked_at   set by an operator to cut an account off server
--                         processing. The API server checks it (cached ≤ 60 s)
--                         and answers 403 account_blocked.
--
-- Retention: the API server deletes usage rows older than USAGE_RETENTION_DAYS
-- (default 90) once a day. A row holds an account id and an IP address, which
-- is personal data — keep the window as short as investigations allow.
--
-- Apply with the Supabase CLI (`supabase db push`) or paste into the SQL editor.

-- ─── usage_events ────────────────────────────────────────────────────────────

create table public.usage_events (
  id             bigint generated always as identity primary key,
  -- Null for a signed-out mastering preview (the one feature open to them).
  user_id        uuid references auth.users (id) on delete cascade,
  ip             inet,
  -- Feature id from src/auth/plans.js ('mastering', 'autoLevel', …).
  feature        text not null check (char_length(feature) between 1 and 64),
  -- 'full' (entitled) or 'preview' (≤ the free preview length).
  mode           text check (mode in ('full', 'preview')),
  -- Decoded length of the upload; null if it could not be read.
  audio_seconds  real check (audio_seconds is null or audio_seconds >= 0),
  upload_bytes   bigint check (upload_bytes is null or upload_bytes >= 0),
  -- 'ok' when the work completed, 'error' when the server failed it.
  outcome        text not null check (outcome in ('ok', 'error')),
  duration_ms    integer check (duration_ms is null or duration_ms >= 0),
  created_at     timestamptz not null default now()
);

-- Per-account history ("what did this user run this week?") and, later,
-- quotas: both read one user's newest rows first.
create index usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc);

-- Retention deletes by age across all users; BRIN is tiny on an append-only
-- table whose rows arrive in created_at order.
create index usage_events_created_brin
  on public.usage_events using brin (created_at);

alter table public.usage_events enable row level security;

-- A user may see their own usage (for a future "your usage" page); nobody but
-- the service role writes.
create policy "usage_events: read own"
  on public.usage_events for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.usage_events from anon;
revoke insert, update, delete on public.usage_events from authenticated;

-- ─── profiles: blocking ──────────────────────────────────────────────────────

-- The existing column grants already keep these out of the user's reach:
-- authenticated may update only display_name.
alter table public.profiles
  add column blocked_at     timestamptz,
  add column blocked_reason text check (blocked_reason is null or char_length(blocked_reason) <= 500);

-- To block:    update public.profiles
--                set blocked_at = now(), blocked_reason = '…'
--                where id = '<user uuid>';
-- To unblock:  update public.profiles
--                set blocked_at = null, blocked_reason = null
--                where id = '<user uuid>';
