/**
 * Run with:  npm test
 *
 * AUTO LEVEL — clip-based gain riding, client port of server/pipeline/autoLeveler.js.
 *
 * ⚠ THE LOAD-BEARING TEST IS `the envelope is the same wherever it is evaluated
 * from`. The offline apply path renders a PRE-ROLL ahead of its region and has
 * to give that pre-roll the same gain the preview gave it — otherwise the
 * compressors downstream meet a level step exactly at the region boundary, which
 * is the thing a pre-roll exists to prevent. That only holds if the envelope is
 * a function of absolute position in the file and not of where the render
 * happened to start, and the cursor in `renderAutoLevelGainDb` is where that
 * could quietly stop being true.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  analyzeAutoLevel, renderAutoLevelGainDb, renderAutoLevelGainLinear,
  voicedFramesByEnergy, applyVadHysteresis, shapeDrift,
  AUTO_LEVEL_DEFAULTS, FRAME_MS, VAD_MIN_VOICED_MS, VAD_MIN_UNVOICED_MS,
} from '../../src/audio/dsp/autoLevel.js'
import { kWeightingSections } from '../../src/audio/dsp/loudness.js'
import { BiquadCascade } from '../../src/audio/dsp/biquad.js'

const SR = 44100

/**
 * Narration-shaped: phrases with real pauses between them, a syllable envelope
 * that DIPS but does not fall to the floor mid-phrase, and room tone throughout.
 *
 * ⚠ THE MID-PHRASE FLOOR IS NOT COSMETIC. A generator whose syllables reach
 * digital silence between them puts the signal under the voiced gate several
 * times a second, and `applyVadHysteresis`'s first pass then drops every voiced
 * run as too short — the mask comes back empty and the stage skips. Real speech
 * does not stop between syllables; a stimulus that does is testing the gate's
 * behaviour on something that never arrives.
 */
function narration({ seconds = 60, driftDb = 0, seed = 5, floorDb = -60,
                     phraseS = 4, pauseS = 1, baseDb = -18, leadSilenceS = 0 } = {}) {
  const lead = Math.round(SR * leadSilenceS)
  const n = Math.round(SR * seconds) + lead
  const x = new Float32Array(n)
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1
  const floor = Math.pow(10, floorDb / 20)
  const base = Math.pow(10, baseDb / 20)
  for (let i = 0; i < n; i++) {
    const t = (i - lead) / SR
    let v = floor * rnd()
    if (i >= lead && (t % (phraseS + pauseS)) < phraseS) {
      const syl = 0.25 + 0.75 * Math.max(0, Math.sin(2 * Math.PI * 3.2 * t)) ** 2
      const drift = Math.pow(10, (driftDb * (t / seconds)) / 20)
      v += base * drift * syl * (
        Math.sin(2 * Math.PI * 170 * t) + 0.5 * Math.sin(2 * Math.PI * 340 * t + 0.7)
        + 0.25 * Math.sin(2 * Math.PI * 900 * t + 1.3) + 0.1 * rnd()
      )
    }
    x[i] = v
  }
  return x
}

function kWeighted(channel) {
  const sections = kWeightingSections(SR)
  const cascade = new BiquadCascade(sections.length, 1)
  cascade.setSections(sections)
  const y = new Float32Array(channel.length)
  cascade.process(channel, y, channel.length, 0)
  return y
}
const lufsRange = (kw, a, b) => {
  let sum = 0
  for (let i = a; i < b; i++) sum += kw[i] * kw[i]
  return -0.691 + 10 * Math.log10(sum / (b - a))
}
const stdev = (v) => {
  const m = v.reduce((a, b) => a + b, 0) / v.length
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length)
}
const applyGain = (x, gainDb) => {
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) y[i] = x[i] * Math.pow(10, gainDb[i] / 20)
  return y
}

test('shapeDrift: the deadband is exactly zero, not merely small', () => {
  // A file already level must come back BIT-IDENTICAL, not nudged, which needs
  // the correction to be exactly 0 rather than a small number.
  for (const d of [0, 0.5, 1.0, 1.49]) {
    assert.equal(shapeDrift(d, 1.5, 1, 6, 8), 0)
    assert.equal(shapeDrift(-d, 1.5, 1, 6, 8), 0)
  }
})

