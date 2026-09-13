#!/usr/bin/env node
/**
 * VOCAL CHAIN DYNAMICS — CALIBRATION BENCH.
 *
 *   npm run dynamics:calibrate -- path/to/narration.wav
 *
 * ⚠ THIS EXISTS BECAUSE THE FIRST CALIBRATION WAS DONE ON SYNTHETIC MATERIAL
 * AND REAL NARRATION OVERTURNED IT. The opto was being SEARCHED for the squash
 * that minimised block-level spread; on a synthetic stimulus that curve has a
 * clean minimum, and on 35 s of a real narrator it has none — every setting is
 * worse than not running the stage at all. The synthetic minimum came from an
 * amplitude envelope the generator put there, which is exactly the long-term
 * variation an opto can track and is not what narration's variance looks like.
 *
 * So every number this prints is a claim about REAL AUDIO, and this is how to
 * re-make it. Point it at another voice before treating any of them as settled.
 *
 * What it reports:
 *
 *   1. Where each stage sits, and the ALIGNMENT GAP — the opto's own input is
 *      several dB below the section's, which is why the solve renders the head
 *      stage by stage rather than measuring once at the front.
 *   2. squash -> wet-path gain reduction, the quantity `squash` is calibrated
 *      against. Scheps' calibrated layer depth is peak 7.64 / avg 1.23 dB.
 *   3. Level invariance: the same squash across a gain sweep, aligned and not.
 *      Unaligned, the opto stops working entirely a few dB down.
 *   4. Block-level spread across squash, which is the measurement that killed
 *      the search.
 */

import { readWav } from '../test/voicerx/wav.js'
import { SoftClipperKernel } from '../src/audio/softClipperProcessor.js'
import { FET1176Kernel } from '../src/audio/fet1176Processor.js'
import { LA2AKernel } from '../src/audio/la2aProcessor.js'
import { BiquadCascade } from '../src/audio/dsp/biquad.js'
import {
  clipParamsFor, fetParamsFor, optoParamsFor, pultecPairFor,
} from '../src/audio/dynamicsProcessor.js'
import { inputAlignDbFor } from '../src/audio/dsp/inputAlign.js'
import { measureDynamics, levelSpreadDb, VOICINGS } from '../src/audio/dynamicsSolve.js'

const file = process.argv[2]
if (!file) {
  console.error('usage: npm run dynamics:calibrate -- path/to/narration.wav')
  process.exit(1)
}
const CLIP_DB = Number(process.argv[3] ?? -9)

const wav = readWav(file)
const SR = wav.sampleRate
const input = [wav.mono]

/**
 * ⚠ RENDERED WITHOUT OVERSAMPLING, matching what the solve itself does — every
 * solved value is identical with it on or off and the render is 3.2x cheaper.
 * See SOLVE_RENDER in dynamicsSolve.js.
 */
const OFF = { oversample: false }

function run(kernel, channels) {
  const out = channels.map(c => new Float32Array(c.length))
  for (let i = 0; i < channels[0].length; i += 128) {
    const n = Math.min(128, channels[0].length - i)
    kernel.process(
      channels.map(c => c.subarray(i, i + n)),
      out.map(c => c.subarray(i, i + n)),
      n,
    )
  }
  return out
}

/** The section's head, stage by stage, with each stage aligned at its own input. */
function head(channels, { align = true } = {}) {
  const clip = new SoftClipperKernel(SR)
  clip.setParams({ ...clipParamsFor({ clipThresholdDb: CLIP_DB }), ...OFF })
  const clipped = run(clip, channels)

  const fetAlignDb = align ? inputAlignDbFor(clipped, SR) : 0
  const fet = new FET1176Kernel(SR)
  fet.setParams({ ...fetParamsFor({ fetDrive: 50, fetAlignDb }), ...OFF })
  const dry = run(fet, clipped)

  const optoAlignDb = align ? inputAlignDbFor(dry, SR) : 0
  return { clipped, dry, fetAlignDb, optoAlignDb }
}

