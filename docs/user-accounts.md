# User Accounts — Setup and Architecture

> Status: sign-in, `GET /api/me`, plans and feature gating, presets in the
> account, and Stripe billing (Checkout, the customer portal, webhooks) are
> built. Billing is off until its env vars are set; until then the upgrade
> prompt's button reads "coming soon".

## How it fits together

```
Browser (Vercel)                        API server (Linux)                Supabase
────────────────                        ──────────────────                ────────
supabase-js ── sign in / sign up ─────────────────────────────────────▶  Auth
   │  session (access token, refresh) kept in localStorage
   │
   └─ GET /api/me ─ Authorization: Bearer <access token> ─▶ verify JWT locally
                                                             (project JWKS)
                                                            read profile +   ──▶ Postgres
                                                            subscriptions        (service key)
                                         ◀─ { user, plan, subscription } ──
```

- **Supabase Auth** owns identity: email + password, magic link, password reset,
  and any OAuth providers you enable.
- **The API server** never sees a password. It verifies the access token's
  signature against the project's public keys (cached, no per-request call to
  Supabase) and reads the account with the service key.
- **The plan comes from the server, never the browser.** It is derived from the
  `subscriptions` table (`server/lib/plans.js`): no entitled subscription means
  `free`. Stripe webhooks (a later step) will be the only writer of that table.
- **Bearer tokens, not cookies**, because pre-production runs the frontend and
  API on different domains. The same code works unchanged once production puts
  them on one domain.

### Accounts are off until configured

With the Supabase variables unset, the frontend creates no client, makes no auth
requests and shows no sign-in button; the server answers `/api/me` with 503.
Every existing feature works signed out, with or without accounts configured.

## Setup

### 1. Supabase project

1. Create a project at supabase.com (one per environment is simplest: e.g.
   `wavely-staging`, `wavely-prod`).
2. Apply the schema — every file in `supabase/migrations/`, in name order
   (`…_accounts.sql`, then `…_user_presets.sql`) — via the Supabase CLI
   (`supabase link` then `supabase db push`) or by pasting each into the SQL
   editor.
3. **Authentication → URL Configuration**
   - *Site URL*: the app's main URL, e.g. `https://app.example.com`.
   - *Redirect URLs*: every origin the app is served from. Email links and OAuth
     return to the page the user started on, so include:
     - `http://localhost:5173/**` (local dev)
     - your staging URL, e.g. `https://staging.example.com/**`
     - Vercel previews, e.g. `https://*-<team>.vercel.app/**`
4. **Authentication → Providers**: email is on by default. Decide whether to
   require email confirmation (recommended for production). For Google, add the
   OAuth client ID/secret there, then set `VITE_AUTH_PROVIDERS=google` below.
5. **Authentication → Emails / SMTP**: the built-in mailer is heavily rate
   limited and meant for testing. Configure custom SMTP (Resend, Postmark, SES…)
   before real users sign up.

### 2. Frontend env (Vercel project settings, or `.env.local` for dev)

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the project's publishable key (`sb_publishable_…`). The legacy anon key also works, as `VITE_SUPABASE_ANON_KEY`. Public by design. |
| `VITE_AUTH_PROVIDERS` | optional, e.g. `google` — only providers enabled in the dashboard |
| `VITE_API_BASE_URL` | the API server's origin when it is on another domain, e.g. `https://api.crisp.fm`. Vite inlines it at build time, so redeploy after changing it. |

### 3. API server env (`server/.env`)

| Variable | Value |
|---|---|
| `SUPABASE_URL` | same project URL |
| `SUPABASE_SECRET_KEY` | the secret key (`sb_secret_…`), or the legacy `SUPABASE_SERVICE_ROLE_KEY`. **Server only — it bypasses row-level security.** |
| `SUPABASE_JWT_SECRET` | only if the project still signs tokens with the legacy HS256 secret. Projects on asymmetric JWT signing keys need nothing here. |
| `CORS_ORIGINS` | comma-separated exact frontend origins, e.g. `https://app.example.com,https://staging.example.com`. Unset falls back to the localhost dev origins, so it **must** be set in production. |
| `HOST` | interface Node listens on. Default `127.0.0.1`: only the reverse proxy on the same machine can reach it, which is what makes the per-IP rate limits trustworthy (`trust proxy` believes `X-Forwarded-For`). Point the proxy at `http://127.0.0.1:3001`. Set `0.0.0.0` only when the proxy runs on another host or container, and firewall the port to it. |
| `MAX_CONCURRENT_JOBS` / `MAX_QUEUED_JOBS` / `MAX_JOBS_PER_CLIENT` | mastering job queue (defaults 2 / 10 / 2) |
| `MAX_CONCURRENT_ANALYSES` / `MAX_ANALYSES_PER_CLIENT` | shared limit on `/api/spot` and `/api/analyze` (defaults 4 / 2). Full is refused (503 / 429) before the upload, never queued |
| `SUBPROCESS_TIMEOUT_MS` / `PROBE_TIMEOUT_MS` | kill limits for pipeline processes (defaults 60 min / 2 min) |
| `USAGE_RETENTION_DAYS` | days of `usage_events` rows to keep; the server deletes older ones daily (default 90, `0` keeps all) |
| `CORS_ORIGIN_PATTERNS` | comma-separated regexes for origins you can't list, i.e. Vercel preview URLs, e.g. `^https://wavely-app(-[a-z0-9-]+)?\.vercel\.app$`. Anchor with `^…$`: the check is `pattern.test(origin)`, so an unanchored pattern matches anywhere in the string. |