test('shapeDrift: closes the excess over the deadband, not the whole gap', () => {
  // 5 dB out with a 1.5 dB deadband corrects 3.5 dB, leaving the deadband
  // uncorrected by design — otherwise the deadband would be a trigger rather
  // than a no-op band.
  assert.ok(Math.abs(shapeDrift(5, 1.5, 1, 20, 20) - 3.5) < 1e-9)
  assert.ok(Math.abs(shapeDrift(-5, 1.5, 1, 20, 20) + 3.5) < 1e-9)
})

test('shapeDrift: monotonic through the knee, and clamped per direction', () => {
  let prev = -Infinity
  for (let d = 0; d <= 12; d += 0.05) {
    const g = shapeDrift(d, 1.5, 1, 6, 8)
    assert.ok(g >= prev - 1e-12, `not monotonic at ${d}`)
    prev = g
  }
  assert.equal(shapeDrift(100, 1.5, 1, 6, 8), 6)
  assert.equal(shapeDrift(-100, 1.5, 1, 6, 8), -8)
})

test('the voiced gate reads the noise floor from the file, not a constant', () => {
  const quiet = narration({ seconds: 20, floorDb: -70 })
  const noisy = narration({ seconds: 20, floorDb: -45 })
  const a = voicedFramesByEnergy(quiet, SR)
  const b = voicedFramesByEnergy(noisy, SR)
  assert.ok(a.noiseFloorDbfs < b.noiseFloorDbfs - 15,
    `floors should track the material: ${a.noiseFloorDbfs} vs ${b.noiseFloorDbfs}`)
  // Both should still find roughly the same speech — the gate is relative.
  const count = (m) => m.reduce((s, v) => s + v, 0)
  const ratio = count(a.voiced) / count(b.voiced)
  assert.ok(ratio > 0.9 && ratio < 1.1,
    `a relative gate should find the same speech at either floor; ratio ${ratio}`)
})

test('hysteresis drops brief voiced runs and bridges brief unvoiced gaps', () => {
  const frames = (pattern) => Uint8Array.from(pattern)
  const minVoiced = Math.round(VAD_MIN_VOICED_MS / FRAME_MS) // 8
  const minUnvoiced = Math.round(VAD_MIN_UNVOICED_MS / FRAME_MS) // 12

  // A run one frame short of the minimum is dropped entirely.
  const brief = new Array(40).fill(0)
  for (let i = 10; i < 10 + minVoiced - 1; i++) brief[i] = 1
  assert.ok(applyVadHysteresis(frames(brief)).every(v => v === 0))

  /**
   * ⚠ THE BRIDGING PASS IS WHAT MAKES AN ENERGY GATE USABLE HERE. Silero labels
   * unvoiced fricatives as speech; an energy gate at noiseFloor + 6 dB does not,
   * so a phrase could fragment at its own "s". A gap shorter than 300 ms is
   * bridged, and speech fricatives are always shorter than that.
   */
  const gapped = new Array(80).fill(1)
  for (let i = 30; i < 30 + minUnvoiced - 1; i++) gapped[i] = 0
  assert.ok(applyVadHysteresis(frames(gapped)).every(v => v === 1),
    'a sub-300 ms gap inside speech should be bridged')

  // A gap at or past the minimum is a real phrase boundary and survives.
  const paused = new Array(80).fill(1)
  for (let i = 30; i < 30 + minUnvoiced + 4; i++) paused[i] = 0
  assert.ok(applyVadHysteresis(frames(paused)).some(v => v === 0),
    'a real pause should not be bridged away')
})

test('a file that is already level is skipped rather than nudged', () => {
  const flat = narration({ driftDb: 0 })
  const result = analyzeAutoLevel([flat], SR)
  assert.equal(result.applied, false)
  assert.equal(result.skippedReason, 'file_already_leveled')
  // And the envelope of a skipped analysis is unity everywhere.
  const g = renderAutoLevelGainDb(result, 0, SR)
  assert.ok(g.every(v => v === 0))
})

