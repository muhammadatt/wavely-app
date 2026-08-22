/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ResonanceKernel,
  RESONANCE_KERNEL_DEFAULTS,
  processResonanceBuffer,
} from '../../src/audio/resonanceProcessor.js'
import {
  effectivePitchRange,
  HARMONIC_PITCH_RANGE,
  RESONANCE_DEFAULTS,
  toKernelParams,
  resonanceDisplayRange,
  RESONANCE_ATTACK_MIN_MS,
  RESONANCE_RELEASE_MIN_MS,
  uniformZones,
  RESONANCE_ZONE_STOCK as ZONE_STOCK,
} from '../../src/audio/resonanceParams.js'
import { peaking, BiquadCascade } from '../../src/audio/dsp/biquad.js'
import { getFFT, rfftBinCount } from '../../src/audio/dsp/fft.js'

const SR = 44100
const LATENCY = 2048

/**
 * Pitched signal: a harmonic stack with slow pitch wobble over a broadband
 * floor. Used wherever a test needs harmonics to protect. It is NOT required
 * for the suppressor to do anything — see the unpitched test below, which is
 * the regression guard for the gate that used to switch the effect off on
 * anything the pitch tracker could not read.
 */
function voice({
  seconds = 3, f0 = 150, jitterHz = 3, amp = 0.2, noiseDb = -45,
} = {}) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const noiseAmp = Math.pow(10, noiseDb / 20)
  let phase = 0
  let s = 4242
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const pitch = f0 + jitterHz * Math.sin(2 * Math.PI * 2.7 * t)
    phase += (2 * Math.PI * pitch) / SR
    let v = 0
    for (let k = 1; k <= 30; k++) {
      if (pitch * k >= SR / 2) break
      v += (amp / k) * Math.sin(k * phase + k * 0.9)
    }
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = v + noiseAmp * (s / 0x3fffffff - 1)
  }
  return out
}

/** Apply a resonant peaking boost — what a room mode or mic resonance does. */
function resonate(sig, freqHz, q, gainDb) {
  const cascade = new BiquadCascade(1, 1)
  cascade.setSections([peaking(SR, freqHz, q, gainDb)])
  const out = new Float32Array(sig.length)
  cascade.process(sig, out, sig.length, 0)
  return out
}

/** Unpitched broadband signal — the tracker reads 0 of 255 frames as pitched. */
function noise({ seconds = 3, db = -20 } = {}) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const amp = Math.pow(10, db / 20)
  let s = 4242
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = amp * (s / 0x3fffffff - 1)
  }
  return out
}

/**
 * Mean power in dB across a band, measured on a Hann-windowed segment.
 *
 * The window is not optional: a rectangular window lets a strong harmonic leak
 * 30 dB into the inter-harmonic gaps, which swamps whatever is actually being
 * measured there.
 */
function bandDb(buf, freqHz, from, halfHz = 60) {
  const n = 16384
  const fft = getFFT(n)
  const bins = rfftBinCount(n)
  const windowed = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n))
    windowed[i] = buf[from + i] * w
  }
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  fft.rfft(windowed, re, im)

  const binHz = SR / n
  const lo = Math.max(0, Math.round((freqHz - halfHz) / binHz))
  const hi = Math.min(bins - 1, Math.round((freqHz + halfHz) / binHz))
  let power = 0
  for (let k = lo; k <= hi; k++) power += re[k] * re[k] + im[k] * im[k]
  return 10 * Math.log10(power / (hi - lo + 1) / (n * n) + 1e-20)
}

/**
 * How much of a resonant boost the suppressor took back out, in dB.
 * Measured against the un-boosted signal so the voice itself cancels.
 */
function boostRemoved(dry, freqHz, q, gainDb, params) {
  const wet = resonate(dry, freqHz, q, gainDb)
  const out = processResonanceBuffer([wet], SR, params).channelData[0]
  const before = bandDb(wet, freqHz, SR) - bandDb(dry, freqHz, SR)
  const after = bandDb(out, freqHz, SR + LATENCY) - bandDb(dry, freqHz, SR)
  return before - after
}

/**
 * Parametric tests run with harmonic protection OFF so they measure detection
 * and reduction rather than the mask. With it on, protection covers 60–100% of
 * the spectrum (see the coverage test below) and whether a given probe
 * frequency is reachable depends on where the measured pitch put its harmonics
 * that frame — which makes for a flaky test of the wrong thing.
 */
// Harmonic protection is per zone now, so "unprotected" is a zone set, not a
// flag. `zoned()` below layers a setting onto it.
/**
 * THESE ARE MECHANISM TESTS AND THEY PIN THE CEPSTRAL REFERENCE EXPLICITLY.
 *
 * They were written and their thresholds derived against it, and they are about
 * the parts both references share — the detection threshold, the knee, depth,
 * the spread kernel, the mask, the mix law — which sit downstream of the one
 * thing the two modes differ in, the envelope. Pinning the mode here means the
 * shipping default can move (it has: peak ships now) without silently
 * re-tuning what these measure. The peak path's own behaviour is covered in
 * resonancePitch.test.js and resonanceZones.test.js.
 *
 * The zone settings are the cepstral era's stock, for the same reason: the two
 * references disagree about what `selectivity` measures by an order of
 * magnitude, so 20 on this path is not 20 on the other.
 */
const CEPSTRAL_STOCK = { refMode: 'cepstral', selectivity: 8, depth: 0.67 }
const UNPROTECTED = {
  ...RESONANCE_KERNEL_DEFAULTS,
  refMode: 'cepstral',
  zones: uniformZones({ ...CEPSTRAL_STOCK, protect: false }),
}

/**
 * Kernel params with one zone spanning everything.
 *
 * Depth, sharpness and selectivity are per-zone settings — there is no global
 * value for any of them — so a test that wants "this setting, everywhere" says
 * so with a uniform zone. Not a shim: the kernel has one path and this is what
 * uniform looks like in it.
 */