CORS lives **only in Express** (`server/index.js`). If Apache or another proxy
fronts the API, do not add `Access-Control-*` headers there as well: the browser
rejects a response with duplicate `Access-Control-Allow-Origin` values. The
proxy just has to forward `Origin` and `OPTIONS` requests to Node, which
`ProxyPass /api` does. Restart the Node process after changing either variable.

Billing return URLs (Checkout and the customer portal) are checked against this
same allowlist, so a frontend origin missing here breaks billing as well as API
calls. A rejected origin is logged as `CORS rejected origin: …`.

## What's in the code

| Piece | Where |
|---|---|
| Schema, RLS, sign-up trigger | `supabase/migrations/20261020000000_accounts.sql` |
| Token verification, `optionalAuth` / `requireAuth` middleware | `server/lib/auth.js` |
| Plan resolution from subscriptions | `server/lib/plans.js` |
| Service-key client, account loader | `server/lib/supabaseAdmin.js` |
| `GET /api/me` | `server/routes/me.js` |
| Build-time switch and env | `src/auth/config.js` |
| Auth state machine (session, account, dialog) | `src/auth/authStore.js`, via `useAuth()` |
| Sign-in / sign-up / reset dialog | `src/components/AuthDialog.vue` |
| Top-bar account control | `src/components/AccountMenu.vue` |
| Plan/feature table (shared with the server) | `src/auth/plans.js` |
| Client entitlement checks | `src/auth/entitlements.js`, via `useEntitlements()` |
| Upgrade prompt | `src/components/UpgradeDialog.vue` |
| Server enforcement + free preview | `server/lib/entitlements.js` |
| Account preset storage | `src/auth/presetBackend.js`, `supabase/migrations/…_user_presets.sql` |
| Usage history, account blocking | `server/lib/usage.js`, `server/lib/requestLog.js`, `supabase/migrations/…_usage_and_blocking.sql` |

### Database rules worth knowing

- `profiles`: one row per user, created by a trigger at sign-up. Users can read
  their own row and update **only** `display_name` (column privilege); the
  Stripe customer id is server-written.
- `subscriptions`: users can read their own rows; only the server writes them.
  Entitled statuses are `active`, `trialing` and `past_due` (the dunning window).
- `usage_events`: one row per served server-processing request; users can read
  their own rows, only the server writes them.
- `profiles.blocked_at` / `blocked_reason`: operator-only (outside the
  `display_name` column grant).

### Client behaviour worth knowing

- **OAuth runs in a popup**, not a redirect, so signing in never navigates the
  editor away from unsaved work. If the popup is blocked it falls back to a
  redirect (the unsaved-work guard still asks first).
- **Magic links and confirmation links open in a new tab**; the editor tab
  signs in too (supabase-js syncs tabs). Because the flow is PKCE, the link must
  be opened in the same browser it was requested from.
- `useAuth().getAccessToken()` returns the current token for calls to our API.
  The analysis and spot-effect calls send it (`src/api/serverError.js`).

## Plans and feature gating

**One table, `src/auth/plans.js`, read by both the app and the API server.**
Each feature names the lowest plan that unlocks it; higher plans inherit it.
The ladder is: signed out → `free` (any account) → `pro`.

| Feature id | Needs | What it gates | Enforced by |
|---|---|---|---|
| `savePresets` | account | Saving plugin presets | UI and database (RLS) |
| `pluginChainApply` | Pro | Plugin Chain **Apply**. Preview is free | UI only |
| `autoLevel` | Pro | Auto Leveler analysis and Apply. Free account: 30 s preview; signed out: nothing | **Server** (`/api/analyze/vad`) |
| `sibilanceEditor` | Pro | Sibilance Editor analysis and Apply. Free account: 30 s preview; signed out: nothing | **Server** (`/api/analyze/sibilance`) |
| `spotEffects` | Pro | `/api/spot/*` (no callers today). Free account: 30 s preview; signed out: nothing | **Server** |
| `mastering` | account | Preset mastering chain (`/api/process`). Signed out: the 30 s preview only | **Server** (`/api/process`) |

