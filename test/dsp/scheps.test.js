/**
 * Run with:  npm test
 *
 * Covers the two things the Scheps chain adds beyond its parts: the parallel
 * blend (dry alignment, mix law, level behaviour) and the measured trim that
 * makes an A/B honest. The Pultec curves are covered in pultec.test.js and the
 * compressor in the LA-2A's own tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SchepsKernel,
  processSchepsBuffer,
  computeSchepsAutoTrim,
  mixGains,
  SCHEPS_KERNEL_DEFAULTS,
} from '../../src/audio/schepsProcessor.js'
import { OVERSAMPLE_LATENCY_SAMPLES } from '../../src/audio/dsp/oversample.js'
import { highpass, lowpass, BiquadCascade } from '../../src/audio/dsp/biquad.js'
import {
  percentileOfChannels, MAKEUP_PERCENTILE, CEILING_KNEE_DB,
} from '../../src/audio/dsp/makeupReference.js'
import { SCHEPS_DEFAULTS, toKernelParams } from '../../src/audio/effects/schepsParams.js'
import { withMeasuredClears } from '../../src/audio/effects/measuredKeys.js'
import {
  setLA2ATuning, resetLA2ATuning, la2aTuningOverrides,
} from '../../src/audio/effects/la2aTuning.js'

const SR = 44100

function rms(x, skip = 0) {
  let s = 0
  for (let i = skip; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, x.length - skip))
}

function db(x) {
  return 20 * Math.log10(x)
}

/**
 * A stand-in for a voice.
 *
 * FORMANTS MATTER HERE, and a plain 1/h harmonic stack will not do. Both this
 * chain's low-rejecting elements — the Pultec pre-cut and R37 wide open — take
 * energy out of the side-chain below about a kilohertz, so a probe whose energy
 * is almost all fundamental is the one signal that makes a working compressor
 * look idle. Resonances near 600/1800/2800 Hz plus a little fricative noise put
 * weight where speech actually has it, and roughly double the gain reduction at
 * a matched level.
 *
 * The syllable envelope is shaped rather than gated: a hard on/off splatters
 * broadband energy that the low shelves would then read as content.
 */
function voiceLike(seconds, { f0 = 130, envRateHz = 3 } = {}) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  let seed = 1
  for (let i = 0; i < n; i++) {
    const t = i / SR
    let s = 0
    for (let h = 1; h <= 40; h++) {
      const f = f0 * h
      if (f > SR / 2) break
      let a = 1 / h
      for (const F of [600, 1800, 2800]) {
        a += 0.9 * Math.exp(-Math.pow((f - F) / 260, 2)) / Math.sqrt(h)
      }
      // Per-harmonic phase offset: summing them all in phase builds an
      // impulse train with a crest factor no voice has.
      s += a * Math.sin(2 * Math.PI * f * t + h)
    }
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const env = 0.25 + 0.75 * (0.5 - 0.5 * Math.cos(2 * Math.PI * envRateHz * t))
    out[i] = 0.06 * (s + ((seed / 0x7fffffff) - 0.5) * 0.35) * env
  }
  return out
}

/**
 * RMS of the 300 Hz - 4 kHz band, in dB.
 *
 * The level the trim actually targets, and the one the ear uses to judge how
 * loud a voice is. Broadband RMS is not a substitute: on a real narrator
 * recording 81% of the total energy sits between 125 and 500 Hz, so a broadband
 * figure barely moves when the whole intelligibility range shifts by 3 dB.
 */
function speechRmsDb(x, skip = 0) {
  const c = new BiquadCascade(2, 1)
  c.setSections([highpass(SR, 300, Math.SQRT1_2), lowpass(SR, 4000, Math.SQRT1_2)])
  const y = new Float32Array(x.length)
  c.process(x, y, x.length, 0)
  return 10 * Math.log10(
    y.subarray(skip).reduce((s, v) => s + v * v, 0) / (y.length - skip) + 1e-30,
  )
}

/** Speech-band level of the loud parts — p95 of 100 ms blocks. The makeup target. */
function loudPartDb(x, skip = 0) {
  const c = new BiquadCascade(2, 1)
  c.setSections([highpass(SR, 300, Math.SQRT1_2), lowpass(SR, 4000, Math.SQRT1_2)])
  const y = new Float32Array(x.length)
  c.process(x, y, x.length, 0)
  const W = Math.round(SR * 0.1)
  const blocks = []
  for (let off = skip; off + W <= y.length; off += W) {
    let s = 0
    for (let i = 0; i < W; i++) s += y[off + i] * y[off + i]
    blocks.push(10 * Math.log10(s / W + 1e-30))
  }
  const loudest = Math.max(...blocks)
  const voiced = blocks.filter(v => v > loudest - 40).sort((a, b) => a - b)
  return voiced[Math.floor((voiced.length - 1) * 0.95)]
}

/** Standard deviation of short-term (50 ms) RMS, in dB — how uneven a level is. */
function levelSpreadDb(x, skip = 0) {
  const W = Math.round(0.05 * SR)
  const frames = []
  for (let off = skip; off + W <= x.length; off += W) {
    let s = 0
    for (let i = 0; i < W; i++) s += x[off + i] * x[off + i]
    frames.push(20 * Math.log10(Math.sqrt(s / W) + 1e-12))
  }
  const mean = frames.reduce((a, b) => a + b, 0) / frames.length
  return Math.sqrt(frames.reduce((a, b) => a + (b - mean) ** 2, 0) / frames.length)
}

// ── mix law ─────────────────────────────────────────────────────────────────

test('mix law is equal-power, not linear', () => {
  const { dry, wet } = mixGains(0.5)
  assert.ok(Math.abs(dry - Math.SQRT1_2) < 1e-12)
  assert.ok(Math.abs(wet - Math.SQRT1_2) < 1e-12)
  // The point of choosing it: a linear blend would put each path 6 dB down here.
  assert.ok(db(dry) > -3.5 && db(dry) < -2.5)
})

