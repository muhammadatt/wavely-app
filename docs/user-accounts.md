# User Accounts — Setup and Architecture

> Status: sign-in, `GET /api/me`, plans and feature gating, and presets in the
> account are built. Stripe billing (checkout, portal, webhooks) is next — until
> then the upgrade prompt's button reads "coming soon".

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
| `VITE_API_BASE_URL` | already used: the API server's origin when it is on another domain |

### 3. API server env (`server/.env`)

| Variable | Value |
|---|---|
| `SUPABASE_URL` | same project URL |
| `SUPABASE_SECRET_KEY` | the secret key (`sb_secret_…`), or the legacy `SUPABASE_SERVICE_ROLE_KEY`. **Server only — it bypasses row-level security.** |
| `SUPABASE_JWT_SECRET` | only if the project still signs tokens with the legacy HS256 secret. Projects on asymmetric JWT signing keys need nothing here. |
| `CORS_ORIGINS` / `CORS_ORIGIN_PATTERNS` | must include the frontend origin(s), as today. |

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

### Database rules worth knowing

- `profiles`: one row per user, created by a trigger at sign-up. Users can read
  their own row and update **only** `display_name` (column privilege); the
  Stripe customer id is server-written.
- `subscriptions`: users can read their own rows; only the server writes them.
  Entitled statuses are `active`, `trialing` and `past_due` (the dunning window).

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
| `autoLevel` | Pro | Auto Leveler analysis and Apply | **Server** (`/api/analyze/vad`) |
| `sibilanceEditor` | Pro | Sibilance Editor analysis and Apply | **Server** (`/api/analyze/sibilance`) |
| `spotEffects` | Pro | `/api/spot/*` (no callers today) | **Server** |

- **Adding a gate:** add an entry to `FEATURES`, then use it in the UI.
  - `apply-feature="<id>"` on a `FloatingWindow` locks its Apply button.
  - `feature: '<id>'` on a registry entry shows a PRO tag in the rail and the command palette.
  - `useEntitlements().request('<id>')` guards any action in code.
- **Adding a tier:** add it to `PLAN_ORDER` and move the `requires` of the
  features it unlocks.
- **Accounts off means no gating.** The app allows everything, and the
  server's gate lets every request through.

### Free previews of server features

Server features accept non-Pro requests on up to `FREE_PREVIEW_SECONDS` (30)
of audio, so anyone can hear the result before paying.

- **Server side:** `server/lib/entitlements.js` reads the uploaded file's
  duration with ffprobe and does not trust the client.
  - A longer upload without Pro gets **402** with `{ code: 'upgrade_required', feature, requires, previewSeconds }`.
  - If the duration can't be read, the request is refused.
  - Plans are cached per user for 60 s.
- **App side:** when a non-Pro user presses Analyse, the selection is narrowed
  to its first 30 s before anything is uploaded, and a caption says so. Apply
  stays Pro. A 402 opens the upgrade prompt.

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

## Next steps

1. **Stripe**: Checkout from the upgrade prompt, the customer portal, and
   webhooks writing `subscriptions` and `profiles.stripe_customer_id`.
2. **Optional:** gate the preset chain (`/api/process`). It isn't listed as Pro
   today.
