/**
 * Run with:  npm test
 *
 * VoxPressor stage 1 — the voice detector and the Peaks (1176) → Body (LA-2A)
 * core. Pins what the plugin adds beyond the two kernels it holds: the
 * sidechain hook that feeds them the detector, the bypasses that keep the
 * latency constant, the detector's shape, and the per-file solves that give
 * Peaks and Body their meaning.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { narration } from '../helpers/narration.js'
import { LA2AKernel } from '../../src/audio/la2aProcessor.js'
import { FET1176Kernel } from '../../src/audio/fet1176Processor.js'
import {
  processVoxPressorBuffer, VOX_KERNEL_DEFAULTS,
} from '../../src/audio/voxPressorProcessor.js'
import {
  voiceDetectorSections, PLOSIVE_SHELF_DB, SIBILANCE_SHELF_DB,
} from '../../src/audio/dsp/voiceDetector.js'
import { solveVoxPressor, PEAKS_FLOOR_DB } from '../../src/audio/voxPressorSolve.js'
import { magnitudeResponseDb } from '../../src/audio/dsp/biquad.js'
import { gatedRmsOfChannels } from '../../src/audio/dsp/inputAlign.js'
import { OVERSAMPLE_LATENCY_SAMPLES } from '../../src/audio/dsp/oversample.js'

const SR = 44100
const db = v => 20 * Math.log10(v)

function peak(x) {
  let p = 0
  for (const v of x) p = Math.max(p, Math.abs(v))
  return p
}

function runKernel(kernel, x, sidechain) {
  const out = new Float32Array(x.length)
  for (let o = 0; o < x.length; o += 128) {
    const n = Math.min(128, x.length - o)
    kernel.process([x.subarray(o, o + n)], [out.subarray(o, o + n)], n,
      sidechain ? sidechain.subarray(o, o + n) : undefined)
  }
  return out
}

const speech = narration(SR, { seconds: 12, levelDb: -24 })

test('LA-2A: a sidechain equal to its own mono tap renders bit-identically', () => {
  const a = new LA2AKernel(SR)
  const b = new LA2AKernel(SR)
  a.setParams({ inputAlignDb: 8 })
  b.setParams({ inputAlignDb: 8 })
  const plain = runKernel(a, speech)
  const fed = runKernel(b, speech, speech)
  assert.deepEqual(fed, plain)
})

test('1176: a sidechain equal to its own mono tap renders bit-identically', () => {
  const a = new FET1176Kernel(SR)
  const b = new FET1176Kernel(SR)
  a.setParams({ ratio: '12', inputAlignDb: 6 })
  b.setParams({ ratio: '12', inputAlignDb: 6 })
  const plain = runKernel(a, speech)
  const fed = runKernel(b, speech, speech)
  assert.deepEqual(fed, plain)
})

test('a sidechain moves the gain, never the audio path', () => {
  // A silent detector means no reduction: the LA-2A then renders exactly what
  // it renders on input too quiet to reach its threshold.
  const quiet = new LA2AKernel(SR)
  quiet.setParams({ inputAlignDb: -60 })
  const silentSc = new LA2AKernel(SR)
  silentSc.setParams({ inputAlignDb: 8 })
  const ref = runKernel(quiet, speech)
  const out = runKernel(silentSc, speech, new Float32Array(speech.length))
  assert.deepEqual(out, ref)
})

test('both stages off is a pure delay of the constant latency, bit for bit', () => {
  const { channelData, latencySamples } = processVoxPressorBuffer([speech], SR, {
    peaksOn: false, bodyOn: false,
  })
  assert.equal(latencySamples, 2 * OVERSAMPLE_LATENCY_SAMPLES)
  const y = channelData[0]
  for (let i = latencySamples; i < y.length; i++) {
    if (y[i] !== speech[i - latencySamples]) assert.fail(`sample ${i} differs`)
  }
})

test('the latency does not move when a stage is switched', () => {
  const lat = (p) => processVoxPressorBuffer([speech.subarray(0, 4096)], SR, p).latencySamples
  const all = lat({})
  assert.equal(lat({ peaksOn: false }), all)
  assert.equal(lat({ bodyOn: false }), all)
  assert.equal(lat({ peaksOn: false, bodyOn: false }), all)
})

test('stereo: an identical pair renders identically on both sides', () => {
  const x = speech.subarray(0, SR * 3)
  const { channelData } = processVoxPressorBuffer([x, x.slice()], SR, { peaksAlignDb: -6, bodyAlignDb: 8 })
  assert.deepEqual(channelData[1], channelData[0])
})

test('detector shape: the Body tap ducks plosives and sibilance, the Peaks tap only sibilance', () => {
  const body = voiceDetectorSections(SR, { cornerHz: 70, plosive: true })
  const peaks = voiceDetectorSections(SR, { cornerHz: 70, plosive: false })
  const f = [40, 100, 1000, 12000]
  const b = magnitudeResponseDb(body, f, SR)
  const p = magnitudeResponseDb(peaks, f, SR)
  // Below the corner: rolled off on both.
  assert.ok(b[0] < -6 && p[0] < -6)
  // A plosive's band: the Body tap sits well under the Peaks tap.
  assert.ok(p[1] - b[1] > 6, `100 Hz: peaks ${p[1].toFixed(2)} vs body ${b[1].toFixed(2)}`)
  assert.ok(p[1] > -3, 'the Peaks tap keeps a plosive audible to the 1176')
  // Vowels: untouched on both.
  assert.ok(Math.abs(b[2]) < 1 && Math.abs(p[2]) < 1)
  // Sibilance: the full shelf on both.
  assert.ok(Math.abs(b[3] - SIBILANCE_SHELF_DB) < 1 && Math.abs(p[3] - SIBILANCE_SHELF_DB) < 1)
  assert.ok(PLOSIVE_SHELF_DB < 0)
})

/**
 * Six words, each opened by a "p": a 120 ms puff of low-passed noise (two
 * one-poles at 250 Hz), the broadband wind a plosive puts on a mic.
 */
