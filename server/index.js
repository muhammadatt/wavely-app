import express from 'express'
import cors from 'cors'
import { processRoute } from './routes/process.js'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.0.1' })
})

// Processing endpoint
app.use('/api', processRoute)

app.listen(PORT, () => {
  console.log(`Wavely server listening on port ${PORT}`)
})
