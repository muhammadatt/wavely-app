#!/usr/bin/env node
/**
 * FET Punch (1176) against reference emulations — stimulus and gain-trace
 * tooling.
 *
 *   npm run fet:stimulus    write the test signals
 *   npm run fet:selftest    prove the recovery on our own kernel
 *
 * See `docs/fet1176_capture_protocol.md` for the full protocol — the
 * control-parity check, the four-bounce null test that can disqualify a
 * reference before the other thirty-eight, and what to log per capture. This
 * script builds the stimulus and proves the recovery; the doc is how to run the
 * bounces.
 *
 * ⚠ EACH MODE HAS ITS OWN NPM SCRIPT WITH THE FLAG BAKED IN, AND THAT IS NOT
 * COSMETIC. `npm run fet:ballistics -- --stimulus` can reach this file with an
 * EMPTY argv on Windows — PowerShell and some npm/shell combinations swallow the
 * `--` — whereupon it falls through to the wrong mode. Same arrangement, and
 * same reason, as `la2a-ballistics.mjs`.
 *
 * WHY THIS EXISTS. Every constant in `src/audio/fet1176Processor.js` — the
 * input taper, the threshold reference, the four ratio knees, both ballistics
 * ranges, the program-dependent release split, all seven all-buttons-in
 * constants and the FET drive — was chosen to reproduce a DESCRIBED behaviour.
 * Not one of them has been measured against anything. The module is careful
 * about saying so; this is the tooling that starts closing it, against two
 * reference emulations (Analog Obsession FETish, Waves CLA-76).
 *
 * ⚠ BOTH REFERENCES ARE PLUGINS, NOT HARDWARE, AND THAT IS A LIMITATION TO
 * STATE RATHER THAN A DISQUALIFICATION. `docs/la2a_tube_capture_protocol.md`
 * records what happens when it is forgotten: LAEA was asked for an output-stage
 * saturation it does not model at all, and two captures that "looked like one
 * dataset" turned out to be a plugin and an analog unit that disagreed exactly
 * where it mattered. Label every capture with its reference and its settings.
 * Do not average the two references; fit one, hold the other out.
 *
 * ⚠ AND THEY ARE NOT INTERCHANGEABLE — control parity found four structural
 * differences before a single bounce. FETish's Input is INTERNALLY COMPENSATED
 * (a drive offset, not an input gain), so it cannot speak to our Input's audio
 * path; it has NO all-buttons-in mode, so all seven ALL_* constants can only
 * come from CLA-76 and are a single-reference fit with no hold-out; its manual
 * says the threshold MOVES with ratio where we hold it fixed; and its
 * ballistics are continuous, which is better, except that its advertised
 * endpoints are identical to ours because both quote the same datasheet.
 * `docs/fet1176_capture_protocol.md` has all four and what each does to the
 * matrix.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT EACH PLAN MEASURES, AND WHY IT IS SEPARABLE FROM THE OTHERS
 *
 *   stairs.wav     STATIC CURVE — threshold, input taper, ratio knee.
 *                  A settled staircase, so every ballistic transient is
 *                  excluded and what is left is the gain computer alone.
 *
 *                  ⚠ CAPTURE IT AT ATTACK 1 / RELEASE 7, and both halves of
 *                  that matter. The detector is a bare full-wave rectifier with
 *                  no smoothing, so at a FAST attack the gain tracks |sin|
 *                  within the cycle and there is no settled value to read — the
 *                  trace swings between no reduction at the crossings and full
 *                  reduction at the peaks. The slowest attack (800 us, against
 *                  a 250 us probe period) smooths that into a steady,
 *                  peak-referenced value, which is the quantity the static
 *                  curve is defined on. The FASTEST release then settles each
 *                  step in ~200 ms so the steps can sit 1.5 s apart instead of
 *                  needing 10.
 *
 *   bursts.wav     BALLISTICS — attack, release, and the program-dependent
 *                  release tail (TAIL_FRACTION / TAIL_MULT).
 *                  Four hold lengths from 50 ms to 3 s. Sweeping how LONG the
 *                  tone was held is what separates the tail from the main
 *                  release: a single time constant recovers identically after
 *                  every hold, and a two-stage network does not. ⚠ This is also
 *                  the check that caught a mislabelled LA-2A capture — a
 *                  release trace bit-identical after 50 ms and 10 s is an FET
 *                  signature and cannot be a photocell.
 *
 *   frequency.wav  HOLD-OUT, NOT FIT DATA. The hardware's detector is
 *                  broadband and ours models it that way, so the settled
 *                  reduction must be IDENTICAL at every probe frequency. That
 *                  is a testable claim rather than an assumption baked into the
 *                  model: if a reference ducks 100 Hz harder than 4 kHz, no
 *                  retuning of the taper or the knee can reproduce it, and the
 *                  answer is that the detector needs a filter, not that a
 *                  constant is wrong. Keeping it out of the fit is what lets it
 *                  answer that.
 *
 *   thd.wav        DISTORTION — five long steady tones at rising level.
 *                  ⚠ THE AXIS IS GAIN REDUCTION, NOT INPUT LEVEL, and that is
 *                  the correction the LA-2A work arrived at the expensive way.
 *                  Measuring THD against input level cannot tell a gain-cell
 *                  nonlinearity from an output-amp one; measuring it against dB
 *                  of GR can, and on the LA-2A the answer turned out to be the
 *                  cell, after two years of a model that put it in the valves.
 *                  Bounce this at several Input positions and read THD against
 *                  the reduction each one produced.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ WHAT THE SELF-TEST FOUND, AND WHY IT CHANGES HOW THE FIT MUST BE DONE
 *
 * Run against our own kernel, whose ballistics constants are known exactly, the
 * recovery reconstructs the applied gain to 2.8e-17 — the method is sound. But
 * the t63 it measures is NOT the attack constant that produced it. Measured
 * against `attackSecondsForDial()`, the ratio runs about 2.9x across the
 * resolvable dials:
 *
 *   dial      1      2      3      4
 *   declared  800us  433us  234us  126us
 *   measured  2313   1188    688    438  us
 *   ratio     2.89   2.75   2.94   3.46
 *
 * The cause is structural and the reference will have it too: the detector is a
 * bare full-wave rectifier, so its target is over threshold only near the
 * waveform PEAKS and falls under it at every crossing. The gain therefore
 * attacks in bursts and releases between them, and the peak-to-peak envelope
 * climbs more slowly than the coefficient. The factor is NOT a constant to
 * divide out — it depends on how much of the cycle sits over threshold, i.e. on
 * Input, on level and on the knee.
 *
 * ⚠ SO THE FIT IS BY MATCHED MEASUREMENT, NEVER BY CONVERTING t63 TO A
 * CONSTANT. Run our kernel at each dial, measure its t63 THIS EXACT WAY, and
 * find the dial whose measurement matches the reference's; both sides then
 * carry the same bias and it cancels. Fitting `ATTACK_FASTEST_S` to a
 * reference's raw t63 would have landed it about 3x too slow, and the number
 * would have looked entirely reasonable. `la2a-pair-compare.mjs` reaches the
 * same arrangement from the other direction with `matchKnob`.
 *
 * AND THE OVERSHOOT COLUMN IS THE BETTER STATISTIC ANYWAY. How far the first
 * post-step peak sits above the settled reduction runs 3.55 / 3.42 / 3.20 /
 * 2.83 / 2.27 / 1.52 / 0.78 dB across dials 1-7 — monotone over the WHOLE
 * range, including the three dials that are faster than any audio-band probe
 * can resolve as a time constant. It is also the thing a listener is actually
 * buying from this unit. Fit against it, and use t63 as the cross-check.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CAPTURE MATRIX. `--stimulus` prints it; the short version is that the
 * stimulus files do not change across it — only the plugin's knobs do.
 *
 * ⚠ INPUT IS SWEPT ON THE STATIC PLAN AND THE MODEL SAYS THAT IS REDUNDANT.
 * Drive and level add in dB, so a level ramp at a fixed Input and an Input
 * sweep at a fixed level should be the same experiment. That is precisely why
 * the sweep is in the matrix: if the curves collapse onto one another when
 * shifted by the knob's dB, the additive model holds and the SHIFT REQUIRED TO
 * COLLAPSE THEM IS THE TAPER, measured directly. If they do not collapse, the
 * Input knob is doing something our model does not have.
 */

