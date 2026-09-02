/**
 * Run with:  npm test
 *
 * The auto-makeup measurement runs the whole kernel over the selection several
 * times to converge, and it does that through a base-rate path rather than the
 * oversampled one the audio takes. That shortcut is what keeps the Output knob
 * up with a drag — measuring through the oversampled path made it about three
 * times slower, slow enough that Output visibly lagged and, worse, that a stale
 * Output could be applied to a signal it was not measured for.
 *
 * These tests pin the premise that makes the shortcut sound: oversampling
 * barely moves the number being measured. If that ever stops being true, this
 * fails rather than the makeup quietly drifting.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FET1176Kernel,
  processFET1176Buffer,
  computeFET1176AutoMakeupDb,
} from '../../src/audio/fet1176Processor.js'
import {
  LA2AKernel,
  processLA2ABuffer,
  computeAutoMakeupDb,
} from '../../src/audio/la2aProcessor.js'
import { OVERSAMPLE_LATENCY_SAMPLES } from '../../src/audio/dsp/oversample.js'

const SR = 44100

/** Voice-like material: a harmonic stack under a syllabic envelope. */
function material(seconds = 1.5, peak = 0.7) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const env = Math.max(0, Math.sin(2 * Math.PI * 3.1 * t)) ** 2 * 0.8 + 0.05
    let s = 0
    for (let h = 1; h <= 14; h++) s += Math.sin(2 * Math.PI * 118 * h * t + h * 0.7) / h
    x[i] = s * env
  }
  let max = 0
  for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(x[i]))
  for (let i = 0; i < n; i++) x[i] *= peak / max
  return x
}

function rmsDb(channels, skip = 0) {
  let sumSq = 0
  let count = 0
  for (const c of channels) {
    for (let i = skip; i < c.length; i++) sumSq += c[i] * c[i]
    count += Math.max(0, c.length - skip)
  }
  return 10 * Math.log10(sumSq / count)
}

/** Peak magnitude across channels, in dB — the makeup reference. */
function peakDb(channels, skip = 0) {
  let peak = 0
  for (const ch of channels) {
    for (let i = skip; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]))
  }
  return 20 * Math.log10(peak + 1e-30)
}

const SIGNAL = material()

test('FET Punch: the measurement path measures the same level as the audio path', () => {
  // The tolerance is the whole argument for the shortcut. Oversampling removes
  // folded harmonics, which carry almost no energy, so the RMS it changes is a
  // rounding error next to the gain being set from it.
  for (const params of [
    { inputDrive: 30, ratio: '4', attack: 1, release: 4, fetDrive: 0 },
    { inputDrive: 50, ratio: '4', attack: 4, release: 4, fetDrive: 0.35 },
    { inputDrive: 70, ratio: '12', attack: 7, release: 4, fetDrive: 0.35 },
    { inputDrive: 90, ratio: '20', attack: 7, release: 7, fetDrive: 1 },
    { inputDrive: 100, ratio: 'all', attack: 4, release: 4, fetDrive: 1 },
  ]) {
    const over = processFET1176Buffer([SIGNAL], SR, { ...params, oversample: true })
    const base = processFET1176Buffer([SIGNAL], SR, { ...params, oversample: false })
    // The oversampled output is delayed, so skip its ramp-up on both sides.
    const delta = rmsDb(over.channelData, OVERSAMPLE_LATENCY_SAMPLES)
      - rmsDb(base.channelData, OVERSAMPLE_LATENCY_SAMPLES)
    assert.ok(
      Math.abs(delta) < 0.05,
      `inputDrive ${params.inputDrive} ratio ${params.ratio}: `
      + `oversampled RMS differs from base-rate by ${delta.toFixed(4)} dB`,
    )
  }
})

test('OptoSmooth: the measurement path measures the same level as the audio path', () => {
  for (const params of [
    { mode: 'compress', peakReduction: 20, tubeDrive: 0 },
    { mode: 'compress', peakReduction: 50, tubeDrive: 0.3 },
    { mode: 'compress', peakReduction: 90, tubeDrive: 1 },
    { mode: 'limit', peakReduction: 70, tubeDrive: 0.3 },
  ]) {
    const over = processLA2ABuffer([SIGNAL], SR, { ...params, oversample: true })
    const base = processLA2ABuffer([SIGNAL], SR, { ...params, oversample: false })
    const delta = rmsDb(over.channelData, OVERSAMPLE_LATENCY_SAMPLES)
      - rmsDb(base.channelData, OVERSAMPLE_LATENCY_SAMPLES)
    assert.ok(
      Math.abs(delta) < 0.05,
      `${params.mode} PR ${params.peakReduction}: `
      + `oversampled RMS differs from base-rate by ${delta.toFixed(4)} dB`,
    )
  }
})

