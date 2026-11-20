import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  setPlaybackAudioSession,
  createAudioContext,
  needsResume,
  resumeIfStopped,
  onContextStopped,
} from '../../src/platform/audioSession.js'
import { startPlayback, stopPlayback } from '../../src/audio/playback.js'

/** A context stand-in: counts resume() calls, can refuse or throw, fires statechange. */
function fakeContext(state, { refuse = false, throwSync = false } = {}) {
  const listeners = new Set()
  const ctx = {
    state,
    resumes: 0,
    resume() {
      ctx.resumes++
      if (throwSync) throw new Error('InvalidStateError')
      if (refuse) return Promise.reject(new Error('NotAllowedError'))
      ctx.state = 'running'
      return Promise.resolve()
    },
    addEventListener(type, fn) { if (type === 'statechange') listeners.add(fn) },
    removeEventListener(type, fn) { if (type === 'statechange') listeners.delete(fn) },
    /** Move to `next` and fire statechange, as the browser would. */
    become(next) {
      ctx.state = next
      for (const fn of listeners) fn()
    },
    listenerCount: () => listeners.size,
  }
  return ctx
}

test('sets the audio session to playback where the API exists', () => {
  const nav = { audioSession: { type: 'auto' } }
  assert.equal(setPlaybackAudioSession(nav), true)
  assert.equal(nav.audioSession.type, 'playback')
})

test('leaves browsers without the Audio Session API alone', () => {
  assert.equal(setPlaybackAudioSession({}), false)
  assert.equal(setPlaybackAudioSession(undefined), false)
})

test('a session that refuses the type reports false instead of throwing', () => {
  const nav = {
    audioSession: {
      get type() { return 'auto' },
      set type(_) { throw new Error('refused') },
    },
  }
  assert.equal(setPlaybackAudioSession(nav), false)
})

test('creates a context from the prefixed constructor where only that exists', () => {
  class Webkit { constructor() { this.kind = 'webkit' } }
  class Standard { constructor() { this.kind = 'standard' } }
  assert.equal(createAudioContext({ webkitAudioContext: Webkit }).kind, 'webkit')
  assert.equal(createAudioContext({ AudioContext: Standard, webkitAudioContext: Webkit }).kind, 'standard')
})

test('suspended and interrupted contexts need a resume; running and closed do not', () => {
  assert.equal(needsResume({ state: 'suspended' }), true)
  assert.equal(needsResume({ state: 'interrupted' }), true)
  assert.equal(needsResume({ state: 'running' }), false)
  assert.equal(needsResume({ state: 'closed' }), false)
  assert.equal(needsResume(null), false)
})

test('resumeIfStopped resumes a stopped context and leaves a running one alone', async () => {
  const stopped = fakeContext('interrupted')
  assert.equal(await resumeIfStopped(stopped), true)
  assert.equal(stopped.resumes, 1)

  const running = fakeContext('running')
  assert.equal(await resumeIfStopped(running), true)
  assert.equal(running.resumes, 0)

  assert.equal(await resumeIfStopped(fakeContext('closed')), false)
  assert.equal(await resumeIfStopped(null), false)
})

test('resumeIfStopped never rejects or throws: a refusal resolves false', async () => {
  assert.equal(await resumeIfStopped(fakeContext('interrupted', { refuse: true })), false)
  assert.equal(await resumeIfStopped(fakeContext('suspended', { throwSync: true })), false)
})

test('a context that stops under the user reports it; one that starts does not', () => {
  const ctx = fakeContext('running')
  let stops = 0
  const stop = onContextStopped(ctx, () => stops++)
  ctx.become('interrupted')
  assert.equal(stops, 1)
  ctx.become('running')
  assert.equal(stops, 1)
  ctx.become('suspended')
  assert.equal(stops, 2)
  ctx.become('closed')
  assert.equal(stops, 2)
  stop()
  assert.equal(ctx.listenerCount(), 0)
})

test('nothing resumes the context on its own: only a call to resumeIfStopped does', () => {
  const ctx = fakeContext('running')
  onContextStopped(ctx, () => {})
  ctx.become('interrupted')
  assert.equal(ctx.resumes, 0)
})

// ── Where the session is claimed ─────────────────────────────────────────────

/** Just enough AudioContext for startPlayback to schedule one node. */
function playbackContext() {
  return {
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    createBufferSource: () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, onended: null }),
    createGain: () => ({ connect() {}, disconnect() {} }),
  }
}

/** Run `fn` with a fake navigator.audioSession, restoring the real one after. */
function withAudioSession(fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const session = { type: 'auto' }
  Object.defineProperty(globalThis, 'navigator', { value: { audioSession: session }, configurable: true, writable: true })
  const raf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame ??= () => 0
  globalThis.cancelAnimationFrame ??= () => {}
  try {
    fn(session)
  } finally {
    stopPlayback()
    if (desc) Object.defineProperty(globalThis, 'navigator', desc)
    else delete globalThis.navigator
    if (!raf) delete globalThis.requestAnimationFrame
  }
}

test('starting playback claims the playback audio session', () => {
  withAudioSession((session) => {
    const segments = [{
      id: 's', outputStart: 0, sourceStart: 0, sourceEnd: 1,
      sourceBuffer: { duration: 1, numberOfChannels: 1, sampleRate: 48000 }, sourceBufferId: 'b',
    }]
    startPlayback(segments, 0, playbackContext(), () => {}, () => {})
    assert.equal(session.type, 'playback')
  })
})

test('creating the editor context does not claim the session (imports must not stop other audio)', () => {
  const src = readFileSync(new URL('../../src/composables/useEditorState.js', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('function getAudioContext()'), src.indexOf('// ── Undo/Redo'))
  assert.ok(body.length > 0)
  assert.doesNotMatch(body, /setPlaybackAudioSession\(/)
  assert.match(body, /onContextStopped\(audioContext/)
})

test('the web app manifest is linked and its icons exist', () => {
  const root = new URL('../../', import.meta.url)
  const html = readFileSync(new URL('index.html', root), 'utf8')
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/)
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/)
  readFileSync(new URL('public/icons/apple-touch-icon.png', root))

  const manifest = JSON.parse(readFileSync(new URL('public/manifest.webmanifest', root), 'utf8'))
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.start_url, '/')
  const sizes = manifest.icons.map(i => `${i.sizes}:${i.purpose}`)
  assert.ok(sizes.includes('192x192:any'))
  assert.ok(sizes.includes('512x512:any'))
  assert.ok(sizes.includes('512x512:maskable'))
  for (const icon of manifest.icons) {
    const png = readFileSync(new URL(`public${icon.src}`, root))
    // PNG width and height sit at bytes 16–23 of the IHDR chunk.
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)]
    assert.equal(`${w}x${h}`, icon.sizes, icon.src)
  }
})