import { mkdirSync, existsSync, readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

import { writeFloatWav } from './lib/wav.js'
import { scheduleClear, assertPlanClear } from './lib/demoMute.js'
import { snapToZeroCrossing, buildProbe } from './lib/probeStimulus.js'
import { traceGain, fillShortGaps, blindWindowUs, rippleDb } from './lib/gainTrace.js'
import { readCapture, alignByEnvelope, refineLagAtEdge, preflight } from './lib/probeCapture.js'
import {
  FET1176Kernel, attackSecondsForDial, releaseSecondsForDial,
} from '../src/audio/fet1176Processor.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const STIM_DIR = join(ROOT, 'data/corpus/fet1176/stimulus')
export const CAP_DIR = join(ROOT, 'data/corpus/fet1176/captures')

/**
 * ⚠ THE CAPTURE RATE IS A HARD FLOOR ON THE ATTACK MEASUREMENT, which is the
 * one respect in which this unit is harder to capture than the LA-2A.
 * `ATTACK_FASTEST_S` is 20 us — 0.88 samples at 44.1 kHz, 1.92 at 96 kHz, 3.84
 * at 192 kHz. 96 kHz is the default because it is what every DAW offers and it
 * also clears H8 of the 4 kHz probe; pass `--rate 192000` if the session can
 * run there, and capture at the SAME rate the stimulus was written at.
 */
const DEFAULT_SR = 96000

/**
 * ⚠ THE PROBE IS 4 kHz AND THE LA-2A'S IS 1 kHz, and the reason is the whole
 * argument in `lib/gainTrace.js`. The gain trace is blind while the probe is
 * near zero, for `asin(floor)/(pi*f)` seconds twice per cycle: 31.9 us at
 * 1 kHz, 8.0 us at 4 kHz, against a 20 us fastest attack. A 1 kHz probe cannot
 * see this unit's fast end at all. 4 kHz also puts a half-period at 125 us, so
 * the peak-to-peak sampling of the reduction is fine enough to trace dials 1-4
 * as trajectories; dials 5-7 are faster than any audio-band probe resolves and
 * are read as FIRST-PEAK OVERSHOOT instead of as a time constant (see
 * `--selftest`, which reports both columns and says which one is meaningful).
 */
const PROBE_HZ = 4000

/** Well below threshold at every Input position in the matrix: the cell rests open. */
const LOW_DBFS = -50
/** Peak level of the compressed state. At Input 50 this is ~5 dB over threshold. */
const HIGH_DBFS = -12

// ── Plan constants ──────────────────────────────────────────────────────────

// Hold lengths for the burst plan. The longest is 3 s, not the LA-2A's 10:
// RELEASE_SLOWEST_S is 1.1 s and the tail runs 4x that, so 3 s is already
// several time constants of exposure and a longer hold buys nothing.
const BURSTS = [0.05, 0.2, 1.0, 3.0]
const PRE_S = 1.0    // quiet lead inside the protected span
const POST_S = 7.0   // release observed here — 1.1 s main plus a 4.4 s tail
const REST_S = 10.0  // everything discharges before the next burst

// Static staircase. 3 dB steps from well under the knee to well over it, at
// every Input position in the matrix.
const STAIRS = [-45, -42, -39, -36, -33, -30, -27, -24, -21, -18, -15, -12, -9, -6, -3]
const STAIR_S = 1.0
const STAIR_REST_S = 1.5

// Detector frequency hold-out.
const FREQS_HZ = [100, 400, 1000, 4000, 10000]
const FREQ_HOLD_S = 1.0
const FREQ_PRE_S = 1.0
const FREQ_POST_S = 3.0
const FREQ_REST_S = 6.0

// Distortion tones. Long enough for a clean DFT, and 1 kHz because that is the
// frequency hardware THD specs are conventionally quoted at.
const THD_HZ = 1000
const THD_LEVELS = [-30, -24, -18, -12, -6]
const THD_S = 3.0
const THD_REST_S = 1.5

// ── Plans ───────────────────────────────────────────────────────────────────

export function burstPlan() {
  const events = []
  const spans = []
  let t = 1.0
  for (const T of BURSTS) {
    // ⚠ PRE, HOLD AND POST ARE ONE SPAN. The release is the measurement, so
    // nothing may be inserted into it; pushing the group past a mute moves the
    // step and its recovery together.
    t = scheduleClear(t, PRE_S + T + POST_S, `burst ${T}s`)
    const up = snapToZeroCrossing(t + PRE_S, PROBE_HZ)
    events.push({
      tag: `burst ${T}s`, T, freqHz: PROBE_HZ, hiDb: HIGH_DBFS,
      up, down: snapToZeroCrossing(up + T, PROBE_HZ),
    })
    spans.push([`burst ${T}s`, t, t + PRE_S + T + POST_S])
    t += PRE_S + T + POST_S + REST_S
  }
  assertPlanClear('bursts', spans)
  return { events, spans, seconds: t + 1.0, lowDb: LOW_DBFS }
}

export function stairPlan() {
  const events = []
  const spans = []
  let t = 1.0
  for (const L of STAIRS) {
    t = scheduleClear(t, STAIR_REST_S + STAIR_S, `${L} dBFS`)
    const up = snapToZeroCrossing(t + STAIR_REST_S, PROBE_HZ)
    events.push({
      tag: `${L} dBFS`, L, freqHz: PROBE_HZ, hiDb: L,
      up, down: snapToZeroCrossing(up + STAIR_S, PROBE_HZ),
    })
    spans.push([`${L} dBFS`, t, t + STAIR_REST_S + STAIR_S])
    t += STAIR_REST_S + STAIR_S
  }
  assertPlanClear('staircase', spans)
  return { events, spans, seconds: t + 1.0, lowDb: LOW_DBFS }
}

export function freqPlan() {
  const events = []
  const spans = []
  let t = 1.0
  for (const f of FREQS_HZ) {
    t = scheduleClear(t, FREQ_PRE_S + FREQ_HOLD_S + FREQ_POST_S, `${f} Hz`)
    const up = snapToZeroCrossing(t + FREQ_PRE_S, f)
    events.push({
      tag: `${f} Hz`, freqHz: f, hiDb: HIGH_DBFS,
      up, down: snapToZeroCrossing(up + FREQ_HOLD_S, f),
    })
    spans.push([`${f} Hz`, t, t + FREQ_PRE_S + FREQ_HOLD_S + FREQ_POST_S])
    t += FREQ_PRE_S + FREQ_HOLD_S + FREQ_POST_S + FREQ_REST_S
  }
  assertPlanClear('frequency', spans)
  return { events, spans, seconds: t + 1.0, lowDb: LOW_DBFS }
}

export function thdPlan() {
  const events = []
  const spans = []
  let t = 1.0
  for (const L of THD_LEVELS) {
    t = scheduleClear(t, THD_REST_S + THD_S, `${L} dBFS`)
    const up = snapToZeroCrossing(t + THD_REST_S, THD_HZ)
    events.push({
      tag: `${L} dBFS`, L, freqHz: THD_HZ, hiDb: L,
      up, down: snapToZeroCrossing(up + THD_S, THD_HZ),
    })
    spans.push([`${L} dBFS`, t, t + THD_REST_S + THD_S])
    t += THD_REST_S + THD_S
  }
  assertPlanClear('thd', spans)
  return { events, spans, seconds: t + 1.0, lowDb: LOW_DBFS }
}

/**
 * ⚠ THE PLANS ARE THE SINGLE SOURCE OF TRUTH AND THERE IS NO MANIFEST. A
 * fitter imports these builders rather than reading a JSON file written
 * alongside the WAVs, so a stimulus edit reaches the analysis on its next run
 * and the two cannot drift apart. Same arrangement as
 * `la2a-tube-capture-tones.mjs`, and for the same reason.
 */
export const PLANS = {
  'stairs.wav': stairPlan,
  'bursts.wav': burstPlan,
  'frequency.wav': freqPlan,
  'thd.wav': thdPlan,
}

// ── Kernel driver ───────────────────────────────────────────────────────────

/**
 * Our kernel over a stimulus.
 *
 * ⚠ `oversample: false` IS THE MEASUREMENT MODE AND IS NOT WHAT ANYONE HEARS.
 * With it off the kernel's output is exactly `in * inputLin * cellGain *
 * outGain` — no half-band filters, no latency, no waveshaper if `fetDrive` is
 * 0 — which makes the recovered trace the kernel's gain to the last bit and
 * gives the self-test a ground truth rather than another estimate. The shipping
 * path holds audio back by `latencySamples` and a capture of it has to be
 * aligned first.
 */
export function runKernel(x, sampleRate, params) {
  const k = new FET1176Kernel(sampleRate)
  k.setParams({ outputGainDb: 0, mix: 1, fetDrive: 0, oversample: false, ...params })
  const o = new Float32Array(x.length)
  for (let f = 0; f < x.length; f += 128) {
    const l = Math.min(128, x.length - f)
    k.process([x.subarray(f, f + l)], [o.subarray(f, f + l)], l)
  }
  return { y: o, kernel: k }
}

// ── Analysis ────────────────────────────────────────────────────────────────

const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))