test('the measurement shortcut degrades at the top of LIMIT, and by how much', () => {
  // Split out of the test above, which used to cover limit PR 95 at the same
  // 0.05 dB bar and stopped clearing it when the Peak Reduction taper was fitted
  // to a real LA-2A. That is not the shortcut going wrong — it is the knob
  // finally reaching the depth the hardware has. The old taper topped out at
  // 13 dB of gain reduction, so the saturator was never driven hard enough for
  // folded harmonics to carry measurable energy; it now reaches 27 dB, and at
  // the very top of LIMIT they do.
  //
  // Pinned at measured values rather than folded into a looser blanket
  // tolerance, so this still fails on drift. The error is worth accepting
  // because it is bounded and small next to the ~24 dB of makeup being set from
  // it, and because measuring through the oversampled path is three times
  // slower — enough that the Gain knob visibly lagged a drag.
  for (const [params, bound] of [
    [{ mode: 'compress', peakReduction: 100, tubeDrive: 1 }, 0.1],
    [{ mode: 'limit', peakReduction: 95, tubeDrive: 1 }, 0.25],
    [{ mode: 'limit', peakReduction: 100, tubeDrive: 1 }, 0.35],
  ]) {
    const over = processLA2ABuffer([SIGNAL], SR, { ...params, oversample: true })
    const base = processLA2ABuffer([SIGNAL], SR, { ...params, oversample: false })
    const delta = rmsDb(over.channelData, OVERSAMPLE_LATENCY_SAMPLES)
      - rmsDb(base.channelData, OVERSAMPLE_LATENCY_SAMPLES)
    assert.ok(
      Math.abs(delta) < bound,
      `${params.mode} PR ${params.peakReduction}: `
      + `oversampled RMS differs from base-rate by ${delta.toFixed(4)} dB`,
    )
  }
})

test('auto-makeup restores the PEAK, which is what makeup gain means', () => {
  // Not level-neutrality, which is what this used to assert. A compressor
  // pulls the loud moments down; makeup hands back what it took, so the peaks
  // land where they started and everything underneath rises with them. Matching
  // RMS instead returns only the average loss and leaves the compressor unable
  // to make anything louder.
  //
  // The guarantee this buys is the important half: the output can never come
  // out hotter than the source, whatever the setting. That is what stops a
  // surviving transient being pushed above the input and reading as an errant
  // peak.
  for (const params of [
    { inputDrive: 50, ratio: '4', attack: 4, release: 4, fetDrive: 0.35 },
    { inputDrive: 85, ratio: '20', attack: 7, release: 4, fetDrive: 0.5 },
  ]) {
    const makeup = computeFET1176AutoMakeupDb([SIGNAL], SR, params)
    const out = processFET1176Buffer([SIGNAL], SR, { ...params, outputGainDb: makeup })
    const peakDelta = peakDb(out.channelData, OVERSAMPLE_LATENCY_SAMPLES)
      - peakDb([SIGNAL], OVERSAMPLE_LATENCY_SAMPLES)
    assert.ok(
      Math.abs(peakDelta) < 0.1,
      `FET makeup ${makeup.toFixed(2)} dB left the peak ${peakDelta.toFixed(3)} dB off`,
    )
  }

  // Settings the +24 dB Gain knob can actually restore. `limit` PR 90 used to be
  // one of them and no longer is — see the clamp test below.
  for (const params of [
    { mode: 'compress', peakReduction: 70, tubeDrive: 0.3 },
    { mode: 'compress', peakReduction: 85, tubeDrive: 0.3 },
  ]) {
    const makeup = computeAutoMakeupDb([SIGNAL], SR, params)
    const out = processLA2ABuffer([SIGNAL], SR, { ...params, gainDb: makeup })
    const peakDelta = peakDb(out.channelData, OVERSAMPLE_LATENCY_SAMPLES)
      - peakDb([SIGNAL], OVERSAMPLE_LATENCY_SAMPLES)
    assert.ok(
      Math.abs(peakDelta) < 0.1,
      `Opto makeup ${makeup.toFixed(2)} dB left the peak ${peakDelta.toFixed(3)} dB off`,
    )
    assert.ok(peakDelta <= 0.05, 'the output must never exceed the input peak')
  }
})

