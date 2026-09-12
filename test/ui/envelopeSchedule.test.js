/**
 * Run with:  npm test
 *
 * Envelope modulator scheduling — see src/audio/effects/envelopeSchedule.js.
 *
 * ⚠ THE FAILURE THIS GUARDS IS SILENT. A wrong `at` or `offset` slides the
 * envelope against the audio, so a de-esser dip lands off the sibilant and a
 * leveller's step lands mid-word. Nothing errors; the effect just sounds
 * slightly wrong, which is far harder to trace than a crash.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { scheduleEnvelope } from '../../src/audio/effects/envelopeSchedule.js'

test('playback starting before the region waits out the gap', () => {
  const s = scheduleEnvelope({ regionStartSec: 10, durationSec: 5, when: 100, startSec: 4 })
  assert.equal(s.at, 106) // 100 + (10 - 4)
  assert.equal(s.offset, 0)
  // The meters read from where the envelope actually begins, not from startSec.
  assert.equal(s.transportStartSec, 10)
})

test('playback starting inside the region starts part-way into the buffer', () => {
  const s = scheduleEnvelope({ regionStartSec: 10, durationSec: 5, when: 100, startSec: 12.5 })
  assert.equal(s.at, 100)
  assert.equal(s.offset, 2.5)
  assert.equal(s.transportStartSec, 12.5)
})

test('playback starting exactly at the region start takes the inside branch', () => {
  const s = scheduleEnvelope({ regionStartSec: 10, durationSec: 5, when: 100, startSec: 10 })
  assert.equal(s.at, 100)
  assert.equal(s.offset, 0)
  assert.equal(s.transportStartSec, 10)
})

test('a region already behind the playhead schedules nothing', () => {
  // Not an error — seeking past an applied region is ordinary.
  assert.equal(scheduleEnvelope({ regionStartSec: 10, durationSec: 5, when: 100, startSec: 15 }), null)
  assert.equal(scheduleEnvelope({ regionStartSec: 10, durationSec: 5, when: 100, startSec: 99 }), null)
})

test('a region at the very start of the timeline needs no offset arithmetic', () => {
  const s = scheduleEnvelope({ regionStartSec: 0, durationSec: 30, when: 42, startSec: 0 })
  assert.equal(s.at, 42)
  assert.equal(s.offset, 0)
  assert.equal(s.transportStartSec, 0)
})
