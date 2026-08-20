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
import { BiquadCascade, lowpass, peaking } from '../../src/audio/dsp/biquad.js'

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
function voice({ f0 = 120, seconds = 4, sr = SR } = {}) {
  const n = Math.round(sr * seconds)
  const sig = new Float32Array(n)
  const harmonics = Math.floor(5000 / f0)
  const fade = Math.round(0.02 * sr)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const phase = t % 0.75
    if (phase > 0.6) continue
    let env = 1
    const into = phase * sr
    const outOf = (0.6 - phase) * sr
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

/**
 * Additive low-frequency noise — the shape actual rumble has, energy piled at
 * the bottom rather than an amplification of what was already there.
 *
 * An earlier version of this helper only shelved the existing signal, which is
 * a weaker test: boosting a band that is already near-empty flattens the tilt
 * but cannot reverse it, so it never produced the signal the heuristic is
 * really meant to catch. HVAC and traffic ADD energy; they do not amplify the
 * voice's own tail.
 */
function withRumble(audio, levelDbfs, cornerHz = 45) {
  const rumble = new Float32Array(audio.length)
  noiseInto(rumble, Math.pow(10, levelDbfs / 20), 0x1234567)
  // Two cascaded low-passes, so what is added really is confined to the bottom
  // and does not leak into the band the corner is measured against.
  const lp = new BiquadCascade(2, 1)
  lp.setSection(0, lowpass(SR, cornerHz))
  lp.setSection(1, lowpass(SR, cornerHz))
  lp.process(rumble, rumble, rumble.length, 0)

  const out = new Float32Array(audio.length)
  for (let i = 0; i < audio.length; i++) out[i] = audio[i] + rumble[i]
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
  // Levels in dBFS, and measured: the clean signal's tilt is -15.8 dB, -30 dBFS
  // of rumble takes it to -12.5, and -20 dBFS to -5.1. At -10 it goes POSITIVE
  // (+2.8) -- the spectrum genuinely rising toward DC, which is the physical
  // signature this whole measurement is built on.
  const clean = analyzeRumble(voice(), SR, f0sFor(120))
  const light = analyzeRumble(withRumble(voice(), -30), SR, f0sFor(120))
  const heavy = analyzeRumble(withRumble(voice(), -20), SR, f0sFor(120))

  assert.ok(light.applies, `-30 dBFS of rumble was ignored (tilt ${light.tiltDb})`)
  assert.ok(heavy.applies, `-20 dBFS of rumble was ignored (tilt ${heavy.tiltDb})`)
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
  const r = analyzeRumble(withRumble(voice(), -5), SR, f0sFor(120))
  assert.ok(r.gainDb >= -12.001, `spent ${r.gainDb} dB, past the 12 dB bound`)
})

test('unmeasurable input is refused rather than guessed at', () => {
  assert.equal(analyzeRumble(new Float32Array(64), SR, f0sFor(120)), null)
  assert.equal(analyzeRumble(voice(), SR, []), null)
})

test('the tilt bands never run out of bins, at any corner or rate', () => {
  // THE REGRESSION GUARD FOR A DEFECT THAT HAD NO TEST, and which the shipped
  // build failed silently: the tilt bands are fractions of the corner, so on
  // the region machinery's 2048-sample frame they held one or two bins, and
  // below two `analyzeRumble` returned null and produced no finding at all.
  //
  // Measured on that build: at 48 kHz EVERY corner below 75 Hz failed; at
  // 44.1 kHz every corner below 65 failed, and 75 failed while 70 and 80
  // passed — bin-alignment luck rather than a bound. A deep-voiced narrator
  // got no rumble analysis and nothing said so.
  //
  // Swept end to end across the F0 range that maps onto the whole corner
  // range, at every rate the app decodes to, because the failure was a
  // function of both.
  for (const sr of [22050, 44100, 48000]) {
    for (const f0 of [80, 90, 100, 120, 140, 170, 200, 240]) {
      const r = analyzeRumble(voice({ f0, sr }), sr, f0sFor(f0))
      assert.ok(r !== null,
        `no rumble analysis at all for F0 ${f0} at ${sr} Hz (corner ${rumbleCornerHz(f0sFor(f0))})`)
      assert.ok(Number.isFinite(r.tiltDb), `tilt is not a number at F0 ${f0}, ${sr} Hz`)
    }
  }
})

test('a selection too short to measure is refused, not guessed at', () => {
  // The long window introduces a new way to have no frames at all. Halving
  // down to a floor keeps short selections working; below the floor the honest
  // answer is null rather than a tilt nothing supports.
  const sr = 44100
  // 0.4 s — shorter than the 16384-sample frame at this rate, still measurable.
  const short = analyzeRumble(voice({ seconds: 0.4 }), sr, f0sFor(120))
  assert.ok(short !== null, 'a 0.4 s selection was refused')
  // 20 ms — below any usable low-frequency resolution.
  assert.equal(analyzeRumble(voice({ seconds: 0.02 }), sr, f0sFor(120)), null)
})
