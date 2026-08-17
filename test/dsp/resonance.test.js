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
  PITCH_RANGES,
  resonanceDisplayRange,
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
const UNPROTECTED = { ...RESONANCE_KERNEL_DEFAULTS, preserveHarmonics: false }

test('reports a latency of exactly one FFT frame', () => {
  assert.equal(new ResonanceKernel(SR).latencySamples, LATENCY)
})

test('passes audio through delayed, not mangled, at zero depth', () => {
  const sig = voice({ seconds: 2 })
  const { channelData } = processResonanceBuffer([sig], SR, { depth: 0 })
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
  const out = processResonanceBuffer([sig], SR, { depth: 0 }).channelData[0]

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
  const golden = { 100: 600, 120.5: 495, 150: 665, 154.7: 645, 220: 694, 300: 578 }
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
  const light = boostRemoved(dry, 3000, 40, 12, { ...UNPROTECTED, depth: 0.2 })
  const heavy = boostRemoved(dry, 3000, 40, 12, { ...UNPROTECTED, depth: 1.0 })
  assert.ok(heavy > light + 2, `depth barely mattered: ${light.toFixed(1)} vs ${heavy.toFixed(1)}`)
})

test('selectivity gates what counts as a resonance', () => {
  const dry = voice()
  const removed = boostRemoved(dry, 3000, 40, 12, { ...UNPROTECTED, selectivity: 60 })
  assert.ok(removed < 2, `expected almost nothing at selectivity 60, got ${removed.toFixed(1)} dB`)
})

test('max reduction caps the cut', () => {
  const dry = voice()
  const capped = boostRemoved(dry, 3000, 40, 18, { ...UNPROTECTED, maxReductionDb: 3 })
  const uncapped = boostRemoved(dry, 3000, 40, 18, UNPROTECTED)
  assert.ok(capped < uncapped - 4, `cap had no effect: ${capped.toFixed(1)} vs ${uncapped.toFixed(1)}`)
})

test('band limits confine the reduction', () => {
  const dry = voice()
  const inBand = boostRemoved(dry, 3000, 40, 12, UNPROTECTED)
  const outOfBand = boostRemoved(dry, 3000, 40, 12, { ...UNPROTECTED, freqCeilHz: 2000 })
  assert.ok(inBand > 6, `in-band removal was only ${inBand.toFixed(1)} dB`)
  assert.ok(outOfBand < 1.5, `above the ceiling should be untouched, got ${outOfBand.toFixed(1)} dB`)
})