function zoned(base, settings) {
  return {
    ...base,
    refMode: 'cepstral',
    zones: uniformZones({ ...CEPSTRAL_STOCK, protect: false, ...settings }),
  }
}

test('reports a latency of exactly one FFT frame', () => {
  assert.equal(new ResonanceKernel(SR).latencySamples, LATENCY)
})

test('passes audio through delayed, not mangled, at zero depth', () => {
  const sig = voice({ seconds: 2 })
  const { channelData } = processResonanceBuffer([sig], SR, zoned(RESONANCE_KERNEL_DEFAULTS, { depth: 0 }))
  let maxErr = 0
  for (let i = LATENCY; i + LATENCY < sig.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(channelData[0][i + LATENCY] - sig[i]))
  }
  assert.ok(maxErr < 1e-5, `reconstruction error ${maxErr}`)
})

test('the delay is measurable, not merely advertised', () => {
  // applyWorkletRegion trims by exactly this number; a mismatch would
  // time-shift every applied region.
  const n = SR
  const sig = new Float32Array(n)
  for (let i = 2000; i < 2400; i++) {
    sig[i] = Math.sin((2 * Math.PI * 800 * i) / SR) * Math.sin((Math.PI * (i - 2000)) / 400)
  }
  const out = processResonanceBuffer([sig], SR, zoned(RESONANCE_KERNEL_DEFAULTS, { depth: 0 })).channelData[0]

  const argmax = buf => {
    let idx = -1
    let peak = 0
    for (let i = 0; i < buf.length; i++) {
      if (Math.abs(buf[i]) > peak) {
        peak = Math.abs(buf[i])
        idx = i
      }
    }
    return idx
  }
  assert.equal(argmax(out) - argmax(sig), LATENCY)
})

test('harmonic mask geometry is pinned', () => {
  // These counts DIVERGE from resonance_suppressor.py, deliberately. Two
  // changes, both forced by this being a general-purpose effect rather than a
  // stage inside a speech chain:
  //
  //   - the walk ends at freqCeilHz instead of a fixed 100 harmonics, so the
  //     protected band no longer slides with pitch (at 40 Hz the Python stops
  //     at 4 kHz and leaves everything above exposed);
  //   - the half-width is clamped so neighbouring masks keep a gap.
  //
  // The second is what makes the first safe. With the cap lifted and no clamp,
  // coverage measured 100% for every f0 at or below 82 Hz — "protect the
  // harmonics" collapses into "protect everything" and the effect goes inert.
  const kernel = new ResonanceKernel(SR)
  // Re-recorded when the adjustable band ceiling was removed: the walk now runs
  // to Nyquist rather than stopping at a 20 kHz default, so every count is
  // higher by the harmonics between the two.
  const golden = { 100: 660, 120.5: 546, 150: 730, 154.7: 710, 220: 782, 300: 655 }
  for (const [f0, expected] of Object.entries(golden)) {
    const mask = kernel._harmonicMask(parseFloat(f0))
    let count = 0
    for (let i = 0; i < mask.length; i++) if (mask[i]) count++
    assert.equal(count, expected, `f0 ${f0}: ${count} bins masked, expected ${expected}`)
  }
})

test('no mask at all below the resolvable harmonic spacing', () => {
  // Under ~64.6 Hz at this bin width, consecutive harmonics land closer than
  // three bins and no comb with gaps can be drawn. Returning null says "no
  // protection available" rather than silently protecting the whole spectrum.
  const kernel = new ResonanceKernel(SR)
  assert.equal(kernel._harmonicMask(64), null)
  assert.ok(kernel._harmonicMask(70) instanceof Uint8Array)
})

test('harmonic protection leaves gaps at every frequency', () => {
  // The property that matters: the inter-harmonic floor stays reachable across
  // the whole band. This previously failed above roughly 50x F0 — for a 150 Hz
  // speaker, everything above ~7.5 kHz was fully masked and unreachable,
  // because the 1%-of-frequency half-width outgrew the harmonic spacing.
  const kernel = new ResonanceKernel(SR)
  const binHz = SR / 2048
  const coverage = (f0, loHz, hiHz) => {
    const mask = kernel._harmonicMask(f0)
    let total = 0
    let covered = 0
    for (let b = 0; b < mask.length; b++) {
      const f = b * binHz
      if (f >= loHz && f < hiHz) {
        total++
        if (mask[b]) covered++
      }
    }
    return covered / total
  }
  for (const f0 of [100, 150, 220, 300]) {
    for (const [lo, hi] of [[500, 1500], [8000, 12000], [16000, 20000]]) {
      const c = coverage(f0, lo, hi)
      assert.ok(
        c < 0.95,
        `f0 ${f0}, ${lo}-${hi} Hz: ${(c * 100).toFixed(1)}% masked, nothing left to work on`,
      )
    }
  }
})

test('suppresses a narrow resonance', () => {
  const dry = voice()
  const removed = boostRemoved(dry, 3000, 40, 12, UNPROTECTED)
  assert.ok(removed > 6, `only ${removed.toFixed(1)} dB of a 12 dB resonance came out`)
})


test('depth scales how much comes out', () => {
  const dry = voice()
  const light = boostRemoved(dry, 3000, 40, 12, zoned(UNPROTECTED, { depth: 0.2 }))
  const heavy = boostRemoved(dry, 3000, 40, 12, zoned(UNPROTECTED, { depth: 1.0 }))
  assert.ok(heavy > light + 2, `depth barely mattered: ${light.toFixed(1)} vs ${heavy.toFixed(1)}`)
})

test('selectivity gates what counts as a resonance', () => {
  const dry = voice()
  const removed = boostRemoved(dry, 3000, 40, 12, zoned(UNPROTECTED, { selectivity: 24 }))
  assert.ok(removed < 2, `expected almost nothing at selectivity 60, got ${removed.toFixed(1)} dB`)
})

test('max reduction caps the cut', () => {
  const dry = voice()
  const capped = boostRemoved(dry, 3000, 40, 18, zoned(UNPROTECTED, { maxCut: 3 }))
  const uncapped = boostRemoved(dry, 3000, 40, 18, UNPROTECTED)
  assert.ok(capped < uncapped - 4, `cap had no effect: ${capped.toFixed(1)} vs ${uncapped.toFixed(1)}`)
})