test('mix law endpoints are exactly one path or the other', () => {
  for (const rho of [0, 0.5, 0.9]) {
    const off = mixGains(0, rho)
    assert.ok(Math.abs(off.dry * off.compensation - 1) < 1e-12)
    assert.ok(Math.abs(off.wet) < 1e-12)
    const full = mixGains(1, rho)
    assert.ok(Math.abs(full.wet * full.compensation - 1) < 1e-12)
    assert.ok(Math.abs(full.dry) < 1e-12)
  }
})

test('correlation compensation holds the summed level flat across the sweep', () => {
  // Two level-matched, correlated paths. Without compensation the equal-power
  // law would run up to 3 dB hot in the middle of the Mix sweep — the loudness
  // bias the auto trim exists to remove, arriving from the other direction.
  for (const rho of [0, 0.4, 0.8, 0.95]) {
    for (const mix of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const { dry, wet, compensation } = mixGains(mix, rho)
      const power = dry * dry + wet * wet + 2 * rho * dry * wet
      const summed = power * compensation * compensation
      assert.ok(
        Math.abs(db(Math.sqrt(summed))) < 0.01,
        `rho ${rho}, mix ${mix}: summed level ${db(Math.sqrt(summed)).toFixed(3)} dB`,
      )
    }
  }
})

test('uncompensated equal-power really would run hot — the guard is not theatre', () => {
  const rho = 0.8
  const { dry, wet } = mixGains(0.5, rho)
  const power = dry * dry + wet * wet + 2 * rho * dry * wet
  assert.ok(db(Math.sqrt(power)) > 2, `expected a real bump, got ${db(Math.sqrt(power))} dB`)
})

// ── blend wiring ────────────────────────────────────────────────────────────

test('Mix at 0 is the dry signal, delayed by exactly the reported latency', () => {
  const input = voiceLike(0.5)
  const { channelData, latencySamples } = processSchepsBuffer([input], SR, { mix: 0 })
  assert.equal(latencySamples, OVERSAMPLE_LATENCY_SAMPLES)

  const out = channelData[0]
  for (let i = latencySamples; i < input.length; i++) {
    assert.ok(
      Math.abs(out[i] - input[i - latencySamples]) < 1e-6,
      `sample ${i}: ${out[i]} vs ${input[i - latencySamples]}`,
    )
  }
})

test('the dry path is delay-aligned to the wet one — no comb filtering', () => {
  // A misaligned parallel blend of two near-identical signals cancels, and the
  // cancellation is deepest exactly where the two paths agree most: the low end.
  // Compare the blended output's low-frequency energy against the dry alone.
  const input = voiceLike(1)
  const { channelData: mixed } = processSchepsBuffer([input], SR, {
    mix: 0.5, character: 'thick',
  })
  const skip = OVERSAMPLE_LATENCY_SAMPLES

  // Thick's net curve is +4 dB at the bottom and the wet path is not trimmed
  // here, so a correctly aligned blend must come out LOUDER than the dry, never
  // quieter. Any real misalignment shows up as a loss.
  assert.ok(
    db(rms(mixed[0], skip) / rms(input, skip)) > -0.5,
    `blend lost level: ${db(rms(mixed[0], skip) / rms(input, skip)).toFixed(2)} dB`,
  )
})

test('in-place processing gives the same result as out-of-place', () => {
  // The kernel reads the dry sample before writing the output for exactly this.
  const input = voiceLike(0.3)
  const { channelData } = processSchepsBuffer([input], SR, { mix: 0.4 })

  const kernel = new SchepsKernel(SR)
  kernel.setParams({ mix: 0.4 })
  const scratch = Float32Array.from(input)
  for (let off = 0; off < scratch.length; off += 128) {
    const len = Math.min(128, scratch.length - off)
    const view = scratch.subarray(off, off + len)
    kernel.process([view], [view], len)
  }
  for (let i = 0; i < scratch.length; i++) {
    assert.ok(Math.abs(scratch[i] - channelData[0][i]) < 1e-6, `sample ${i} diverged`)
  }
})