/** Pultec pre -> opto -> Pultec post at one squash, returning its metering. */
function wetPath(dry, squash, optoAlignDb) {
  const { pre, post } = pultecPairFor({ character: 'thick' }, SR)
  const a = new BiquadCascade(pre.length, dry.length)
  a.setSections(pre)
  const wet = dry.map((c, ch) => {
    const y = new Float32Array(c.length)
    a.process(c, y, c.length, ch)
    return y
  })
  const opto = new LA2AKernel(SR)
  opto.setParams({ ...optoParamsFor({ squash, optoAlignDb }), ...OFF })
  const out = run(opto, wet)
  const b = new BiquadCascade(post.length, dry.length)
  b.setSections(post)
  out.forEach((c, ch) => b.process(c, c, c.length, ch))
  return { out, metering: opto.getMetering() }
}

const scaled = (channels, db) => {
  const g = Math.pow(10, db / 20)
  return channels.map((c) => {
    const y = new Float32Array(c.length)
    for (let i = 0; i < c.length; i++) y[i] = Math.fround(c[i] * g)
    return y
  })
}
const f = (v, w = 6) => v.toFixed(2).padStart(w)

console.log(`\n${file.split('/').pop()}  ${SR} Hz  ${(wav.mono.length / SR).toFixed(1)} s  `
  + `clip threshold ${CLIP_DB} dBFS`)
if (SR !== 44100) {
  console.log(`⚠ NOT 44.1 kHz. The product resamples everything to 44.1 before processing,\n`
    + `  so a calibration taken here is one sample rate away from what ships.`)
}

// ── 1. Where each stage sits ────────────────────────────────────────────────
console.log('\n── where each stage sits ───────────────────────────────────────────')
const { clipped, dry, fetAlignDb, optoAlignDb } = head(input)
const sectionAlign = inputAlignDbFor(input, SR)
for (const [label, sig] of [['input', input], ['after clip', clipped], ['after FET', dry]]) {
  const m = measureDynamics(sig, SR)
  console.log(`  ${label.padEnd(11)} peak ${f(m.peakDb)}  body ${f(m.gatedDb)}  `
    + `crest ${f(m.crestDb)}  impact ${f(m.impactDb)}  spread ${m.spreadDb.toFixed(3)}`)
}
console.log(`  alignment   section ${f(sectionAlign)}   FET ${f(fetAlignDb)}   `
  + `opto ${f(optoAlignDb)}   GAP ${f(optoAlignDb - sectionAlign)} dB`)

// ── 2. squash -> gain reduction ─────────────────────────────────────────────
console.log('\n── squash -> wet-path gain reduction (Scheps anchor: peak 7.64 / avg 1.23) ──')
console.log('  squash   GRpeak   GRavg   spread')
let closest = { squash: null, err: Infinity }
for (let sq = 20; sq <= 50; sq += 2) {
  const { out, metering } = wetPath(dry, sq, optoAlignDb)
  const err = Math.abs(metering.maxGainReductionDb - 7.64)
  if (err < closest.err) closest = { squash: sq, err }
  console.log(`   ${String(sq).padStart(3)}     ${f(metering.maxGainReductionDb, 5)}   `
    + `${f(metering.avgGainReductionDb, 5)}   ${levelSpreadDb(out, SR).toFixed(3)}`)
}
console.log(`  -> closest to the anchor: squash ${closest.squash}  `
  + `(shipping default ${VOICINGS.audiobook.squash} for audiobook)`)

// ── 3. Level invariance ─────────────────────────────────────────────────────
const SQ = VOICINGS.audiobook.squash
console.log(`\n── level invariance at squash ${SQ} ─────────────────────────────────`)
console.log('  inputGain   optoAlign   GRpeak   GRavg  |  UNALIGNED GRpeak   GRavg')
for (const db of [6, 0, -6, -12, -20, -30]) {
  const x = scaled(input, db)
  const on = head(x)
  const onM = wetPath(on.dry, SQ, on.optoAlignDb).metering
  const off = head(x, { align: false })
  const offM = wetPath(off.dry, SQ, 0).metering
  console.log(`   ${String(db).padStart(4)} dB     ${f(on.optoAlignDb)}     ${f(onM.maxGainReductionDb, 5)}  `
    + `${f(onM.avgGainReductionDb, 5)}  |     ${f(offM.maxGainReductionDb, 5)}   ${f(offM.avgGainReductionDb, 5)}`)
}
console.log('\n  ⚠ The unaligned column IS the feature. Without the offset the opto stops')
console.log('    working a few dB below nominal, and a saved patch means nothing.')
console.log(`  ⚠ Alignment saturates at ALIGN_MAX_DB (36), so a file far enough down`)
console.log('    runs out of travel again — visible as the bottom row falling away.\n')