test('band limits confine the reduction', () => {
  const dry = voice()
  const inBand = boostRemoved(dry, 3000, 40, 12, UNPROTECTED)
  const outOfBand = boostRemoved(dry, 3000, 40, 12, { ...UNPROTECTED, zones: [
    { id: 'a', hiHz: 2000, depth: 1, sharpness: 0.8, selectivity: 6, enabled: true },
    { id: 'b', hiHz: 20000, depth: 1, sharpness: 0.8, selectivity: 6, enabled: false },
  ] })
  assert.ok(inBand > 6, `in-band removal was only ${inBand.toFixed(1)} dB`)
  assert.ok(outOfBand < 1.5, `above the ceiling should be untouched, got ${outOfBand.toFixed(1)} dB`)
})

test('harmonic protection holds the suppressor off the voice', () => {
  // The mask is the safety mechanism the server refuses to run without. With
  // it on, a signal that is nothing but voice should come through close to
  // untouched; with it off the suppressor starts eating harmonics.
  const sig = voice()
  // protect: true explicitly — the stock zone's default went to false when the
  // peak envelope became the shipping reference, because there it is not
  // protection at all. This test is about the cepstral path, where it is.
  const withMask = processResonanceBuffer([sig], SR, { ...RESONANCE_KERNEL_DEFAULTS, refMode: 'cepstral',
    zones: uniformZones({ ...CEPSTRAL_STOCK, protect: true }) }).channelData[0]
  const without = processResonanceBuffer([sig], SR, UNPROTECTED).channelData[0]

  const departure = out => {
    let sum = 0
    for (let i = LATENCY + 2000; i < sig.length - 2000; i++) {
      sum += Math.abs(out[i] - sig[i - LATENCY])
    }
    return sum / (sig.length - LATENCY - 4000)
  }
  const guarded = departure(withMask)
  const unguarded = departure(without)
  assert.ok(
    unguarded > guarded * 3,
    `mask made little difference: ${guarded.toExponential(2)} vs ${unguarded.toExponential(2)}`,
  )
})

test('suppresses a resonance in unpitched material', () => {
  // REGRESSION GUARD. Suppression used to be gated on the pitch tracker
  // reporting a pitch, which conflated "is there signal here" with "did we
  // find a periodic component". On this input the tracker reads 1 frame in 258
  // as pitched, so the old gate zeroed the reduction on 257 of them and the
  // effect did nothing at all. Drums, cymbals, synths, room tone and every
  // fricative in a narration land in the same hole.
  const sig = resonate(noise(), 3000, 40, 14)
  const out = processResonanceBuffer([sig], SR, { ...RESONANCE_KERNEL_DEFAULTS, refMode: 'cepstral',
    zones: uniformZones(CEPSTRAL_STOCK) }).channelData[0]

  const change = f => bandDb(out, f, SR + LATENCY) - bandDb(sig, f, SR)
  const onResonance = change(3000)
  assert.ok(onResonance < -1.5, `resonant band only moved ${onResonance.toFixed(2)} dB`)
  for (const control of [1500, 6000]) {
    assert.ok(
      change(control) > onResonance + 1,
      `${control} Hz moved as much as the resonance — the cut is not selective`,
    )
  }
})

test('the pitch search range is settable and clamped to what the frame resolves', () => {
  // The kernel keeps the range as a parameter even though the UI no longer
  // offers a choice: the clamp is what stops a caller asking for a floor the
  // frame cannot autocorrelate, and a 2048-sample frame cannot reach below
  // ~43 Hz whatever it is asked for.
  const kernel = new ResonanceKernel(SR)

  kernel.setParams({ pitchMinHz: 40, pitchMaxHz: 1200 })
  assert.ok(kernel.pitchRange.minHz >= 43, 'a 2048-sample frame cannot reach below ~43 Hz')
  assert.ok(kernel.pitchRange.minHz < 45, `clamped too hard: ${kernel.pitchRange.minHz}`)
  assert.equal(kernel.pitchRange.maxHz, 1200)
  assert.equal(kernel.f0.lagMin, Math.floor(SR / 1200))

  kernel.setParams({ pitchMinHz: 70, pitchMaxHz: 400 })
  assert.equal(kernel.pitchRange.minHz, 70)
  assert.equal(kernel.f0.lagMax, Math.floor(SR / 70))
})

test('THE HARMONIC MASK SEARCHES ONE FIXED RANGE, and the UI shows what it is', () => {
  // The VOICE/WIDE switch is gone. The effect is general-purpose; the MASK is
  // not — it is a comb built from one tracked F0, so it is a voice feature
  // whatever the effect is pointed at, and WIDE was measurably worse on the
  // only material the mask is for: on 46 s of real narration the two settings
  // disagreed on 18.6% of frames, with WIDE's p90 at 849 Hz against a real
  // median of 191. A zone whose content is not a voice switches protection off
  // rather than retuning the range.
  //
  // effectivePitchRange mirrors the kernel's clamp on the main thread, because
  // a worklet has no way to hand a value back for rendering a label. Mirrored
  // logic drifts, so pin the two together.
  assert.deepEqual(HARMONIC_PITCH_RANGE, { minHz: 70, maxHz: 400 })
  for (const sampleRate of [44100, 48000, 96000]) {
    const kernel = new ResonanceKernel(sampleRate)
    kernel.setParams(toKernelParams(RESONANCE_DEFAULTS))
    const shown = effectivePitchRange(sampleRate)
    assert.ok(
      Math.abs(shown.minHz - kernel.pitchRange.minHz) < 1e-9,
      `@ ${sampleRate}: UI says ${shown.minHz}, kernel uses ${kernel.pitchRange.minHz}`,
    )
    assert.equal(shown.maxHz, kernel.pitchRange.maxHz)
  }
})