test('block size does not change the output', () => {
  const input = voiceLike(0.3)
  const reference = processSchepsBuffer([input], SR, { mix: 0.5 }).channelData[0]

  const kernel = new SchepsKernel(SR)
  kernel.setParams({ mix: 0.5 })
  const out = new Float32Array(input.length)
  const sizes = [1, 7, 64, 128, 33]
  let off = 0
  let k = 0
  while (off < input.length) {
    const len = Math.min(sizes[k++ % sizes.length], input.length - off)
    kernel.process([input.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    off += len
  }
  // The compressor refreshes its slow release coefficient once per block, so
  // ragged blocks differ by a hair rather than not at all.
  for (let i = 0; i < out.length; i++) {
    assert.ok(Math.abs(out[i] - reference[i]) < 2e-3, `sample ${i}: ${out[i]} vs ${reference[i]}`)
  }
})

test('stereo channels stay independent in the EQ and shared in the detector', () => {
  const left = voiceLike(0.3, { f0: 130 })
  const right = new Float32Array(left.length) // silent
  const { channelData } = processSchepsBuffer([left, right], SR, { mix: 1 })
  // A silent input channel must stay silent: per-channel filter state, not a
  // summed bus.
  assert.ok(rms(channelData[1], OVERSAMPLE_LATENCY_SAMPLES) < 1e-6)
  assert.ok(rms(channelData[0], OVERSAMPLE_LATENCY_SAMPLES) > 0.01)
})

// ── measured trim ───────────────────────────────────────────────────────────

/**
 * ⚠ THE TRIM REFERENCES THE SHARED SAMPLE PERCENTILE NOW, NOT `loudPartDb`, and
 * these tests were rewritten around that rather than loosened. The old ones
 * asserted the wet path's LOUD PARTS land on the dry one's, which was the
 * invariant while the trim solved for loud parts; it now solves for the same
 * statistic OptoSmooth does, so that is what has to be checked.
 *
 * ⚠ AND IT IS CHECKED IN THE SPEECH BAND, because that is the domain the trim
 * solves in — matching broadband would let the Pultec low-frequency moves
 * either side of the compressor dominate a measurement of something else. On
 * real narration the in-band error is 0.001 dB at every Squash.
 *
 * The loud parts now sit ABOUT 1.4 dB ABOVE the dry's, and that is the intended
 * consequence rather than drift: a percentile-matched compressed copy is louder
 * on average than a loud-part-matched one, which is the compression's yield and
 * is exactly what `densityDb` reports — it went 0.95 to 2.46 dB on narration at
 * Squash 60 when the reference changed.
 */
function speechBand(x) {
  const cascade = new BiquadCascade(2, 1)
  cascade.setSections([
    highpass(SR, 300, Math.SQRT1_2),
    lowpass(SR, 4000, Math.SQRT1_2),
  ])
  const y = new Float32Array(x.length)
  cascade.process(x, y, x.length, 0)
  return y
}

const bandPercentileDb = (x, skip) => 20 * Math.log10(
  percentileOfChannels([speechBand(x.subarray(skip))], MAKEUP_PERCENTILE),
)

test('the makeup lands the wet path on the dry one at the shared reference', () => {
  const input = voiceLike(4, { envRateHz: 0.5 })
  const skip = OVERSAMPLE_LATENCY_SAMPLES
  for (const character of ['thick', 'presence']) {
    const m = computeSchepsAutoTrim([input], SR, { character, squash: 65 })
    const { channelData } = processSchepsBuffer([input], SR, {
      character, squash: 65, mix: 1, wetTrimDb: m.trimDb,
      correlation: m.correlation, densityDb: m.densityDb,
    })
    const errDb = bandPercentileDb(channelData[0], skip) - bandPercentileDb(input, skip)
    assert.ok(
      Math.abs(errDb) < 0.1,
      `${character}: wet path is ${errDb.toFixed(3)} dB off dry at the reference`,
    )
  }
})

test('stereo trim level-matches the louder channel, not channel 0', () => {
  const loud = voiceLike(4, { envRateHz: 0.5 })
  const quiet = loud.map(v => v * 0.35)
  const measured = computeSchepsAutoTrim([quiet, loud], SR, { squash: 65 })
  const { channelData } = processSchepsBuffer([quiet, loud], SR, {
    mix: 1, squash: 65, wetTrimDb: measured.trimDb,
  })
  const skip = OVERSAMPLE_LATENCY_SAMPLES
  const errDb = bandPercentileDb(channelData[1], skip) - bandPercentileDb(loud, skip)
  // Looser than the mono case at 0.1: the quiet channel is the same signal at
  // 0.35, so the shared detector is riding a sum the louder side dominates but
  // does not own, and the trim lands the pair rather than either alone.
  assert.ok(
    Math.abs(errDb) < 0.4,
    `louder stereo channel is ${errDb.toFixed(3)} dB off after trim`,
  )
})

test('the compression yields real density, and it is modest on an opto cell', () => {
  // `densityDb` is how much louder the wet copy's average is once its loud
  // parts are level — the loudness the compressor actually earns. It must be
  // positive, or the makeup is doing nothing. It is also small: a T4 cell with a
  // multi-second release applies nearly constant gain reduction rather than
  // ducking peaks selectively, so it hands back far less than a fast peak
  // compressor would. Measured 0.6-0.8 dB on real speech.
  const input = voiceLike(4, { envRateHz: 0.5 })
  const { densityDb } = computeSchepsAutoTrim([input], SR, { squash: 80 })
  assert.ok(densityDb > 0, `expected the compression to buy something, got ${densityDb.toFixed(2)} dB`)
  assert.ok(densityDb < 4, `suspiciously large for an opto cell: ${densityDb.toFixed(2)} dB`)
})

test('Mix adds the compression’s density, monotonically, and nothing else', () => {
  // The promise is not "Mix changes nothing" — a blended-in compressed copy
  // SHOULD get gently louder, and refusing to let it was the bug. The promise
  // is that the only loudness Mix adds is the density the compressor earned,
  // rising smoothly from exactly dry at 0. What it must never do is jump around
  // or run away, which is what an uncorrected correlated sum does.
  const input = voiceLike(4, { envRateHz: 0.5 })
  const m = computeSchepsAutoTrim([input], SR, {})
  const skip = OVERSAMPLE_LATENCY_SAMPLES
  const dryDb = speechRmsDb(input, skip)

  const levels = [0, 0.25, 0.5, 0.75, 1].map((mix) => {
    const { channelData } = processSchepsBuffer([input], SR, {
      mix, wetTrimDb: m.trimDb, correlation: m.correlation, densityDb: m.densityDb,
    })
    return speechRmsDb(channelData[0], skip) - dryDb
  })

  assert.ok(Math.abs(levels[0]) < 0.05, `mix 0 must be dry: ${levels[0].toFixed(2)} dB`)
  for (let i = 1; i < levels.length; i++) {
    assert.ok(
      levels[i] > levels[i - 1] - 0.05,
      `should not dip on the way up: ${levels.map(v => v.toFixed(2)).join(' -> ')}`,
    )
  }
  assert.ok(
    Math.abs(levels[levels.length - 1] - m.densityDb) < 0.4,
    `full wet should land on the measured density ${m.densityDb.toFixed(2)}, got ${levels[levels.length - 1].toFixed(2)}`,
  )
  // Bounded: an uncorrected equal-power sum of two correlated paths runs ~3 dB
  // hot in the middle of the sweep. Nothing here may approach that.
  assert.ok(Math.max(...levels) < 1.5, `Mix is acting as a volume control: ${levels.map(v => v.toFixed(2)).join(' -> ')}`)
})

test('broadband energy is allowed to rise with Mix — that is the character', () => {
  // The other half of the trade, asserted so nobody "fixes" it back. Holding
  // BROADBAND energy constant is what broke this: on a voice, that band is
  // mostly fundamental, so a constant-broadband trim lets the low end Thick
  // adds pay for itself out of the midrange, and the file goes quiet where it
  // counts while the meters read level.
  const input = voiceLike(4)
  const skip = OVERSAMPLE_LATENCY_SAMPLES
  const { trimDb, correlation } = computeSchepsAutoTrim([input], SR, { character: 'thick' })

  const at = mix => processSchepsBuffer([input], SR, {
    character: 'thick', mix, wetTrimDb: trimDb, correlation,
  }).channelData[0]

  const broadband = m => db(rms(at(m), skip) / rms(input, skip))
  assert.ok(
    broadband(1) > broadband(0) + 0.2,
    `broadband should gain weight with Mix, got ${broadband(1).toFixed(2)} dB at full wet`,
  )
})

test('the correlation the blend needs is real and high for this material', () => {
  // If this ever measured near zero, the compensation would be a no-op and the
  // equal-power law would be running uncorrected.
  const { correlation } = computeSchepsAutoTrim([voiceLike(1)], SR, {})
  assert.ok(correlation > 0.5 && correlation <= 1, `correlation ${correlation}`)
})

test('silence measures as no trim rather than as an infinite one', () => {
  const { trimDb, correlation } = computeSchepsAutoTrim([new Float32Array(4096)], SR, {})
  assert.equal(trimDb, 0)
  assert.equal(correlation, 0)
})

test('the wet path really is levelled, and Squash controls how much', () => {
  // Guards the whole reason the effect exists.
  //
  // Level SPREAD, not crest factor. An opto cell is a leveller: 10 ms attack
  // into a release measured in seconds, so it rides the shape of a performance
  // and deliberately lets individual transients through. Measured here, at 80 it
  // takes 12 dB of gain reduction while leaving crest factor slightly HIGHER
  // than the input — every onset overshoots the slow cell by design, and after
  // makeup those overshoots are the peaks. Crest would report that as no
  // compression at all.
  //
  // Compared against the same chain with the compressor backed off rather than
  // against the raw input: Thick's two EQ stages net +4 dB at the bottom, which
  // on a harmonic stack moves these statistics on its own.
  //
  // SLOW envelope, and that is the physics rather than a threshold that needed
  // loosening. A T4 cell is 10 ms of attack into a release measured in seconds,
  // so it cannot follow syllables — measured across envelope rates, the same
  // settings that flatten a 0.1 Hz swell by 1.3 dB move a 3 Hz one by 0.16.
  // Levelling phrases while letting syllables through is what the unit is for.
  const input = voiceLike(10, { envRateHz: 0.1 })
  const skip = OVERSAMPLE_LATENCY_SAMPLES

  const spreadAt = (squash) => {
    const { trimDb } = computeSchepsAutoTrim([input], SR, { squash })
    const { channelData } = processSchepsBuffer([input], SR, {
      mix: 1, squash, wetTrimDb: trimDb,
    })
    return levelSpreadDb(channelData[0], skip)
  }

  const idle = spreadAt(0)
  const squashed = spreadAt(80)
  assert.ok(
    squashed < idle - 1,
    `level spread at squash 80 is ${squashed.toFixed(2)} dB, idle ${idle.toFixed(2)} dB`,
  )
})

test('the blend keeps the dry signal’s dynamics — that is what parallel is for', () => {
  // Series compression at this depth would flatten the performance. Blended at
  // the default Mix it must not: the summed level spread has to sit between the
  // dry signal's and the fully-wet one's.
  const input = voiceLike(10, { envRateHz: 0.1 }) // slow, per the note above
  const skip = OVERSAMPLE_LATENCY_SAMPLES
  const { trimDb, correlation } = computeSchepsAutoTrim([input], SR, { squash: 80 })

  const spreadAt = mix => levelSpreadDb(
    processSchepsBuffer([input], SR, { mix, squash: 80, wetTrimDb: trimDb, correlation }).channelData[0],
    skip,
  )
  const dry = spreadAt(0)
  const wet = spreadAt(1)
  const blended = spreadAt(SCHEPS_KERNEL_DEFAULTS.mix)
  assert.ok(wet < dry - 1, `the wet path should be flatter: ${wet.toFixed(2)} vs ${dry.toFixed(2)}`)
  assert.ok(
    blended > wet && blended < dry,
    `blended spread ${blended.toFixed(2)} dB should sit between ${wet.toFixed(2)} and ${dry.toFixed(2)}`,
  )
})

test('gain reduction is reported for the meter', () => {
  const kernel = new SchepsKernel(SR)
  kernel.setParams({ squash: 85 })
  const input = voiceLike(0.5)
  const out = new Float32Array(128)
  for (let off = 0; off + 128 <= input.length; off += 128) {
    kernel.process([input.subarray(off, off + 128)], [out], 128)
  }
  assert.ok(kernel.getReduction() > 1, `expected the cell to be working, got ${kernel.getReduction()} dB`)
})

test('an unknown character falls back rather than throwing at audio rate', () => {
  // setParams runs on every knob move on the audio thread; a bad preset id
  // arriving there must not take the worklet down mid-playback.
  const kernel = new SchepsKernel(SR)
  kernel.setParams({ character: 'bassier' })
  assert.equal(kernel.params.character, 'bassier')
  const out = new Float32Array(128)
  kernel.process([voiceLike(0.01).subarray(0, 128)], [out], 128)
  assert.ok(Number.isFinite(out[64]))
})

test('defaults are the ones the panel and the apply path share', () => {
  assert.equal(SCHEPS_KERNEL_DEFAULTS.character, 'thick')
  assert.ok(SCHEPS_KERNEL_DEFAULTS.mix > 0 && SCHEPS_KERNEL_DEFAULTS.mix < 1)
})

test('a bad param cannot poison the kernel — it used to, permanently', () => {
  // Since the makeup became the compressor's own Gain, a non-finite param no
  // longer stays local: it reaches the T4 cell's envelope and memory, which
  // feed back into themselves, and every later block comes out NaN. Measured
  // before the guard: one bad push, then twenty blocks of good params, still
  // 128/128 non-finite samples. In the app that is an effect that goes silent
  // and stays silent until the page is reloaded.
  //
  // `clamp` alone does not catch it — `undefined < lo` and `undefined > hi` are
  // both false, so it hands the undefined straight through.
  const SR_ = SR
  const block = new Float32Array(128)
  for (let i = 0; i < 128; i++) block[i] = 0.3 * Math.sin((2 * Math.PI * 200 * i) / SR_)

  const kernel = new SchepsKernel(SR_)
  const out = new Float32Array(128)
  const nonFinite = a => a.reduce((n, v) => n + (Number.isFinite(v) ? 0 : 1), 0)

  kernel.setParams({ mix: 0.35, wetTrimDb: 3 })
  kernel.process([block], [out], 128)
  assert.equal(nonFinite(out), 0)

  for (const bad of [
    { wetTrimDb: undefined }, { wetTrimDb: NaN }, { outputDb: NaN },
    { mix: undefined }, { squash: NaN }, { correlation: undefined },
    { densityDb: NaN }, { squash: Infinity },
  ]) {
    kernel.setParams(bad)
    kernel.process([block], [out], 128)
    assert.equal(nonFinite(out), 0, `${JSON.stringify(bad)} produced non-finite output`)
  }

  // And it still works afterwards, rather than having been quietly bricked.
  kernel.setParams({ mix: 0.35, wetTrimDb: 3, squash: 80, correlation: 0.9, densityDb: 0.6 })
  kernel.process([block], [out], 128)
  assert.equal(nonFinite(out), 0)
  assert.ok(out.some(v => v !== 0), 'the kernel went silent instead of recovering')
})

// ── the output ceiling ──────────────────────────────────────────────────────

const peakOf = (x) => {
  let p = 0
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a }
  return p
}

/**
 * ⚠ SCHEPS NEEDED THIS MORE THAN OPTOSMOOTH DID, AND HAD GONE WITHOUT IT SINCE
 * IT SHIPPED. A parallel blend sums two paths and nothing in the trim bounds
 * their sum: measured on narration with the auto trim, the output ran up to
 * 5.37 dB OVER the source peak and reached +2.57 dBFS at Squash 90 / Mix 1 —
 * it clipped.
 *
 * ⚠ AND THE CEILING IS AT THIS PLUGIN'S OUTPUT, NOT ON THE EMBEDDED LA-2A. In
 * OptoSmooth the kernel is the last stage so its internal ceiling bounds what
 * leaves; here the post EQ and the dry sum both come after it, so a ceiling
 * inside the kernel would be undone downstream. The test that matters is the
 * one at Mix well below 1, where the dry path — which the kernel never sees at
 * all — is most of the output.
 */
test('the ceiling holds the output under the source peak at every blend', () => {
  const input = voiceLike(4, { envRateHz: 0.5 })
  const inPeak = peakOf(input)
  for (const squash of [45, 65, 90]) {
    for (const mix of [0.3, 0.5, 1]) {
      const m = computeSchepsAutoTrim([input], SR, { squash })
      assert.ok(Number.isFinite(m.ceilingDb), 'the trim must return a ceiling')
      const { channelData } = processSchepsBuffer([input], SR, {
        squash, mix, wetTrimDb: m.trimDb, correlation: m.correlation,
        densityDb: m.densityDb, ceilingDb: m.ceilingDb,
      })
      assert.ok(
        peakOf(channelData[0]) <= inPeak,
        `squash ${squash} mix ${mix}: ${db(peakOf(channelData[0])).toFixed(3)} `
        + `exceeded source ${db(inPeak).toFixed(3)}`,
      )
    }
  }
})

/**
 * The failure pinned as a failure, exactly as OptoSmooth's is: if this ever
 * stops overshooting, the blend has become self-bounding and the ceiling is
 * unnecessary — which is a finding, not a passing test.
 */
test('and without it the blend really does exceed the source', () => {
  const input = voiceLike(4, { envRateHz: 0.5 })
  const m = computeSchepsAutoTrim([input], SR, { squash: 90 })
  const { channelData } = processSchepsBuffer([input], SR, {
    squash: 90, mix: 1, wetTrimDb: m.trimDb, correlation: m.correlation,
    densityDb: m.densityDb,
  })
  assert.ok(
    peakOf(channelData[0]) > peakOf(input),
    'expected an unguarded overshoot at Squash 90 / Mix 1',
  )
})

test('no ceiling is sample-identical to not passing one', () => {
  const input = voiceLike(2, { envRateHz: 0.5 })
  const base = { squash: 65, mix: 0.5, wetTrimDb: 6 }
  const bare = processSchepsBuffer([input], SR, base).channelData[0]
  const explicit = processSchepsBuffer([input], SR, { ...base, ceilingDb: null }).channelData[0]
  for (let i = 0; i < bare.length; i++) assert.equal(bare[i], explicit[i], `sample ${i} moved`)
})

test('a ceiling above the signal changes nothing', () => {
  const input = voiceLike(2, { envRateHz: 0.5 })
  const base = { squash: 65, mix: 0.5, wetTrimDb: 6 }
  const bare = processSchepsBuffer([input], SR, base).channelData[0]
  const high = processSchepsBuffer([input], SR, { ...base, ceilingDb: 12 }).channelData[0]
  for (let i = 0; i < bare.length; i++) {
    assert.equal(bare[i], high[i], `sample ${i} moved under a ceiling nothing reaches`)
  }
})

/**
 * ── THE PANEL SEAM ──────────────────────────────────────────────────────────
 *
 * ⚠ THESE EXIST BECAUSE THE IDENTICAL BUG SHIPPED ON OPTOSMOOTH THIS WEEK:
 * `toKernelParams` did not carry `ceilingDb` at all, so the panel would have run
 * the raised makeup with nothing behind it. It was caught only because the
 * LA-2A params had already been split into a Node-reachable module. Scheps'
 * were not, until now — `schepsParams.js` is that split, and this is what it
 * buys.
 */

test('the panel param object carries the ceiling into kernel params', () => {
  assert.equal(toKernelParams({ ...SCHEPS_DEFAULTS, ceilingDb: -3.5 }).ceilingDb, -3.5)
})

test('kernel params omit the ceiling entirely when there is none', () => {
  for (const absent of [{ ...SCHEPS_DEFAULTS }, { ...SCHEPS_DEFAULTS, ceilingDb: null }]) {
    assert.ok(!('ceilingDb' in toKernelParams(absent)),
      'an absent ceiling must not appear as a key')
  }
})

test('a panel-shaped patch actually limits when it carries a ceiling', () => {
  const input = voiceLike(2, { envRateHz: 0.5 })
  const panel = { ...SCHEPS_DEFAULTS, squash: 90, mix: 100, wetTrimDb: 18 }
  // Well under the unguarded render's own peak (-5.79 dBFS on this stimulus),
  // so the assertion below is testing the ceiling rather than the signal.
  const ceilingDb = -12

  const loud = processSchepsBuffer([input], SR, toKernelParams(panel)).channelData[0]
  const held = processSchepsBuffer([input], SR, toKernelParams({ ...panel, ceilingDb })).channelData[0]

  assert.ok(db(peakOf(loud)) > ceilingDb + 3,
    `the unguarded render should be well over the ceiling: ${db(peakOf(loud)).toFixed(2)}`)
  assert.ok(db(peakOf(held)) <= ceilingDb + 1e-9,
    `the guarded one must sit at or under it: ${db(peakOf(held)).toFixed(4)}`)
})

/**
 * ⚠ THE PANEL DEFAULTS AND THE KERNEL DEFAULTS DRIFTED APART AND SHIPPED, which
 * is why this is a round trip and not a spot check on one key. `squash` was
 * recalibrated 62 -> 40 when the R37 mechanism was corrected; the move landed on
 * the kernel and not on the panel, and the panel is the object users open with.
 * Measured on narration, the wet path ran 4.75 dB of average gain reduction
 * against the calibrated 1.11 — four times the compression the default patch is
 * meant to have.
 *
 * `SCHEPS_DEFAULTS` now derives every shared key from `SCHEPS_KERNEL_DEFAULTS`,
 * so this should hold by construction. It is asserted anyway: the failure mode
 * was someone restating a number, and nothing stops that returning except a test
 * that notices.
 */
test('the panel defaults are exactly the kernel defaults, through the mapping', () => {
  assert.deepEqual(toKernelParams(SCHEPS_DEFAULTS), SCHEPS_KERNEL_DEFAULTS)
})

test('the default Squash is the calibrated one, not the value it drifted to', () => {
  assert.equal(SCHEPS_DEFAULTS.squash, 40)
  assert.notEqual(SCHEPS_DEFAULTS.squash, 62, 'the pre-R37-fix value shipped once')
})

// ── the LA-2A bench tuning ──────────────────────────────────────────────────

/**
 * ⚠ SCHEPS FOLLOWED EVERY LA-2A CONSTANT EXCEPT THIS ONE, and the exception was
 * invisible. It holds the kernel rather than a copy, so module constants — the
 * taper, the ballistics, R37's mechanism, the cell and tube laws — reach it by
 * construction and always have. The bench tuning is module STATE, read when
 * kernel params are BUILT, and Scheps built its own: a tuning session moved
 * OptoSmooth and left Scheps at the shipping constants, with nothing saying so.
 *
 * These tests are on the seam rather than the sound, because the seam is what
 * broke: the value has to survive `toKernelParams` and then the allowlist in
 * `SchepsKernel.setParams`, and it was the second of those that dropped it.
 */
test('an untouched bench adds nothing to the kernel params', () => {
  resetLA2ATuning()
  assert.deepEqual(la2aTuningOverrides(), {}, 'precondition: the bench is at defaults')
  assert.ok(!('la2aTuning' in toKernelParams(SCHEPS_DEFAULTS)),
    'an untouched bench must leave the params key-for-key as they were')
})

test('a moved bench reaches the kernel params', () => {
  try {
    setLA2ATuning({ cellModMax: 0.5 })
    const kp = toKernelParams(SCHEPS_DEFAULTS)
    assert.equal(kp.la2aTuning?.cellModMax, 0.5)
  } finally {
    resetLA2ATuning()
  }
})

/**
 * The one that matters: the value has to change the AUDIO, not just the params
 * object. `cellMod: 0` removes the gain cell's modulation entirely, which is
 * the LA-2A's dominant distortion term — if the bench reaches the embedded
 * kernel at all, this is audible in the samples.
 */
/**
 * ⚠ MOVES `cellCurveDriveMax`, NOT `cellMod`, AND THE SWAP IS THE POINT. The
 * claim is that a moved bench reaches Scheps' EMBEDDED kernel — it needs a knob
 * that is live on the shipping patch to demonstrate that. Since Tube
 * Saturation's curve became the default cell mechanism, `cellMod` scales a
 * modulation that is not running, so moving it correctly changes nothing and
 * the test would be asserting the bench is broken when it is not.
 */
test('a moved bench actually reaches the embedded cell', () => {
  const input = voiceLike(2, { envRateHz: 0.5 })
  const patch = { ...SCHEPS_DEFAULTS, squash: 80, mix: 100 }
  const shipping = processSchepsBuffer([input], SR, toKernelParams(patch)).channelData[0]

  let benched
  try {
    setLA2ATuning({ cellCurveDriveMax: 0 })
    benched = processSchepsBuffer([input], SR, toKernelParams(patch)).channelData[0]
  } finally {
    resetLA2ATuning()
  }

  let moved = 0
  for (let i = 0; i < shipping.length; i++) if (shipping[i] !== benched[i]) moved++
  assert.ok(moved > shipping.length * 0.25,
    `the bench must reach the audio, moved ${moved}/${shipping.length} samples`)
})

test('the bench cannot override what Scheps pins', () => {
  try {
    // The tuning carries no r37, mode, mix or lookaheadMs, so LA2A_FIXED's
    // decisions survive a tuning session — pinned because a future tuning key
    // that DID collide would silently change what the Scheps trick is.
    setLA2ATuning({ cellModMax: 0.5, tubeDriveLin: 0.9 })
    for (const key of ['r37', 'mode', 'mix', 'lookaheadMs']) {
      assert.ok(!(key in la2aTuningOverrides()),
        `the bench must not carry ${key} — Scheps pins it`)
    }
  } finally {
    resetLA2ATuning()
  }
})

/**
 * ⚠ THE TRIM MEASUREMENT HAS TO SEE THE BENCH TOO, and it did not. The bench
 * reaches the preview and the apply through `toKernelParams`; the trim builds
 * its params by hand in `useScheps.measurementParams` and was solving against
 * the SHIPPING constants while the audio played through the BENCH ones. On
 * OptoSmooth, where the same gap existed, that was worth up to 1.14 dB of makeup
 * error — and a level error is the one thing a distortion bench cannot have,
 * because it exists to be judged by ear and loudness dominates an A/B.
 *
 * This pins the seam the composable depends on: the nested key has to survive
 * the worker, `computeSchepsAutoTrim`, its wet-path render and `SchepsKernel`'s
 * allowlist. Only the last of those had ever carried it.
 */
test('the trim measurement honours the nested bench tuning', () => {
  const input = voiceLike(3, { envRateHz: 0.5 })
  const patch = { ...SCHEPS_KERNEL_DEFAULTS, squash: 80 }

  const plain = computeSchepsAutoTrim([input], SR, patch)
  const benched = computeSchepsAutoTrim([input], SR, {
    // Live on the shipping patch — see the note above.
    ...patch, la2aTuning: { cellCurveDriveMax: 0, vocalSatCurveDrive: 4 },
  })

  assert.notEqual(plain.trimDb, benched.trimDb,
    'the bench must reach the wet-path render the trim solves against')
})

test('an absent bench leaves the trim exactly where it was', () => {
  const input = voiceLike(3, { envRateHz: 0.5 })
  const patch = { ...SCHEPS_KERNEL_DEFAULTS, squash: 80 }
  assert.deepEqual(
    computeSchepsAutoTrim([input], SR, patch),
    computeSchepsAutoTrim([input], SR, { ...patch, la2aTuning: {} }),
  )
})

// Spread into Math.max blows the stack on a buffer this long; loop instead.
function peakDb(x) {
  let p = 0
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a }
  return db(p)
}

