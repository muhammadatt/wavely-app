import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SOFT_CLIPPER_DEFAULTS, toKernelParams } from '../../src/audio/effects/softClipperParams.js'
import { measureSpeechLevelDb } from '../../src/audio/staticThreshold.js'
import { processSoftClipperBuffer } from '../../src/audio/softClipperProcessor.js'

/**
 * The static-threshold wiring, tested where it can actually break.
 *
 * Every failure this guards against is SILENT: the kernel falls back to the
 * adaptive tracker whenever `staticSpeechLevelDb` is not finite, which is
 * correct as a safety net and indistinguishable from working if a link in the
 * chain drops the value. The composable and the panel are Vue and out of this
 * suite's reach (see the test-infrastructure note in CLAUDE.md), so the links
 * that CAN be reached are checked directly and the rest are checked as source
 * invariants — a blunt instrument, but it fails when someone deletes the line.
 */

const SR = 48000

/**
 * Narration-shaped probe: syllable bodies well below the peak, plus occasional
 * plosive transients that reach it.
 *
 * ⚠ WHAT MATTERS IS THE GAP BETWEEN THE TRACKED SPEECH LEVEL AND THE PEAK, and
 * two earlier probes had none. The threshold sits Headroom dB above a
 * peak-referenced tracker, so a probe whose syllables are all similar puts the
 * tracked level within a few dB of its own peak and NOTHING reaches the
 * threshold at any Headroom the panel offers (4-16). Measured: even syllables
 * gave a 0.58 dB gap and 0.000 dB of reduction at Headroom 7/4/2; borrowing
 * `variedSpeech`'s 12-20 dB amplitude spread only reached 3.2-4.2 dB and was
 * still inert at 7 and 5. Adding plosives takes it to 8.9 dB, against 12.4 /
 * 8.5 / 4.4 on the three real narrators, and the stage finally engages.
 *
 * The same property explains why `art` behaves unlike the other two real files
 * throughout this work: hard-mastered, it has only 4.4 dB there, so a static
 * threshold at the shipped Headroom barely touches it either.
 *
 * Fifteenth time synthetic material has been too clean to answer the question
 * asked of it — and the first where the fix was a missing SIGNAL FEATURE
 * rather than a missing amount of variation.
 */
function narration(seconds, peakDb, seed = 11) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const peakAmp = Math.pow(10, peakDb / 20)
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const burstN = Math.round(0.012 * SR)
  let i = 0
  let syl = 0
  while (i < n) {
    const sylN = Math.round((0.08 + rnd() * 0.14) * SR)
    const gapN = Math.round((0.02 + rnd() * 0.06) * SR)
    const amp = peakAmp * Math.pow(10, (-16 + 8 * rnd()) / 20)
    const f0 = 100 + rnd() * 60
    const plosive = syl++ % 5 === 0
    for (let j = 0; j < sylN && i < n; j++, i++) {
      const env = Math.sin((Math.PI * j) / sylN) ** 1.5
      const t = i / SR
      let v = (amp * env * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t)
        + 0.33 * Math.sin(6 * Math.PI * f0 * t) + 0.25 * Math.sin(8 * Math.PI * f0 * t))) / 2.08
      if (plosive && j < burstN) {
        const pe = 1 - j / burstN
        v += peakAmp * 0.95 * pe * pe * Math.sin((2 * Math.PI * 95 * j) / SR)
      }
      out[i] = v
    }
    for (let j = 0; j < gapN && i < n; j++, i++) out[i] = peakAmp * 0.002 * (rnd() - 0.5)
  }
  return out
}

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