test('global mode removes whole-file drift', () => {
  const x = narration({ driftDb: 20 })
  const a = analyzeAutoLevel([x], SR, { targetMode: 'global' })
  assert.ok(a.applied, `expected an applied result, got ${a.skippedReason}`)

  const y = applyGain(x, renderAutoLevelGainDb(a, 0, x.length))
  const kx = kWeighted(x)
  const ky = kWeighted(y)
  const before = a.clips.map(c => lufsRange(kx, c.sampleStart, c.sampleEnd))
  const after = a.clips.map(c => lufsRange(ky, c.sampleStart, c.sampleEnd))

  // Measured on this stimulus: sd 5.75 -> 1.60, range 18.33 -> 4.33.
  assert.ok(stdev(after) < stdev(before) / 2,
    `clip spread should more than halve: sd ${stdev(before).toFixed(2)} -> ${stdev(after).toFixed(2)}`)
  assert.ok(Math.max(...after) - Math.min(...after) < 6,
    `range after: ${(Math.max(...after) - Math.min(...after)).toFixed(2)} dB`)
})

test('⚠ the envelope has no step at the head, where the server steps', () => {
  /**
   * The server's buildSampleGainArray fills everything before the first clip
   * with 0 dB and the clip with its own gain, so the envelope jumps by the whole
   * of that gain on a single sample — landing exactly where the first word
   * begins. Measured here before the head ramp existed: 6.00 dB.
   *
   * ⚠ EVERY ACX FILE MEETS THIS, which is why the port diverges rather than
   * matching: roomTonePad puts 0.75 s of room tone at the head of a narration
   * file, so leading silence is the house style for the beachhead audience.
   */
  const x = narration({ driftDb: 20, leadSilenceS: 3 })
  const a = analyzeAutoLevel([x], SR, { targetMode: 'global' })
  assert.ok(a.applied)
  assert.ok(a.clips[0].sampleStart > 0, 'this probe needs leading silence to be a probe')
  assert.ok(a.headPlan != null, 'a first clip past sample 0 should get a head ramp')

  const g = renderAutoLevelGainDb(a, 0, x.length)
  let worstStep = 0
  for (let i = 1; i < g.length; i++) worstStep = Math.max(worstStep, Math.abs(g[i] - g[i - 1]))
  // Measured: 7.12e-3 dB with the ramp, 6.00 without it.
  assert.ok(worstStep < 0.05, `envelope steps by ${worstStep.toFixed(4)} dB in one sample`)

  // And the ramp is placed in the silence, not over the first word.
  assert.ok(a.headPlan.endSample <= a.clips[0].sampleStart,
    'the head ramp must finish before the first clip begins')
})

test('the envelope is the same wherever it is evaluated from', () => {
  /**
   * ⚠ THIS IS WHAT THE APPLY PATH'S PRE-ROLL RESTS ON. A region is rendered with
   * audio ahead of it, and that audio has to carry the gain the preview gave it.
   * If the envelope depended on where evaluation started, the pre-roll would be
   * levelled differently from the region and the composite's compressors would
   * meet a step at precisely the boundary the pre-roll exists to smooth over.
   */
  const x = narration({ driftDb: 20, leadSilenceS: 2 })
  const a = analyzeAutoLevel([x], SR, { targetMode: 'global' })
  assert.ok(a.applied)

  const whole = renderAutoLevelGainDb(a, 0, x.length)

  for (const startSample of [0, 1, SR, SR * 7 + 13, SR * 23, x.length - SR]) {
    const len = Math.min(SR * 3, x.length - startSample)
    const span = renderAutoLevelGainDb(a, startSample, len)
    for (let i = 0; i < len; i++) {
      assert.equal(span[i], whole[startSample + i],
        `span from ${startSample} differs at offset ${i}`)
    }
  }

  // Past the end of the file the envelope holds the last clip's gain, matching
  // what the preview's modulator does when it runs past its buffer.
  const tail = renderAutoLevelGainDb(a, x.length, 512)
  assert.ok(tail.every(v => v === tail[0]))
})

test('a span starting before the file holds 0 dB, then ramps in', () => {
  const x = narration({ driftDb: 20, leadSilenceS: 2 })
  const a = analyzeAutoLevel([x], SR, { targetMode: 'global' })
  const g = renderAutoLevelGainDb(a, -SR, SR * 3)
  // The first second is before sample 0 and must be the head's own value.
  assert.ok(g.slice(0, SR).every(v => v === g[0]))
  assert.ok(Number.isFinite(g[g.length - 1]))
})