// ── The ceiling's knee is sized by the solve ─────────────────────────────────
//
// This plugin is why the knee stopped being a fixed 3 dB. Its ceiling is the
// source peak and at low Mix its output IS approximately the source, so the peak
// sample lands where the knee is deepest by construction — the fixed width cost
// 0.63 dB of peak at Mix 0, where the kernel is otherwise bit-exact against the
// delayed input. See `ceilingKneeDbFor`.

test('the auto trim returns a knee alongside its ceiling, never one without', () => {
  const input = voiceLike(3)
  const t = computeSchepsAutoTrim([input], SR, SCHEPS_KERNEL_DEFAULTS)
  assert.ok(Number.isFinite(t.ceilingDb))
  assert.ok(Number.isFinite(t.ceilingKneeDb))
  assert.ok(t.ceilingKneeDb >= 0 && t.ceilingKneeDb <= CEILING_KNEE_DB)
  // Silence has a ceiling of nothing, and must not invent a knee for it.
  const quiet = computeSchepsAutoTrim([new Float32Array(SR)], SR, SCHEPS_KERNEL_DEFAULTS)
  assert.equal(quiet.ceilingDb, null)
  assert.equal(quiet.ceilingKneeDb, null)
})

test('the solved knee is sized at Mix 1, the worst case, not at the current Mix', () => {
  const input = voiceLike(3)
  // Solved at the default Mix...
  const t = computeSchepsAutoTrim([input], SR, SCHEPS_KERNEL_DEFAULTS)
  const common = {
    wetTrimDb: t.trimDb,
    correlation: t.correlation,
    densityDb: t.densityDb,
    ceilingDb: t.ceilingDb,
  }
  // ...and the ceiling must still hold at every Mix the user can then dial,
  // which is the whole reason the measurement is taken at Mix 1.
  for (const mix of [0, 0.35, 0.7, 1]) {
    const { channelData } = processSchepsBuffer([input], SR, {
      ...common, mix, ceilingKneeDb: t.ceilingKneeDb,
    })
    assert.ok(peakDb(channelData[0]) <= t.ceilingDb + 1e-9,
      `mix ${mix}: ceiling broken`)
  }
})