test('the mask cache survives every param change', () => {
  // It used to depend on the band ceiling, which ended the harmonic walk. There
  // is no adjustable ceiling any more — the walk runs to Nyquist — so the mask
  // is a function of F0 alone and nothing a knob can do invalidates it. The
  // effect wrapper posts the whole param object on every move, so a cache that
  // cleared on any change would in practice never survive one.
  const kernel = new ResonanceKernel(SR)
  kernel._harmonicMask(150)
  assert.equal(kernel.maskCache.size, 1)

  kernel.setParams(zoned(RESONANCE_KERNEL_DEFAULTS, { depth: 0.4 }))
  assert.equal(kernel.maskCache.size, 1, 'depth does not move a single harmonic')

  kernel.setParams(zoned(RESONANCE_KERNEL_DEFAULTS, { selectivity: 12 }))
  assert.equal(kernel.maskCache.size, 1, 'nor does selectivity')
})

test('output is independent of the block size it was fed in', () => {
  // The kernel walks a block in hop-sized pieces so a block spanning two
  // frames cannot leave later channels applying the wrong frame's gain.
  const sig = voice({ seconds: 1.5 })
  const n = sig.length
  const params = zoned(RESONANCE_KERNEL_DEFAULTS, {})
  const oneShot = processResonanceBuffer([sig], SR, params).channelData[0]

  const kernel = new ResonanceKernel(SR)
  kernel.setParams(params)
  const chunked = new Float32Array(n)
  const sizes = [1, 128, 999, 2048, 37]
  let off = 0
  let i = 0
  while (off < n) {
    const len = Math.min(sizes[i++ % sizes.length], n - off)
    kernel.process([sig.subarray(off, off + len)], [chunked.subarray(off, off + len)], len)
    off += len
  }

  let maxErr = 0
  for (let k = 0; k < n; k++) maxErr = Math.max(maxErr, Math.abs(oneShot[k] - chunked[k]))
  assert.ok(maxErr < 1e-6, `block-size dependence: max error ${maxErr}`)
})

test('stereo channels share one gain, so the image cannot wander', () => {
  const sig = voice({ seconds: 1.5 })
  const { channelData } = processResonanceBuffer(
    [sig.slice(), sig.slice()], SR, RESONANCE_KERNEL_DEFAULTS,
  )
  let maxErr = 0
  for (let i = 0; i < sig.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(channelData[0][i] - channelData[1][i]))
  }
  assert.ok(maxErr < 1e-9, `channels diverged by ${maxErr}`)
})

test('survives silence without producing NaN', () => {
  const { channelData } = processResonanceBuffer(
    [new Float32Array(SR)], SR, RESONANCE_KERNEL_DEFAULTS,
  )
  for (let i = 0; i < channelData[0].length; i++) {
    assert.ok(Number.isFinite(channelData[0][i]), `non-finite output at ${i}`)
  }
})

