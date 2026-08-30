/**
 * Run with:  npm test
 *
 * The kernel's `frameSize` option — a BAND-LIMITED instance, not a cheaper
 * full-range one.
 *
 * The shipping 2048-point frame exists for the low end: resolving a 70-100 Hz
 * fundamental takes a long frame. A stage pointed at 5-12 kHz has no such
 * requirement — at 44.1 kHz a 512-point frame is 86 Hz per bin, which is far
 * finer than any sibilance feature — and it buys back the two things that made
 * this plugin hard to put in a chain: 46.4 ms of latency and a burst that
 * lands on one quantum in four.
 *
 * What these pin is the pair of claims that makes the option safe: the shipping
 * path cannot move, and a short frame must refuse to do the one job it cannot
 * do (pitch) rather than doing it badly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ResonanceKernel,
  resonanceLatencySamples,
  resolveResonanceFrameSize,
  processResonanceBuffer,
} from '../../src/audio/resonanceProcessor.js'
import { RESONANCE_FRAME_SIZE, DEFAULT_RESONANCE_ZONES } from '../../src/audio/resonanceParams.js'
import { getFFT } from '../../src/audio/dsp/fft.js'

const SR = 44100
const Q = 128

/** Voice + sibilant bursts + a planted ring, deterministic. */
function sibilantVoice(n, ringHz = 7500) {
  const x = new Float32Array(n)
  let ph = 0
  let seed = 12345
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  for (let i = 0; i < n; i++) {
    const t = i / SR
    ph += (2 * Math.PI * (130 + 10 * Math.sin(2 * Math.PI * 0.7 * t))) / SR
    let v = 0
    for (let h = 1; h <= 22; h++) v += Math.sin(ph * h) / h
    v += 0.35 * Math.sin(2 * Math.PI * 700 * t)
    if (t % 0.8 < 0.12) v += 0.55 * rnd()
    v += 0.30 * Math.sin(2 * Math.PI * ringHz * t)
    x[i] = 0.20 * v * (0.25 + 0.75 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t))) * (t % 5 < 4 ? 1 : 0)
  }
  return x
}

/** One zone live over [loHz, hiHz], everything else switched off. */
function bandZones(loHz, hiHz, overrides = {}) {
  const stock = DEFAULT_RESONANCE_ZONES[DEFAULT_RESONANCE_ZONES.length - 1]
  const z = { ...stock, ...overrides }
  return [
    { ...z, loHz: 20, hiHz: loHz, enabled: false },
    { ...z, loHz, hiHz, enabled: true },
    { ...z, loHz: hiHz, hiHz: 20000, enabled: false },
  ]
}

function render(x, params, options) {
  const n = x.length
  const out = new Float32Array(n)
  const k = new ResonanceKernel(SR, options)
  k.setParams(params)
  for (let off = 0; off + Q <= n; off += Q) {
    k.process([x.subarray(off, off + Q)], [out.subarray(off, off + Q)], Q)
  }
  return { out, kernel: k }
}

/** Mean energy in a band, over frames starting at `skip`. */
function bandEnergy(sig, loHz, hiHz, skip) {
  const NF = 4096
  const fft = getFFT(NF)
  const re = new Float64Array(NF / 2 + 1)
  const im = new Float64Array(NF / 2 + 1)
  const fr = new Float64Array(NF)
  let acc = 0
  let frames = 0
  for (let p = skip; p + NF < sig.length; p += NF) {
    for (let i = 0; i < NF; i++) fr[i] = sig[p + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NF))
    fft.rfft(fr, re, im)
    for (let b = 0; b < re.length; b++) {
      const f = (b * SR) / NF
      if (f >= loHz && f <= hiHz) acc += re[b] * re[b] + im[b] * im[b]
    }
    frames++
  }
  return acc / Math.max(1, frames)
}

const dB = (before, after) => 10 * Math.log10((after + 1e-30) / (before + 1e-30))

test('the shipping frame is the default, and an unrecognised value falls back to it', () => {
  // The rule SoftClipperKernel's `oversample` already follows: a typo gives the
  // shipped path, never a third behaviour.
  assert.equal(resolveResonanceFrameSize(undefined), RESONANCE_FRAME_SIZE)
  assert.equal(resolveResonanceFrameSize(777), RESONANCE_FRAME_SIZE)
  assert.equal(resolveResonanceFrameSize(4096), RESONANCE_FRAME_SIZE)
  assert.equal(resolveResonanceFrameSize(512), 512)

  const k = new ResonanceKernel(SR)
  assert.equal(k.frameSize, RESONANCE_FRAME_SIZE)
  assert.equal(k.hopSize, RESONANCE_FRAME_SIZE / 4)
  assert.equal(k.latencySamples, RESONANCE_FRAME_SIZE)
})

test('asking for the shipping frame is bit-identical to not asking', () => {
  // The whole safety argument for the option. If these ever diverge, every
  // measurement recorded against the shipping patch is measuring something
  // else.
  const x = sibilantVoice(SR * 3)
  const a = render(x, {}).out
  const b = render(x, {}, { frameSize: RESONANCE_FRAME_SIZE }).out
  for (let i = 0; i < x.length; i++) {
    assert.equal(a[i], b[i], `default and explicit 2048 diverged at ${i}`)
  }
})

