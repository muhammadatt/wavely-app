# Cloudflare in front of the API

Edge rules for the API hostname (written here as `api.example.com`). They
complement the server's own defences rather than replace them. The server
already does sign-in and plan checks, per-account and per-IP job limits, the
request log and account blocking (`docs/user-accounts.md`). What only the edge
can do is absorb volume **before it reaches the box**, especially a flood
spread across many IPs, which no per-IP limit inside the app can stop.

⚠ Plan limits below are as published at the time of writing and change often.
The dashboard shows what your plan allows; trust it over this page.

---

## 0. Prerequisites: without these the rules protect nothing

### 0.1 The origin must only accept Cloudflare

If the server's IP answers on 443 to anyone, an attacker skips every rule here
by connecting to it directly. Pick one:

- **Firewall the origin to Cloudflare's IP ranges**
  (<https://www.cloudflare.com/ips/>, both v4 and v6) on 80/443, in the
  provider's firewall or `ufw`. Re-check the list occasionally; it changes.
- **Cloudflare Tunnel** (`cloudflared`): the origin opens no inbound port at all.
  This is the stronger option and needs no IP list.

Also: SSL/TLS mode **Full (strict)**, and the API record **proxied** (orange
cloud). A grey-cloud record bypasses everything below.

### 0.2 The server must see the real client IP. It does NOT today.

`server/index.js` sets `trust proxy 1`: it believes ONE proxy hop. Behind
Cloudflare the chain is client → Cloudflare → Traefik (or Apache) → Node. That is
two hops, so `req.ip` resolves to a **Cloudflare edge address**, and with it:

- every per-IP rate limit and the per-IP job limit for signed-out mastering is
  shared by everyone who reaches the API through the same Cloudflare data centre;
- the request log's `ip` field and `usage_events.ip` record Cloudflare, not users.

Fix: trust two hops when Cloudflare is in front (`app.set('trust proxy', 2)`,
ideally from an env var so a non-Cloudflare deployment keeps 1). This is safe
**only once 0.1 is in place**. With the origin locked to Cloudflare, a forged
`X-Forwarded-For` from a client is pushed one position further left and never
read. Verify after deploying: one `{"evt":"api",…}` log line should show your
own public IP, not a Cloudflare one.

### 0.3 Upload size: why audio goes up in chunks

Cloudflare caps request bodies at **100 MB on Free and Pro**, 200 MB on
Business and 500 MB on Enterprise (more by arrangement), answering **413**
before the request reaches the server. An hour of narration is far over that
in any format the app could send:

| 60 min, 44.1 kHz | Mono | Stereo |
|---|---|---|
| 32-bit float WAV (what the client renders) | ~635 MB | ~1.27 GB |
| 24-bit FLAC (speech, ~55 %) | ~260 MB | ~520 MB |

So no audio travels in one request any more. Every upload, mastering and
analysis alike, is a **resumable upload** (tus protocol: `server/lib/uploads.js`,
client `src/api/upload.js`). It is sent as **20 MB PATCHes** to `/api/uploads`,
and the processing request then names it: `{ "uploadId": "…" }` as JSON. A
dropped connection costs one chunk, not the file: the client asks the server's
offset (`HEAD`) and carries on. The server's own limits, all checked when the
upload is created and before a byte is stored, are in `docs/user-accounts.md`
(`UPLOAD_*`).

Making the record DNS-only to dodge the cap would expose the origin's IP and
undo §0.1 for every hostname on the box, so don't. Uploading FLAC instead of
float WAV would cut transfer time 2–3×. It is not done yet: float audio above
0 dBFS would clip on the way into a fixed-point format, so it needs a peak
check first.

### 0.4 The 100-second proxy timeout

Cloudflare closes a request with **524** if the origin sends nothing for
100 seconds (Free to Business). Mastering is already a 202 + polling job, so
it is immune. `/api/spot` and `/api/analyze` answer synchronously: an analysis
of a long selection that takes longer than 100 s fails at the edge even though
the server finishes it.

---

## 1. WAF custom rules

Security → WAF → **Custom rules**. Order matters (first match wins for Block).
Free plans allow only a handful of custom rules, so the list below is ordered by
value: stop at your plan's limit.

Set **Action: Block** on each unless noted.

**1. Only the API lives on this hostname.** Scanners probing `/wp-admin` and
`/.env` never reach Node.

```
(http.host eq "api.example.com" and not starts_with(http.request.uri.path, "/api/"))
```

**2. Only the methods the API uses.** The routes are GET, POST and CORS
preflight `OPTIONS`. Resumable uploads (`/api/uploads…`) also use `HEAD`,
`PATCH` and `DELETE`. Nothing uses PUT.

```
(http.host eq "api.example.com"
 and not http.request.method in {"GET" "POST" "OPTIONS"}
 and not (starts_with(http.request.uri.path, "/api/uploads")
          and http.request.method in {"HEAD" "PATCH" "DELETE"}))
```

**3. Requests must have the shape the app sends.** Processing POSTs are JSON
naming an upload. Multipart is still accepted from client builds older than
resumable uploads; drop it from this rule once those are gone. Upload chunks are
`application/offset+octet-stream`.

```
(http.host eq "api.example.com"
 and ((http.request.method eq "POST"
       and (starts_with(http.request.uri.path, "/api/process")
            or starts_with(http.request.uri.path, "/api/spot/")
            or starts_with(http.request.uri.path, "/api/analyze/"))
       and not any(http.request.headers["content-type"][*] contains "application/json")
       and not any(http.request.headers["content-type"][*] contains "multipart/form-data"))
   or (http.request.method eq "PATCH"
       and not any(http.request.headers["content-type"][*] eq "application/offset+octet-stream"))))
```

**4. Spot effects and analyses carry a sign-in token.** The server refuses a
signed-out request with 401 before reading the upload. This rule moves that
refusal to the edge, so it costs the origin nothing. It checks only that a token
is *present*; the server still verifies it.

```
(http.host eq "api.example.com"
 and http.request.method eq "POST"
 and (starts_with(http.request.uri.path, "/api/spot/")
      or starts_with(http.request.uri.path, "/api/analyze/"))
 and not any(lower(http.request.headers.names[*])[*] eq "authorization"))
```

⚠ Enable this only once accounts are live (Supabase env vars set). With
accounts off the client sends no token and this rule blocks every analysis.
Do not apply it to `/api/process`: mastering's 30-second preview is
deliberately open to signed-out visitors.

⚠ Never add `/api/billing/webhook` to a rule that demands a token or challenges
the caller. Stripe calls it server-to-server with neither; it is protected by
its signature.

Test each expression in the rule editor's preview (or **Trace**) against a
real request before saving. Header-name matching in particular is worth
confirming against the live expression builder.

---

## 2. Rate limiting rules

Security → WAF → **Rate limiting rules**. These sit in front of the server's
own limits (per IP per 15 min, plus the per-account job queue). The edge's job is
bursts: anything that reaches these thresholds is not a person clicking.

### Free plan: one rule

Free allows a single rule, counting by IP, with a fixed 10-second period and a
10-second block. Spend it on the expensive routes:

| Field | Value |
|---|---|
| Expression | `(http.host eq "api.example.com" and http.request.method eq "POST" and (starts_with(http.request.uri.path, "/api/process") or starts_with(http.request.uri.path, "/api/spot/") or starts_with(http.request.uri.path, "/api/analyze/")))` |
| Characteristics | IP |
| Requests / period | 10 per 10 s |
| Action | Block, 10 s |

Ten processing POSTs in ten seconds is far beyond what the app sends. A Plugin
Chain Apply makes one analysis request per slot, one after another. Job
polling (`GET /api/jobs/…`, every 3 s) is a GET and is deliberately left out,
and so are upload chunks (`PATCH /api/uploads/…`): a fast connection sends a
20 MB chunk every second or two, and the server has its own upload limits.

### Pro and above: two rules, longer periods

Replace the Free rule with:

| Rule | Expression | Rate | Action |
|---|---|---|---|
| Processing | as above | 20 per 1 min, per IP | Block 1 min |
| Everything else | `(http.host eq "api.example.com" and starts_with(http.request.uri.path, "/api/") and not http.request.uri.path eq "/api/billing/webhook")` | 300 per 1 min, per IP | Managed Challenge |

300 a minute covers several tabs polling jobs (20/min each) plus account and
billing calls. Counting by account (the `Authorization` header) is an
Enterprise feature at the edge. Per-account limits live in the server instead
(`MAX_JOBS_PER_CLIENT`, `MAX_ANALYSES_PER_CLIENT`).

---

## 3. Bots

- **Bot Fight Mode (Free)** challenges suspected bots and **cannot be skipped
  by any rule** on the Free plan. The API is called by browsers via `fetch`,
  and by Stripe's webhook. Turn it on only after checking that neither is
  challenged, and leave it off if it touches the webhook.
- **Super Bot Fight Mode (Pro+)**: "Definitely automated → Block" on the API
  hostname, with a skip rule for `/api/billing/webhook`.
- Leave "Verified bots" allowed; nothing legitimate crawls the API, but it
  costs nothing.

---

## 4. Caching

Nothing under `/api/` should be cached. Cloudflare does not cache these
responses by default (no static extension), but a **Cache Rule** "Bypass cache"
for `http.host eq "api.example.com"` makes that explicit. It guards against a
future page rule that caches everything accidentally serving one user's
processed audio (`/api/jobs/…/download`) to another.

---

## 5. After deploying: checklist

1. `curl -I https://<origin-ip>` from outside times out or is refused (0.1).
2. A request log line shows your real public IP (0.2).
3. `curl -X POST https://api.example.com/api/analyze/vad` (no token) gets 403
   from Cloudflare when rule 4 is on, or 401 from the server when it is off.
4. `curl https://api.example.com/wp-admin` gets Cloudflare's 403 (rule 1).
5. A short master and an Auto Leveler analysis still work end to end, signed in
   and signed out.
6. A Stripe test webhook (`stripe trigger customer.subscription.updated`)
   still returns 200.

The server's own refusals (`rate_limited`, `too_many_jobs`, `server_busy`,
`account_blocked`, …) are in the request log; Cloudflare's are under
Security → Events.
