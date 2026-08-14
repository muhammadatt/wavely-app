/**
 * The baseline override used for listening to the two detectors back to back.
 *
 * Worth testing because the failure mode is silent: a typo in the query string
 * that fell through to an unrecognised value would change what the detector
 * does while looking exactly like a normal run, and the whole point of the
 * override is to know which side of an A/B you are hearing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBaseline } from '../../src/audio/voicerx/baselineOverride.js'

function withEnv({ search = '', stored = null, throws = false }, fn) {
  const had = 'window' in globalThis
  const previous = globalThis.window
  globalThis.window = {
    location: { search },
    localStorage: {
      getItem: () => {
        if (throws) throw new Error('localStorage is not available')
        return stored
      },
    },
  }
  try {
    return fn()
  } finally {
    if (had) globalThis.window = previous
    else delete globalThis.window
  }
}

test('the shipping baseline is the default', () => {
  assert.equal(withEnv({}, resolveBaseline), 'trend')
})

test('the query string selects a baseline', () => {
  assert.equal(withEnv({ search: '?voicerxBaseline=chord' }, resolveBaseline), 'chord')
  assert.equal(withEnv({ search: '?voicerxBaseline=trend' }, resolveBaseline), 'trend')
  assert.equal(
    withEnv({ search: '?foo=1&voicerxBaseline=chord&bar=2' }, resolveBaseline), 'chord',
  )
})

test('localStorage persists a choice, and the query string outranks it', () => {
  assert.equal(withEnv({ stored: 'chord' }, resolveBaseline), 'chord')
  assert.equal(
    withEnv({ search: '?voicerxBaseline=trend', stored: 'chord' }, resolveBaseline), 'trend',
  )
})

test('an unrecognised value falls back rather than passing through', () => {
  for (const search of ['?voicerxBaseline=chrod', '?voicerxBaseline=', '?voicerxBaseline=v2']) {
    assert.equal(withEnv({ search }, resolveBaseline), 'trend', search)
  }
  assert.equal(withEnv({ stored: 'nonsense' }, resolveBaseline), 'trend')
})

test('a storage access that throws does not break analysis', () => {
  // Safari private mode throws on localStorage rather than returning null.
  assert.equal(withEnv({ throws: true }, resolveBaseline), 'trend')
})
