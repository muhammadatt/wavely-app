import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { processRoute } from './routes/process.js'
import { jobsRoute }   from './routes/jobs.js'
import { createSpotRoute }    from './routes/spot.js'
import { createAnalyzeRoute } from './routes/analyze.js'
import { meRoute } from './routes/me.js'
import { readAuthConfig, createTokenVerifier } from './lib/auth.js'
import { getSupabaseAdmin } from './lib/supabaseAdmin.js'
import { createEntitlementGate, createPlanResolver } from './lib/entitlements.js'
import Stripe from 'stripe'
import { readBillingConfig, createBilling } from './lib/billing.js'
import { createBillingRoutes, createBillingWebhook } from './routes/billing.js'

const app = express()
const PORT = process.env.PORT || 3001

// Trust the first proxy hop (Apache reverse proxy on the same machine).
// Required for express-rate-limit to correctly identify client IPs via
// X-Forwarded-For. Without this, rate-limit returns 428 on all requests.
app.set('trust proxy', 1)



// CORS: restrict to known origins in production
// CORS_ORIGINS       — comma-separated exact origin matches
// CORS_ORIGIN_PATTERNS — comma-separated regex patterns (for Vercel preview URLs)
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:5174']

const allowedPatterns = process.env.CORS_ORIGIN_PATTERNS
  ? process.env.CORS_ORIGIN_PATTERNS.split(',').map(p => new RegExp(p.trim()))
  : []

/**
 * Is this a frontend origin we serve? Shared by CORS and by billing, which
 * must only send the browser back (from Stripe Checkout / the portal) to one.
 */
function isAllowedOrigin(origin) {
  if (allowedOrigins.includes(origin)) return true
  if (allowedPatterns.some(pattern => pattern.test(origin))) return true
  // Allow local development and testing domains, including LAN IPs
  return /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin) || origin.endsWith('.test')
}

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no origin (server-to-server, curl, etc.) or "null" origin (file://) in dev
    if (!origin || origin === 'null') return callback(null, true)
    if (isAllowedOrigin(origin)) return callback(null, true)

    console.error(`CORS rejected origin: ${origin}`)
    callback(new Error('Not allowed by CORS'))
  },
}))

// ── Accounts and billing — configured before the body parsers ───────────────
//
// Accounts (Supabase) and billing (Stripe) are both optional: with their env
// vars unset the server runs exactly as before. See docs/user-accounts.md.
const authConfig = readAuthConfig()
const verifyAccessToken = authConfig.supabaseUrl ? createTokenVerifier(authConfig) : null
const supabaseAdmin = getSupabaseAdmin(authConfig)
if (verifyAccessToken && !supabaseAdmin) {
  console.warn('SUPABASE_URL is set but SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY is not — /api/me will answer 503')
}

const planFor = supabaseAdmin ? createPlanResolver(supabaseAdmin) : null

const billingConfig = readBillingConfig()
const stripe = billingConfig.secretKey ? new Stripe(billingConfig.secretKey) : null
const billing = stripe && supabaseAdmin && verifyAccessToken && billingConfig.prices.length
  ? createBilling({
      stripe,
      admin: supabaseAdmin,
      prices: billingConfig.prices,
      // A plan change must reach the entitlement gate now, not after its cache expires.
      onPlanChanged: (userId) => planFor?.invalidate(userId),
    })
  : null
if (stripe && !billing) {
  console.warn('STRIPE_SECRET_KEY is set but accounts or STRIPE_PRICE_* are not configured — billing is off')
}
if (billing && !billingConfig.webhookSecret) {
  console.warn('STRIPE_WEBHOOK_SECRET is not set — subscriptions will only sync when a browser returns from Checkout')
}

// ⚠ Before express.json(): the webhook verifies Stripe's signature over the raw bytes.
app.use('/api', createBillingWebhook({ stripe, billing, webhookSecret: billingConfig.webhookSecret }))

app.use(express.json())

// Rate limit the processing endpoint to prevent abuse
const processLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,                   // 30 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many processing requests, please try again later' },
  // Suppress X-Forwarded-For validation — Apache proxy handles IP forwarding
  // and trust proxy is already set above.
  validate: { xForwardedForHeader: false },
})
app.use('/api/process', processLimiter)

// Spot effects run on short selections — more generous than the preset chain.
const spotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 120,                  // 120 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many spot-effect requests, please try again later' },
  validate: { xForwardedForHeader: false },
})
app.use('/api/spot', spotLimiter)

// Analysis runs a short stage sequence and returns JSON, no audio. Cheaper
// than a spot effect but not free — it spawns Python — so it gets the same
// budget rather than the preset chain's.
const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 120,                  // 120 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analysis requests, please try again later' },
  validate: { xForwardedForHeader: false },
})
app.use('/api/analyze', analyzeLimiter)

// Account reads are cheap (one token check, two indexed selects) but run on
// every page load and sign-in, so the budget is the widest of the lot.
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,                  // 300 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many account requests, please try again later' },
  validate: { xForwardedForHeader: false },
})
app.use('/api/me', accountLimiter)

// Billing calls share the account budget. (The webhook is mounted earlier and
// answers before this runs, so a Stripe retry burst is never rate-limited.)
app.use('/api/billing', accountLimiter)

// Plan enforcement for server-processing features (src/auth/plans.js). Needs
// both the verifier and the database; with either missing it lets everything
// through, as before accounts existed.
const gate = createEntitlementGate({ verify: verifyAccessToken, planFor })

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.0.1' })
})

// Processing endpoint (submit job — returns 202 + jobId immediately)
app.use('/api', processRoute)

// Job status + download endpoints (polled by client after submission)
app.use('/api', jobsRoute)

// Spot effect endpoint (synchronous — returns processed WAV directly)
app.use('/api', createSpotRoute({ gate }))

// Analysis endpoints (synchronous — return measurements as JSON)
app.use('/api', createAnalyzeRoute({ gate }))

// Signed-in user's account and plan
app.use('/api', meRoute({ verify: verifyAccessToken, admin: supabaseAdmin }))

// Checkout, the customer portal and prices (Stripe)
app.use('/api', createBillingRoutes({ verify: verifyAccessToken, billing, isAllowedOrigin }))

const server = app.listen(PORT, () => {
  console.log(`Wavely server listening on port ${PORT}`)
})

// ── Proxy-safe timeout configuration ─────────────────────────────────────────
//
// Apache (and nginx) reuse keep-alive connections to the upstream.  Node.js's
// default keepAliveTimeout is only 5 s, which is shorter than most proxy
// keepalive windows.  If Apache sends the next request on a connection that
// Node.js has already decided to close, Apache reads a connection reset and
// returns 502 Bad Gateway.  This is especially likely with large file uploads
// because the upload takes long enough for the race to be hit reliably.
//
// Rule: keepAliveTimeout must be > proxy keepalive timeout (Apache default: 5 s,
//       but commonly 60–75 s in production configs).  headersTimeout must be
//       > keepAliveTimeout so the two timers don't fire in the wrong order.
//
// These values are intentionally generous — they only govern idle time between
// requests on a persistent connection, not the duration of an active upload.
server.keepAliveTimeout = 75_000  // 75 s — safely above typical proxy keepalive
server.headersTimeout   = 80_000  // must be strictly greater than keepAliveTimeout