/**
 * Sample the trace at the probe's waveform PEAKS — one reading per half cycle.
 *
 * ⚠ THIS IS THE RIGHT SAMPLING AND THE MEAN IS NOT, because the detector has no
 * smoothing. The reduction the unit applies is set by the rectified level, so
 * it is deepest at the waveform peak and shallowest at the crossing; the peak
 * reading is the one the static curve is defined on, and the one that does not
 * change shape when the attack dial moves. Resolution is a half period —
 * 125 us at 4 kHz — which is what bounds the attack fit below.
 */
function peakSeries(g, dry, env, from, to) {
  const out = []
  for (let i = Math.max(1, from); i < Math.min(dry.length - 1, to); i++) {
    const a = Math.abs(dry[i])
    if (!(a > Math.abs(dry[i - 1])) || !(a >= Math.abs(dry[i + 1]))) continue
    if (!(a > 0.5 * env[i])) continue
    if (Number.isFinite(g[i])) out.push([i, g[i]])
  }
  return out
}

/** Time to reach `frac` of the way from `a` to `b`, in seconds, or null. */
function timeToFraction(series, sampleRate, t0Sample, a, b, frac) {
  const target = a + (b - a) * frac
  const rising = b > a
  for (const [i, v] of series) {
    if (i < t0Sample) continue
    if (rising ? v >= target : v <= target) return (i - t0Sample) / sampleRate
  }
  return null
}