test('reset returns the kernel to its initial behaviour', () => {
  const sig = voice({ seconds: 1 })
  const kernel = new ResonanceKernel(SR)
  kernel.setParams(RESONANCE_KERNEL_DEFAULTS)

  const run = () => {
    const out = new Float32Array(sig.length)
    for (let off = 0; off < sig.length; off += 128) {
      const len = Math.min(128, sig.length - off)
      kernel.process([sig.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    }
    return out
  }

  const a = run()
  kernel.reset()
  const b = run()
  let maxErr = 0
  for (let i = 0; i < sig.length; i++) maxErr = Math.max(maxErr, Math.abs(a[i] - b[i]))
  assert.ok(maxErr < 1e-9, `reset did not restore state: ${maxErr}`)
})

// ── Display grid ────────────────────────────────────────────────────────────
//
// The panel draws these numbers directly, so they are the display's only
// contract. What matters is that a frequency on the plot is the frequency in
// the audio, that the level axis means dBFS, and that a peak between two reads
// is not lost — a display that misses transient reductions would be worse than
// the bar it replaces, which never missed one.

/** Run a signal through a kernel and return it, ready to be read. */
function runKernel(sig, params = {}) {
  const kernel = new ResonanceKernel(SR)
  kernel.setParams(params)
  const out = new Float32Array(sig.length)
  for (let off = 0; off < sig.length; off += 128) {
    const len = Math.min(128, sig.length - off)
    kernel.process([sig.subarray(off, off + len)], [out.subarray(off, off + len)], len)
  }
  return kernel
}

/** Split a display read into its curves plus the grid's frequencies. */
function readDisplay(kernel) {
  const d = kernel.displayBins
  const buf = new Float32Array(kernel.displayLength)
  const ok = kernel.readDisplay(buf)
  const octaves = Math.log2(kernel.displayMaxHz / kernel.displayMinHz)
  const curve = i => buf.subarray(i * d, (i + 1) * d)
  return {
    ok,
    bins: d,
    mag: curve(0),
    reference: curve(1),
    output: curve(2),
    reduction: curve(3),
    reductionHeld: curve(4),
    hz: i => kernel.displayMinHz * Math.pow(2, (i / (d - 1)) * octaves),
  }
}

/**
 * Mean reduction per display bin over a whole run, read the way the worklet
 * reads it — every 1024 samples.
 *
 * Reading once at the end instead would report the maximum over every frame in
 * the file, and on noise that saturates: somewhere in three seconds nearly
 * every bin momentarily pokes over the threshold, so the peak of a
 * read-once trace is wherever the noise happened to be loudest. Averaging the
 * reads is both what the display shows over time and the only way to ask where
 * the effect is *consistently* working.
 */
function meanReduction(sig, params) {
  const kernel = new ResonanceKernel(SR)
  kernel.setParams(params)
  const out = new Float32Array(sig.length)
  const d = kernel.displayBins
  const buf = new Float32Array(kernel.displayLength)
  const sum = new Float64Array(d)
  let reads = 0
  let since = 0
  for (let off = 0; off < sig.length; off += 128) {
    const len = Math.min(128, sig.length - off)
    kernel.process([sig.subarray(off, off + len)], [out.subarray(off, off + len)], len)
    since += len
    if (since < 1024) continue
    since = 0
    if (!kernel.readDisplay(buf)) continue
    for (let i = 0; i < d; i++) sum[i] += buf[4 * d + i]
    reads++
  }
  const octaves = Math.log2(kernel.displayMaxHz / kernel.displayMinHz)
  return {
    mean: Array.from(sum, v => v / reads),
    hz: i => kernel.displayMinHz * Math.pow(2, (i / (d - 1)) * octaves),
  }
}

function argmax(arr) {
  let best = -Infinity
  let at = 0
  for (let i = 0; i < arr.length; i++) if (arr[i] > best) { best = arr[i]; at = i }
  return at
}

test('nothing to display until a frame has been analysed', () => {
  const kernel = new ResonanceKernel(SR)
  assert.equal(kernel.readDisplay(new Float32Array(kernel.displayLength)), false)
})

test('the display puts the reduction at the frequency it was taken from', () => {
  // Unpitched carrier on purpose. On the harmonic stack the deepest cut with
  // protection off lands on the fundamental, which is correct behaviour and
  // useless as a position test — it would pass for a display that reported
  // every cut at 150 Hz.
  const d = meanReduction(resonate(noise(), 3000, 40, 14), UNPROTECTED)
  const at = d.hz(argmax(d.mean))
  assert.ok(
    Math.abs(Math.log2(at / 3000)) < 0.12,
    `deepest cut reported at ${at.toFixed(0)} Hz, resonance was at 3000 Hz`,
  )
})

test('the displayed spectrum is calibrated in dBFS', () => {
  // A full-scale sine reads 0 dBFS. Without this the level axis is an
  // arbitrary offset and the numerals beside it are decoration.
  //
  // On a bin centre, because scalloping is not calibration error: a Hann
  // window loses up to 1.4 dB on a tone that falls between two bins, and that
  // is a property of every FFT analyser ever built rather than something this
  // display could correct. Testing off-centre would only pin the loss.
  const hz = (46 * SR) / 2048
  const n = SR
  const sig = new Float32Array(n)
  for (let i = 0; i < n; i++) sig[i] = Math.sin((2 * Math.PI * hz * i) / SR)

  const d = readDisplay(runKernel(sig, zoned(UNPROTECTED, { depth: 0 })))
  const peak = argmax(d.mag)
  assert.ok(
    Math.abs(Math.log2(d.hz(peak) / hz)) < 0.05,
    `peak at ${d.hz(peak).toFixed(0)} Hz, expected ${hz.toFixed(0)}`,
  )
  assert.ok(
    Math.abs(d.mag[peak]) < 0.3,
    `full scale should read 0 dBFS, read ${d.mag[peak].toFixed(2)}`,
  )
})

test('the reference sits below a resonance by more than the selectivity', () => {
  // What the panel draws as the threshold is reference + selectivity, and the
  // whole explanation it offers is "this peak is over that line". If the
  // reference tracked the peak instead there would be nothing to see.
  const kernel = runKernel(resonate(noise(), 3000, 40, 18), UNPROTECTED)
  const d = readDisplay(kernel)
  const at = argmax(d.reduction)
  assert.ok(
    d.mag[at] - d.reference[at] > CEPSTRAL_STOCK.selectivity,
    `peak stood only ${(d.mag[at] - d.reference[at]).toFixed(1)} dB over the reference`,
  )
})

test('reduction between two reads is held, not lost', () => {
  // The worklet reads at half the frame rate, so a peak landing on an unread
  // frame has to survive to the next read — that peak is the transient ring
  // the user is looking for. Only the held curve carries it.
  const kernel = runKernel(resonate(voice(), 3000, 40, 14), UNPROTECTED)
  const first = readDisplay(kernel)
  const held = Math.max(...first.reductionHeld)
  assert.ok(held > 3, `expected a real cut to report, got ${held.toFixed(1)} dB`)

  // A second read with no further audio holds nothing: the accumulator was
  // cleared, so a stale peak cannot be shown twice. The live curve is a
  // snapshot rather than an accumulator, so it still reports the last frame.
  const second = readDisplay(kernel)
  assert.equal(Math.max(...second.reductionHeld), 0)
  assert.deepEqual(
    Array.from(second.reduction),
    Array.from(first.reduction),
    'the live curve should be the last frame, unchanged by being read',
  )
})

test('the held reduction never reads below the live one', () => {
  // The held curve is a maximum taken over the frames the live curve is the
  // last of, so it can only ever be the larger of the two. If that inverts,
  // the peak-hold outline would sit under the fill it is meant to cap.
  const kernel = runKernel(resonate(voice(), 3000, 40, 14), UNPROTECTED)
  const d = readDisplay(kernel)
  for (let i = 0; i < d.bins; i++) {
    assert.ok(
      d.reductionHeld[i] >= d.reduction[i] - 1e-6,
      `held ${d.reductionHeld[i].toFixed(2)} below live ${d.reduction[i].toFixed(2)} at bin ${i}`,
    )
  }
})

test('the output curve is the kernel\'s, not magnitude minus reduction', () => {
  // Both summarise a display cell, but from different FFT bins — magnitude
  // takes the loudest bin, reduction the most suppressed one, and on speech
  // those differ in most cells that carry any cut. Subtracting one from the
  // other draws a deeper notch than the audio has, which is why the output is
  // measured per bin in the kernel and sent.
  const kernel = runKernel(resonate(voice(), 3000, 40, 14), UNPROTECTED)
  const d = readDisplay(kernel)

  let worst = 0
  for (let i = 0; i < d.bins; i++) {
    // It is an output level, so it can never exceed the input at the same place
    // nor fall below what subtracting the cell's own peak cut would give.
    assert.ok(d.output[i] <= d.mag[i] + 1e-4, `output above input at bin ${i}`)
    assert.ok(
      d.output[i] >= d.mag[i] - d.reduction[i] - 1e-4,
      `output below the deepest possible cut at bin ${i}`,
    )
    worst = Math.max(worst, d.output[i] - (d.mag[i] - d.reduction[i]))
  }
  // And it is not merely the subtraction under another name.
  assert.ok(worst > 0.2, `output never differed from mag - reduction (${worst.toFixed(3)} dB)`)
})

test('the display grid covers the documented span at every sample rate', () => {
  for (const sr of [44100, 48000, 22050]) {
    const kernel = new ResonanceKernel(sr)
    const expected = resonanceDisplayRange(sr)
    assert.equal(kernel.displayMinHz, expected.minHz)
    assert.equal(kernel.displayMaxHz, expected.maxHz)
    // Every point resolves to a real bin — including the low end, where the
    // grid is finer than the FFT and the kernel interpolates instead.
    for (let i = 0; i < kernel.displayBins; i++) {
      const lo = kernel.dLo[i]
      const hi = kernel.dHi[i]
      if (hi >= lo) {
        assert.ok(hi < kernel.binCount, `bin span past the spectrum at ${i}`)
      } else {
        assert.ok(kernel.dPos[i] >= 0 && kernel.dPos[i] <= kernel.binCount - 1)
      }
    }
  }
})

test('every displayed value is finite, silence included', () => {
  const d = readDisplay(runKernel(new Float32Array(SR)))
  for (let i = 0; i < d.bins; i++) {
    assert.ok(Number.isFinite(d.mag[i]), `magnitude ${i} was not finite`)
    assert.ok(Number.isFinite(d.reference[i]), `reference ${i} was not finite`)
    assert.ok(Number.isFinite(d.output[i]), `output ${i} was not finite`)
    assert.ok(Number.isFinite(d.reduction[i]), `reduction ${i} was not finite`)
    assert.ok(Number.isFinite(d.reductionHeld[i]), `held reduction ${i} was not finite`)
  }
})

test('reset clears the display as well as the audio state', () => {
  const kernel = runKernel(resonate(voice(), 3000, 40, 14), UNPROTECTED)
  kernel.reset()
  assert.equal(kernel.readDisplay(new Float32Array(kernel.displayLength)), false)
})

// ── Delta monitoring ────────────────────────────────────────────────────────
//
// Auditioning the difference is only useful if it IS the difference. The
// implementation applies the complement of the gain inside the same STFT rather
// than subtracting two signals downstream, so the claim to check is the
// identity that licenses it: output + delta must reconstruct the input, sample
// for sample, with nothing left over at the edges where the overlap-add
// normalisation does its work.

/** Render a signal through a kernel and return the output. */
function renderKernel(sig, params = {}, { monitorDelta = false } = {}) {
  const kernel = new ResonanceKernel(SR)
  kernel.setParams(params)
  if (monitorDelta) kernel.setMonitor(true)
  const out = new Float32Array(sig.length)
  for (let off = 0; off < sig.length; off += 128) {
    const len = Math.min(128, sig.length - off)
    kernel.process([sig.subarray(off, off + len)], [out.subarray(off, off + len)], len)
  }
  return out
}

/**
 * Peak level past the latency, which is where every other measurement in this
 * file starts too.
 *
 * The kernel's first frames carry a startup transient: a spectral gain applied
 * while the analysis ring is still filling smears energy into a region the
 * overlap-add has barely any accumulated window for, and the normalisation
 * there magnifies it. It sits inside the latency the apply path trims, and it
 * cancels exactly between the output and the delta — the reconstruction test
 * above covers the whole signal and sees 7e-9 — but it is 30x either signal's
 * working level, so a peak measured from sample 0 measures only it.
 */
function maxAbs(a, from = LATENCY) {
  let m = 0
  for (let i = from; i < a.length; i++) m = Math.max(m, Math.abs(a[i]))
  return m
}

test('output plus delta reconstructs the input', () => {
  const sig = resonate(voice(), 3000, 40, 14)
  const wet = renderKernel(sig, UNPROTECTED)
  const delta = renderKernel(sig, UNPROTECTED, { monitorDelta: true })
  // At zero depth the gain is 1 everywhere, so this is the input as the STFT
  // reconstructs it — the only fair reference, since it carries the same
  // latency and the same overlap-add normalisation as the other two.
  const dry = renderKernel(sig, zoned(UNPROTECTED, { depth: 0 }))

  let worst = 0
  for (let i = 0; i < sig.length; i++) {
    worst = Math.max(worst, Math.abs(wet[i] + delta[i] - dry[i]))
  }
  assert.ok(worst < 1e-6, `output + delta missed the input by ${worst}`)
})

test('delta carries what was removed, and only that', () => {
  // Unpitched carrier, so the resonance is the only structure in the signal.
  // On the harmonic stack with protection off the suppressor legitimately eats
  // harmonics all over the spectrum — that is what PROTECTION OFF does — and a
  // delta measured there says more about the mask than about this feature.
  const sig = resonate(noise(), 3000, 40, 18)
  const delta = renderKernel(sig, UNPROTECTED, { monitorDelta: true })
  const dry = renderKernel(sig, zoned(UNPROTECTED, { depth: 0 }))

  // Something is there: a silent delta would satisfy the reconstruction test
  // above whenever the suppressor happened to be doing nothing.
  assert.ok(maxAbs(delta) > 1e-3, `delta was silent (${maxAbs(delta)})`)
  // You cannot remove more than there was.
  assert.ok(
    maxAbs(delta) <= maxAbs(dry) * 1.01,
    `delta (${maxAbs(delta).toFixed(3)}) exceeded the input (${maxAbs(dry).toFixed(3)})`,
  )

  const atResonance = bandDb(delta, 3000, SR + LATENCY)
  const away = bandDb(delta, 700, SR + LATENCY)
  assert.ok(
    atResonance > away + 15,
    `delta is not concentrated at the resonance: ${atResonance.toFixed(1)} dB at 3 kHz vs ${away.toFixed(1)} dB at 700 Hz`,
  )
})

test('monitoring is off by default and unreachable through the parameters', () => {
  // The structural guarantee behind setMonitor: applyResonanceRegion spreads a
  // param object straight into the kernel, so a monitoring mode that could be
  // set from `params` would be one careless key away from rendering a
  // difference signal into the timeline.
  const kernel = new ResonanceKernel(SR)
  assert.equal(kernel.monitorDelta, false)
  kernel.setParams({ monitorDelta: true, delta: true, monitor: 'delta' })
  assert.equal(kernel.monitorDelta, false)

  const sig = resonate(voice({ seconds: 1 }), 3000, 40, 14)
  const rendered = processResonanceBuffer([sig], SR, UNPROTECTED).channelData[0]
  const expected = renderKernel(sig, UNPROTECTED)
  let worst = 0
  for (let i = 0; i < sig.length; i++) {
    worst = Math.max(worst, Math.abs(rendered[i] - expected[i]))
  }
  assert.ok(worst < 1e-9, `the render path did not produce the processed output (${worst})`)
})

// ── Log-frequency geometry, ballistics, stereo detection, mix and trim ──────

test('the spread kernel is a constant width in octaves, not in bins', () => {
  // The width used to be `30 * (1 - sharpness)` FFT bins — the same width in
  // Hz everywhere, which is ~1.9 octaves at 60 Hz and 0.02 at 8 kHz. Pinned
  // here as a ratio to the bin index, which is what "constant in octaves"
  // means: half-width proportional to frequency.
  const k = new ResonanceKernel(SR)
  k.setParams(zoned(RESONANCE_KERNEL_DEFAULTS, { sharpness: 0.8 }))
  const at = f => k.spreadHalfBins[Math.round(f / k.binWidth)]

  // 3 kHz is the calibration point: ±6 bins, exactly what the linear kernel
  // gave there. Everything else follows from proportionality.
  assert.equal(at(3000), 6)
  for (const [lo, hi] of [[1000, 2000], [2000, 4000], [4000, 8000]]) {
    const ratio = at(hi) / at(lo)
    assert.ok(
      ratio > 1.8 && ratio < 2.2,
      `an octave should double the half-width, ${lo}->${hi} gave ${ratio.toFixed(2)}`,
    )
  }
  // Wider at lower sharpness, everywhere.
  const wide = new ResonanceKernel(SR)
  wide.setParams(zoned(RESONANCE_KERNEL_DEFAULTS, { sharpness: 0.2 }))
  for (const f of [1000, 3000, 9000]) {
    const bin = Math.round(f / wide.binWidth)
    assert.ok(
      wide.spreadHalfBins[bin] > k.spreadHalfBins[bin],
      `sharpness did not widen the cut at ${f} Hz`,
    )
  }
})

test('a broad defect is removed by a similar amount wherever it sits', () => {
  // THE REGRESSION THIS EXISTS FOR. With a spread fixed in bins and a lifter
  // fixed to F0, the same +10 dB hump swept across the spectrum was removed by
  // 25 dB at 500 Hz and 6 dB at 6 kHz — one setting behaving as two orders of
  // magnitude of Q depending only on where the problem was.
  // Probe frequencies stay inside the carrier's own content: `voice` runs 30
  // harmonics, so at F0 150 there is nothing but noise floor above ~4.5 kHz
  // and a probe up there measures the generator, not the suppressor.
  const dry = voice({ f0: 150 })
  const removed = [500, 1200, 2500, 4000].map(
    f => boostRemoved(dry, f, 1.5, 10, UNPROTECTED),
  )
  const lo = Math.min(...removed)
  const hi = Math.max(...removed)
  assert.ok(
    hi - lo < 5,
    `spread across the axis was ${(hi - lo).toFixed(1)} dB: ${removed.map(v => v.toFixed(1)).join(', ')}`,
  )
  assert.ok(lo > 5, `least-removed band only lost ${lo.toFixed(1)} dB`)
})

test('sharpness moves the detection scale, not just the cut width', () => {
  // The lifter cutoff used to be F0 and nothing else, so nothing the user
  // could touch changed what counted as a resonance in the first place.
  const dry = voice({ f0: 150 })
  const broad = boostRemoved(dry, 3000, 1.5, 10, zoned(UNPROTECTED, { sharpness: 0.4 }))
  const surgical = boostRemoved(dry, 3000, 1.5, 10, zoned(UNPROTECTED, { sharpness: 1 }))
  assert.ok(
    broad > surgical + 8,
    `low sharpness should catch a broad hump the high setting walks past: ${broad.toFixed(1)} vs ${surgical.toFixed(1)}`,
  )
})

test('the envelope is no finer than the harmonic comb, and no finer than asked', () => {
  // Two separate bounds, and the F0 one is the physical half: an envelope
  // finer than the harmonic spacing traces the comb instead of passing under
  // it. The sharpness target is the half that used to be missing, which is why
  // a deep voice got a reference four times finer than a high one and the
  // effect quietly did less on it.
  const k = new ResonanceKernel(SR)
  k.setParams(zoned(RESONANCE_KERNEL_DEFAULTS, { sharpness: 0.8 }))
  // The target lives on the envelope group now — one per distinct zone
  // sharpness, because sharpness sets the scale of a whole transform and a
  // zone asking for a different one needs its own envelope.
  const target = k.envGroups[0].lifterTarget
  const combLimit = f0 => Math.max(20, Math.trunc((0.4 * SR) / f0))

  // A 220 Hz voice is comb-limited: the target is finer than the comb allows.
  assert.ok(target > combLimit(220))
  // An 80 Hz voice is not, and used to be given nearly twice the resolution.
  assert.ok(target < combLimit(80))
  assert.ok(combLimit(80) / target > 1.7)
})

test('the ballistic minima are settings the frame rate can express', () => {
  // Below one STFT hop the IIR coefficient rounds to zero and every setting is
  // the same instantaneous jump, so the bottom of both knobs was inert travel.
  const hopMs = (512 / SR) * 1000
  assert.ok(RESONANCE_ATTACK_MIN_MS >= hopMs)
  assert.ok(RESONANCE_RELEASE_MIN_MS >= 2 * hopMs)

  const k = new ResonanceKernel(SR)
  k.setParams({ attackMs: RESONANCE_ATTACK_MIN_MS, releaseMs: RESONANCE_RELEASE_MIN_MS })
  assert.ok(k.attackCoeff > 0.25, `attack coefficient ${k.attackCoeff} is indistinguishable from instant`)
  assert.ok(k.releaseCoeff > 0.55, `release coefficient ${k.releaseCoeff} is indistinguishable from instant`)
})

test('detection reads every channel, not just the first', () => {
  // It used to run on channel 0 alone and call the result "linked". A
  // resonance living only in the right channel was invisible — which on a
  // two-host podcast tracked to separate channels is half the material.
  const dry = voice({ seconds: 2 })
  const right = resonate(dry, 3000, 40, 14)
  const { channelData } = processResonanceBuffer(
    [dry.slice(), right.slice()], SR, UNPROTECTED,
  )
  const removed = bandDb(right, 3000, SR) - bandDb(channelData[1], 3000, SR + LATENCY)
  assert.ok(removed > 6, `only ${removed.toFixed(1)} dB came out of the right channel`)
})

test('one shared gain still reaches every channel', () => {
  // The detection mix must not turn into per-channel processing: identical
  // channels have to stay identical, or the image wanders.
  const sig = voice({ seconds: 1.5 })
  const { channelData } = processResonanceBuffer(
    [sig.slice(), sig.slice()], SR, RESONANCE_KERNEL_DEFAULTS,
  )
  let maxErr = 0
  for (let i = 0; i < sig.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(channelData[0][i] - channelData[1][i]))
  }
  assert.ok(maxErr < 1e-9, `channels diverged by ${maxErr}`)
})

test('mono is untouched by the stereo detection path', () => {
  // One channel runs no second transform and takes exactly the code it always
  // did, so nothing a narrator records can have moved.
  const sig = voice({ seconds: 1.5 })
  const k = new ResonanceKernel(SR)
  k.process([sig.subarray(0, 512)], [new Float32Array(512)], 512)
  assert.equal(k.detStft, null)
})

test('mix 0 is the input, sample for sample', () => {
  const sig = resonate(voice({ seconds: 2 }), 3000, 40, 14)
  const { channelData } = processResonanceBuffer([sig], SR, { ...UNPROTECTED, mix: 0 })
  let maxErr = 0
  for (let i = LATENCY; i < sig.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(channelData[0][i] - sig[i - LATENCY]))
  }
  assert.ok(maxErr < 1e-6, `mix 0 was not the dry signal: max error ${maxErr}`)
})