- **Adding a gate:** add an entry to `FEATURES`, then use it in the UI.
  - `apply-feature="<id>"` on a `FloatingWindow` locks its Apply button.
  - `feature: '<id>'` on a registry entry shows a PRO tag in the rail and the command palette.
  - `useEntitlements().request('<id>')` guards any action in code.
- **Adding a tier:** add it to `PLAN_ORDER` and move the `requires` of the
  features it unlocks.
- **Accounts off means no gating.** The app allows everything, and the
  server's gate lets every request through.

### Free previews of server features

Server features accept non-entitled requests on up to `FREE_PREVIEW_SECONDS`
(30) of audio, so the result can be heard before paying. Who gets the preview
is the feature's `preview` field: `'account'` (any signed-in user — Auto
Leveler, Sibilance Editor, spot effects) or `'anyone'` (signed out too — only
`mastering`, the first-run experience). Server time spent on an anonymous
visitor can only be limited per IP, so a new server feature should default to
`'account'`.

- **Server side:** `server/lib/entitlements.js` reads the uploaded file's
  duration with ffprobe and does not trust the client.
  - A signed-out request for a feature with nothing open to them gets **401**
    `{ code: 'sign_in_required', feature }` from `gate.signIn`, which runs
    BEFORE multer, so the upload is never read.
  - A longer upload without Pro gets **402** with `{ code: 'upgrade_required', feature, requires, previewSeconds }`.
  - If the duration can't be read, the request is refused.
  - Plans are cached per user for 60 s.
- **App side:** a signed-out user who presses Analyse gets the sign-in dialog
  (`requestPreview`) and the caption says a free account previews 30 s. A
  signed-in non-Pro user's selection is narrowed to its first 30 s before
  anything is uploaded, and a caption says so. Apply stays Pro. A 402 opens the
  upgrade prompt — or the sign-in dialog when the feature only needs an account
  (`requires: 'free'`); a 401 `sign_in_required` opens the sign-in dialog. Mastering cannot narrow a
  whole file, so a signed-out user with more than 30 s is asked to sign in
  before the upload.

### Investigating and blocking an account

Every request to `/api/process`, `/api/spot` and `/api/analyze` — served or
refused — writes one JSON line to the server's stdout (`server/lib/requestLog.js`):

```
{"evt":"api","t":"2026-10-26T18:02:11.204Z","route":"/api/analyze/vad","user":"<uuid>","ip":"203.0.113.9","status":200,"code":null,"feature":"autoLevel","mode":"preview","bytes":2817212,"audio_s":29.8,"ms":812}
```

