import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  setPlaybackAudioSession,
  needsResume,
  keepContextRunning,
  RESUME_GESTURES,
} from '../../src/platform/audioSession.js'

/** A document stand-in that records listeners and can fire them. */
function fakeDocument() {
  const listeners = new Map()
  return {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    fire(type) {
      for (const fn of listeners.get(type) ?? []) fn()
    },
    count() {
      let n = 0
      for (const set of listeners.values()) n += set.size
      return n
    },
  }
}

/** A context stand-in whose resume() is counted and can be refused. */
function fakeContext(state, { refuse = false } = {}) {
  const ctx = {
    state,
    resumes: 0,
    resume() {
      ctx.resumes++
      if (refuse) return Promise.reject(new Error('NotAllowedError'))
      ctx.state = 'running'
      return Promise.resolve()
    },
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

test('suspended and interrupted contexts need a resume; running and closed do not', () => {
  assert.equal(needsResume({ state: 'suspended' }), true)
  assert.equal(needsResume({ state: 'interrupted' }), true)
  assert.equal(needsResume({ state: 'running' }), false)
  assert.equal(needsResume({ state: 'closed' }), false)
  assert.equal(needsResume(null), false)
})

test('an interrupted context resumes on the next user gesture', () => {
  const doc = fakeDocument()
  const ctx = fakeContext('interrupted')
  keepContextRunning(ctx, doc)
  doc.fire('touchend')
  assert.equal(ctx.resumes, 1)
  assert.equal(ctx.state, 'running')
  // Running now: further gestures leave it alone.
  doc.fire('click')
  assert.equal(ctx.resumes, 1)
})

test('listens for every gesture iOS accepts, plus visibility', () => {
  const doc = fakeDocument()
  keepContextRunning(fakeContext('running'), doc)
  assert.equal(doc.count(), RESUME_GESTURES.length + 1)
  for (const type of ['touchend', 'click', 'keydown']) assert.ok(RESUME_GESTURES.includes(type))
})

test('a refused resume is swallowed and the next gesture tries again', async () => {
  const doc = fakeDocument()
  const ctx = fakeContext('interrupted', { refuse: true })
  keepContextRunning(ctx, doc)
  doc.fire('click')
  doc.fire('keydown')
  await new Promise(r => setImmediate(r)) // let the rejections settle unhandled-free
  assert.equal(ctx.resumes, 2)
})

test('returning to the page tries to resume; hiding it does not', () => {
  const doc = fakeDocument()
  const ctx = fakeContext('suspended')
  keepContextRunning(ctx, doc)
  doc.visibilityState = 'hidden'
  doc.fire('visibilitychange')
  assert.equal(ctx.resumes, 0)
  doc.visibilityState = 'visible'
  doc.fire('visibilitychange')
  assert.equal(ctx.resumes, 1)
})

test('the returned cleanup removes every listener', () => {
  const doc = fakeDocument()
  const stop = keepContextRunning(fakeContext('running'), doc)
  stop()
  assert.equal(doc.count(), 0)
})

test('the editor sets the session before creating its AudioContext', () => {
  const src = readFileSync(new URL('../../src/composables/useEditorState.js', import.meta.url), 'utf8')
  const session = src.indexOf('setPlaybackAudioSession()')
  const create = src.indexOf('new (window.AudioContext')
  assert.ok(session > 0 && create > 0 && session < create)
  assert.ok(src.includes('keepContextRunning(audioContext)'))
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