function puffedPhrase(puffs, amp = 6) {
  let s = 7
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  const n = 4 * SR
  const x = new Float32Array(n)
  const c = 1 - Math.exp(-2 * Math.PI * 250 / SR)
  for (let w = 0; w < 6; w++) {
    const st = Math.round((0.5 + w * 0.6) * SR)
    for (let i = 0; i < 0.45 * SR; i++) {
      const t = i / SR
      let v = 0
      for (let k = 1; k <= 30; k++) {
        const f = k * 120
        v += Math.sin(2 * Math.PI * f * t + k) / (1 + ((f - 600) / 400) ** 2)
      }
      x[st + i] = 0.05 * v * Math.min(1, t / 0.02) * Math.exp(-2 * t)
    }
    let lp1 = 0
    let lp2 = 0
    for (let i = 0; i < 0.12 * SR; i++) {
      // Drawn whether or not it is rendered, so both variants share the voice.
      lp1 += (rnd() * 2 - 1 - lp1) * c
      lp2 += (lp1 - lp2) * c
      if (puffs) x[st - Math.round(0.03 * SR) + i] += amp * 0.4 * lp2 * Math.exp(-(i / SR) / 0.04)
    }
  }
  return x
}

test('plosives push the Body stage less than they push a plain LA-2A', () => {
  // ⚠ A MODEST CLAIM, AND THAT IS THE MEASUREMENT. The LA-2A kernel already
  // high-passes its own side-chain at 80 Hz and its detector is slow, so on
  // synthetic plosives even the plain compressor gains well under 1 dB of
  // average reduction from them (0.65 here, at 18 dB of drive offset). The
  // detector's shelf takes a third or more of that away. Whether real
  // plosives are worse than synthetic ones is for real recordings to say.
  const avg = (g) => g.reduce((a, b) => a + b, 0) / g.length
  const vox = x => avg(processVoxPressorBuffer([x], SR, {
    peaksOn: false, bodyAlignDb: 18, oversample: false,
  }, { meter: true }).bodyGr)
  const plain = (x) => {
    const k = new LA2AKernel(SR)
    k.setParams({ inputAlignDb: 18, oversample: false })
    const gr = []
    const out = new Float32Array(128)
    for (let o = 0; o + 128 <= x.length; o += 128) {
      k.process([x.subarray(o, o + 128)], [out], 128)
      gr.push(k.grDb)
    }
    return avg(gr)
  }
  const clean = puffedPhrase(false)
  const popped = puffedPhrase(true)
  const voxExtra = vox(popped) - vox(clean)
  const plainExtra = plain(popped) - plain(clean)
  assert.ok(voxExtra < 1, `VoxPressor Body: +${voxExtra.toFixed(2)} dB from plosives`)
  assert.ok(voxExtra < 0.8 * plainExtra,
    `VoxPressor +${voxExtra.toFixed(2)} dB against a plain LA-2A's +${plainExtra.toFixed(2)}`)
})