/**
 * Everything one burst event says about the ballistics.
 *
 * ⚠ THE OPEN REFERENCE COMES FROM THE HEAD OF THE FILE, before any event, which
 * is the only place the cell has no history at all. Taking it from the end of a
 * recovery reads short at the slow dials — at release 1 the tail runs 4.4 s, so
 * 7 s after the step it still holds 20 % of its share.
 */
function analyseBurst(y, plan, stim, sampleRate, lag, ev) {
  const g = fillShortGaps(traceGain(y, stim.env, stim.x, { lag, floor: 0.1 }),
    Math.ceil(sampleRate / PROBE_HZ))
  const upS = Math.round(ev.up * sampleRate)
  const downS = Math.round(ev.down * sampleRate)
  const series = peakSeries(g, stim.x, stim.env, 0, downS + 8 * sampleRate)
    .map(([i, v]) => [i, db(v)])

  const openRows = series.filter(([i]) => i > 0.3 * sampleRate && i < 0.8 * sampleRate)
  const restRows = series.filter(([i]) => i < upS).slice(-4)
  /**
   * ⚠ THE HELD WINDOW MUST FIT INSIDE THE BURST, and a fixed 0.1 s one does not.
   * The shortest hold in this plan is 50 ms, so a 100 ms window reaching back
   * from its end spans the REST BEFORE THE BURST and averages the open gain into
   * the held level. Measured on our own kernel, that put the 50 ms burst's
   * release t63 at 606 ms against 326-389 for the longer holds — an outlier
   * pointing the wrong way, which made the tail test report NO TAIL on a kernel
   * whose tail is 22 % of the reduction on a network 4x slower.
   */
  const heldWindow = Math.min(0.1, (ev.down - ev.up) * 0.4)
  const heldRows = series.filter(([i]) => i > downS - heldWindow * sampleRate && i < downS)
  if (!openRows.length || !restRows.length || !heldRows.length) return null

  const mean = rows => rows.reduce((a, [, v]) => a + v, 0) / rows.length
  const open = mean(openRows)
  const rest = mean(restRows)
  const held = mean(heldRows)

  const attackT63 = timeToFraction(series, sampleRate, upS, rest, held, 0.63)
  const first = series.find(([i]) => i >= upS)
  const releaseT63 = timeToFraction(series, sampleRate, downS, held, open, 0.63)

  return {
    tag: ev.tag,
    holdS: ev.T,
    grDb: rest - held,
    attackT63,
    overshootDb: first ? first[1] - held : NaN,
    releaseT63,
  }
}

/** Every burst in one capture. */
function analyseCapture(y, plan, stim, sampleRate, lag) {
  return plan.events.map(ev => analyseBurst(y, plan, stim, sampleRate, lag, ev)).filter(Boolean)
}

