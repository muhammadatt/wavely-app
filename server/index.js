import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { processRoute } from './routes/process.js'

const app = express()
const PORT = process.env.PORT || 3001

// CORS: restrict to known origins in production
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:4173']

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no origin (server-to-server, curl, etc.) in dev
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
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