test('the worker exposes the measurement and hands back the level', () => {
  const src = read('../../src/workers/processWorker.js')
  assert.match(src, /measureSpeechLevelDb/, 'worker must import the measurement')
  assert.match(src, /case 'softClipperSpeechLevel'/, 'worker must handle the message type')
  assert.match(src, /speechLevelDb: measureSpeechLevelDb\(/, 'worker must post the level back')
})

test('processing sends the matching message type', () => {
  // A typo here does not throw — the worker answers with an "Unknown operation"
  // error, the composable logs it, and the mode quietly runs adaptive forever.
  const src = read('../../src/audio/processing.js')
  assert.match(src, /measureInWorker\('softClipperSpeechLevel'/)
  assert.match(src, /export function computeSoftClipperSpeechLevel/)
})

test('the composable puts the measured level into the params both paths use', () => {
  // currentParams() feeds the live chain AND applySoftClipperRegion. If the key
  // is missing from it, static mode renders adaptive on apply while the preview
  // sounded right — the exact preview/apply divergence this design avoids.
  const src = read('../../src/composables/useSoftClipper.js')
  assert.match(src, /staticSpeechLevelDb: speechLevelDb\.value/)
  assert.match(src, /computeSoftClipperSpeechLevel/)
})

test('apply re-measures when the measurement belongs to another region', () => {
  // Moving the selection leaves the old region's level in place on purpose (so
  // the preview does not audibly drop to adaptive on every nudge), which makes
  // the staleness check at apply the only thing standing between the user and
  // a threshold measured somewhere else.
  const src = read('../../src/composables/useSoftClipper.js')
  assert.match(src, /speechLevelRegion/, 'the measured region must be tracked')
  assert.match(src, /speechLevelRegion\.start !== start/)
  assert.match(src, /speechLevelRegion\.end !== end/)
})

test('teardown cancels a pending measurement', () => {
  const src = read('../../src/composables/useSoftClipper.js')
  const teardown = src.slice(src.indexOf('function teardown()'))
  assert.match(teardown.slice(0, 500), /clearTimeout\(speechTimer\)/)
})

test('the panel offers STATIC and says when there is no measurement', () => {
  const src = read('../../src/components/panels/SoftClipperModal.vue')
  assert.match(src, /value: 'static'/, 'the mode must be reachable from the panel')
  assert.match(src, /MODE_CAPTION[\s\S]{0,120}static:/)
  assert.match(src, /using ADAPTIVE/, 'a missing measurement must be stated, not implied')
  assert.match(src, /watch\(\(\) => state\.selection/, 're-measure when the region changes')
})

test('end to end: the measured level reaches the kernel and moves the threshold', () => {
  // The whole chain in miniature — measure, hand over, render — against the
  // same call the apply path makes.
  const sig = narration(10, -1)
  const level = measureSpeechLevelDb([sig], SR)
  assert.ok(Number.isFinite(level))

  const params = toKernelParams({
    ...SOFT_CLIPPER_DEFAULTS,
    // Inside the panel's range, and deep enough that the curve does real work
    // on this probe — at the shipped 7 it reaches only 0.1 dB here.
    headroomDb: 5,
    thresholdMode: 'static',
    staticSpeechLevelDb: level,
  })
  assert.equal(params.staticSpeechLevelDb, level)

  const statRender = processSoftClipperBuffer([sig], SR, params)
  const adaptRender = processSoftClipperBuffer([sig], SR, { ...params, thresholdMode: 'adaptive' })
  // Without this the comparison below passes on a probe the stage never
  // touches — see the note on the probe.
  assert.ok(statRender.metering.maxReductionDb > 0.2,
    `the stage must actually engage; it reduced ${statRender.metering.maxReductionDb.toFixed(3)} dB`)
  const stat = statRender.channelData[0]
  const adapt = adaptRender.channelData[0]
  let differs = false
  for (let i = 0; i < stat.length; i++) if (stat[i] !== adapt[i]) { differs = true; break }
  assert.ok(differs, 'static and adaptive should not render identically on real material')

  // And dropping the value anywhere in the chain degrades to adaptive — the
  // silent failure, made visible here.
  const dropped = processSoftClipperBuffer([sig], SR, { ...params, staticSpeechLevelDb: null }).channelData[0]
  for (let i = 0; i < dropped.length; i++) assert.equal(dropped[i], adapt[i])
})