test('harmonic protection holds the suppressor off the voice', () => {
  // The mask is the safety mechanism the server refuses to run without. With
  // it on, a signal that is nothing but voice should come through close to
  // untouched; with it off the suppressor starts eating harmonics.
  const sig = voice()
  const withMask = processResonanceBuffer([sig], SR, RESONANCE_KERNEL_DEFAULTS).channelData[0]
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
  const out = processResonanceBuffer([sig], SR, RESONANCE_KERNEL_DEFAULTS).channelData[0]

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
  // The server hard-coded 70-400 Hz because it only ever saw speech. An
  // out-of-range source does not fail quietly here: the peak picker returns the
  // best lag WITHIN the range, so a 45 Hz source is reported as an octave
  // artefact with full confidence and the mask lands on non-harmonics.
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

test('the range the UI shows is the range the kernel uses', () => {
  // effectivePitchRange mirrors the kernel's clamp on the main thread, because
  // a worklet has no way to hand a value back for rendering a label. Mirrored
  // logic drifts, so pin the two together.
  for (const sampleRate of [44100, 48000, 96000]) {
    const kernel = new ResonanceKernel(sampleRate)
    for (const [key, range] of Object.entries(PITCH_RANGES)) {
      kernel.setParams({ pitchMinHz: range.minHz, pitchMaxHz: range.maxHz })
      const shown = effectivePitchRange(sampleRate, key)
      assert.ok(
        Math.abs(shown.minHz - kernel.pitchRange.minHz) < 1e-9,
        `${key} @ ${sampleRate}: UI says ${shown.minHz}, kernel uses ${kernel.pitchRange.minHz}`,
      )
      assert.equal(shown.maxHz, kernel.pitchRange.maxHz)
    }
  }
  // The case that motivated it: 'wide' asks for 40 Hz and does not get it.
  assert.ok(effectivePitchRange(44100, 'wide').minHz > PITCH_RANGES.wide.minHz)
})

test('the mask cache survives a knob move that does not change its geometry', () => {
  // The effect wrapper posts the whole param object on every knob move, so an
  // `in partial` test on the key would clear the cache on every twist.
  const kernel = new ResonanceKernel(SR)
  kernel._harmonicMask(150)
  assert.equal(kernel.maskCache.size, 1)

  kernel.setParams({ ...RESONANCE_KERNEL_DEFAULTS, depth: 0.4 })
  assert.equal(kernel.maskCache.size, 1, 'depth does not move a single harmonic')

  kernel.setParams({ ...RESONANCE_KERNEL_DEFAULTS, freqCeilHz: 12000 })
  assert.equal(kernel.maskCache.size, 0, 'the ceiling ends the harmonic walk')
})

test('output is independent of the block size it was fed in', () => {
  // The kernel walks a block in hop-sized pieces so a block spanning two
  // frames cannot leave later channels applying the wrong frame's gain.
  const sig = voice({ seconds: 1.5 })
  const n = sig.length
  const oneShot = processResonanceBuffer([sig], SR, RESONANCE_KERNEL_DEFAULTS).channelData[0]

  const kernel = new ResonanceKernel(SR)
  kernel.setParams(RESONANCE_KERNEL_DEFAULTS)
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

/** Split a display read into its three curves plus the grid's frequencies. */
function readDisplay(kernel) {
  const d = kernel.displayBins
  const buf = new Float32Array(3 * d)
  const ok = kernel.readDisplay(buf)
  const octaves = Math.log2(kernel.displayMaxHz / kernel.displayMinHz)
  return {
    ok,
    bins: d,
    mag: buf.subarray(0, d),
    reference: buf.subarray(d, 2 * d),
    reduction: buf.subarray(2 * d, 3 * d),
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
  const buf = new Float32Array(3 * d)
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
    for (let i = 0; i < d; i++) sum[i] += buf[2 * d + i]
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
  assert.equal(kernel.readDisplay(new Float32Array(3 * kernel.displayBins)), false)
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

  const d = readDisplay(runKernel(sig, { ...UNPROTECTED, depth: 0 }))
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
    d.mag[at] - d.reference[at] > RESONANCE_KERNEL_DEFAULTS.selectivity,
    `peak stood only ${(d.mag[at] - d.reference[at]).toFixed(1)} dB over the reference`,
  )
})

test('reduction between two reads is held, not lost', () => {
  // The worklet reads at half the frame rate, so a peak landing on an unread
  // frame has to survive to the next read — that peak is the transient ring
  // the user is looking for.
  const kernel = runKernel(resonate(voice(), 3000, 40, 14), UNPROTECTED)
  const first = readDisplay(kernel)
  const held = Math.max(...first.reduction)
  assert.ok(held > 3, `expected a real cut to report, got ${held.toFixed(1)} dB`)

  // A second read with no further audio reports nothing: the accumulator was
  // cleared, so a stale peak cannot be shown twice.
  const second = readDisplay(kernel)
  assert.equal(Math.max(...second.reduction), 0)
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
    assert.ok(Number.isFinite(d.reduction[i]), `reduction ${i} was not finite`)
  }
})

test('reset clears the display as well as the audio state', () => {
  const kernel = runKernel(resonate(voice(), 3000, 40, 14), UNPROTECTED)
  kernel.reset()
  assert.equal(kernel.readDisplay(new Float32Array(3 * kernel.displayBins)), false)
})
