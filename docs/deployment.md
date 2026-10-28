# Deploying the API server (Docker + Coolify)

The frontend stays on Vercel. This guide covers the backend (`server/`): one
Docker image, run by [Coolify](https://coolify.io) on a VPS, with a production
app, a staging app and optional per-PR previews.

---

## 1. The image

| File | Purpose |
|---|---|
| `server/Dockerfile` | Node 22 + Python 3.11 venv (CPU PyTorch 2.0.1, DeepFilterNet3, Demucs, Silero, …). |
| `.dockerignore` (repo root) | Whitelist: `server/`, the two shared modules the server imports from `src/` (`src/audio/presets.js`, `src/auth/plans.js`) and `data/reference_curves/` (the `referenceEQ` stage's curves). |

**Build from the repository root**, not `server/`, because of the `src/` and `data/` dependencies:

```bash
docker build -f server/Dockerfile -t wavely-server .
docker run --rm -p 3001:3001 --env-file server/.env \
  -v wavely-models:/models wavely-server
curl localhost:3001/api/health        # {"status":"ok",...}
```

Facts the rest of this guide relies on:

- **Port 3001** (`PORT`). Health check: `GET /api/health`.
- **No apt-get, no compiler.** Every Python and Node dependency installs from a
  prebuilt wheel or tarball; ffmpeg comes from `@ffmpeg-installer`.
- **Model weights are not baked in.** DeepFilterNet3 (~170 MB), Demucs
  (~350 MB) etc. download on first use into **`/models`**
  (`XDG_CACHE_HOME`, `TORCH_HOME`, `HF_HOME` and `NUMBA_CACHE_DIR` all point
  there). **Mount a persistent volume at `/models`**, or
  every redeploy downloads them again and the first job after a deploy is slow.
- **CPU PyTorch** by default. On an NVIDIA host, build with
  `--build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu118`.
- **Not included:** the hand-cloned `vendor/` repos (AP-BWE, DTLN, VACE-WPE).
  No active preset uses them (dereverb and bandwidth extension are off, DTLN is
  optional). If one is turned on, add a `git clone` step to the Dockerfile.
- **Runs as a non-root user** (`app`, uid 1000) and exits immediately on
  SIGTERM, so redeploys don't wait out a kill timeout.
- **Expect a ~4–5 GB image** with CPU PyTorch (an estimate; the CUDA build
  measured 9.2 GB) and a first build of 10+ minutes. Later builds
  reuse the cached Python layer unless `server/requirements.txt` changes.

⚠ **Jobs live in memory** (`server/lib/jobStore.js`). Each app must run as
exactly **one** container, and **a redeploy drops any job in progress**. Deploy
production when nobody is mid-job.

---

## 2. Server and Coolify install

**Sizing.** Builds run on the same machine as the apps. Plan for production +
staging + one preview plus a build at the same time: **≥ 8 vCPU / 16 GB RAM /
100 GB disk** is comfortable. A second, cheaper VPS can be added to Coolify
later as the build/preview server.

**Ports 80/443.** Coolify's proxy (Traefik) needs them, so it can't run
alongside the current Apache reverse proxy. Either install on a fresh Contabo
VPS and switch DNS when it works (recommended: the current server keeps serving
until then), or stop Apache on the existing box first.

Install (Ubuntu/Debian, as root):

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Open `http://<server-ip>:8000`, create the admin account, and set a domain for
the dashboard itself if you want HTTPS on it. Then lock down port 8000 in the
firewall once the dashboard has a domain.

**DNS** (at your DNS provider, A records → the VPS IP):

| Record | For |
|---|---|
| `api.example.com` | production |
| `api-staging.example.com` | staging |
| `*.preview.example.com` | per-PR previews (wildcard; only needed for §5) |

If Cloudflare proxies these records, keep SSL mode at **Full (strict)**. Coolify
issues Let's Encrypt certificates, and that works through Cloudflare. See the
proxy note in §8.

**GitHub.** In Coolify: *Sources → + Add → GitHub App*, follow the flow and
grant it access to `wavely-app`. A GitHub App (rather than a deploy key) is what
enables push-to-deploy and PR previews.

---

## 3. Production app

*Projects → + Add → "Instant Polish"*. Inside the **production** environment:
*+ New Resource → Private Repository (with GitHub App)* → `wavely-app`.

| Setting | Value |
|---|---|
| Branch | `main` |
| Build Pack | **Dockerfile** |
| Base Directory | `/` |
| Dockerfile Location | `/server/Dockerfile` |
| Ports Exposes | `3001` |
| Domains | `https://api.example.com` |
| Auto Deploy | on (deploys on push to `main`) |

**Persistent Storage** → *+ Add → Volume*: name `wavely-models`, destination
path `/models`.

**Health check.** Coolify's own health check runs `curl`/`wget` *inside* the
container, and this image has neither. Leave Coolify's health check disabled.
The image's Docker `HEALTHCHECK` (Node `fetch` against `/api/health`) still
marks the container healthy or unhealthy.

**Environment variables:** see §6. Then **Deploy** and watch the build log.

Check it: `curl https://api.example.com/api/health`.

---

## 4. Staging app

In the same project, *+ Add environment → "staging"*, and add the same
repository as a second resource there with these differences:

| Setting | Value |
|---|---|
| Branch | `staging` (create it on GitHub first) |
| Domains | `https://api-staging.example.com` |
| Persistent Storage | its own volume (`wavely-models-staging`) at `/models` |
| Environment variables | staging values (§6): Stripe **test** keys, staging Supabase project |

Workflow: merge or push work into `staging`, and staging redeploys. When
satisfied, merge `staging` (or the PR) into `main`.

**Vercel:** in the Vercel project → *Settings → Environment Variables*:

| Variable | Environment | Value |
|---|---|---|
| `VITE_API_BASE_URL` | Production | `https://api.example.com` |
| `VITE_API_BASE_URL` | Preview | `https://api-staging.example.com` |

Every Vercel preview build (any branch) then talks to staging. The variable is
read at **build** time, so redeploy on Vercel after changing it. Add the same
Supabase / Stripe *publishable* frontend variables per environment as described
in `docs/user-accounts.md`.

---

## 5. Per-PR backend previews (optional)

Only worth turning on when a PR changes the backend itself. Each preview is a
full copy of the server (multi-GB image, several GB of RAM while running).

On the **staging** app (so previews inherit staging's env vars), open
*Preview Deployments*:

- Enable preview deployments.
- URL template: `{{pr_id}}.preview.example.com` (needs the wildcard DNS record).
- Set **preview-specific** environment variables where they differ. Coolify
  keeps a separate preview set.
- Under *Resource Limits*, cap memory (e.g. 6 GB) so a preview can't starve
  production.

Coolify then deploys each PR opened against the app's branch, redeploys on
every push to it, and deletes the preview when the PR is merged or closed. Check
in the dashboard whether your Coolify version gives previews their own copy of
the `/models` volume. If not, the first job on each preview downloads the
models.

**Pairing with Vercel:** Vercel previews keep pointing at staging (§4). To test
a PR's backend from the browser, run the frontend locally against it:

```bash
VITE_API_BASE_URL=https://42.preview.example.com npm run dev
```

Or set a branch-specific `VITE_API_BASE_URL` for that Git branch in Vercel's
Preview environment.

---

## 6. Environment variables

Full reference with defaults: `server/.env.example`. All are optional for the
server to boot. These are the ones a deployment sets:

| Variable | Production | Staging / previews |
|---|---|---|
| `CORS_ORIGINS` | `https://app.example.com` (your Vercel production domain(s)) | the same, or empty |
| `CORS_ORIGIN_PATTERNS` | leave empty | `^https://wavely-app(-[a-z0-9-]+)?\.vercel\.app$` (adjust to your Vercel project/team slug) |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | production project | **separate** staging project |
| `STRIPE_SECRET_KEY` | `sk_live_…` | `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | production endpoint's `whsec_…` | test-mode endpoint's `whsec_…` |
| `STRIPE_PRICE_PRO_MONTHLY` / `_YEARLY` | live price ids | test price ids |
| `PYTHON_WORKER_POOL_SIZE` etc. | tuned to the box (below) | smaller |

Stripe webhooks: add one endpoint per environment in the Stripe dashboard
(`https://api.example.com/api/billing/webhook`, and a test-mode one for
staging).

**Threading.** Copy the values from the current VPS's `server/.env`: they were
tuned on real hardware. The relevant knobs are `PYTHON_WORKER_POOL_SIZE`,
`CHUNKED_CONCURRENCY`, `TORCH_NUM_THREADS`, `DF3_TORCH_THREADS` and
`SERIAL_TORCH_THREADS`, documented in `server/.env.example`. On a shared box,
give staging and previews `PYTHON_WORKER_POOL_SIZE=1` so they don't compete with
production for cores.

Don't set `PORT` unless you also change *Ports Exposes*. The image defaults to
3001.

Don't set `HOST`, and don't add *Ports Mappings*. The image listens on
`0.0.0.0` (outside a container the server defaults to `127.0.0.1`) so Traefik
can reach it over Coolify's network. The API must only be reachable through
the proxy: `server/index.js` trusts `X-Forwarded-For`, so a port published on
the host lets anyone forge their IP and reset every per-IP rate limit.

---

## 7. Migrating from the current VPS

1. Bring up Coolify + the production app on the new server (§2–3) with a
   temporary domain, e.g. `api-new.example.com`.
2. Copy env vars from the old `server/.env`. Run a real job from a local
   frontend pointed at the temporary domain, and confirm the first run downloads
   the models into the volume.
3. Point `api.example.com` at the new server (or change Vercel's
   `VITE_API_BASE_URL` and redeploy). Jobs in memory on the old server are lost
   at cutover, so do it at a quiet time.
4. Update the Stripe webhook endpoint if its host changed.
5. Keep the old VPS for a few days, then cancel it.

---

## 8. Notes and caveats

- **Client IPs behind proxies.** `server/index.js` trusts exactly one proxy hop
  (`trust proxy 1`), which was written for Apache. Under Coolify the hop is
  Traefik. If Cloudflare also proxies the API domain there are two hops, and
  `req.ip` (which the rate limiter keys on) may be Cloudflare's edge IP rather
  than the user's. Check one request's logged IP after cutover. If it's a
  Cloudflare address, the rate limits are effectively shared across users.
- **Upload size.** Cloudflare's free/pro plans cap request bodies at 100 MB.
  Traefik adds no limit of its own.
- **Request log.** Every `/api/process`, `/api/spot` and `/api/analyze`
  request writes one `{"evt":"api",…}` JSON line to stdout (account, IP,
  status, refusal code). Coolify's log view is not long-term storage; ship
  stdout somewhere that keeps it if you need it for abuse investigations — see
  `docs/user-accounts.md`, "Investigating and blocking an account".
- **Logs.** Coolify shows container stdout/stderr per app. `PIPELINE_LOG=1` writes
  per-run JSON under `server/logs` inside the container, which is lost on
  redeploy unless you add a second volume there.
- **Disk.** Old images pile up. Coolify's *Settings → Docker cleanup* keeps it
  in check. Turn it on.
- **Rollback.** Each app's *Deployments* tab can redeploy any previous build.