test('the noise floor caps how far anything may be raised', () => {
  /**
   * Lifting a quiet clip lifts its room tone with it. A leveller that hands back
   * a louder noise floor than it was given has made the file worse in the one
   * dimension ACX actually measures.
   */
  const noisy = narration({ driftDb: 20, floorDb: -40 })
  const a = analyzeAutoLevel([noisy], SR, {
    targetMode: 'global', noiseFloorTargetDbfs: -50, maxUpDb: 10,
  })
  assert.ok(a.applied, `expected applied, got ${a.skippedReason}`)
  assert.ok(a.maxUpDbEffective < 10,
    `a -40 dBFS floor against a -50 target should cap the lift; got ${a.maxUpDbEffective}`)
  assert.ok(a.gainsDb.every(g => g <= a.maxUpDbEffective + 1e-9),
    'no clip may be raised past the cap')
})

test('the linear envelope is the dB one, converted', () => {
  const x = narration({ driftDb: 20 })
  const a = analyzeAutoLevel([x], SR, { targetMode: 'global' })
  const db = renderAutoLevelGainDb(a, 0, 5000)
  const lin = renderAutoLevelGainLinear(a, 0, 5000)
  for (let i = 0; i < db.length; i += 97) {
    assert.ok(Math.abs(lin[i] - Math.pow(10, db[i] / 20)) < 1e-6)
  }
})

test('the chunked K-weighting matches a single-pass measurement', () => {
  /**
   * ⚠ THIS IS THE ONLY DIRECT CHECK ON THE STREAMING FILTER. The energy sum is
   * built in chunks so the scratch buffer is not file-length — an hour at
   * 44.1 kHz would otherwise want a 1.27 GB Float64Array and a 635 MB mono
   * buffer, on exactly the file size this product exists for. A BiquadCascade
   * is a stateful streaming filter, so the chunks are only equivalent while its
   * state is CARRIED ACROSS them; resetting between chunks would put a filter
   * transient at every boundary, ~40 s apart, and nothing else here would
   * notice.
   *
   * 90 s crosses at least one chunk boundary (4096 blocks x 10 ms = 41 s).
   */
  const x = narration({ seconds: 90, driftDb: 12 })
  const a = analyzeAutoLevel([x], SR, { targetMode: 'global' })
  assert.ok(a.applied)
  assert.ok(x.length > 41 * SR, 'the probe must be long enough to cross a chunk boundary')

  const kw = kWeighted(x) // one uninterrupted cascade over the whole file
  for (let k = 0; k < a.clips.length; k++) {
    const c = a.clips[k]
    const independent = lufsRange(kw, c.sampleStart, c.sampleEnd)
    // Block quantisation of the range ends is the only expected difference.
    assert.ok(Math.abs(a.clipLufs[k] - independent) < 0.05,
      `clip ${k}: ${a.clipLufs[k].toFixed(3)} vs single-pass ${independent.toFixed(3)}`)
  }
})

test('channels are summed, not measured separately and averaged', () => {
  /**
   * ⚠ THE TWO AGREE ON DUPLICATED CHANNELS, WHICH IS WHY THAT CANNOT BE THE
   * TEST. `[x, x]` is precisely the case where a channel sum and a mean of
   * channel powers give the same answer — the same trap `inputAlign.js` records
   * a measurement falling into. Opposed channels separate them: summed, they
   * cancel to the room tone and nothing is voiced.
   */
  const x = narration({ driftDb: 12 })
  const inverted = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) inverted[i] = -x[i]

  const summed = voicedFramesByEnergy([x, inverted], SR, x.length)
  const count = (m) => m.reduce((s, v) => s + v, 0)
  assert.equal(count(summed.voiced), 0,
    'a polarity-flipped pair sums to silence and must read as silence')

  // And an ordinary duplicated pair reads the same as the mono original.
  const mono = voicedFramesByEnergy([x], SR, x.length)
  const dual = voicedFramesByEnergy([x, x], SR, x.length)
  assert.equal(count(dual.voiced), count(mono.voiced))
})

test('short and empty input is skipped, not crashed on', () => {
  assert.equal(analyzeAutoLevel([], SR).skippedReason, 'empty')
  assert.equal(analyzeAutoLevel([new Float32Array(0)], SR).skippedReason, 'empty')
  assert.equal(analyzeAutoLevel([new Float32Array(SR)], SR).skippedReason, 'file_too_short')
  // Long enough, but no speech in it.
  const silence = new Float32Array(SR * 20)
  assert.equal(analyzeAutoLevel([silence], SR).applied, false)
  assert.deepEqual(AUTO_LEVEL_DEFAULTS.targetMode, 'running_median')
})
