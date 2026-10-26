/**
 * The analysis route is not plan-gated: any request is served up to a size
 * cap that is the same for every plan (routes/analyze.js). Runners and the
 * duration probe are injected, so no Python or ffprobe is involved.
 *
 * Run with:  cd server && node --test test/analyzeRoute.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createAnalyzeRoute, ANALYSIS_MAX_SECONDS } from '../routes/analyze.js'

async function serve(deps) {
  const app = express()
  app.use('/api', createAnalyzeRoute(deps))
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)) })
  return { base: `http://localhost:${server.address().port}`, close: () => server.close() }
}

function upload(base, kind, token) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(64)], { type: 'audio/wav' }), 'a.wav')
  return fetch(`${base}/api/analyze/${kind}`, {
    method: 'POST',
    body: form,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

const kinds = { vad: { run: async () => ({ voicedRuns: [], numFrames: 0 }) } }

test('a chapter-length analysis is served with no account and no plan', async () => {
  const s = await serve({ kinds, probeDuration: async () => 45 * 60 })
  try {
    const res = await upload(s.base, 'vad')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { voicedRuns: [], numFrames: 0 })
  } finally { s.close() }
})

test('past the cap the request is refused with 413, whoever sends it', async () => {
  let ran = false
  const s = await serve({
    kinds: { vad: { run: async () => { ran = true; return {} } } },
    probeDuration: async () => ANALYSIS_MAX_SECONDS + 1,
  })
  try {
    for (const token of [null, 'any-token']) {
      const res = await upload(s.base, 'vad', token)
      assert.equal(res.status, 413)
      const body = await res.json()
      assert.equal(body.code, 'too_long')
      assert.equal(body.maxSeconds, ANALYSIS_MAX_SECONDS)
    }
    assert.equal(ran, false)
  } finally { s.close() }
})

test('the cap is two hours, and an unreadable duration is left to the analysis', async () => {
  assert.equal(ANALYSIS_MAX_SECONDS, 2 * 60 * 60)
  const s = await serve({ kinds, probeDuration: async () => null })
  try {
    assert.equal((await upload(s.base, 'vad')).status, 200)
  } finally { s.close() }
})
