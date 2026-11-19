/**
 * Run with:  npm test
 *
 * VoxPressor's voice-profile cache: measured once per file version, shared
 * while in flight, never cached for a chain's running segments, forgotten
 * when a measurement fails.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceProfileCache } from '../../src/audio/voiceProfileCache.js'

const PROFILE = { cornerHz: 90, voiceF0Hz: 180 }

test('one measurement per key, shared while in flight and after', async () => {
  const cache = createVoiceProfileCache()
  let calls = 0
  const measure = () => { calls++; return Promise.resolve(PROFILE) }
  const a = cache.get('doc:1', measure)
  const b = cache.get('doc:1', measure)
  assert.equal(a, b)
  assert.deepEqual(await a, PROFILE)
  assert.equal(cache.get('doc:1', measure), a)
  assert.equal(calls, 1)
  assert.ok(cache.holds(a))
})

test('a new key (an edit, another file) measures again and replaces the entry', async () => {
  const cache = createVoiceProfileCache()
  let calls = 0
  const measure = () => { calls++; return PROFILE }
  const a = cache.get('doc:1', measure)
  const b = cache.get('doc:2', measure)
  assert.notEqual(a, b)
  await b
  assert.equal(calls, 2)
  assert.ok(!cache.holds(a))
  assert.ok(cache.holds(b))
})

test('uncacheable requests (a chain\'s running segments) always measure and never replace the entry', async () => {
  const cache = createVoiceProfileCache()
  let calls = 0
  const measure = () => { calls++; return PROFILE }
  const own = cache.get('doc:1', measure)
  const chain1 = cache.get('doc:chain', measure, false)
  const chain2 = cache.get('doc:chain', measure, false)
  await Promise.all([own, chain1, chain2])
  assert.equal(calls, 3)
  assert.notEqual(chain1, chain2)
  assert.ok(cache.holds(own))
  assert.equal(cache.get('doc:1', measure), own)
})

test('a failed measurement is forgotten, so the next request measures again', async () => {
  const cache = createVoiceProfileCache()
  let calls = 0
  const failing = () => { calls++; return Promise.reject(new Error('worker died')) }
  const a = cache.get('doc:1', failing)
  await assert.rejects(a)
  await Promise.resolve()
  const b = cache.get('doc:1', () => { calls++; return PROFILE })
  assert.notEqual(a, b)
  assert.deepEqual(await b, PROFILE)
  assert.equal(calls, 2)
})

test('a measure that throws synchronously rejects rather than throwing at the call', async () => {
  const cache = createVoiceProfileCache()
  const p = cache.get('doc:1', () => { throw new Error('boom') })
  await assert.rejects(p, /boom/)
})