test('mix blends monotonically between dry and fully suppressed', () => {
  const dry = voice({ seconds: 2 })
  const removed = [0, 0.25, 0.5, 0.75, 1].map(
    mix => boostRemoved(dry, 3000, 40, 14, { ...UNPROTECTED, mix }),
  )
  assert.ok(Math.abs(removed[0]) < 0.05, `mix 0 removed ${removed[0].toFixed(2)} dB`)
  for (let i = 1; i < removed.length; i++) {
    assert.ok(
      removed[i] > removed[i - 1],
      `mix is not monotone: ${removed.map(v => v.toFixed(2)).join(', ')}`,
    )
  }
})

test('trim is a clean output gain on the wet path', () => {
  const sig = resonate(voice({ seconds: 2 }), 3000, 40, 14)
  const flat = processResonanceBuffer([sig], SR, UNPROTECTED).channelData[0]
  const lifted = processResonanceBuffer([sig], SR, { ...UNPROTECTED, trimDb: 6 }).channelData[0]
  let a = 0
  let b = 0
  for (let i = LATENCY + 4096; i < sig.length - 4096; i++) {
    a += flat[i] * flat[i]
    b += lifted[i] * lifted[i]
  }
  const gained = 10 * Math.log10(b / a)
  assert.ok(Math.abs(gained - 6) < 0.05, `+6 dB of trim gave ${gained.toFixed(3)} dB`)
})

