import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { SOFT_CLIPPER_DEFAULTS, toKernelParams } from '../../src/audio/effects/softClipperParams.js'
import { SOFT_CLIPPER_KERNEL_DEFAULTS, processSoftClipperBuffer } from '../../src/audio/softClipperProcessor.js'
import { CEILING_PRESETS, measurePeakCeilingDb } from '../../src/audio/ceilingPresets.js'

/**
 * The ceiling-preset wiring, tested where it can break.
 *
 * The composable and the panel are Vue and out of this suite's reach (see the
 * test-infrastructure note in CLAUDE.md), so the links that CAN be reached are
 * exercised directly and the rest are checked as source invariants — blunt, but
 * it fails when someone deletes the line.
 */

const SR = 48000
/**
 * Broadband sibilance between the low-frequency peaks.
 *
 * ⚠ WITHOUT THIS THE EMPHASIS TEST BELOW GUARDS NOTHING. The lift compensation
 * raises the threshold by the HF boost measured at loud moments, so a probe
 * with no sibilance produces a lift of 0.05 dB and emphasis 7 looks harmless
 * (0.10 dB of escape). Real speech has fricatives between its plosives: add
 * them and the same setting lets peaks escape by 6.00 dB, which is what the
 * reported tutorial file does. Sixteenth time synthetic material has been too
 * clean, and the missing ingredient was HF CONTENT BETWEEN the peaks rather
 * than anything about the peaks themselves.
 */
function withSibilance(x, levelDb, seed = 7) {
  const y = Float32Array.from(x)
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const amp = Math.pow(10, levelDb / 20)
  let lp = 0
  for (let i = 0; i < y.length; i++) {
    const noise = rnd() * 2 - 1
    lp = 0.85 * lp + 0.15 * noise
    if (Math.abs(x[i]) > 0.02) y[i] += amp * (noise - lp)
  }
  return y
}

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

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

test('the worker measures the ceiling at the requested percentile', () => {
  const src = read('../../src/workers/processWorker.js')
  assert.match(src, /measurePeakCeilingDb/, 'worker must import the measurement')
  assert.match(src, /case 'softClipperCeiling'/)
  // ⚠ The percentile has to reach it. Dropping `params` here makes every preset
  // return the same ceiling and the whole ladder collapses to one button.
  assert.match(src, /measurePeakCeilingDb\(channelData, sampleRate, params\.percentile\)/)
})

