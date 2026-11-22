import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CONSENT_KEY, CONSENT_VERSION, GRANTED_TTL_MS, REFUSED_TTL_MS,
  createConsentManager, decide, isCurrent, readRecord,
} from '../../src/platform/consent.js'
import { consentModelFor, normalizeCountry } from '../../src/platform/consentRegions.js'

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }
}

function harness({ vendors = { metaPixelId: '1' }, model = 'opt-in', gpc = false, stored = null, t = 1e12 } = {}) {
  const storage = memoryStorage(stored ? { [CONSENT_KEY]: JSON.stringify(stored) } : {})
  const applied = []
  const logged = []
  let regionCalls = 0
  const clock = { t }
  const m = createConsentManager({
    vendors, storage, gpc, now: () => clock.t,
    fetchModel: async () => { regionCalls++; if (model instanceof Error) throw model; return model },
    apply: ads => applied.push(ads),
    log: r => logged.push(r),
  })
  return { m, storage, applied, logged, clock, regionCalls: () => regionCalls }
}

test('regions: EEA, UK and CH opt in; elsewhere opts out; unknown opts in', () => {
  for (const c of ['DE', 'fr', 'NO', 'IS', 'LI', 'GB', 'CH', 'IE']) assert.equal(consentModelFor(c), 'opt-in', c)
  for (const c of ['US', 'CA', 'AU', 'JP']) assert.equal(consentModelFor(c), 'opt-out', c)
  for (const c of [null, undefined, '', 'XX', 'T1', 'DEU', 7]) assert.equal(consentModelFor(c), 'opt-in', String(c))
  assert.equal(normalizeCountry(' de '), 'DE')
})

test('no vendor configured: inert — no region lookup, no bar, nothing stored', async () => {
  const h = harness({ vendors: {} })
  await h.m.start()
  assert.deepEqual(h.m.state, { ready: true, inert: true, ads: false, ask: false, reopened: false, model: null })
  h.m.choose(true)
  h.m.reopen()
  assert.equal(h.regionCalls(), 0)
  assert.deepEqual(h.applied, [])
  assert.equal(h.storage.map.size, 0)
})

test('opt-in region: asks, and NOTHING is applied before the answer', async () => {
  const h = harness()
  await h.m.start()
  assert.equal(h.m.state.ask, true)
  assert.equal(h.m.state.ads, false)
  assert.deepEqual(h.applied, [], 'a fresh refusal state must not even call the vendor revoke')
})

test('a failed region lookup is opt-in', async () => {
  const h = harness({ model: new Error('offline') })
  await h.m.start()
  assert.equal(h.m.state.model, 'opt-in')
  assert.equal(h.m.state.ask, true)
  assert.deepEqual(h.applied, [])
})

test('accept loads, records and logs; reject after it revokes', async () => {
  const h = harness()
  await h.m.start()
  h.m.choose(true)
  assert.deepEqual(h.applied, [true])
  const rec = readRecord(h.storage)
  assert.equal(rec.ads, true)
  assert.equal(rec.v, CONSENT_VERSION)
  assert.equal(rec.source, 'banner')
  assert.equal(h.logged.length, 1)
  assert.equal(h.m.state.ask, false)

  h.m.reopen()
  assert.equal(h.m.state.ask, true)
  h.m.choose(false)
  assert.deepEqual(h.applied, [true, false])
  assert.equal(readRecord(h.storage).source, 'settings')
  assert.equal(h.logged[1].id, h.logged[0].id, 'one anonymous id per browser')
})

test('reject on a fresh page records but touches no vendor', async () => {
  const h = harness()
  await h.m.start()
  h.m.choose(false)
  assert.deepEqual(h.applied, [])
  assert.equal(readRecord(h.storage).ads, false)
})

test('a stored current choice is honoured without a region lookup', async () => {
  const h = harness({ stored: { v: CONSENT_VERSION, ads: true, at: 1e12 - 1000, id: 'abcdefgh-1', model: 'opt-in', source: 'banner' } })
  await h.m.start()
  assert.equal(h.regionCalls(), 0)
  assert.equal(h.m.state.ask, false)
  assert.deepEqual(h.applied, [true])
})

