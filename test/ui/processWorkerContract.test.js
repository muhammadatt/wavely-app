/**
 * Run with:  npm test
 *
 * THE MEASUREMENT WORKER'S REPLY CONTRACT.
 *
 * ⚠ THIS EXISTS BECAUSE BREAKING IT IS SILENT AND SHIPPED ONCE. `getMeasureWorker`
 * in processing.js resolves a measurement on `type === 'done'` and REJECTS every
 * other reply; every caller of a measurement catches and logs. So a handler that
 * answers with any other word is not a warning or a wrong number — it is a
 * measurement that never lands, with the panel still claiming AUTO and the knob
 * sitting whereever it was. A handler posting `type: 'complete'` did exactly
 * that: OptoSmooth's auto makeup stopped working entirely, and the only symptom
 * anyone could see was that two settings produced identical output.
 *
 * Nothing else covers this seam. The worker is not reachable from the app's
 * tests and the main-thread half is in processing.js, which pulls Vite
 * `?worker&url` specifiers and cannot be imported under Node at all. Loading the
 * worker against a fake `self` is the only way to assert the two halves agree.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

const SR = 44100

/**
 * The worker installs `self.onmessage` at module scope and answers through
 * `self.postMessage`, so a stand-in for `self` is all it needs. Imported once —
 * ES modules are cached, and the handler is stateless between messages apart
 * from the request id it echoes.
 */
const replies = []
globalThis.self = {
  onmessage: null,
  postMessage: msg => replies.push(msg),
}
await import('../../src/workers/processWorker.js')

/** Send one request and return its reply. */
function request(type, { channelData, sampleRate = SR, params = {} } = {}) {
  replies.length = 0
  globalThis.self.onmessage({
    data: { __id: 7, type, channelData, sampleRate, params },
  })
  assert.equal(replies.length, 1, `${type} must answer exactly once`)
  return replies[0]
}

/** Voice-ish content, loud enough that the compressors actually reduce. */
function tone(seconds = 0.5) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * 220) / SR
    x[i] = 0.5 * Math.sin(phase)
  }
  return [x]
}

/**
 * ⚠ THE ASSERTION IS ON THE STRING, NOT ON "IT DIDN'T THROW". `type: 'done'` IS
 * the contract — see `getMeasureWorker` — so a reply that carries a perfectly
 * good number under a different type is still a failed measurement.
 */
const MEASUREMENTS = [
  ['la2aAutoMakeup', { peakReduction: 60 }, 'makeupDb'],
  ['la2aAutoMakeup', { peakReduction: 60, reference: 'percentile' }, 'makeupDb'],
  ['fet1176AutoMakeup', { input: 55 }, 'makeupDb'],
  ['softClipperAutoMakeup', {}, 'makeupDb'],
  ['schepsAutoTrim', {}, 'trimDb'],
  ['softClipperCeiling', { percentile: 0.001 }, 'ceilingDb'],
  ['voiceProfile', {}, 'profile'],
  ['measureLoudness', {}, 'loudness'],
  [
    'loudnessNormalize',
    { target: { targetDb: -16, unit: 'LUFS', ceilingDb: -1 }, peakMode: 'limit' },
    'report',
  ],
]

for (const [type, params, key] of MEASUREMENTS) {
  const label = type === 'la2aAutoMakeup' && params.reference
    ? `${type} (${params.reference})`
    : type
  test(`${label} answers with type "done"`, () => {
    const reply = request(type, { channelData: tone(), params })
    assert.equal(reply.type, 'done',
      `${label} answered "${reply.type}" — processing.js rejects anything but "done"`)
    assert.ok(key in reply, `${label} must carry ${key}`)
    assert.equal(reply.__id, 7, 'every reply must echo the request id')
  })
}

test('the two OptoSmooth references really do return different makeup', () => {
  const audio = tone(1)
  const byPeak = request('la2aAutoMakeup', {
    channelData: audio, params: { peakReduction: 60 },
  })
  const byBody = request('la2aAutoMakeup', {
    channelData: audio, params: { peakReduction: 60, reference: 'percentile' },
  })
  assert.equal(byPeak.type, 'done')
  assert.equal(byBody.type, 'done')
  assert.notEqual(byPeak.makeupDb, byBody.makeupDb,
    'the reference is being dropped somewhere between the message and the solve')
})

test('loudnessNormalize hands back audio as well as a report', () => {
  // ⚠ IT REPLIES THROUGH A DIFFERENT HELPER FROM EVERY OTHER HANDLER HERE,
  // because it transfers its buffers rather than copying them. That is a second
  // place the reply is spelled out, and the contract is the same one: `done`,
  // `__id` echoed. Spelling it differently would fail exactly as silently.
  const reply = request('loudnessNormalize', {
    channelData: tone(1),
    params: { target: { targetDb: -16, unit: 'LUFS', ceilingDb: -1 }, peakMode: 'limit' },
  })
  assert.equal(reply.type, 'done')
  assert.equal(reply.__id, 7, 'the transferring reply must echo the request id too')
  assert.equal(reply.channelData.length, 1, 'the rendered audio must come back')
  assert.ok(reply.channelData[0] instanceof Float32Array)
  assert.ok(Number.isFinite(reply.report.achievedDb), 'and the measured report with it')
})

test('an unknown operation answers with an error, not silence', () => {
  const reply = request('nonsenseOperation')
  assert.equal(reply.type, 'error')
  assert.match(reply.message, /Unknown operation/)
})

test('a handler that throws answers with an error, not silence', () => {
  // No channel data at all — the measurement cannot run.
  const reply = request('la2aAutoMakeup', { channelData: undefined })
  assert.equal(reply.type, 'error')
  assert.ok(reply.message, 'an error reply must say something')
})