`code` is the refusal code (`rate_limited`, `sign_in_required`,
`upgrade_required`, `too_many_jobs`, `server_busy`, `account_blocked`) and
`user` is null for a signed-out caller. Keep these logs: whatever runs Node
(systemd's journal, pm2, Docker) must retain stdout, or they are gone at the
next restart. Find one account's requests with, e.g.,
`journalctl -u wavely -o cat | grep '"evt":"api"' | jq 'select(.user == "<uuid>")'`.

Each SERVED request (or server failure) also writes a `usage_events` row —
for mastering, when the job ends. Refusals are only in the log. One account's
last week:

```sql
select feature, mode, count(*) as requests,
       round(sum(audio_seconds) / 60) as audio_minutes
from public.usage_events
where user_id = '<uuid>' and created_at > now() - interval '7 days'
group by feature, mode
order by audio_minutes desc nulls last;
```

The heaviest accounts:

```sql
select user_id, count(*) as requests, round(sum(audio_seconds) / 60) as audio_minutes
from public.usage_events
where created_at > now() - interval '24 hours'
group by user_id
order by audio_minutes desc nulls last
limit 20;
```

**To block an account** from server processing (the SQL editor runs as an
operator):

```sql
update public.profiles
set blocked_at = now(), blocked_reason = 'what happened, and the ticket/date'
where id = '<uuid>';
```

The server re-reads the flag at least once a minute, then answers every server
feature with **403** `{ code: 'account_blocked' }`, before the upload is read.
Clear both columns to unblock. Blocking does not sign the user out or touch
their subscription — cancel or refund that in Stripe if you need to, and ban
them in Supabase Auth (Authentication → Users) if they should not sign in at
all; a ban alone leaves their current access token valid for up to an hour,
which is what the flag closes. A failed flag lookup lets the request through
(a database hiccup must not lock everyone out).

### Limits of browser-side gates

Browser-side gates are product limits, not security. The DSP ships to every
visitor, so a determined user can get around a hidden Apply. Only server
features are actually enforced.

## Presets in the account

- **Accounts on, signed in:** user presets are rows in `public.user_presets`,
  one per (user, plugin, name). The browser reads and writes them with the
  user's own session, under RLS.
  - Saving shows up in the menu immediately.
  - A failed write is rolled back and shown as a toast.
  - Each user can save up to 1000 presets.
- **Accounts on, signed out:** there are no user presets. "Save as…" reads
  "Sign in to save presets…" and opens sign-up. There is no browser-only
  fallback (owner's call), and presets saved earlier in `localStorage` are not
  migrated.
- **Accounts off:** presets save to `localStorage` exactly as before.
- **Code:** the store (`src/audio/pluginPresets/store.js`) has pluggable
  backends: `local`, `account` (`src/auth/presetBackend.js`) and `none`.
  `useAuth` switches between them as the session changes.

## Billing (Stripe)

### How it works

```
Upgrade prompt ──POST /api/billing/checkout──▶ server ──▶ Stripe Checkout session
   │  (opens a NEW TAB, so unsaved edits stay put)            │
   ▼                                                           ▼
 new tab: Stripe Checkout ── pays ──▶ returns to app?checkout=success&session_id=…
                                        │ POST /api/billing/checkout/complete
                                        │   → server re-fetches the subscription, upserts the row
                                        │ BroadcastChannel → editor tab reloads /api/me → Pro
                                        └ the tab closes itself
Stripe ──webhook──▶ POST /api/billing/webhook ──▶ same sync (renewals, cancels, failed cards)
```

- **One sync for every path.** The webhook and the checkout return both call
  `syncSubscription(id)`. It **re-fetches** the subscription from Stripe rather
  than trusting the event's payload, so events that arrive late, twice or out of
  order all settle on Stripe's current state.
- **Ownership.** Each user gets one Stripe customer, stored as
  `profiles.stripe_customer_id`. The user id travels on the Checkout session
  and in the subscription's metadata.
- **Plans come from config.** Price ids map to plans through env vars. A price
  the server doesn't know is stored as `unknown` and grants nothing.
- **No double billing.** Checkout is refused (409) while the user has an active
  subscription. Switching monthly ↔ yearly and cancelling happen in Stripe's
  customer portal ("Manage billing" in the account menu).
- **Return URLs** are checked against the CORS allowlist, so Checkout can't be
  used as an open redirect.
- **Plan changes apply immediately.** A sync clears the server's cached plan
  for that user, so the server stops refusing Pro requests at once.

### Setup

1. **Product and prices.** In Stripe (test mode first), create a product "Pro"
   with a recurring monthly price and/or a yearly one.
2. **Customer portal.** In Settings → Billing → Customer portal, enable:
   - updating the payment method,
   - cancelling (at period end),
   - switching between the Pro prices.
3. **Webhook.** Add an endpoint `https://<api-host>/api/billing/webhook`
   listening for:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.subscription.paused`
   - `customer.subscription.resumed`

   Copy its signing secret.
4. **Server env** (`server/.env`):

   | Variable | Value |
   |---|---|
   | `STRIPE_SECRET_KEY` | `sk_test_…` / `sk_live_…` (or a restricted key with Customers, Checkout Sessions, Billing Portal and Subscriptions write, Prices read) |
   | `STRIPE_WEBHOOK_SECRET` | the endpoint's `whsec_…` |
   | `STRIPE_PRICE_PRO_MONTHLY` | `price_…` (optional if yearly is set) |
   | `STRIPE_PRICE_PRO_YEARLY` | `price_…` (optional if monthly is set) |

   Billing switches on only when accounts are configured too (Supabase vars).
   The frontend needs no new variables: it asks `GET /api/billing/prices`
   whether billing is on and what it costs.
5. **Local testing:**

   ```
   stripe listen --forward-to localhost:3001/api/billing/webhook
   ```

   Put the secret this prints in `STRIPE_WEBHOOK_SECRET`, then pay with card
   `4242 4242 4242 4242`.

### Code

| Piece | Where |
|---|---|
| Sync, customer, Checkout, portal, prices | `server/lib/billing.js` |
| Routes + webhook (raw body, mounted before `express.json()`) | `server/routes/billing.js` |
| Browser client, new-tab flow, return handling | `src/auth/billing.js`, via `useBilling()` |
| Upgrade prompt (prices, monthly/yearly) | `src/components/UpgradeDialog.vue` |
| Account menu (Upgrade / Manage billing / renewal date) | `src/components/AccountMenu.vue` |

## Next steps

1. **Optional:** gate the preset chain (`/api/process`). It isn't listed as Pro
   today.
2. **Export tiers** (MP3 128 kbps free, WAV for paid — see CLAUDE.md "Freemium
   Gates"), once pricing is settled.