function selftest(sampleRate) {
  console.log(`\nFET Punch gain-trace self-test — ${sampleRate} Hz, ${PROBE_HZ} Hz probe`)
  console.log(`Zero-crossing blind window: ${blindWindowUs(PROBE_HZ, 0.1).toFixed(1)} us ` +
    `(floor 0.1), sample period ${(1e6 / sampleRate).toFixed(1)} us, ` +
    `probe half-period ${(5e5 / PROBE_HZ).toFixed(0)} us`)

  const plan = burstPlan()
  const { x, env } = buildProbe(plan, sampleRate)
  const ev = plan.events[plan.events.length - 1]   // the 3 s hold
  const upS = Math.round(ev.up * sampleRate)
  const downS = Math.round(ev.down * sampleRate)

  // ── (1) The trace is exact when nothing nonlinear is in the path ──────────
  {
    const { y } = runKernel(x, sampleRate, { inputDrive: 50, ratio: '4', attack: 4, release: 4 })
    const g = traceGain(y, env, x, { floor: 0.1 })
    const filled = fillShortGaps(g, Math.ceil(sampleRate / PROBE_HZ))
    let worst = 0, n = 0
    for (let i = upS + 100; i < downS - 100; i++) {
      if (!Number.isFinite(filled[i]) || x[i] === 0) continue
      const err = Math.abs(y[i] - x[i] * filled[i])
      if (err > worst) worst = err
      n++
    }
    const ok = worst < 1e-6
    console.log(`\n  reconstruction    ${ok ? 'OK' : 'FAIL'} — max |wet - dry*g| = ${worst.toExponential(2)} over ${n} samples`)
    if (!ok) process.exitCode = 1
  }

  // ── (2) Attack and release, per dial, against the kernel's own constants ──
  console.log('\n  ATTACK — t63 of the reduction against attackSecondsForDial()')
  console.log('  dial   declared    measured   ratio   overshoot   verdict')
  for (const dial of [1, 2, 3, 4, 5, 6, 7]) {
    const { y } = runKernel(x, sampleRate, { inputDrive: 50, ratio: '4', attack: dial, release: 1 })
    const g = fillShortGaps(traceGain(y, env, x, { floor: 0.1 }), Math.ceil(sampleRate / PROBE_HZ))
    const series = peakSeries(g, x, env, upS - 10, downS)
    const rest = series.filter(([i]) => i < upS).slice(-4)
    const settled = series.filter(([i]) => i > downS - 0.2 * sampleRate)
    if (!rest.length || !settled.length) { console.log(`  ${dial}      — no usable peaks —`); continue }
    const a = rest.reduce((s, [, v]) => s + db(v), 0) / rest.length
    const b = settled.reduce((s, [, v]) => s + db(v), 0) / settled.length
    const t63 = timeToFraction(series.map(([i, v]) => [i, db(v)]), sampleRate, upS, a, b, 0.63)
    // Overshoot: how far past the settled gain the first post-step peak sits.
    const first = series.find(([i]) => i >= upS)
    const over = first ? db(first[1]) - b : NaN
    const declared = attackSecondsForDial(dial)
    const halfPeriod = 0.5 / PROBE_HZ
    const resolvable = declared > halfPeriod
    console.log(
      `  ${dial}      ${(declared * 1e6).toFixed(0).padStart(6)} us  ` +
      `${t63 === null ? '    --   ' : (t63 * 1e6).toFixed(0).padStart(7) + ' us'}  ` +
      `${t63 === null ? '   -- ' : (t63 / declared).toFixed(2).padStart(6)}  ` +
      `${Number.isFinite(over) ? over.toFixed(2).padStart(8) + ' dB' : '      -- '}   ` +
      `${resolvable ? 'resolvable' : 'below probe resolution — read the overshoot'}`)
  }

  console.log('\n  RELEASE — t63 of the recovery against releaseSecondsForDial()')
  console.log('  dial   declared    measured   ratio   note')
  for (const dial of [1, 2, 3, 4, 5, 6, 7]) {
    const { y } = runKernel(x, sampleRate, { inputDrive: 50, ratio: '4', attack: 7, release: dial })
    const g = fillShortGaps(traceGain(y, env, x, { floor: 0.1 }), Math.ceil(sampleRate / PROBE_HZ))
    const series = peakSeries(g, x, env, 0, downS + 8 * sampleRate).map(([i, v]) => [i, db(v)])
    const held = series.filter(([i]) => i > downS - 0.1 * sampleRate && i < downS)
    /**
     * ⚠ THE OPEN REFERENCE COMES FROM THE HEAD OF THE FILE, NOT FROM THE END OF
     * THE RECOVERY, and the first version of this test took it from the end and
     * was wrong at the slow dials. At release dial 1 the tail runs 4.4 s, so
     * 7 s after the step it still holds e^-1.6 = 20 % of its share; taking that
     * as "open" puts the t63 target 4 % low and shortened the measured time
     * constant enough to read as ratio 1.36 where the other six dials all read
     * 1.70. Before the FIRST event the cell has no history at all, which is the
     * only unambiguous open reading in the file.
     */
    const open = series.filter(([i]) => i > 0.3 * sampleRate && i < 0.8 * sampleRate)
    if (!held.length || !open.length) { console.log(`  ${dial}      — no usable peaks —`); continue }
    const a = held.reduce((s, [, v]) => s + v, 0) / held.length
    const b = open.reduce((s, [, v]) => s + v, 0) / open.length
    const t63 = timeToFraction(series, sampleRate, downS, a, b, 0.63)
    const declared = releaseSecondsForDial(dial)
    // ⚠ THE MEASURED t63 IS EXPECTED TO RUN LONG, AND BY A KNOWN AMOUNT. The
    // recovery is two stages — TAIL_FRACTION of it on a network TAIL_MULT times
    // slower — so a single-exponential t63 read off a two-stage decay lands
    // between the two constants. A measured/declared ratio near 1.0 would mean
    // the tail is MISSING, which is the thing this column is really watching.
    console.log(
      `  ${dial}      ${(declared * 1e3).toFixed(0).padStart(5)} ms  ` +
      `${t63 === null ? '    --  ' : (t63 * 1e3).toFixed(0).padStart(6) + ' ms'}  ` +
      `${t63 === null ? '   -- ' : (t63 / declared).toFixed(2).padStart(6)}   ` +
      `${t63 !== null && t63 / declared < 1.1 ? '⚠ no tail visible' : 'two-stage recovery present'}`)
  }

  // ── (3) The saturator's ripple, which the shipping path always carries ────
  {
    const { y } = runKernel(x, sampleRate,
      { inputDrive: 50, ratio: '4', attack: 1, release: 7, fetDrive: 0.35 })
    const g = traceGain(y, env, x, { floor: 0.1 })
    const r = rippleDb(g, downS - Math.round(0.2 * sampleRate), downS - 100)
    console.log(`\n  2f ripple at fetDrive 0.35: ${r.toFixed(2)} dB over a settled hold`)
    console.log('    This is the static nonlinearity, separated from the compression —')
    console.log('    a pure time-varying gain would read 0.00 dB. Ballistics fits must')
    console.log('    read the peak series (above), never the raw trace, or this lands')
    console.log('    in the time constant.')
  }
}

// ── Fitting captured references ─────────────────────────────────────────────

/**
 * Pull the declared knobs out of a capture's filename — `..._a3_r4.wav` for a
 * dial, `..._a800us_r235ms.wav` for FETish's continuous controls.
 */
function knobsFromName(file) {
  const a = file.match(/_a(\d+(?:\.\d+)?)(us|ms)?/i)
  const r = file.match(/_r(\d+(?:\.\d+)?)(us|ms)?/i)
  const val = m => m && ({ n: Number(m[1]), unit: (m[2] || '').toLowerCase() })
  return { attack: val(a), release: val(r) }
}

const showKnob = k => (k ? k.n + (k.unit || ' (dial)') : '?')

/**
 * Our own kernel measured the IDENTICAL way, at every dial.
 *
 * ⚠ THIS IS THE WHOLE FITTING METHOD AND IT IS NOT A CONVERSION. Measured t63
 * runs about 2.9x the attack constant that produced it — the detector is a bare
 * rectifier, so its target is over threshold only near the waveform peaks and
 * the gain attacks in bursts and releases between them. The factor moves with
 * Input, level and knee, so it cannot be divided out. Running our kernel through
 * the same analysis puts the same bias on both sides, where it cancels.
 */
const dialTableCache = new Map()