test('the solved knee recovers peak the fixed 3 dB one was taking', () => {
  const input = voiceLike(3)
  const t = computeSchepsAutoTrim([input], SR, SCHEPS_KERNEL_DEFAULTS)
  const common = {
    wetTrimDb: t.trimDb,
    correlation: t.correlation,
    densityDb: t.densityDb,
    ceilingDb: t.ceilingDb,
  }
  for (const mix of [0, 0.35, 1]) {
    const solved = peakDb(processSchepsBuffer([input], SR, {
      ...common, mix, ceilingKneeDb: t.ceilingKneeDb,
    }).channelData[0])
    // No ceilingKneeDb is the old fixed width, by design — see the kernel.
    const fixed = peakDb(processSchepsBuffer([input], SR, { ...common, mix }).channelData[0])
    assert.ok(solved > fixed, `mix ${mix}: expected to recover peak, got ${solved} vs ${fixed}`)
  }
})

test('at Mix 0 the peak loss scales with the knee, so a narrower one recovers it', () => {
  const input = voiceLike(3)
  const t = computeSchepsAutoTrim([input], SR, SCHEPS_KERNEL_DEFAULTS)
  const common = {
    mix: 0,
    wetTrimDb: t.trimDb,
    correlation: t.correlation,
    densityDb: t.densityDb,
    ceilingDb: t.ceilingDb,
  }
  const dryDb = peakDb(input)
  const lossFor = ceilingKneeDb => dryDb - peakDb(processSchepsBuffer([input], SR, {
    ...common, ceilingKneeDb,
  }).channelData[0])
  /**
   * Mix 0 is the dry signal and its peak IS the ceiling, so this is the worst
   * position for a soft knee and the one the fixed 3 dB width cost most at.
   * Asserted as a monotone relationship rather than at a number, because how
   * wide the SOLVE goes is a property of the material: this synthetic stimulus
   * overshoots by 2.04 dB at Mix 1 and asks for a 2.54 dB knee, where the real
   * narration in `ceilingKneeDbFor` overshoots by 0.58 and asks for 1.08.
   */
  const losses = [0, 0.5, 1.08, 2, CEILING_KNEE_DB].map(lossFor)
  for (let i = 1; i < losses.length; i++) {
    assert.ok(losses[i] > losses[i - 1],
      `a wider knee must cost more peak: ${losses.map(v => v.toFixed(3)).join(' ')}`)
  }
  // A zero knee is a hard ceiling the dry peak sits exactly on, so it is free.
  assert.ok(losses[0] < 1e-6, `a zero knee must cost nothing, got ${losses[0]}`)
  // And no knee at all is still the old fixed width, so nothing upstream moved.
  assert.equal(
    peakDb(processSchepsBuffer([input], SR, common).channelData[0]),
    peakDb(processSchepsBuffer([input], SR, {
      ...common, ceilingKneeDb: CEILING_KNEE_DB,
    }).channelData[0]),
  )
  /**
   * ⚠ THE SOLVED KNEE DOES NOT DRIVE THIS TO ZERO, AND THAT IS A KNOWN RESIDUAL.
   * It is sized for the worst Mix because Mix moves after the solve, so at Mix 0
   * the dry peak still sits inside it. Closing it needs a knee that follows Mix,
   * which needs the dry and wet peaks handed over as separate params.
   * Deliberately not built here.
   */
})