test('choices expire: 12 months granted, 6 refused, and on a version bump', () => {
  const now = 1e12
  assert.ok(isCurrent({ v: CONSENT_VERSION, ads: true, at: now - GRANTED_TTL_MS + 1 }, now))
  assert.ok(!isCurrent({ v: CONSENT_VERSION, ads: true, at: now - GRANTED_TTL_MS }, now))
  assert.ok(isCurrent({ v: CONSENT_VERSION, ads: false, at: now - REFUSED_TTL_MS + 1 }, now))
  assert.ok(!isCurrent({ v: CONSENT_VERSION, ads: false, at: now - REFUSED_TTL_MS }, now))
  assert.ok(!isCurrent({ v: CONSENT_VERSION - 1, ads: true, at: now }, now))
  assert.ok(!isCurrent({ v: CONSENT_VERSION, ads: true, at: now + 5000 }, now), 'a record from the future is not trusted')
})

test('Global Privacy Control is a recorded refusal, never asked', async () => {
  for (const model of ['opt-in', 'opt-out']) {
    const h = harness({ gpc: true, model })
    await h.m.start()
    assert.equal(h.m.state.ask, false)
    assert.equal(h.m.state.ads, false)
    assert.deepEqual(h.applied, [])
    assert.equal(readRecord(h.storage).source, 'gpc')
    assert.equal(h.regionCalls(), 0)
  }
  // …but an explicit, current yes given before GPC was switched on stands.
  assert.deepEqual(decide({ record: { v: CONSENT_VERSION, ads: true, at: 0 }, model: 'opt-in', gpc: true, now: 1 }),
    { ads: true, ask: false, recordGpc: false })
})

test('opt-out region: runs by default without asking or storing; the footer can turn it off', async () => {
  const h = harness({ model: 'opt-out' })
  await h.m.start()
  assert.equal(h.m.state.ask, false)
  assert.deepEqual(h.applied, [true])
  assert.equal(h.storage.map.size, 0)
  h.m.reopen()
  h.m.choose(false)
  assert.deepEqual(h.applied, [true, false])
  assert.equal(readRecord(h.storage).ads, false)
})

test('cancel after reopen changes nothing', async () => {
  const h = harness()
  await h.m.start()
  h.m.choose(true)
  h.m.reopen()
  h.m.cancel()
  assert.equal(h.m.state.ask, false)
  assert.equal(h.logged.length, 1)
  assert.deepEqual(h.applied, [true])
})

test('readRecord survives garbage and a throwing storage', () => {
  assert.equal(readRecord(memoryStorage({ [CONSENT_KEY]: '{nope' })), null)
  assert.equal(readRecord(memoryStorage({ [CONSENT_KEY]: '{"ads":"yes","at":1,"v":1}' })), null)
  assert.equal(readRecord({ getItem() { throw new Error('denied') } }), null)
})

// ── Structure ────────────────────────────────────────────────────────────

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(js|vue|mjs)$/.test(e.name)) yield p
  }
}

test('only adPixels.js names a vendor script host', async () => {
  const hosts = /connect\.facebook\.net|googletagmanager\.com|googleadservices\.com|google-analytics\.com/
  const offenders = []
  for await (const f of walk('src')) {
    if (f.endsWith(join('platform', 'adPixels.js'))) continue
    if (hosts.test(await readFile(f, 'utf8'))) offenders.push(f)
  }
  for (const f of ['index.html', 'help/index.html', 'effects/index.html']) {
    if (hosts.test(await readFile(f, 'utf8'))) offenders.push(f)
  }
  assert.deepEqual(offenders, [])
})

test('consent starts on the marketing pages only, never in the editor', async () => {
  const users = []
  for await (const f of walk('src')) {
    const s = await readFile(f, 'utf8')
    if (/consent\.start\(\)/.test(s)) users.push(f.replaceAll('\\', '/'))
  }
  assert.deepEqual(users, ['src/marketing/main.js'])
})

test('Reject and Accept share one button class (equal prominence)', async () => {
  const s = await readFile('src/components/consent/ConsentBar.vue', 'utf8')
  const reject = s.match(/<button[^>]*data-consent="reject"[^>]*>/)?.[0]
  const accept = s.match(/<button[^>]*data-consent="accept"[^>]*>/)?.[0]
  assert.ok(reject && accept)
  const cls = b => b.match(/class="([^"]*)"/)?.[1]
  assert.equal(cls(reject), 'cb-btn')
  assert.equal(cls(accept), 'cb-btn')
  assert.ok(!/:class/.test(reject) && !/:class/.test(accept), 'no conditional styling on either answer')
})