test('auto-makeup that cannot fit in the Gain knob clamps short, never over', () => {
  // A regime that did not exist before the Peak Reduction taper was fitted to a
  // real LA-2A. The old law reached 13 dB of gain reduction across its entire
  // travel, so +24 dB of Gain could always hand it back; the taper now reaches
  // 27 dB, and deep LIMIT settings ask for more makeup than the knob has.
  //
  // The knob's range is the hardware's and is not the thing to widen. What has
  // to hold is the direction of the shortfall: an unreachable makeup must leave
  // the output QUIETER than the source, because the guarantee this whole
  // mechanism buys is that the output never comes out hotter than what went in.
  // Clamping in the other direction would put peaks above the input at exactly
  // the settings most likely to produce them.
  for (const params of [
    { mode: 'limit', peakReduction: 90, tubeDrive: 0.3 },
    { mode: 'limit', peakReduction: 100, tubeDrive: 0.3 },
  ]) {
    const makeup = computeAutoMakeupDb([SIGNAL], SR, params)
    assert.ok(makeup <= 24 + 1e-9, `makeup ${makeup.toFixed(2)} dB exceeds the Gain knob`)
    assert.ok(makeup > 23.9, `expected the clamp to be reached, got ${makeup.toFixed(2)} dB`)
    const out = processLA2ABuffer([SIGNAL], SR, { ...params, gainDb: makeup })
    const peakDelta = peakDb(out.channelData, OVERSAMPLE_LATENCY_SAMPLES)
      - peakDb([SIGNAL], OVERSAMPLE_LATENCY_SAMPLES)
    assert.ok(
      peakDelta < 0,
      `a clamped makeup must undershoot; PR ${params.peakReduction} left the peak `
      + `${peakDelta.toFixed(3)} dB off`,
    )
  }
})

test('a peak compressor earns loudness from makeup; a slow leveller may not', () => {
  // The measured difference between the two, and the reason the same makeup
  // rule reads so differently on them.
  //
  // FET Punch catches peaks, so restoring them lifts everything underneath and
  // the average rises — the textbook picture. OptoSmooth on this material does
  // the opposite: a 10 ms attack into a multi-second release lets syllable
  // onsets through nearly intact while pulling the sustained body down, so it
  // reduces the average MORE than the peaks and peak-referenced makeup comes
  // out quieter on average.
  //
  // That is a property of an opto leveller rather than a fault, and it is
  // pinned here because it decides what users should expect: reach for FET
  // Punch to make something louder, for OptoSmooth to make it steadier. On
  // slower material the Opto does earn density — measured at +1.6 dB on a real
  // narration clip at Peak Reduction 60.
  const fetParams = { inputDrive: 50, ratio: '4', attack: 4, release: 4, fetDrive: 0.35 }
  const fetMakeup = computeFET1176AutoMakeupDb([SIGNAL], SR, fetParams)
  const fetOut = processFET1176Buffer([SIGNAL], SR, { ...fetParams, outputGainDb: fetMakeup })
  const fetGain = rmsDb(fetOut.channelData, OVERSAMPLE_LATENCY_SAMPLES)
    - rmsDb([SIGNAL], OVERSAMPLE_LATENCY_SAMPLES)
  assert.ok(fetGain > 0.5, `FET Punch should earn density, got ${fetGain.toFixed(2)} dB`)

  const optoParams = { mode: 'compress', peakReduction: 70, tubeDrive: 0.3 }
  const optoMakeup = computeAutoMakeupDb([SIGNAL], SR, optoParams)
  const optoOut = processLA2ABuffer([SIGNAL], SR, { ...optoParams, gainDb: optoMakeup })
  const optoGain = rmsDb(optoOut.channelData, OVERSAMPLE_LATENCY_SAMPLES)
    - rmsDb([SIGNAL], OVERSAMPLE_LATENCY_SAMPLES)
  assert.ok(
    optoGain < fetGain,
    `the opto should trail the FET on density: ${optoGain.toFixed(2)} vs ${fetGain.toFixed(2)} dB`,
  )
})

