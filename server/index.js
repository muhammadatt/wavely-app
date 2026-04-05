import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { processRoute } from './routes/process.js'

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
  : ['http://localhost:5173', 'http://localhost:4173']

const allowedPatterns = process.env.CORS_ORIGIN_PATTERNS
  ? process.env.CORS_ORIGIN_PATTERNS.split(',').map(p => new RegExp(p.trim()))
  : []

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no origin (server-to-server, curl, etc.) in dev
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    if (allowedPatterns.some(pattern => pattern.test(origin))) return callback(null, true)
    callback(new Error('Not allowed by CORS'))
  },
}))

app.use(express.json())

// Rate limit the processing endpoint to prevent abuse
const processLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,                   // 30 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many processing requests, please try again later' },
  // Fall back to socket IP if X-Forwarded-For is absent — prevents 428 when
  // the proxy doesn't forward the header.
  keyGenerator: (req) => req.ip ?? req.socket.remoteAddress ?? 'unknown',
  validate: { xForwardedForHeader: false },
})
app.use('/api/process', processLimiter)

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.0.1' })
})

// Processing endpoint
app.use('/api', processRoute)

app.listen(PORT, () => {
  console.log(`Wavely server listening on port ${PORT}`)
})
