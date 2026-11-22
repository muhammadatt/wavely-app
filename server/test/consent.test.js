import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

import { consentRoute, parseConsentBody } from '../routes/consent.js'

async function withApp(fn) {
  const lines = []
  const app = express()
  app.use(express.json())
  app.use('/api', consentRoute({ log: l => lines.push(JSON.parse(l)), now: () => Date.parse('2026-11-22T12:00:00Z') }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  try { await fn(`http://127.0.0.1:${server.address().port}`, lines) } finally { await new Promise(r => server.close(r)) }
}

const good = { v: 1, ads: true, at: Date.parse('2026-11-22T11:59:00Z'), id: '3f1c2b9a-0000-4000-8000-000000000001', model: 'opt-in', source: 'banner', page: '/effects/la-vintage-2a/' }

test('region: country from CF-IPCountry; unknown is opt-in', async () => {
  await withApp(async base => {
    const de = await (await fetch(`${base}/api/consent/region`, { headers: { 'CF-IPCountry': 'DE' } })).json()
    assert.deepEqual(de, { country: 'DE', model: 'opt-in' })
    const us = await (await fetch(`${base}/api/consent/region`, { headers: { 'CF-IPCountry': 'US' } })).json()
    assert.deepEqual(us, { country: 'US', model: 'opt-out' })
    const none = await fetch(`${base}/api/consent/region`)
    assert.equal(none.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await none.json(), { country: null, model: 'opt-in' })
  })
})

test('a choice is logged once, with no IP or user agent', async () => {
  await withApp(async (base, lines) => {
    const res = await fetch(`${base}/api/consent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-IPCountry': 'FR', 'User-Agent': 'x' }, body: JSON.stringify(good),
    })
    assert.equal(res.status, 204)
    assert.equal(lines.length, 1)
    const l = lines[0]
    assert.equal(l.evt, 'consent')
    assert.equal(l.ts, '2026-11-22T12:00:00.000Z')
    assert.equal(l.ads, true)
    assert.equal(l.country, 'FR')
    assert.equal(l.page, '/effects/la-vintage-2a/')
    for (const k of ['ip', 'ua', 'userAgent', 'user']) assert.ok(!(k in l), k)
    assert.ok(!JSON.stringify(l).includes('127.0.0.1'))
  })
})

test('a malformed record is 400 and logs nothing', async () => {
  await withApp(async (base, lines) => {
    for (const body of [{}, { ...good, ads: 'yes' }, { ...good, id: 'x' }, { ...good, source: 'pixel' }, { ...good, model: 'maybe' }, { ...good, v: 1.5 }]) {
      const res = await fetch(`${base}/api/consent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(res.status, 400, JSON.stringify(body))
    }
    assert.equal(lines.length, 0)
  })
})

test('parseConsentBody drops an implausible client clock and an odd page', () => {
  const now = Date.parse('2026-11-22T12:00:00Z')
  const e = parseConsentBody({ ...good, at: 0, page: 'https://evil.example/' }, { now })
  assert.equal(e.clientAt, null)
  assert.equal(e.page, null)
})