test('processing sends the matching type and forwards the percentile', () => {
  const src = read('../../src/audio/processing.js')
  assert.match(src, /measureInWorker\('softClipperCeiling', segments, start, end, \{ percentile \}/)
  assert.match(src, /export function computeSoftClipperCeiling/)
})

test('a preset writes the ceiling, and turning the knob drops the preset', () => {
  const src = read('../../src/composables/useSoftClipper.js')
  assert.match(src, /fixedThresholdDb\.value = measured/, 'the preset must set the ceiling')
  assert.match(src, /ceilingPreset\.value = preset\.id/)
  // The lamp must go out when the value stops being the preset's.
  const sync = src.slice(src.indexOf('const syncFixedThreshold'))
  assert.match(sync.slice(0, 300), /ceilingPreset\.value = null/)
})

test('a null measurement leaves the ceiling where it is', () => {
  // Moving the knob to some fallback would be worse than not moving it: the
  // user asked for a value derived from this material and there isn't one.
  const src = read('../../src/composables/useSoftClipper.js')
  const fn = src.slice(src.indexOf('async function applyCeilingPreset'))
  assert.match(fn.slice(0, 1200), /if \(measured === null\) return/)
})

test('a region change never re-measures over a hand-set ceiling', () => {
  // Once the ceiling is hand-set it is the user's number; re-measuring on a
  // selection change would overwrite a deliberate choice. `userSetCeiling` is
  // the flag that records that, so the guard has to consult it.
  //
  // ⚠ IT IS NOT SIMPLY "ONLY WHILE A PRESET IS ACTIVE" ANY MORE, and it could
  // not stay that way: the panel's open-time measurement needs a region, the
  // presets are disabled until there is one, and with the old guard a user who
  // opened the panel before selecting got no measurement at all — the ceiling
  // sat at the kernel's arbitrary -10 dBFS until they clicked a button they
  // had no reason to think was waiting for them. The first selection is the
  // moment that measurement becomes possible, so it runs then.
  //
  // ⚠ THE PRESETS ARE SETTERS NOW, so there is no "active preset" to re-run.
  // What follows the region are the LABELS — what each button would write here
  // — and the value follows only while it is still the panel's to place.
  const src = read('../../src/composables/useSoftClipper.js')
  const fn = src.slice(src.indexOf('function scheduleCeilingPreset'))
  const body = fn.slice(0, 700)
  assert.match(body, /userSetCeiling/,
    'a hand-set ceiling can be overwritten by a selection change')
  assert.match(body, /DEFAULT_CEILING_PRESET/,
    'the first selection does not place the opening measurement')
  assert.match(body, /measureCeilingChoices/,
    'the button labels do not follow the region — they would promise stale numbers')
})

test('a setter writes the number its button is printing', () => {
  // ⚠ THE WORST OF THE THREE STATES would be a button that writes something
  // other than what it says. `setCeilingFromPreset` therefore uses the ALREADY
  // MEASURED value rather than measuring again on click: a fresh measurement
  // could land elsewhere if the region moved between the label and the press.
  const src = read('../../src/composables/useSoftClipper.js')
  const fn = src.slice(src.indexOf('function setCeilingFromPreset'), src.indexOf('function setCeilingFromPreset') + 500)
  assert.match(fn, /ceilingChoices\.value\[id\]/,
    'the setter re-measures instead of writing the number it displayed')
  assert.doesNotMatch(fn, /computeSoftClipperCeiling/)
  // And it marks the value as the user's, because a setter hands ownership over
  // rather than keeping a claim on it.
  assert.match(fn, /userSetCeiling = true/)
})

test('teardown cancels a pending measurement', () => {
  const src = read('../../src/composables/useSoftClipper.js')
  const teardown = src.slice(src.indexOf('function teardown()'))
  assert.match(teardown.slice(0, 600), /clearTimeout\(ceilingTimer\)/)
})

test('the panel is fixed-only and offers the presets', () => {
  const src = read('../../src/components/panels/SoftClipperModal.vue')
  assert.doesNotMatch(src, /MODE_OPTIONS/, 'the threshold mode switch must be gone')
  assert.doesNotMatch(src, /setThresholdMode/, 'the panel must not set the mode any more')
  assert.match(src, /v-for="p in ceilingSetters"/, 'the ceiling setters must be reachable')
  assert.match(src, /setCeilingFromPreset\(p\.id\)/)
  assert.match(src, /watch\(\(\) => state\.selection/, 're-measure when the region changes')
  // ⚠ THE CAPTION REPORTS THE CURRENT SETTING, NOT A PREVIEW. It names the
  // preset the ceiling is sitting on and prints its dBFS, and reads empty the
  // rest of the time.
  //
  // Two earlier states were removed on purpose — a hover preview, and the
  // disabled reason — because both put text under the bank that was about
  // something other than the current setting, so the line changed identity as
  // the pointer moved. What must not regress is that it stays DERIVED: driven
  // by `active`, which is itself a live comparison against the ceiling, so it
  // goes out by itself rather than needing to be cleared.
  assert.match(src, /const setterCaption = computed/, 'the setter caption is gone')
  assert.match(src, /find\(x => x\.active && x\.ready\)/,
    'the caption is no longer driven by which setter the ceiling is sitting on')
  assert.match(src, /\$\{active\.db\}/, 'the caption no longer prints the value')
  assert.doesNotMatch(src, /hoveredSetterId/,
    'the hover preview is back — the line changes identity under the pointer again')
  assert.doesNotMatch(src, /ceilingPreset ===/,
    "a latching preset lamp is back — the value belongs to the knob, not a button")

  const composable = read('../../src/composables/useSoftClipper.js')
  assert.match(composable, /const thresholdMode = ref\('fixed'\)/,
    'the panel state must default to a fixed ceiling regardless of the kernel default')
})

test('static mode is gone from the kernel and the param contract', () => {
  // It was superseded by a ceiling the user can read and turn. Two
  // parameterisations of one motionless threshold is the duplication this
  // codebase keeps learning not to ship.
  assert.ok(!('staticSpeechLevelDb' in SOFT_CLIPPER_KERNEL_DEFAULTS))
  assert.ok(!('staticSpeechLevelDb' in toKernelParams(SOFT_CLIPPER_DEFAULTS)))
  const kernel = read('../../src/audio/softClipperProcessor.js')
  assert.doesNotMatch(kernel, /staticMode/)
})

test('THE CEILING MEANS WHAT IT SAYS — the output peak lands on it', () => {
  // The panel's whole contract, and the thing two reported bugs turned out to
  // be: "almost no lowering of the loudest peaks even on HARD or SQUASH", and
  // "dragging the threshold into the waveform doesn't match the reduction that
  // occurs". Both were emphasisDb.
  //
  // ⚠ WHY IT CANNOT BE COMPENSATED AWAY. The curve compares the PRE-EMPHASISED
  // signal against the threshold, so where a sample crosses depends on its own
  // HF content. A file whose loudest peaks are low-frequency has them pushed
  // further below a threshold raised on account of its sibilants — measured on
  // a real tutorial recording, SQUASH delivered 0.000 dB of peak reduction at
  // emphasis 7 and 4.027 dB at emphasis 0.
  const sig = withSibilance(narration(10, -1), -14)
  const escape = (ceilingDb, over = {}) => {
    const params = toKernelParams({
      ...SOFT_CLIPPER_DEFAULTS,
      thresholdMode: 'fixed',
      fixedThresholdDb: ceilingDb,
    })
    const r = processSoftClipperBuffer([sig], SR, { ...params, ...over })
    const y = r.channelData[0].subarray(r.latencySamples)
    let out = 0
    for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > out) out = Math.abs(y[i])
    return 20 * Math.log10(out) - ceilingDb
  }

  for (const preset of CEILING_PRESETS) {
    const ceilingDb = measurePeakCeilingDb([sig], SR, preset.percentile)
    assert.ok(escape(ceilingDb) < 1.0,
      `${preset.id}: peaks escaped ${escape(ceilingDb).toFixed(3)} dB above the ceiling`)
    // And the mutation this exists to catch: restoring a non-zero emphasis must
    // visibly break the promise, or the assertion above is passing for the
    // wrong reason.
    assert.ok(escape(ceilingDb, { emphasisDb: 7 }) > 3,
      `${preset.id}: emphasis 7 should break the ceiling and did not — the probe is too clean`)
  }
})

test('the shipped emphasis is zero, because a ceiling in dBFS requires it', () => {
  assert.equal(SOFT_CLIPPER_KERNEL_DEFAULTS.emphasisDb, 0)
})

test('end to end: measure, set the ceiling, and the curve does more at each step', () => {
  const sig = narration(10, -1)
  let last = Infinity
  for (const preset of CEILING_PRESETS) {
    const ceilingDb = measurePeakCeilingDb([sig], SR, preset.percentile)
    assert.ok(Number.isFinite(ceilingDb))

    const params = toKernelParams({
      ...SOFT_CLIPPER_DEFAULTS,
      thresholdMode: 'fixed',
      fixedThresholdDb: ceilingDb,
    })
    assert.equal(params.fixedThresholdDb, ceilingDb)

    const { metering } = processSoftClipperBuffer([sig], SR, params)
    // Each step down the ladder must touch more of the file than the last —
    // that is the only thing the labels promise.
    assert.ok(metering.engagedFraction > 0 || preset.percentile > 0.95,
      `${preset.id} engaged ${(metering.engagedFraction * 100).toFixed(2)}%`)
    assert.ok(ceilingDb < last, `${preset.id} ceiling ${ceilingDb.toFixed(2)} must sit below the previous`)
    last = ceilingDb
  }
})

test('the peak switch is on the faceplate and the knob stays on the tuning panel', () => {
  // The two have to coexist: a switch for the two positions worth being in, and
  // the continuous knob underneath for measuring the ones in between. Wiring
  // one without the other leaves either an unreachable middle or a faceplate
  // control with no research path behind it.
  const panel = read('../../src/components/panels/SoftClipperModal.vue')
  assert.match(panel, /:model-value="limiterMode"/, 'the mode switch is not wired')
  assert.match(panel, /@update:model-value="setLimiterMode"/)
  assert.match(panel, /v-if="tuningOn"[\s\S]*:model-value="limiter"/,
    'the continuous Limiter knob left the tuning panel')

  const composable = read('../../src/composables/useSoftClipper.js')
  assert.match(composable, /limiterMode/, 'the composable does not derive a mode')
  assert.match(composable, /function setLimiterMode/)
})

test('the two ceiling measurements supersede independently', () => {
  // ⚠ THE LATCHING BUG THIS EXISTS FOR. Placing the ceiling and labelling the
  // setter buttons are two measurements that run back to back — opening the
  // panel fires both. On ONE shared sequence counter the second invalidates the
  // first, so the placement was always discarded; worse, `applyCeilingPreset`
  // lowers `ceilingBusy` only `if (seq === ceilingSeq)`, so the flag it had
  // already raised was never lowered. `ceilingBusy` latched true,
  // `ceilingDisabledReason` read "Measuring…" for the life of the panel, and
  // all four buttons stayed disabled.
  //
  // Supersession is per-measurement because that is what it means: a newer
  // placement cancels an older placement, not an unrelated labelling pass.
  const src = read('../../src/composables/useSoftClipper.js')
  assert.match(src, /let ceilingSeq = 0/)
  assert.match(src, /let choicesSeq = 0/, 'the two measurements share one counter again')

  const choices = src.slice(src.indexOf('async function measureCeilingChoices'))
  const choicesBody = choices.slice(0, choices.indexOf('\n  }\n'))
  assert.match(choicesBody, /\+\+choicesSeq/)
  assert.doesNotMatch(choicesBody, /ceilingSeq/,
    'labelling the buttons still touches the placement counter')

  const place = src.slice(src.indexOf('async function applyCeilingPreset'))
  const placeBody = place.slice(0, place.indexOf('\n  }\n'))
  assert.doesNotMatch(placeBody, /choicesSeq/,
    'placing the ceiling still touches the labelling counter')

  // And teardown has to cancel both, or a labelling pass lands after the panel
  // closed and writes ceilings for a region nobody is looking at.
  const teardown = src.slice(src.indexOf('function teardown()'))
  assert.match(teardown.slice(0, 900), /ceilingSeq\+\+/)
  assert.match(teardown.slice(0, 900), /choicesSeq\+\+/)
})

test('the strip readings are damped where they are read, not in the panel', () => {
  // ⚠ THE FREEZE THIS EXISTS FOR. Damping the lamp and the dB PEAK numeral in
  // the panel meant a SECOND rAF loop that had to be running for either to move
  // — and when it was not, both simply froze at zero. The composable already
  // runs a frame loop to read the kernel; the ballistics belong beside that
  // read, where a value cannot be live in one place and stale in another.
  const composable = read('../../src/composables/useSoftClipper.js')
  assert.match(composable, /createPeakHold/, 'the reduction reading is no longer held')
  assert.match(composable, /clipperReductionHeld/)
  assert.match(composable, /reductionThrottle\.due/)

  const panel = read('../../src/components/panels/SoftClipperModal.vue')
  assert.doesNotMatch(panel, /useMeterFrame/,
    'the panel runs its own meter loop again — the one that froze')
  assert.doesNotMatch(panel, /createPeakHold/)
  // The lamp and the numeral must read the SAME held value, or they can drift
  // apart and say different things about one event.
  assert.match(panel, /lampFraction\(clipperReductionHeld\.value/)
  assert.match(panel, /clipperReductionReadout\.value\.toFixed/)
})

test('the setter highlight is derived from the ceiling, never remembered', () => {
  // ⚠ THE FAILURE THIS AVOIDS is the one this panel already shipped once: a
  // latching preset lamp that kept claiming a value after the knob or the line
  // had moved away from it. A stored "last clicked" flag is a claim about the
  // PAST and stops being true the moment anything changes; comparing the
  // setter's own number against the live ceiling asks about the PRESENT, so it
  // lights when they agree and goes out when they do not — nothing to clear,
  // and no way to be wrong.
  //
  // The consequence worth keeping: it is not a selection. Land on a preset's
  // value by dragging the line and its button lights, which is correct — the
  // button describes a value, and that value is what the ceiling holds.
  const panel = read('../../src/components/panels/SoftClipperModal.vue')
  const setters = panel.slice(panel.indexOf('const ceilingSetters = computed'))
  const body = setters.slice(0, setters.indexOf('}))') + 3)
  assert.match(body, /fixedThresholdDb\.value/,
    'the highlight does not compare against the live ceiling')
  assert.match(body, /SETTER_MATCH_DB/)
  // No stored selection anywhere: a ref holding the active id would be the
  // latch coming back by another name.
  assert.doesNotMatch(panel, /activeSetter\s*=\s*ref|selectedPreset\s*=\s*ref/)

  // The tolerance has to be tighter than one detent of the ceiling knob, or a
  // nudge would leave the old button lit.
  const tol = Number(panel.match(/const SETTER_MATCH_DB = ([\d.]+)/)[1])
  assert.ok(tol > 0 && tol < 0.5,
    `SETTER_MATCH_DB ${tol} is not inside one 0.5 dB knob step`)
})

test('the strip numerals cannot re-flow the row', () => {
  // They change ten times a second, and a proportional numeral set makes "3.2"
  // and "0.4" different widths — so the label after them slides and the whole
  // strip reads as twitching. Tabular figures in a fixed box, right-aligned so
  // the decimal point stays put as the integer digit comes and goes.
  const panel = read('../../src/components/panels/SoftClipperModal.vue')
  for (const binding of ['peakOverText', 'engagedText']) {
    const at = panel.indexOf(`{{ ${binding} }}`)
    assert.ok(at > 0, `${binding} is not rendered`)
    const span = panel.slice(panel.lastIndexOf('<span', at), at)
    assert.match(span, /tabular-nums/, `${binding} is not set in tabular figures`)
    assert.match(span, /min-width/, `${binding} has no fixed box`)
    assert.match(span, /text-align:right/, `${binding} is not right-aligned in its box`)
  }
})
