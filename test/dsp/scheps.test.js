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

test('the makeup lands the wet path’s LOUD PARTS on the dry one’s', () => {
  // What makeup gain has always meant: give back what the compressor took off
  // the loud moments. Matching the AVERAGE instead — which this used to do — is
  // a compressor that by construction cannot make anything louder.
  const input = voiceLike(4, { envRateHz: 0.5 })
  const skip = OVERSAMPLE_LATENCY_SAMPLES
  for (const character of ['thick', 'presence']) {
    const m = computeSchepsAutoTrim([input], SR, { character, squash: 65 })
    const { channelData } = processSchepsBuffer([input], SR, {
      character, squash: 65, mix: 1, wetTrimDb: m.trimDb,
      correlation: m.correlation, densityDb: m.densityDb,
    })
    const errDb = loudPartDb(channelData[0], skip) - loudPartDb(input, skip)
    assert.ok(
      Math.abs(errDb) < 0.7,
      `${character}: wet loud parts are ${errDb.toFixed(2)} dB off dry`,
    )
  }
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