test('latency is reported per path, so the apply trim can never be wrong', () => {
  // The apply path trims exactly latencySamples. Anything that renders audio
  // takes the oversampled path and must report its delay; the measurement path
  // has none to report, and nothing renders through it.
  for (const [name, Kernel] of [['FET Punch', FET1176Kernel], ['OptoSmooth', LA2AKernel]]) {
    const k = new Kernel(SR)
    k.setParams({})
    assert.equal(
      k.latencySamples, OVERSAMPLE_LATENCY_SAMPLES, `${name}: default must be the audio path`,
    )
    k.setParams({ oversample: false })
    assert.equal(k.latencySamples, 0, `${name}: measurement path has no delay to report`)
    k.setParams({ oversample: true })
    assert.equal(k.latencySamples, OVERSAMPLE_LATENCY_SAMPLES, `${name}: must switch back`)
  }
  assert.equal(
    processFET1176Buffer([SIGNAL], SR, {}).latencySamples,
    OVERSAMPLE_LATENCY_SAMPLES,
  )
  assert.equal(
    processFET1176Buffer([SIGNAL], SR, { oversample: false }).latencySamples, 0,
  )
})

test('the measurement path does not disturb the audio path', () => {
  // Both kernels are stateful and the two paths share that state. Running a
  // measurement must not leave the audio path sounding different.
  const params = { inputDrive: 70, ratio: '4', attack: 4, release: 4, fetDrive: 0.35 }
  const before = processFET1176Buffer([SIGNAL], SR, params).channelData[0]
  computeFET1176AutoMakeupDb([SIGNAL], SR, params)
  const after = processFET1176Buffer([SIGNAL], SR, params).channelData[0]
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i], before[i], `audio path changed at sample ${i}`)
  }
})

// ── Transient timing ────────────────────────────────────────────────────────

test('a hard onset is grabbed on its first sample, not one sample late', () => {
  // The halfband upsampler's even branch is a pure delay, so sub-sample 0 of
  // each base sample IS the original sample rather than an interpolated point.
  // It therefore has to receive the gain computed from it, exactly. A ramp that
  // starts one step past it leaves that sample holding most of the PREVIOUS
  // gain, and at a 20 us attack the previous gain is most of the reduction the
  // onset was supposed to get — the first sample of every hard onset passes
  // through nearly unattenuated and reads as a click.
  //
  // Caught on a real narration recording, where it put 0.056 of overshoot on
  // word onsets: about 10% of the file's peak, on two or three samples.
  const n = 8192
  const onset = Math.round(n / 2)
  const sig = new Float32Array(n)
  // The envelope rises over RAMP samples rather than instantaneously. A
  // sample-to-sample jump is not a signal any sample rate can represent, and
  // the overshoot a resampler correctly reconstructs from one would swamp what
  // is being measured here — at RAMP = 1 both a correct and a broken kernel
  // show large departures for that reason alone.
  //
  // RAMP = 4 (about 0.09 ms) is calibrated: fast enough that the gain moves
  // substantially within a sample, slow enough to be a signal. Measured
  // departure is 0.014 with the gain aligned and 0.146 with it a sample late,
  // so the bound below sits an order of magnitude clear of both.
  const RAMP = 4
  for (let i = 0; i < n; i++) {
    let level = 0.02
    if (i >= onset + RAMP) level = 0.9
    else if (i >= onset) {
      const u = (i - onset) / RAMP
      level = 0.02 + (0.9 - 0.02) * (0.5 - 0.5 * Math.cos(Math.PI * u))
    }
    sig[i] = level * Math.sin((2 * Math.PI * 220 * i) / SR)
  }

  const params = { inputDrive: 85, ratio: '20', attack: 7, release: 4, fetDrive: 0.35 }
  const over = processFET1176Buffer([sig], SR, { ...params, oversample: true }).channelData[0]
  const base = processFET1176Buffer([sig], SR, { ...params, oversample: false }).channelData[0]

  // Compare the two paths across the onset, allowing for the oversampled path's
  // delay. They will not match exactly — oversampling changes the saturation
  // slightly — but neither may overshoot the other on the attack.
  let worst = 0
  let worstIndex = -1
  for (let i = onset - 200; i < onset + 800; i++) {
    const d = Math.abs(over[i + OVERSAMPLE_LATENCY_SAMPLES] - base[i])
    if (d > worst) {
      worst = d
      worstIndex = i
    }
  }
  assert.ok(
    worst < 0.05,
    `oversampled path departs from base-rate by ${worst.toFixed(4)} at sample `
    + `${worstIndex - onset} relative to the onset — the gain envelope is not `
    + 'landing on the sample it was computed from',
  )
})