test('latency is where the audio actually is, not merely what is reported', () => {
  // Measured rather than trusted, for the reason the soft clipper's latency
  // test exists: a getter that disagrees with the signal path shifts every
  // applied region on the timeline, silently and at both boundaries.
  for (const frameSize of [2048, 512, 256]) {
    const n = frameSize * 8
    const x = new Float32Array(n)
    x[frameSize] = 1

    // Zones all off, mix 1: the kernel is a pure delay through its own STFT.
    const zones = DEFAULT_RESONANCE_ZONES.map(z => ({ ...z, enabled: false }))
    const { out, kernel } = render(x, { zones }, { frameSize })

    assert.equal(kernel.latencySamples, frameSize)
    assert.equal(resonanceLatencySamples(frameSize), frameSize)

    let argmax = 0
    for (let i = 1; i < n; i++) if (Math.abs(out[i]) > Math.abs(out[argmax])) argmax = i
    assert.equal(
      argmax - frameSize,
      kernel.latencySamples,
      `frame ${frameSize}: impulse landed ${argmax - frameSize} samples late, getter says ${kernel.latencySamples}`,
    )
  }
})

test('a short frame refuses to track pitch rather than tracking it badly', () => {
  // Autocorrelation cannot see a period longer than half the frame, so a
  // 512-point frame at 44.1 kHz floors at 172 Hz — above most male
  // fundamentals. The failure mode being prevented is not silence: the tracker
  // would lock onto whatever partial fell inside its remaining window, and a
  // harmonic mask built from that comb protects the wrong bins.
  //
  // ⚠ THE CLIFF IS AT THE SHIPPING FRAME, WHICH IS SHARPER THAN IT LOOKS: at
  // 44.1 kHz the floors are 43.1 / 86.1 / 172.3 / 344.5 Hz for 2048 / 1024 /
  // 512 / 256, so ONLY the shipping frame covers the 70 Hz the mask asks for.
  // Halving the frame once already forfeits harmonic protection — there is no
  // middle setting that keeps it and costs less.
  assert.equal(new ResonanceKernel(SR, { frameSize: 2048 }).pitchTrackable, true)
  assert.equal(new ResonanceKernel(SR, { frameSize: 1024 }).pitchTrackable, false)
  assert.equal(new ResonanceKernel(SR, { frameSize: 512 }).pitchTrackable, false)
  assert.equal(new ResonanceKernel(SR, { frameSize: 256 }).pitchTrackable, false)

  // The gate is about the range ASKED for, not the material: a caller that
  // narrows the search to a range the frame does cover gets tracking back.
  const narrowed = new ResonanceKernel(SR, { frameSize: 512 })
  narrowed.setParams({ pitchMinHz: 200, pitchMaxHz: 400 })
  assert.equal(narrowed.pitchTrackable, true, 'a range the frame covers should still be tracked')

  // And it is genuinely skipped, not merely ignored downstream: the tracker
  // never sees a frame, so it can never report a median.
  const x = sibilantVoice(SR * 2)
  const short = render(x, { zones: bandZones(5000, 12000) }, { frameSize: 512 })
  // `median` returns the tracker's seed (null here) until a pitched frame has
  // been recorded, so an empty history is the observable form of "never ran".
  assert.equal(
    short.kernel.f0.median,
    null,
    'the tracker ran on a frame that cannot resolve the range',
  )

  const full = render(x, { zones: bandZones(5000, 12000) }, { frameSize: 2048 })
  assert.ok(full.kernel.f0.median > 0, 'the shipping frame should still track pitch')
})

test('a 512-point frame does the 5-12 kHz job as well as the shipping one', () => {
  // The claim the whole option rests on. If a short frame could not suppress
  // the ring, it would be a cheaper stage that does not work.
  const x = sibilantVoice(SR * 8, 7500)
  const zones = bandZones(5000, 12000)

  const before = {
    ring: bandEnergy(x, 7400, 7600, SR),
    voice: bandEnergy(x, 200, 4000, SR),
    above: bandEnergy(x, 12000, 20000, SR),
  }

  for (const frameSize of [2048, 512]) {
    const { out, kernel } = render(x, { zones }, { frameSize })
    const lat = kernel.latencySamples
    const after = {
      ring: bandEnergy(out, 7400, 7600, SR + lat),
      voice: bandEnergy(out, 200, 4000, SR + lat),
      above: bandEnergy(out, 12000, 20000, SR + lat),
    }
    const ring = dB(before.ring, after.ring)
    const voice = dB(before.voice, after.voice)
    const above = dB(before.above, after.above)

    assert.ok(ring < -12, `frame ${frameSize}: only removed ${ring.toFixed(2)} dB of the ring`)
    assert.ok(Math.abs(voice) < 0.5, `frame ${frameSize}: moved the voice by ${voice.toFixed(2)} dB`)
    assert.ok(Math.abs(above) < 0.5, `frame ${frameSize}: moved 12-20 kHz by ${above.toFixed(2)} dB`)
  }
})

test('processResonanceBuffer carries the frame option and reports its own latency', () => {
  // The offline path needs the instance's figure, not a constant — the trap
  // the soft clipper's apply path already fell into once.
  const x = sibilantVoice(SR)
  const full = processResonanceBuffer([Float32Array.from(x)], SR, {})
  const short = processResonanceBuffer([Float32Array.from(x)], SR, {}, { frameSize: 512 })
  assert.equal(full.latencySamples, RESONANCE_FRAME_SIZE)
  assert.equal(short.latencySamples, 512)
})
