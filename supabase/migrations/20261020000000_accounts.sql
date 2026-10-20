-- User accounts: profiles and subscriptions.
--
-- Supabase Auth owns identity (auth.users). This migration adds the two tables
-- the app reads about a signed-in user:
--
--   profiles       one row per user, created automatically at sign-up.
--   subscriptions  one row per Stripe subscription, written ONLY by the API
--                  server (service role) from Stripe webhooks.
--
-- The plan a user is on is DERIVED from their subscriptions, never stored as a
-- column the client could reach: a user with no active subscription is on
-- 'free'. That keeps billing state single-sourced in Stripe — a cancelled or
-- lapsed subscription takes the plan away without anyone remembering to flip a
-- flag.
--
-- Apply with the Supabase CLI (`supabase db push`) or paste into the SQL editor.

-- ─── profiles ────────────────────────────────────────────────────────────────

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text,
  display_name  text check (display_name is null or char_length(display_name) <= 80),
  -- Set when the first Stripe Checkout runs; one customer per user for life.
  stripe_customer_id text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read own"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "profiles: update own"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- RLS decides WHICH rows; column privileges decide WHICH columns. Without this
-- a user could write their own stripe_customer_id and claim someone else's
-- billing. Only the display name is user-editable.
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

-- ─── subscriptions ───────────────────────────────────────────────────────────

create table public.subscriptions (
  -- Stripe's subscription id (sub_…), so webhook upserts are idempotent.
  id                    text primary key,
  user_id               uuid not null references auth.users (id) on delete cascade,
  -- App plan id ('pro', …), resolved from the Stripe price at webhook time.
  plan                  text not null,
  -- Stripe's status verbatim: trialing, active, past_due, canceled, unpaid, …
  status                text not null,
  stripe_price_id       text,
  current_period_end    timestamptz,
  cancel_at_period_end  boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index subscriptions_user_id_idx on public.subscriptions (user_id);

alter table public.subscriptions enable row level security;

create policy "subscriptions: read own"
  on public.subscriptions for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke insert, update, delete on public.subscriptions from anon, authenticated;

-- ─── housekeeping ────────────────────────────────────────────────────────────

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- Create the profile row at sign-up. SECURITY DEFINER because the inserting
-- role is Supabase Auth's, which has no grant on public.profiles.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    nullif(left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''), 80), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep the copied email in step when a user changes it.
create function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function public.handle_user_email_change();