test('OptoSmooth tracks its base-rate path across an onset too', () => {
  // Slow attack makes this far less sensitive, but the interpolation is shared.
  const n = 16384
  const onset = Math.round(n / 2)
  const sig = new Float32Array(n)
  const RAMP = 4
  for (let i = 0; i < n; i++) {
    let level = 0.02
    if (i >= onset + RAMP) level = 0.9
    else if (i >= onset) {
      const u = (i - onset) / RAMP
      level = 0.02 + (0.9 - 0.02) * (0.5 - 0.5 * Math.cos(Math.PI * u))
    }
    sig[i] = level * Math.sin((2 * Math.PI * 220 * i) / SR)
  }
  const params = { mode: 'limit', peakReduction: 90, tubeDrive: 0.3 }
  const over = processLA2ABuffer([sig], SR, { ...params, oversample: true }).channelData[0]
  const base = processLA2ABuffer([sig], SR, { ...params, oversample: false }).channelData[0]
  let worst = 0
  for (let i = onset - 200; i < onset + 2000; i++) {
    worst = Math.max(worst, Math.abs(over[i + OVERSAMPLE_LATENCY_SAMPLES] - base[i]))
  }
  assert.ok(worst < 0.05, `departs from base-rate by ${worst.toFixed(4)} across the onset`)
})

// ── FET Punch: the exact one-render solve ───────────────────────────────────
//
// The makeup used to be a fixed-point iteration capped at three passes. Output
// gain scales the WET path only, so `makeup += correction` converges at a rate
// set by the wet share — and two factory presets ship at mix 0.4 and 0.5, where
// the cap returned an answer several dB short. It is now solved in closed form
// from one render; these pin that it is exact at every mix rather than
// convergent, which is the property the iteration never had.

/** Peak across every channel. */
function peakOf(channels) {
  let p = 0
  for (const ch of channels) for (const v of ch) p = Math.max(p, Math.abs(v))
  return p
}

test('FET Punch makeup restores the input peak at EVERY mix, not just at 1', () => {
  const x = material(3, 0.7)
  for (const mix of [1, 0.7, 0.5, 0.4, 0.3]) {
    const p = { inputDrive: 55, attack: 4, release: 5, ratio: '4', fetDrive: 0.35, scHpfHz: 0, mix }
    const makeupDb = computeFET1176AutoMakeupDb([x], SR, p)
    const out = processFET1176Buffer([x], SR, { ...p, outputGainDb: makeupDb }).channelData
    const err = 20 * Math.log10(peakOf(out) / peakOf([x]))
    assert.ok(
      Math.abs(err) < 0.25,
      `mix ${mix}: output peak missed the input's by ${err.toFixed(3)} dB (makeup ${makeupDb.toFixed(2)})`,
    )
  }
})

test('a parallel setting needs MORE makeup than a fully wet one', () => {
  // The mechanism behind the bug, stated as behaviour: with less wet in the
  // sum, the wet path has to be lifted further to move the sum's peak. The old
  // iteration returned LESS at low mix, which is the wrong direction entirely.
  const x = material(3, 0.7)
  const at = (mix) => computeFET1176AutoMakeupDb([x], SR, {
    inputDrive: 55, attack: 4, release: 5, ratio: '4', fetDrive: 0.35, scHpfHz: 0, mix,
  })
  assert.ok(at(0.5) > at(1), `mix 0.5 (${at(0.5).toFixed(2)}) should exceed mix 1 (${at(1).toFixed(2)})`)
})

test('mix 0 asks for no makeup — the output IS the input', () => {
  const x = material(2, 0.7)
  assert.equal(computeFET1176AutoMakeupDb([x], SR, {
    inputDrive: 55, attack: 4, release: 5, ratio: '4', fetDrive: 0.35, scHpfHz: 0, mix: 0,
  }), 0)
})

test('the solve never asks for an output hotter than the source', () => {
  const x = material(3, 0.7)
  for (const mix of [1, 0.6, 0.3]) {
    for (const inputDrive of [30, 55, 85]) {
      const p = { inputDrive, attack: 4, release: 5, ratio: '4', fetDrive: 0.35, scHpfHz: 0, mix }
      const makeupDb = computeFET1176AutoMakeupDb([x], SR, p)
      const out = processFET1176Buffer([x], SR, { ...p, outputGainDb: makeupDb }).channelData
      assert.ok(
        peakOf(out) <= peakOf([x]) * 1.03,
        `mix ${mix} drive ${inputDrive}: output peak exceeded the source's`,
      )
    }
  }
})