test('kernel params carry the knee only when it is real', () => {
  assert.equal('ceilingKneeDb' in toKernelParams({ ...SCHEPS_DEFAULTS }), false)
  const mapped = toKernelParams({ ...SCHEPS_DEFAULTS, ceilingDb: -3, ceilingKneeDb: 0 })
  // Zero is a real width — a hard ceiling — not a missing one.
  assert.equal(mapped.ceilingKneeDb, 0)
})

test('a null pushed at the live node clears Scheps’ ceiling and knee too', () => {
  // Same bug, same shape, same fix — see `measuredKeys.js`.
  const panel = { ...SCHEPS_DEFAULTS }
  const kernel = new SchepsKernel(SR)

  panel.ceilingDb = -6
  panel.ceilingKneeDb = 1.2
  kernel.setParams(withMeasuredClears(toKernelParams(panel)))
  assert.ok(kernel.ceilingLin > 0)
  assert.ok(kernel.ceilingKneeLin > 0)

  panel.ceilingDb = null
  panel.ceilingKneeDb = null
  kernel.setParams(withMeasuredClears(toKernelParams(panel)))
  assert.equal(kernel.ceilingLin, 0, 'AUTO off must leave no ceiling behind')
  assert.equal(kernel.ceilingKneeLin, 0)
})

