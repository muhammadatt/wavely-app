/**
 * The rumble heuristic — see src/audio/voicerx/rumble.js for why it exists
 * outside the region/deviation structure.
 *
 * These build their own signals rather than using the shared synthVoice from
 * voicerxAnalysis.test.js, because that generator is unusable here: it gates its
 * pauses with a hard on/off, and the discontinuities splatter broadband energy
 * below F0 that no real recording has. Its sub-F0 tilt reads -1.4 dB where a
 * real clip reads -14.7. The signals below fade their pauses instead.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeRumble, rumbleCornerHz, RUMBLE_Q } from '../../src/audio/voicerx/rumble.js'
import { BiquadCascade, lowShelf, peaking } from '../../src/audio/dsp/biquad.js'

const SR = 44100

/** Deterministic noise, so a threshold never passes or fails on luck. */
function noiseInto(out, amp, seed) {
  let s = seed
  for (let i = 0; i < out.length; i++) {
    s |= 0; s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    out[i] += ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1) * amp
  }
}

/**
 * A voice with RAISED-COSINE pause edges. The fades are the whole point: a hard
 * gate is a step, a step is broadband, and the splatter lands exactly in the
 * range this heuristic reads.
 */
function voice({ f0 = 120, seconds = 4 } = {}) {
  const n = Math.round(SR * seconds)
  const sig = new Float32Array(n)
  const harmonics = Math.floor(5000 / f0)
  const fade = Math.round(0.02 * SR)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const phase = t % 0.75
    if (phase > 0.6) continue
    let env = 1
    const into = phase * SR
    const outOf = (0.6 - phase) * SR
    if (into < fade) env = 0.5 - 0.5 * Math.cos((Math.PI * into) / fade)
    if (outOf < fade) env = Math.min(env, 0.5 - 0.5 * Math.cos((Math.PI * outOf) / fade))
    let v = 0
    for (let k = 1; k <= harmonics; k++) v += Math.sin(2 * Math.PI * k * f0 * t) / k
    sig[i] = 0.3 * v * env
  }
  // A gentle broadband floor, so the bands below the corner measure a real
  // noise floor rather than numerical dust.
  noiseInto(sig, 0.0008, 0x9e3779b9)
  return sig
}

/** Low-frequency noise, the shape actual rumble has: energy piled at the bottom. */
function withRumble(audio, gainDb, cornerHz = 45) {
  const out = Float32Array.from(audio)
  const rum = new Float32Array(out.length)
  noiseInto(rum, 0.05, 0x1234567)
  // Two cascaded low-passes so the added noise really is confined to the bottom.
  const lp = new BiquadCascade(2, 1)
  lp.setSection(0, peaking(SR, cornerHz, 0.7, 0, 'q'))
  lp.setSection(1, peaking(SR, cornerHz, 0.7, 0, 'q'))
  const shelf = new BiquadCascade(1, 1)
  shelf.setSection(0, lowShelf(SR, cornerHz, 0.7, gainDb))
  shelf.process(out, out, out.length, 0)
  return out
}

const f0sFor = (hz, n = 400) => Array.from({ length: n }, () => hz)

test('the corner lands below the fundamental and inside its clamps', () => {
  // A male voice: min(0.75 x p25, 0.55 x median) with both at 120 -> 66 Hz.
  assert.ok(Math.abs(rumbleCornerHz(f0sFor(120)) - 66) < 0.01)

  // A high female voice would compute 0.55 x 260 = 143, which is clamped: a
  // shelf that high would be inside the voice, and that is the one failure
  // worse than doing nothing.
  assert.equal(rumbleCornerHz(f0sFor(260)), 100)

  // A tracker that has collapsed to nonsense must not drag the corner to DC.
  assert.equal(rumbleCornerHz(f0sFor(20)), 40)
  assert.equal(rumbleCornerHz([]), null)
  assert.equal(rumbleCornerHz(null), null)
})

test('a clean recording gets a shelf of nothing', () => {
  const r = analyzeRumble(voice(), SR, f0sFor(120))
  assert.ok(r, 'the heuristic refused to measure a perfectly ordinary signal')
  assert.equal(r.applies, false, `offered ${r.gainDb} dB on clean audio (tilt ${r.tiltDb})`)
  assert.equal(r.gainDb, 0)
  assert.equal(r.q, RUMBLE_Q)
})

test('rumble is cut, and more of it is cut harder', () => {
  const clean = analyzeRumble(voice(), SR, f0sFor(120))
  const light = analyzeRumble(withRumble(voice(), 12), SR, f0sFor(120))
  const heavy = analyzeRumble(withRumble(voice(), 24), SR, f0sFor(120))

  assert.ok(light.applies, `12 dB of rumble was ignored (tilt ${light.tiltDb})`)
  assert.ok(heavy.applies, `24 dB of rumble was ignored (tilt ${heavy.tiltDb})`)
  assert.ok(heavy.gainDb < light.gainDb,
    `more rumble did not cut harder: ${heavy.gainDb} vs ${light.gainDb}`)
  assert.ok(light.gainDb < clean.gainDb, 'rumble did not move the correction at all')
  // Never a boost. There is no reason to lift a band that cannot hold voice.
  assert.ok(heavy.gainDb <= 0 && light.gainDb <= 0)
})

test('a resonance ABOVE the corner is not mistaken for rumble', () => {
  // 90 Hz sits above the corner of 66, so it is voice range, not rumble. An
  // absolute energy ratio failed exactly here -- it moved in the same direction
  // as real rumble -- which is why the measurement is a tilt.
  const audio = Float32Array.from(voice())
  const f = new BiquadCascade(1, 1)
  f.setSection(0, peaking(SR, 90, 1.0, 12, 'q'))
  f.process(audio, audio, audio.length, 0)

  const r = analyzeRumble(audio, SR, f0sFor(120))
  assert.equal(r.applies, false, `cut ${r.gainDb} dB for a resonance above the corner`)
})

test('the cut is bounded however extreme the rumble', () => {
  const r = analyzeRumble(withRumble(voice(), 60), SR, f0sFor(120))
  assert.ok(r.gainDb >= -12.001, `spent ${r.gainDb} dB, past the 12 dB bound`)
})

test('unmeasurable input is refused rather than guessed at', () => {
  assert.equal(analyzeRumble(new Float32Array(64), SR, f0sFor(120)), null)
  assert.equal(analyzeRumble(voice(), SR, []), null)
})