test('the delta monitor stays exact under mix and trim', () => {
  // The blend lives inside the per-bin gain, so 1 - gain is still literally
  // input minus output. Had mix been staged as a node around the effect this
  // would not hold.
  const sig = resonate(voice({ seconds: 1.5 }), 3000, 40, 14)
  const params = { ...UNPROTECTED, mix: 0.6, trimDb: 3 }
  const wet = processResonanceBuffer([sig], SR, params).channelData[0]

  const kernel = new ResonanceKernel(SR)
  kernel.setParams(params)
  kernel.setMonitor(true)
  const delta = new Float32Array(sig.length)
  for (let off = 0; off < sig.length; off += 128) {
    const len = Math.min(128, sig.length - off)
    kernel.process([sig.subarray(off, off + len)], [delta.subarray(off, off + len)], len)
  }

  let maxErr = 0
  for (let i = LATENCY; i < sig.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(wet[i] + delta[i] - sig[i - LATENCY]))
  }
  assert.ok(maxErr < 1e-6, `output + delta drifted from the input by ${maxErr}`)
})

test('the reduction the meter reports is the one the blend leaves', () => {
  // Soothe shows shallower notches as mix comes down and says so in its
  // manual; anything else makes the meter disagree with the ears. Trim moves
  // every bin together, so it must cancel out of a notch depth.
  const k = new ResonanceKernel(SR)
  k.setParams({ mix: 1, trimDb: 0 })
  assert.equal(k._mixDepth(12), 12)

  k.setParams({ mix: 0 })
  assert.ok(Math.abs(k._mixDepth(12)) < 1e-12)

  k.setParams({ mix: 0.5, trimDb: 0 })
  const half = k._mixDepth(12)
  assert.ok(half > 0 && half < 12, `half-mix depth ${half} is not between dry and wet`)

  k.setParams({ mix: 0.5, trimDb: 6 })
  assert.ok(
    Math.abs(k._mixDepth(12) - half) < 1e-9,
    'trim leaked into a notch depth it should cancel out of',
  )
})