test('the Output trim widens the knee, because it is applied before the ceiling', () => {
  const input = voiceLike(3)
  const t = computeSchepsAutoTrim([input], SR, SCHEPS_KERNEL_DEFAULTS)
  const common = {
    mix: 1,
    wetTrimDb: t.trimDb,
    correlation: t.correlation,
    densityDb: t.densityDb,
    ceilingDb: t.ceilingDb,
    ceilingKneeDb: Math.min(t.ceilingKneeDb, 1),
  }
  /**
   * Output is a manual knob AUTO does not own, and `outputLin` multiplies the
   * summed blend BEFORE the ceiling — so a trim added after the solve pushes a
   * peak the knee was never sized for. Without the widening that turns a soft
   * knee into a hard clamp.
   */
  const kneeLinFor = (outputDb) => {
    const k = new SchepsKernel(SR)
    k.setParams({ ...common, outputDb })
    return k.ceilingKneeLin
  }
  const base = kneeLinFor(0)
  // A positive trim widens (knee START moves DOWN, so the linear value falls).
  assert.ok(kneeLinFor(1) < base, 'a +1 dB trim must widen the knee')
  assert.ok(kneeLinFor(6) < kneeLinFor(1), 'and more trim must widen it further')
  // A negative trim does not: it only moves the signal further under the
  // ceiling, where the narrow knee is already right and free.
  assert.equal(kneeLinFor(-6), base)
  // The guarantee holds at every trim regardless.
  for (const outputDb of [-6, 0, 3, 6, 12]) {
    const { channelData } = processSchepsBuffer([input], SR, { ...common, outputDb })
    assert.ok(peakDb(channelData[0]) <= t.ceilingDb + 1e-9, `outputDb ${outputDb}: ceiling broken`)
  }
})