function ourDialTable(plan, stim, sampleRate, params, sweep) {
  /**
   * ⚠ MEMOISED, BECAUSE THIS IS THE ENTIRE COST OF A FIT RUN. Each table is
   * seven renders of the 83 s stimulus, oversampled — and it depends only on
   * the params and which dial is being swept, not on the capture being fitted.
   * Rebuilding it per capture took the self-test to 88 s.
   */
  const key = JSON.stringify({ params, sweep, sampleRate })
  if (dialTableCache.has(key)) return dialTableCache.get(key)
  const rows = []
  for (let dial = 1; dial <= 7; dial++) {
    const p = sweep === 'attack' ? { ...params, attack: dial } : { ...params, release: dial }
    const { y } = runKernel(stim.x, sampleRate, { ...p, oversample: true })
    const k = new FET1176Kernel(sampleRate)
    k.setParams({ ...p, oversample: true })
    const bursts = analyseCapture(y, plan, stim, sampleRate, k.latencySamples)
    rows.push({ dial, bursts })
  }
  dialTableCache.set(key, rows)
  return rows
}

/**
 * Where the reference sits on our dial — as a CONTINUOUS position, and with an
 * explicit answer when it sits off the end.
 *
 * ⚠ AN ARGMIN OVER SEVEN DIALS CANNOT FAIL, AND THAT IS A DEFECT NOT A FEATURE.
 * The first version of this returned the nearest dial and printed it with no
 * residual and no range check — so a reference slower than our slowest came
 * back as a confident "dial 1" and a reference faster than our fastest as
 * "dial 7", either of which reads as a successful fit. The endpoints are
 * `ATTACK_SLOWEST_S` / `ATTACK_FASTEST_S` and their whole provenance is a
 * datasheet, so "the reference is outside our range" is a live outcome and one
 * of the more useful things this capture could say.
 *
 * ⚠ AND THE FRACTIONAL DIAL IS NOT A ROUNDING ARTEFACT — IT IS THE ANSWER A
 * CONTINUOUS CONTROL NEEDS. `dialToSeconds` already takes a float and
 * interpolates geometrically, so 3.4 is a real setting; a knob that reads in
 * microseconds is the same law with the same endpoints, exposed without
 * detents. The interpolation is on the MEASURED statistic rather than on time,
 * because the statistic is what both sides share.
 */
function matchDial(table, target, pick) {
  const pts = table
    .map(r => ({ dial: r.dial, value: pick(r.bursts) }))
    .filter(p => Number.isFinite(p.value))
  if (pts.length < 2) return null

  const first = pts[0].value, last = pts[pts.length - 1].value
  const rising = last > first
  const beyondSlow = rising ? target < first : target > first
  const beyondFast = rising ? target > last : target < last
  if (beyondSlow || beyondFast) {
    const edge = beyondSlow ? pts[0] : pts[pts.length - 1]
    return { dial: edge.dial, value: edge.value, residual: target - edge.value, outside: beyondSlow ? 'slow' : 'fast' }
  }

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const lo = Math.min(a.value, b.value), hi = Math.max(a.value, b.value)
    if (target < lo || target > hi) continue
    const span = b.value - a.value
    const f = span === 0 ? 0 : (target - a.value) / span
    return { dial: a.dial + f * (b.dial - a.dial), value: target, residual: 0, outside: null, between: [a.dial, b.dial] }
  }
  // Non-monotonic table: fall back to nearest, and say the interpolation failed.
  let best = null
  for (const p of pts) {
    const err = Math.abs(p.value - target)
    if (!best || err < best.err) best = { dial: p.dial, value: p.value, err }
  }
  return { ...best, residual: target - best.value, outside: null, nonMonotonic: true }
}

/**
 * Synthetic bursts captures from our own kernel, at dials we choose, with an
 * odd lag injected — so the fitter has to find both.
 *
 * ⚠ THE LAG IS THE HALF OF THIS THAT IS EASY TO GET WRONG SILENTLY. The kernel's
 * own `latencySamples` is trimmed off first and something arbitrary put in its
 * place, so a fitter that quietly assumed a known latency would fail here and
 * pass on a capture that happened to have none.
 */
function writeFitSelftest(dir, sampleRate) {
  mkdirSync(dir, { recursive: true })
  const plan = burstPlan()
  const stim = buildProbe(plan, sampleRate)
  const cases = [{ attack: 2, release: 4, lag: 131 }, { attack: 5, release: 6, lag: -77 }]
  for (const c of cases) {
    const { y } = runKernel(stim.x, sampleRate,
      { inputDrive: 55, ratio: '4', attack: c.attack, release: c.release, fetDrive: 0, oversample: true })
    const k = new FET1176Kernel(sampleRate)
    k.setParams({ oversample: true })
    const trimmed = y.subarray(k.latencySamples)
    const z = new Float32Array(trimmed.length + Math.max(0, c.lag))
    if (c.lag >= 0) z.set(trimmed, c.lag)
    else z.set(trimmed.subarray(-c.lag), 0)
    writeFloatWav(join(dir, `synth_bursts_r4_I3_a${c.attack}_r${c.release}.wav`), z, sampleRate)
  }
  console.log(`\nSynthetic bursts captures in ${dir}`)
  console.log('EXPECTED — anything else is a bug in the fitter, not in the capture:')
  for (const c of cases) {
    console.log(`  a${c.attack}_r${c.release}: lag ${c.lag}, attack dial ${c.attack}, release dial ${c.release}, a tail present`)
  }
  return dir
}