test('listen plays a detector instead of the output', () => {
  const x = speech.subarray(0, SR)
  const out = processVoxPressorBuffer([x], SR, { listen: 'body', oversample: false }).channelData[0]
  const normal = processVoxPressorBuffer([x], SR, { oversample: false }).channelData[0]
  assert.notDeepEqual(out, normal)
  // A plosive-ducked, sibilance-shelved copy of the voice: quieter, not silent.
  assert.ok(peak(out) > 0 && peak(out) < peak(x) * 1.5)
})

// ── Solves ──────────────────────────────────────────────────────────────────

const LEVELS = [-34, -24, -14]
const solved = LEVELS.map((levelDb) => {
  const x = narration(SR, { seconds: 12, levelDb })
  return { levelDb, x, r: solveVoxPressor([x], SR, { peaksDb: 3, bodyDb: 4, wholeRegion: true, cornerHz: 70 }) }
})

test('Peaks and Body land on their targets', () => {
  for (const { levelDb, r } of solved) {
    assert.ok(Math.abs(r.peaksDb - 3) <= 0.1, `${levelDb}: peaks ${r.peaksDb.toFixed(3)}`)
    assert.ok(Math.abs(r.bodyDb - 4) <= 0.1, `${levelDb}: body ${r.bodyDb.toFixed(3)}`)
    assert.equal(r.peaksLimited, false)
  }
})

test('the solves are level-invariant: offsets track the file, results do not', () => {
  const [a, b, c] = solved.map(s => s.r)
  for (const [lo, hi] of [[a, b], [b, c]]) {
    assert.ok(Math.abs((lo.peaksAlignDb - hi.peaksAlignDb) - 10) < 0.2, 'peaks offset follows level')
    assert.ok(Math.abs((lo.bodyAlignDb - hi.bodyAlignDb) - 10) < 0.3, 'body offset follows level')
    assert.ok(Math.abs(lo.makeupDb - hi.makeupDb) < 0.15, 'makeup does not depend on level')
  }
})

test('at Peaks 3 the 1176 leaves the body alone', () => {
  for (const { levelDb, r } of solved) {
    assert.ok(r.peaksBodyDb < 0.5, `${levelDb}: body touched ${r.peaksBodyDb.toFixed(2)} dB`)
  }
})

test('a target past the floor stops at the floor and says so', () => {
  const { x } = solved[1]
  const r = solveVoxPressor([x], SR, { peaksDb: 10, bodyDb: 0, cornerHz: 70 })
  assert.equal(r.peaksLimited, true)
  assert.ok(r.peaksDb < 10)
  assert.ok(r.peaksBodyDb < 1, `body touched ${r.peaksBodyDb.toFixed(2)} dB at the floor`)
  assert.ok(PEAKS_FLOOR_DB > 0)
})

test('makeup is level-matched and the ceiling holds the source peak', () => {
  for (const { levelDb, x, r } of solved) {
    const params = { ...VOX_KERNEL_DEFAULTS, ...r, cornerHz: 70 }
    // Base rate for the level: latency-free and what the solve measured.
    const base = processVoxPressorBuffer([x], SR, { ...params, oversample: false }).channelData
    const inDb = db(gatedRmsOfChannels([x], SR))
    const outDb = db(gatedRmsOfChannels(base, SR))
    assert.ok(Math.abs(outDb - inDb) < 0.3, `${levelDb}: gated level ${inDb.toFixed(2)} → ${outDb.toFixed(2)}`)
    // The rendered (oversampled) path for the guarantee.
    const out = processVoxPressorBuffer([x], SR, params).channelData[0]
    assert.ok(peak(out) <= peak(x), `${levelDb}: peak ${db(peak(x)).toFixed(3)} → ${db(peak(out)).toFixed(3)}`)
  }
})

test('zero targets switch the stages off', () => {
  const r = solveVoxPressor([speech], SR, { peaksDb: 0, bodyDb: 0, cornerHz: 70 })
  assert.equal(r.peaksOn, false)
  assert.equal(r.bodyOn, false)
  assert.ok(Math.abs(r.makeupDb) < 1e-9)
})
