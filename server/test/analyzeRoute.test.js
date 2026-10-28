/**
 * The analysis route needs an account, not a plan: any signed-in request is
 * served up to a size cap that is the same for every plan (routes/analyze.js).
 * Runners, the duration probe and the token check are injected, so no Python,
 * ffprobe or Supabase is involved.
 *
 * Run with:  cd server && node --test test/analyzeRoute.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createAnalyzeRoute, ANALYSIS_MAX_SECONDS } from '../routes/analyze.js'
import { createEntitlementGate } from '../lib/entitlements.js'

const PLANS = { 'tok-free': 'free', 'tok-pro': 'pro' }
const gate = createEntitlementGate({
  verify: async (token) => { if (!PLANS[token]) throw new Error('bad token'); return { id: token } },
  planFor: async (id) => PLANS[id],
  probeDuration: async () => 3600,
})

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

test('a chapter-length analysis is served to any account, free included', async () => {
  const s = await serve({ gate, kinds, probeDuration: async () => 45 * 60 })
  try {
    for (const token of ['tok-free', 'tok-pro']) {
      const res = await upload(s.base, 'vad', token)
      assert.equal(res.status, 200, token)
      assert.deepEqual(await res.json(), { voicedRuns: [], numFrames: 0 })
    }
  } finally { s.close() }
})

test('signed out, or with a bad token, the answer is 401 sign_in_required and nothing runs', async () => {
  let ran = false
  const s = await serve({ gate, kinds: { vad: { run: async () => { ran = true; return {} } } }, probeDuration: async () => 10 })
  try {
    for (const token of [null, 'tok-garbage']) {
      const res = await upload(s.base, 'vad', token)
      assert.equal(res.status, 401, String(token))
      const body = await res.json()
      assert.equal(body.code, 'sign_in_required')
      assert.equal(body.feature, 'audioAnalysis')
    }
    assert.equal(ran, false)
  } finally { s.close() }
})

test('past the cap the request is refused with 413, on every plan', async () => {
  let ran = false
  const s = await serve({
    gate,
    kinds: { vad: { run: async () => { ran = true; return {} } } },
    probeDuration: async () => ANALYSIS_MAX_SECONDS + 1,
  })
  try {
    for (const token of ['tok-free', 'tok-pro']) {
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
  const s = await serve({ gate, kinds, probeDuration: async () => null })
  try {
    assert.equal((await upload(s.base, 'vad', 'tok-free')).status, 200)
  } finally { s.close() }
})