function fitCaptures(sampleRate, dir = CAP_DIR) {
  const plan = burstPlan()
  const stim = buildProbe(plan, sampleRate)
  const CAP_DIR = dir
  const files = existsSync(CAP_DIR)
    ? readdirSync(CAP_DIR).filter(f => /bursts.*\.wav$/i.test(f)).sort()
    : []
  if (!files.length) {
    console.log(`\nNo bursts captures in ${CAP_DIR}.`)
    console.log('Expected names like  cla76_bursts_r4_I3_a3_r4.wav  /  fetish_bursts_r4_I3_a800us_r235ms.wav')
    console.log('See docs/fet1176_capture_protocol.md, Step 3.\n')
    return
  }

  console.log(`\nFET Punch ballistics — ${files.length} capture(s), stimulus at ${sampleRate} Hz`)
  console.log(`Probe ${PROBE_HZ} Hz: blind window ${blindWindowUs(PROBE_HZ, 0.1).toFixed(1)} us, ` +
    `half-period ${(5e5 / PROBE_HZ).toFixed(0)} us\n`)

  for (const file of files) {
    console.log('═'.repeat(78))
    console.log(file)
    console.log('═'.repeat(78))
    let y
    try {
      ;({ y } = readCapture(join(CAP_DIR, file), sampleRate))
    } catch (e) {
      console.log(`  ⚠ ${e.message}\n`)
      continue
    }
    const pre = preflight(file, y, plan, stim.env, sampleRate)
    for (const line of pre.lines) console.log(line)

    const coarse = alignByEnvelope(stim.env, y, sampleRate)
    const ref = refineLagAtEdge(y, stim.x, plan.events[0].up, sampleRate, coarse)
    console.log(`  lag ${ref.lag} samples (${(1000 * ref.lag / sampleRate).toFixed(3)} ms), ` +
      `edge-refined from ${coarse}; margin ${Number.isFinite(ref.margin) ? ref.margin.toFixed(3) : 'n/a'}`)
    if (!(ref.margin > 0.005)) {
      console.log('  ⚠ THE EDGE DID NOT DISAMBIGUATE THE CYCLE. The runner-up lag a period away')
      console.log('    scores almost as well, so this could be locked onto the wrong one. Every')
      console.log('    attack number below is suspect; the release numbers are only shifted.')
    }

    const bursts = analyseCapture(y, plan, stim, sampleRate, ref.lag)
    if (!bursts.length) { console.log('  ⚠ no usable bursts\n'); continue }

    console.log('\n   hold      GR dB    attack t63    overshoot    release t63')
    for (const b of bursts) {
      console.log('   ' + String(b.holdS + ' s').padEnd(8) +
        b.grDb.toFixed(2).padStart(8) +
        (b.attackT63 === null ? '        --' : (b.attackT63 * 1e6).toFixed(0).padStart(9) + ' us') +
        (Number.isFinite(b.overshootDb) ? b.overshootDb.toFixed(2).padStart(12) + ' dB' : '           --') +
        (b.releaseT63 === null ? '           --' : (b.releaseT63 * 1e3).toFixed(0).padStart(12) + ' ms'))
    }

    /**
     * ⚠ THE HOLD SWEEP IS THE TAIL TEST AND IT IS THE POINT OF THIS PLAN. A
     * single time constant recovers identically after every hold length; a
     * two-stage network does not. A release trace bit-identical after 50 ms and
     * 3 s is how an 1176 got mistaken for an LA-2A in this repo's corpus.
     */
    /**
     * ⚠ ONLY HOLDS THAT REACHED FULL REDUCTION BELONG IN THE TAIL TEST. A burst
     * too short to settle releases from a shallower depth, which is a different
     * experiment — the comparison is how long the recovery takes from the SAME
     * place, not from wherever each burst happened to get to.
     */
    const deepestGr = Math.max(...bursts.map(b => b.grDb))
    const rels = bursts.filter(b => b.releaseT63 !== null && b.grDb > deepestGr - 0.5)
    const dropped = bursts.filter(b => b.releaseT63 !== null && b.grDb <= deepestGr - 0.5)
    if (dropped.length) {
      console.log(`\n   ⚠ ${dropped.map(b => b.holdS + ' s').join(', ')} never reached full reduction ` +
        `(${dropped.map(b => b.grDb.toFixed(1)).join(', ')} dB against ${deepestGr.toFixed(1)}) —`)
      console.log('     released from a shallower depth, so left out of the tail test below.')
    }
    if (rels.length >= 2) {
      const lo = rels[0].releaseT63, hi = rels[rels.length - 1].releaseT63
      console.log(`\n   release t63 after a ${rels[0].holdS} s hold vs a ${rels[rels.length - 1].holdS} s hold: ` +
        `${(lo * 1e3).toFixed(0)} vs ${(hi * 1e3).toFixed(0)} ms`)
      console.log(hi > lo * 1.05
        ? '   → THE RELEASE STRETCHES WITH EXPOSURE — a tail is present, as we model.'
        : '   → ⚠ NO STRETCH WITH EXPOSURE. A single-stage release; our TAIL_FRACTION /\n'
          + '     TAIL_MULT have nothing to fit against on this reference.')
    }

    const knobs = knobsFromName(file)
    console.log(`\n   declared knobs: attack ${showKnob(knobs.attack)}, release ${showKnob(knobs.release)}`)

    // ── Matched measurement against our own kernel ──────────────────────────
    const deepest = bursts[bursts.length - 1]
    const params = { inputDrive: 55, ratio: '4', fetDrive: 0, attack: 4, release: 4 }
    for (const [sweep, label, pick, fmt] of [
      ['attack', 'overshoot', bs => bs[bs.length - 1]?.overshootDb, v => v.toFixed(2) + ' dB'],
      ['release', 'release t63', bs => bs[bs.length - 1]?.releaseT63, v => (v * 1e3).toFixed(0) + ' ms'],
    ]) {
      const target = pick(bursts)
      if (!Number.isFinite(target)) continue
      const table = ourDialTable(plan, stim, sampleRate, params, sweep)
      const m = matchDial(table, target, pick)
      console.log(`\n   MATCHED MEASUREMENT on ${label} (${sweep}):`)
      console.log('     our dial   ' + table.map(r => String(r.dial).padStart(9)).join(''))
      console.log('     measured   ' + table.map(r => {
        const v = pick(r.bursts)
        return (Number.isFinite(v) ? (sweep === 'attack' ? v.toFixed(1) : (v * 1e3).toFixed(0)) : '--').padStart(9)
      }).join(''))
      console.log(`     reference reads ${fmt(target)}`)
      if (!m) {
        console.log('     ⚠ too few usable dials to place it.')
      } else if (m.outside) {
        const endpoint = sweep === 'attack'
          ? (m.outside === 'slow' ? 'ATTACK_SLOWEST_S' : 'ATTACK_FASTEST_S')
          : (m.outside === 'slow' ? 'RELEASE_SLOWEST_S' : 'RELEASE_FASTEST_S')
        console.log(`     ⚠⚠ OUTSIDE OUR RANGE — ${m.outside === 'slow' ? 'slower' : 'faster'} than dial ${m.dial},`)
        console.log(`        which reads ${fmt(m.value)}. This is NOT a dial: it is a finding about`)
        console.log(`        ${endpoint}, whose only provenance is a datasheet both plugins quote.`)
      } else if (m.nonMonotonic) {
        console.log(`     ⚠ our table is not monotonic on this statistic, so it cannot be interpolated.`)
        console.log(`       Nearest is dial ${m.dial} (${fmt(m.value)}), residual ${fmt(Math.abs(m.residual))}.`)
      } else {
        const t = sweep === 'attack'
          ? (attackSecondsForDial(m.dial) * 1e6).toFixed(0) + ' us'
          : (releaseSecondsForDial(m.dial) * 1e3).toFixed(0) + ' ms'
        console.log(`     →  our dial ${m.dial.toFixed(2)}  (between ${m.between[0]} and ${m.between[1]}) = ${t}`)
      }
    }
    console.log(`\n   ⚠ Read the dial, not the microseconds. Measured t63 runs ~2.9x the constant`)
    console.log('     behind it, on both sides, which is why the comparison is dial-to-dial.\n')
  }
  console.log('Protocol and what each column answers: docs/fet1176_capture_protocol.md\n')
}

// ── Entry ───────────────────────────────────────────────────────────────────

function rateFromArgs(args) {
  const i = args.indexOf('--rate')
  if (i < 0) return DEFAULT_SR
  const v = Number(args[i + 1])
  if (!Number.isFinite(v) || v < 44100) {
    console.error(`--rate needs a sample rate >= 44100, got "${args[i + 1]}"`)
    process.exit(1)
  }
  return v
}

function writeStimulus(sampleRate) {
  mkdirSync(STIM_DIR, { recursive: true })
  if (!existsSync(CAP_DIR)) mkdirSync(CAP_DIR, { recursive: true })
  console.log(`\nWriting FET Punch stimulus to ${STIM_DIR} at ${sampleRate} Hz\n`)
  for (const [file, planFn] of Object.entries(PLANS)) {
    const plan = planFn()
    const { x } = buildProbe(plan, sampleRate)
    writeFloatWav(join(STIM_DIR, file), x, sampleRate)
    console.log(`  ${file.padEnd(14)} ${plan.seconds.toFixed(1).padStart(6)} s   ` +
      `${plan.events.length} events   probe ${plan.events[0].freqHz} Hz`)
  }

  console.log(`
CAPTURE MATRIX — the stimulus files above do not change across it, only knobs do.

  reference   FETish and CLA-76 separately. Label every capture with which.
              Analog noise / hiss OFF on any reference that offers it, or it
              lands in the trace as gain that is not gain.

  stairs.wav      attack 1, release 7        (see the plan note — a fast attack
                  ratio  4 / 8 / 12 / 20 / all     leaves nothing settled to read)
                  Input  20 / 40 / 60 / 80
                  = 20 bounces per reference.

  bursts.wav      ratio 4, Input 50
                  attack 1..7 at release 4   = 7 bounces
                  release 1..7 at attack 7   = 7 bounces (one shared corner)
                  then ratio 'all' at attack 4 / release 4 = 1 bounce
                  = 14 bounces per reference.

  frequency.wav   ratio 4, Input 50, attack 1, release 7. 1 bounce. HOLD-OUT.

  thd.wav         ratio 4, attack 1, release 7, Input 20 / 50 / 80. 3 bounces.

⚠ START EVERY BOUNCE AT THE FILE'S FIRST SAMPLE. Events are POSITIONED around
  the 20 s demo-mute grid, which is relative to the RENDER's start, not the
  file's — a bounce with pre-roll slides every event into the mutes it was
  placed to avoid, and the only symptom is events going missing.

⚠ BOUNCE AT ${sampleRate} Hz, 32-bit float, NO dither, and with the reference's
  own output/makeup control at unity. A rate mismatch against the stimulus is
  not recoverable downstream.

⚠ DISABLE PLUGIN DELAY COMPENSATION, or note that it is on. A constant latency
  is removable by alignment; what is not removable is a host that compensates by
  a number it will not tell you while the trace is being read as an attack.

Captures go in ${CAP_DIR} (gitignored — *.wav is ignored repo-wide, so no
licensed audio reaches the repo).

⚠ RUN THE FOUR-BOUNCE NULL TEST FIRST. It can disqualify a reference, or show a
  knob is not what it says, before you spend the other 38. Full protocol,
  including what to log per capture:  docs/fet1176_capture_protocol.md
`)
}

/**
 * ⚠ THE CLI RUNS ONLY WHEN THIS FILE IS THE ENTRY POINT, and that guard is
 * load-bearing rather than tidy. The plan builders above are exported BECAUSE a
 * fitter is meant to import them rather than read a manifest — and without this
 * check, `import { PLANS }` executed the argv dispatch and printed the usage
 * text into the importer's output. Caught by importing it.
 */
const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

const args = isEntryPoint ? process.argv.slice(2) : []
const sr = isEntryPoint ? rateFromArgs(args) : DEFAULT_SR

const dirArg = args.indexOf('--dir')
const capDirOverride = dirArg >= 0 && args[dirArg + 1] ? args[dirArg + 1] : null

if (!isEntryPoint) {
  // imported as a library — the plans and `runKernel` are the API
} else if (args.includes('--fit') && args.includes('--selftest')) {
  const dir = capDirOverride || mkdtempSync(join(tmpdir(), 'fet-bal-'))
  fitCaptures(sr, writeFitSelftest(dir, sr))
} else if (args.includes('--fit')) {
  fitCaptures(sr, capDirOverride || CAP_DIR)
} else if (args.includes('--selftest')) {
  selftest(sr)
} else if (args.includes('--stimulus')) {
  writeStimulus(sr)
} else {
  console.log(`
FET Punch capture tooling. Pick a mode:

  npm run fet:stimulus     write the test signals and print the capture matrix
  npm run fet:selftest     prove the gain trace against our own kernel
  npm run fet:ballistics   fit whatever bursts captures are present

Both take --rate <hz> (default ${DEFAULT_SR}).

Fitting captured references is not wired yet — the stimulus and the recovery
come first, and the recovery is proved against a kernel whose constants are
known before it is pointed at one whose constants are not.
`)
}
