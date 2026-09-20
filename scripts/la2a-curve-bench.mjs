#!/usr/bin/env node
/**
 * OptoSmooth's nonlinearity, curve against curve, on tones and on real speech.
 *
 *   npm run la2a:curve              the bench: ladder, passage, matched-GR render
 *   npm run la2a:curve -- --write   also emit level-matched A/B wavs to listen to
 *   npm run la2a:curve -- --cell-only   valve stage off, to isolate the cell
 *   npm run la2a:curve:selftest     prove the instrument on planted curves
 *
 * WHY THIS EXISTS. The shipping cell and valve curves are Tube Saturation's,
 * chosen by ear, and CLAUDE.md is explicit that the Moore calibration does not
 * describe them. The complaint they were brought in to answer has come back
 * inverted: the harmonics are liked, the behaviour on loud peaks is not. That
 * is a claim about the SHAPE of a static curve, and a static curve is the one
 * thing in this plugin that can be compared without a bounce — so this compares
 * them, against the FET reference polynomial and against a candidate identified
 * from the LA-2A captures already in the ledger.
 *
 * ⚠ THIS REPORTS; IT DOES NOT WRITE. Same rule as `la2a-tube-fit.mjs`: there is
 * no `--fit` that lands a constant in `la2aProcessor.js`. Nothing here is
 * shipped, `QUARTIC_C3`/`QUARTIC_C4` are a candidate and not a calibration, and
 * `--write` emits audio to the gitignored corpus, never to source.
 *
 * ── THE THREE SECTIONS, AND WHY IT TAKES THREE ──────────────────────────────
 *
 * A. LADDER — tone probes, DFT at exact harmonics. The house method
 *    (`scripts/lib/harmonics.js`), immune to phase, and the only one of the
 *    three that is rigorous about harmonic ORDER. This is where "the FET curve
 *    stops at H5 and the soft clipper does not" becomes a number.
 *
 * B. PASSAGE — the same curves over the amplitude distribution of real
 *    narration, banded by level. A tone ladder says what a curve does at one
 *    amplitude; this says how much of the file lands where the curve misbehaves,
 *    which is the actual complaint. Metric is residual-after-best-linear-fit,
 *    so it carries no phase and no ballistics.
 *
 * C. RENDER — the whole kernel, both curves, at matched gain reduction.
 *    A and B are properties of a curve; this is the plugin. It exists to catch
 *    the case where a curve that measures better disappears behind the cell's
 *    drive law, or reaches the valve at a different level.
 *
 * ⚠ A TONE LADDER UNDERSTATES A MEMORYLESS SHAPER ON PROGRAMME BY ~11 dB — the
 * ledger's own figure, and the reason section B exists rather than a THD column.
 * Intermodulation between partials is absent from a single-tone probe and is
 * most of what a waveshaper does to speech. Read A for ORDER and B for AMOUNT;
 * neither answers the other's question.
 *
 * ── WHAT THE CANDIDATE IS, AND WHAT IT IS NOT ───────────────────────────────
 *
 * `quartic` is Analog Obsession LALA's output stage, identified from the
 * harmonic readings already recorded in `docs/claude-dev-log.md` (the captures
 * themselves are gitignored and are not needed to reproduce this):
 *
 *   H2 −89.7 / H3 −107.2 / H4 −101.8 dBc at −18 dBFS, Gain 0   (line 312)
 *   H2 −155.7 / −89.7 / −38.7 / −8.1 at −40 / −18 / −1 / +9.2  (line 316)
 *   slopes, dB per dB of input: H2 3.06, H3 1.95               (line 316)
 *
 * A term of order n makes harmonics rising (n−1) dB per dB, so H2 at 3.06 reads
 * as order 4 and H3 at 1.95 as order 3 — and H4−H2 measures −12.10 dB against a
 * pure x⁴ term's −12.04. Fitting `c4` to the −18 dBFS H2 alone then predicts the
 * other three levels to 0.00 dB and H4 to 0.06, and `--selftest` pins that.
 *
 * ⚠⚠ THE LOG HAD ALREADY DONE THIS AND THIS SCRIPT REDISCOVERED IT. See the entry
 * "THE LALA HAS AN OUTPUT STAGE TOO, AND IT IS A POLYNOMIAL WITH NO QUADRATIC
 * TERM", which recovered the same two constants to four figures from 21 measured
 * numbers — and did it better, taking `a₄` from H2 and H4 independently. What the
 * re-derivation below is worth is that it used a DIFFERENT subset (one level) and
 * landed in the same place. It is corroboration, not the source.
 *
 * ⚠⚠ AND IT IDENTIFIES THE OUTPUT STAGE ONLY. Both sweeps were captured at Gain 0
 * / PEAK REDUCTION 0, cell idle. Nothing here measures the T4, so the `quartic`
 * option at the CELL carries none of this pedigree — see the module header.
 *
 * ⚠ IT IS ONE REFERENCE, AND PICKING IT IS PICKING A SIDE. The dev log's
 * position (line 317) is that the two emulations disagree by 10–77 dB and any
 * refit chooses between them. That still holds for MAGNITUDE. It does not hold
 * for SHAPE, and the asymmetry is worth stating: CLA-2A's H2/H3 slopes of
 * 0.77/0.66 are not reachable by any memoryless polynomial at all — a genuine
 * third-order term goes as level², so a sub-unity slope over 39 dB is not a
 * curve being driven. On the question this bench asks, there is one usable
 * reference and CLA-2A abstains.
 *
 * ⚠ THE SIGN OF `c4` IS NOT DETERMINED BY ANY OF IT. Harmonic magnitudes carry
 * no phase, so which polarity expands is unknown from the transcribed numbers —
 * the same standing unknown as `VOCAL_SAT_CURVE_LEAN_POSITIVE`. Positive is
 * assumed here. `--flip` runs the other sign; settling it needs the captures.
 *
 * ⚠ THE DEPTH IS A SEPARATE QUESTION FROM THE SHAPE, AND IT IS AN EAR DECISION.
 * `c4` is LALA's, and LALA is 25.9 dB cleaner at nominal than the Moore paper's
 * six hardware units. Drive spans that: 1.0 is LALA's own, 2.70 puts H2 on the
 * paper's −63.80 dBc median. Nothing measured chooses between them.
 *
 * ⚠⚠ AN EARLIER VERSION OF THIS HEADER CLAIMED A CEILING ON THAT DEPTH — a fold
 * at drive 1.976, a monotonicity limit 8 dB under the Moore anchor, and the
 * conclusion that the shape could not carry the hardware's magnitude without
 * borrowing the FET kernel's partner term. ALL THREE WERE WRONG, and they came
 * from one bug: this script guarded the polynomial's domain in x when the drive
 * convention evaluates it at u = d·x. Guarded in u the drive cancels out of the
 * slope entirely, the stage is monotone at every drive, and the Moore anchor
 * sits at peak u = 0.34 — comfortably inside the measured domain. The curve now
 * lives in `src/audio/dsp/quarticSatCurve.js`; its header has the derivation.
 */

import { readdirSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { readWav, writeFloatWav } from './lib/wav.js'
import { harmonicsAt } from './lib/harmonics.js'
import { makeVocalSatCurve } from '../src/audio/dsp/vocalSatCurve.js'
import {
  makeQuarticSatCurve, QUARTIC_C3, QUARTIC_C4, QUARTIC_XMAX, QUARTIC_MOORE_DRIVE,
} from '../src/audio/dsp/quarticSatCurve.js'
import { gatedRmsOfChannels, alignDbForRms } from '../src/audio/dsp/inputAlign.js'
import {
  LA2AKernel, CELL_CURVE_DRIVE_MAX, VALVE_CURVE_DRIVE,
} from '../src/audio/la2aProcessor.js'

const ROOT = process.cwd()
const CORPUS = path.join(ROOT, 'data/corpus/la2a')
const OUT_DIR = path.join(ROOT, 'data/corpus/la2a-curve-bench')

const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))
const lin = d => Math.pow(10, d / 20)

/** Where the plugin's own input alignment puts programme material. */
const NOMINAL_DBFS = -18

// ── The candidate curve ─────────────────────────────────────────────────────

/**
 * ⚠ THE CANDIDATE LIVES IN `src/audio/dsp/quarticSatCurve.js` AND IS IMPORTED,
 * NOT RESTATED. It began life here as a bench-local curve and moved into the
 * kernel when it became selectable on the panel; leaving a copy behind is the
 * thing CLAUDE.md warns about for Scheps and the LA-2A kernel — the next tuning
 * pass reaches one of them and not the other. The identification below still
 * re-derives the constants from the ledger's readings on every run, so this
 * script is still where the claim is checked.
 *
 * ⚠⚠ AND THE COPY THAT USED TO BE HERE HAD A BUG THE MODULE DOES NOT. It guarded
 * the polynomial's domain in x where the drive convention needs it in u = d·x,
 * which let the coefficients grow over a fixed range and fold the curve. That
 * produced three findings this script once printed and all three were artifacts:
 * a fold at drive 1.976, a monotonicity ceiling 8 dB under the Moore anchor, and
 * the conclusion that the shape could not carry the hardware's magnitude. See
 * the module header.
 */

/**
 * The FET kernel's measured curve, for orientation only.
 *
 * ⚠ RESTATED, NOT IMPORTED, AND THIS IS THE ONE PLACE THAT IS RIGHT. The
 * constants live in `fet1176Processor.js` as module-private `POLY_C4`/`POLY_C5`
 * beside a `registerProcessor` call at module scope — importing that file to
 * reach them is what put a duplicate worklet registration into two bundles and
 * broke whichever plugin loaded second (see the note at the top of
 * `dsp/satCurves.js`). A bench script is not worth re-opening that. The values
 * are pinned against the kernel's own rendering by `--selftest`.
 */
export const FET_C4 = -0.0100
export const FET_C5 = 0.0100
export const FET_XMAX = 1.0

function makeFetCurve() {
  const fAt = x => x + FET_C4 * x ** 4 + FET_C5 * x ** 5
  const dAt = x => 1 + 4 * FET_C4 * x ** 3 + 5 * FET_C5 * x ** 4
  const ep = fAt(FET_XMAX); const sp = dAt(FET_XMAX)
  const en = fAt(-FET_XMAX); const sn = dAt(-FET_XMAX)
  const transfer = (x) => {
    if (x > FET_XMAX) return ep + (x - FET_XMAX) * sp
    if (x < -FET_XMAX) return en + (x + FET_XMAX) * sn
    return fAt(x)
  }
  return { transfer, transferAt: x => transfer(x), inverse: null, drive: 1, minSlope: NaN }
}

// ── The candidates ──────────────────────────────────────────────────────────

/**
 * ⚠ THE TWO SHIPPING ENTRIES READ THEIR DRIVE FROM THE KERNEL, NOT FROM A
 * LITERAL. `CELL_CURVE_DRIVE_MAX` and `VALVE_CURVE_DRIVE` are what the plugin
 * uses; a copy here would make this bench report on a plugin that no longer
 * exists the first time either moves, which is the failure
 * `scripts/la2a-tube-fit.mjs` records having already had.
 */
function candidates({ depth, flip }) {
  return [
    ['cell   TubeSat', makeVocalSatCurve({ curveDrive: CELL_CURVE_DRIVE_MAX })],
    ['valve  TubeSat', makeVocalSatCurve({ curveDrive: VALVE_CURVE_DRIVE })],
    [`quartic d=${depth}`, makeQuarticSatCurve({ drive: depth, leanPositive: !flip })],
    ['FET     poly  ', makeFetCurve()],
  ]
}

// ── A. The ladder ───────────────────────────────────────────────────────────

const SR = 48000
const LADDER_N = 1 << 15
const N_HARM = 20
const LADDER_DBFS = [-30, -18, -12, -6, -1]

/**
 * The probe, chosen so the window holds a whole number of cycles of EVERY
 * harmonic — not a round number of hertz.
 *
 * ⚠ THIS IS THE INSTRUMENT'S ONE REAL TRAP AND THE SELFTEST CAUGHT IT. A first
 * cut used a flat 220 Hz, which at 48 kHz is 218.18 samples per cycle. `dftMag`
 * rounds to an integer number of cycles of the harmonic it is reading, so a
 * non-integer period leaves a partial sample at the window edge and the
 * fundamental leaks across the whole spectrum. Measured, a PURE QUARTIC — a
 * curve that cannot make a harmonic above the fourth — came back with 15.1 % of
 * its distortion energy above H5, its H2 slope read 4.12 instead of 3.00, and a
 * hard clipper read CLEANER than it at 3.1 %. Every headline this bench exists
 * to produce was wrong, and all four numbers looked plausible.
 *
 * `SR · cycles / N` makes the period exactly `N / cycles` samples, so the window
 * is an integer number of cycles of the k-th harmonic for every k and the DFT
 * needs no window function. 150 cycles over 32768 samples lands at 219.7 Hz —
 * low enough that H20 is still well inside the band.
 */
const PROBE_CYCLES = 150
const PROBE_HZ = (SR * PROBE_CYCLES) / LADDER_N

/**
 * Harmonics of one curve at one level, plus the share of distortion energy
 * above the fifth.
 *
 * The share is the metric `test/dsp/vocalSat.test.js` already uses for this
 * question. Total distortion says how MUCH; this says how much of it is the
 * high-order content that reads as grit rather than as warmth. A degree-5
 * polynomial scores 0 by construction — it has no harmonic above the fifth.
 *
 * ⚠ DO NOT READ THE SHARE AS THE HEADLINE — MEASURED, IT IS THE SMALLER EFFECT
 * HERE, and the first pass at this comparison got that wrong. The shipping cell
 * curve's ladder runs visibly to H8 and beyond where the polynomials stop dead,
 * which invites "the dense ladder is the harshness" — but energetically that
 * content is 0.11 % of its distortion at −6 dBFS and 0.23 % at −1. What actually
 * separates the curves is the AMOUNT: H2 −29.4 dBc against the FET curve's
 * −64.0 at the same level, a factor of fifty. The share column is worth having
 * because order and amount are separate axes and a curve could differ on either,
 * but on THESE curves the amount column is where the difference lives.
 */
function ladderRow(curve, ampDbfs) {
  const n = LADDER_N
  const y = new Float64Array(n)
  const A = lin(ampDbfs)
  for (let i = 0; i < n; i++) y[i] = curve.transfer(A * Math.sin(2 * Math.PI * PROBE_HZ * i / SR))
  const h = harmonicsAt(y, 0, n, SR, PROBE_HZ, N_HARM)
  let total = 0; let high = 0
  h.dBc.forEach((v, i) => {
    const k = i + 2
    const e = Math.pow(10, v / 10)
    total += e
    if (k > 5) high += e
  })
  return { dBc: h.dBc, thdPct: h.thdPct, highSharePct: total > 0 ? (100 * high) / total : 0 }
}

function sectionLadder(cands) {
  console.log('\n══ A. LADDER — tone probes, dBc against the fundamental ══')
  console.log(`   ${PROBE_HZ.toFixed(1)} Hz (${PROBE_CYCLES} whole cycles in the window), DFT at exact`)
  console.log('   harmonics. "hi%" is the share of distortion energy above H5.')
  console.log('   ⚠ Read the H2 column, not hi% — see `ladderRow`.\n')
  for (const [name, curve] of cands) {
    console.log(`  ${name}`)
    console.log('    dBFS |     H2     H3     H4     H5     H6     H7     H8 |   THD%   hi%')
    for (const L of LADDER_DBFS) {
      const r = ladderRow(curve, L)
      const cells = r.dBc.slice(0, 7)
        .map(v => (v < -200 ? '     —' : v.toFixed(1).padStart(6))).join(' ')
      console.log(`   ${String(L).padStart(5)} | ${cells} | ${r.thdPct.toFixed(3).padStart(6)} `
        + `${r.highSharePct.toFixed(1).padStart(5)}`)
    }
    // Level slope, for comparison against the references' measured columns.
    const lo = ladderRow(curve, -30); const hi = ladderRow(curve, -6)
    const slope = i => ((hi.dBc[i] - lo.dBc[i]) / 24).toFixed(2).padStart(5)
    console.log(`    slope dB/dB (−30→−6):  H2 ${slope(0)}   H3 ${slope(1)}`)
    console.log()
  }
  console.log('  measured references, same columns:')
  console.log('    LALA     H2 3.06  H3 1.95      CLA-2A   H2 0.77  H3 0.66')
  console.log('    FETish   H2 3.00  H3 4.04      ⚠ CLA-2A is not polynomial-reachable')
}

// ── B. The passage ──────────────────────────────────────────────────────────

/**
 * How much of what a curve does to this passage is NOT a gain.
 *
 * THE METRIC. Fit one gain `g` across the whole passage by least squares, then
 * report the residual `f(x) − g·x` as energy against the output, banded by the
 * sample's own amplitude. A memoryless curve is a gain plus a residual by
 * definition, and the residual is the entire nonlinearity.
 *
 * ⚠ THE GAIN IS FITTED GLOBALLY AND THE RESIDUAL READ PER BAND, NEVER BOTH PER
 * BAND. A per-band gain absorbs exactly the curvature this is trying to find and
 * every curve comes back clean — the same trap `la2a-cellmod-fit.mjs` documents
 * for its local fit, where the fit is deliberately taken on the MID band and
 * read on the loud one.
 *
 * ⚠ NO PHASE AND NO BALLISTICS ARE IN THIS NUMBER, which is what makes it
 * comparable across curves — and also what it cannot see. It is a property of
 * the curve over this file's amplitude histogram, not of the plugin. Section C
 * is the plugin.
 */
function residualBands(curve, x, drive) {
  const f = drive === undefined
    ? (v => curve.transfer(v))
    : (v => curve.transferAt(v, drive))
  const n = x.length
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) y[i] = f(x[i])

  let xy = 0; let xx = 0
  for (let i = 0; i < n; i++) { xy += x[i] * y[i]; xx += x[i] * x[i] }
  const g = xx > 0 ? xy / xx : 1

  // Bands of the passage's own peak, so "peaks" means this file's peaks.
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]))
  const edges = [0, 0.25, 0.5, 0.75, 1.0001]
  const rSq = new Float64Array(edges.length - 1)
  const ySq = new Float64Array(edges.length - 1)
  let rAll = 0; let yAll = 0
  for (let i = 0; i < n; i++) {
    const r = y[i] - g * x[i]
    const a = peak > 0 ? Math.abs(x[i]) / peak : 0
    let b = edges.length - 2
    for (let k = 0; k < edges.length - 1; k++) {
      if (a >= edges[k] && a < edges[k + 1]) { b = k; break }
    }
    rSq[b] += r * r; ySq[b] += y[i] * y[i]
    rAll += r * r; yAll += y[i] * y[i]
  }
  const bandDb = []
  for (let k = 0; k < rSq.length; k++) {
    bandDb.push(ySq[k] > 0 ? db(Math.sqrt(rSq[k] / ySq[k])) : NaN)
  }
  return { gainDb: db(g), totalDb: yAll > 0 ? db(Math.sqrt(rAll / yAll)) : NaN, bandDb }
}

function sectionPassage(cands, mono, sampleRate, file) {
  console.log(`\n══ B. PASSAGE — ${file} ══`)

  /**
   * ⚠ ALIGNED TO NOMINAL FIRST, AND THE BENCH IS WRONG WITHOUT IT. These curves
   * are FIXED drives, so where a file sits on the transfer is set by its level —
   * which is the argument `dsp/inputAlign.js` makes for the plugin and applies
   * unchanged here. Comparing curves on an unaligned file measures the file's
   * gain staging, not the curves.
   */
  const alignDb = alignDbForRms(gatedRmsOfChannels([mono], sampleRate))
  const g = lin(alignDb)
  const x = new Float64Array(mono.length)
  for (let i = 0; i < mono.length; i++) x[i] = mono[i] * g
  let peak = 0
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]))
  console.log(`   input align ${alignDb >= 0 ? '+' : ''}${alignDb.toFixed(2)} dB `
    + `→ peak ${db(peak).toFixed(1)} dBFS, ${(mono.length / sampleRate).toFixed(1)} s`)
  console.log('   residual energy re. output, dB — by band of this file\'s own peak\n')
  console.log('    curve            0–25%   25–50%  50–75%  75–100%  |  all')
  for (const [name, curve] of cands) {
    const r = residualBands(curve, x)
    const cells = r.bandDb.map(v => (Number.isFinite(v) ? v.toFixed(1).padStart(7) : '      —')).join(' ')
    console.log(`   ${name}  ${cells}  | ${r.totalDb.toFixed(1).padStart(6)}`)
  }
  console.log('\n   ⚠ Tone ladders understate a shaper on programme by ~11 dB (ledger).')
  console.log('     Read section A for ORDER, this for AMOUNT.')
}

// ── C. The render ───────────────────────────────────────────────────────────

/**
 * Run the kernel with a curve of our choosing patched in.
 *
 * ⚠ A BENCH HACK, STATED AS ONE. `setParams` builds `this.vsCurve` from the
 * mode selectors, and there is no param that reaches a curve the kernel does not
 * know about — so this sets the field afterwards and then never calls
 * `setParams` again, because a second call would rebuild it and silently revert
 * to the shipping curve mid-render. The kernel is untouched, which is the point:
 * a candidate gets auditioned through the real plugin without a mode landing in
 * shipping source before anyone has decided it should.
 */
function renderWith(mono, sampleRate, params, curve) {
  const k = new LA2AKernel(sampleRate)
  k.setParams(params)
  if (curve) k.vsCurve = curve
  const n = mono.length
  const out = new Float32Array(n)
  const BLOCK = 128
  const inCh = [mono]
  const outCh = [out]
  for (let off = 0; off < n; off += BLOCK) {
    const len = Math.min(BLOCK, n - off)
    k.process(inCh.map(c => c.subarray(off, off + len)),
      outCh.map(c => c.subarray(off, off + len)), len)
  }
  const m = k.getMetering()
  return { out, avgGrDb: m.avgGainReductionDb, maxGrDb: m.maxGainReductionDb }
}

function stats(y) {
  let peak = 0; let sq = 0
  for (let i = 0; i < y.length; i++) { peak = Math.max(peak, Math.abs(y[i])); sq += y[i] * y[i] }
  const rms = Math.sqrt(sq / y.length)
  return { peakDb: db(peak), rmsDb: db(rms), crestDb: db(peak) - db(rms) }
}

const RENDER_PR = [30, 55, 75]

function sectionRender(mono, sampleRate, { depth, flip, write, cellOnly }) {
  console.log('\n══ C. RENDER — the whole kernel, saturation curve swapped ══')
  /**
   * ⚠ THE SWAP REACHES BOTH STAGES, NOT JUST THE CELL, AND THE FIRST VERSION OF
   * THIS SECTION CLAIMED OTHERWISE. The shipping patch selects `vocalsat` at the
   * cell AND at the valve, and `setParams` builds ONE `vsCurve` that both read —
   * so replacing the field re-voices the valve too. There is no param that
   * separates them. `--cell-only` switches the valve off (`tube: false`, the
   * bench's own "off isolates the cell") so the cell can be heard alone; that is
   * not the shipping topology either, and both are worth running.
   */
  console.log(cellOnly
    ? '   Valve stage OFF — the cell alone. Not the shipping topology.'
    : '   One curve object feeds the cell AND the valve, so both move. --cell-only isolates.')
  console.log()

  /**
   * ⚠ GAIN REDUCTION IS CHECKED, NOT SOLVED FOR, AND THAT IS A RESULT RATHER
   * THAN A SHORTCUT. The detector sits ahead of the gain cell and never sees the
   * shaper, so swapping the curve cannot move the envelope — the two renders are
   * at matched GR at equal Peak Reduction by construction. The column is printed
   * so that stops being an assumption: if it ever drifts, the curve has reached
   * somewhere it should not have and every row below is comparing two different
   * operating points.
   */
  console.log('    PR |  curve          avg GR   peak    rms   crest |  Δrms   Δcrest')
  for (const pr of RENDER_PR) {
    const base = {
      mode: 'compress', peakReduction: pr, gainDb: 0, r37: 100, mix: 1,
      ...(cellOnly ? { tube: false } : {}),
    }
    const ship = renderWith(mono, sampleRate, base, null)
    const cand = renderWith(mono, sampleRate, base,
      makeQuarticSatCurve({ drive: depth, leanPositive: !flip }))
    const a = stats(ship.out); const b = stats(cand.out)
    const grDrift = Math.abs(ship.avgGrDb - cand.avgGrDb)
    console.log(`   ${String(pr).padStart(3)} | TubeSat (ships) ${ship.avgGrDb.toFixed(2).padStart(6)} `
      + `${a.peakDb.toFixed(2).padStart(7)} ${a.rmsDb.toFixed(2).padStart(7)} ${a.crestDb.toFixed(2).padStart(6)} |`)
    console.log(`       | quartic d=${depth}    ${cand.avgGrDb.toFixed(2).padStart(6)} `
      + `${b.peakDb.toFixed(2).padStart(7)} ${b.rmsDb.toFixed(2).padStart(7)} ${b.crestDb.toFixed(2).padStart(6)} | `
      + `${(b.rmsDb - a.rmsDb).toFixed(2).padStart(5)} ${(b.crestDb - a.crestDb).toFixed(2).padStart(7)}`)
    if (grDrift > 0.01) {
      console.log(`       ⚠ GR DRIFTED ${grDrift.toFixed(3)} dB between curves — rows are not comparable`)
    }
    if (write) {
      mkdirSync(OUT_DIR, { recursive: true })
      /**
       * ⚠ LEVEL-MATCHED BEFORE WRITING, OR THE AUDITION IS ABOUT LOUDNESS. The
       * two curves deliver different rms by construction (that is half of what
       * is being compared), and louder wins a blind A/B regardless of character.
       * Matched on rms, not peak: the complaint is about what happens to peaks,
       * so normalising on them would divide out the thing under test.
       */
      const trim = lin(a.rmsDb - b.rmsDb)
      const matched = new Float32Array(cand.out.length)
      for (let i = 0; i < matched.length; i++) matched[i] = cand.out[i] * trim
      const tag = cellOnly ? 'cellonly.' : ''
      writeFloatWav(path.join(OUT_DIR, `pr${pr}.${tag}tubesat.wav`), ship.out, sampleRate)
      writeFloatWav(path.join(OUT_DIR, `pr${pr}.${tag}quartic.wav`), matched, sampleRate)
      console.log(`       written: pr${pr}.${tag}tubesat.wav / pr${pr}.${tag}quartic.wav `
        + `(quartic trimmed ${(a.rmsDb - b.rmsDb).toFixed(2)} dB to match rms)`)
    }
  }
}

// ── The identification, re-derived every run ────────────────────────────────

/**
 * The dev log's readings, and what the candidate predicts for them.
 *
 * ⚠ PRINTED ON EVERY RUN RATHER THAN TRUSTED. `la2a-h2-refit.mjs` exists
 * because a previous derivation lived in prose, could not be re-run, and had two
 * premises that did not survive being checked. This is the same hazard one step
 * earlier: `QUARTIC_C4` is a number in this file, and the only thing that makes it
 * a measurement rather than a preference is that the arithmetic tying it to the
 * captures runs in front of whoever is reading the report.
 */
const LALA_MEASURED = {
  h2: { '-40': -155.7, '-18': -89.7, '-1': -38.7, 9.2: -8.1 },
  h3_18: -107.2,
  h4_18: -101.8,
}

function sectionIdentification() {
  console.log('\n══ THE CANDIDATE, RE-DERIVED ══')
  console.log(`   f(x) = x + ${QUARTIC_C3.toExponential(4)}·x³ + ${QUARTIC_C4.toFixed(6)}·x⁴`)
  const A = lin(NOMINAL_DBFS)
  // Small-signal closed form: H2/H1 = c4·A³/2, H3/H1 = c3·A²/4, H4/H1 = c4·A³/8.
  console.log('   fitted from the −18 dBFS row alone; everything else is held out.\n')
  console.log('    reading          measured  predicted    err')
  let worst = 0
  for (const L of ['-40', '-1', '9.2']) {
    const p = db(QUARTIC_C4 * Math.pow(lin(Number(L)), 3) / 2)
    const e = p - LALA_MEASURED.h2[L]
    worst = Math.max(worst, Math.abs(e))
    console.log(`    H2 @ ${String(L).padStart(5)} dBFS ${LALA_MEASURED.h2[L].toFixed(1).padStart(9)} `
      + `${p.toFixed(1).padStart(10)} ${e.toFixed(2).padStart(6)}`)
  }
  const p4 = db(QUARTIC_C4 * Math.pow(A, 3) / 8)
  worst = Math.max(worst, Math.abs(p4 - LALA_MEASURED.h4_18))
  console.log(`    H4 @   −18 dBFS ${LALA_MEASURED.h4_18.toFixed(1).padStart(9)} `
    + `${p4.toFixed(1).padStart(10)} ${(p4 - LALA_MEASURED.h4_18).toFixed(2).padStart(6)}`)
  console.log(`\n   worst held-out error ${worst.toFixed(2)} dB over 49 dB of level`)
  return worst
}

/**
 * What drive buys, and where the two anchors sit on it.
 *
 * ⚠ THIS SECTION ONCE REPORTED A MONOTONICITY CEILING AND THERE ISN'T ONE. The
 * curve is `g(d·x)/d`, so its slope is `g'(d·x)` and the drive CANCELS — the
 * stage presents the same minimum slope at every drive. The ceiling came from a
 * domain guard in the wrong variable; see the module header. The column is kept
 * because a claim that was wrong once is worth printing rather than asserting.
 */
function sectionDepth(flip) {
  console.log('\n══ DEPTH — what drive buys ══')
  console.log('   H2 @ −18 dBFS is the anchor column. LALA reads −89.7 dBc there;')
  console.log('   the Moore paper\'s six hardware units median −63.80.\n')
  console.log('    drive   H2@−18   peak u at nominal   min slope   clipping?')
  const A = lin(NOMINAL_DBFS)
  for (const d of [1, 1.5, QUARTIC_MOORE_DRIVE, 4, 6, 8]) {
    const c = makeQuarticSatCurve({ drive: d, leanPositive: !flip })
    const U = d * A
    const h2 = db(QUARTIC_C4 * U * U * U / 2)
    console.log(`   ${d.toFixed(2).padStart(5)} ${h2.toFixed(1).padStart(8)} `
      + `${U.toFixed(3).padStart(18)} ${c.minSlope.toFixed(4).padStart(11)}   `
      + (U > QUARTIC_XMAX ? 'past the measured domain' : 'inside'))
  }
  const c1 = makeQuarticSatCurve({ drive: 1, leanPositive: !flip })
  console.log(`\n   minimum slope is ${c1.minSlope.toFixed(4)} at EVERY drive — the stage is`)
  console.log('   monotone throughout, so `inverse()` and auto makeup always have an answer.')
  console.log(`   Moore's −63.80 dBc median sits at drive ${QUARTIC_MOORE_DRIVE.toFixed(2)}, peak u `
    + `${(QUARTIC_MOORE_DRIVE * A).toFixed(3)} — well inside the measured domain.`)
  console.log('   ⚠ Drive is an EAR decision. The shape is identified; the depth is not.')
  return c1.minSlope
}

// ── Selftest ────────────────────────────────────────────────────────────────

/**
 * Prove the instrument, not the candidate.
 *
 * ⚠ EVERY FIT SCRIPT IN THIS REPO HAS ONE AND THIS IS WHY. `fet-allbuttons-shape`
 * caught a secant-versus-incremental error in its own extractor with a planted
 * law; `la2a-cellmod-fit` proves its profile reader against the kernel it is
 * about to measure. A bench whose ladder or residual metric is wrong reports a
 * confident comparison between two curves and nothing notices.
 */
function selftest() {
  let fail = 0
  const ok = (cond, msg) => {
    console.log(`   ${cond ? 'ok  ' : 'FAIL'}  ${msg}`)
    if (!cond) fail++
  }
  console.log('\n══ SELFTEST ══\n')

  // 1. The ladder reads back a planted pure quartic: H4/H2 = 1/4 and slope 3.
  const planted = { transfer: x => x + 0.02 * x ** 4 }
  const lo = ladderRow(planted, -30); const hi = ladderRow(planted, -6)
  ok(Math.abs((hi.dBc[2] - hi.dBc[0]) - (-12.04)) < 0.15,
    `planted x⁴ reads H4−H2 = ${(hi.dBc[2] - hi.dBc[0]).toFixed(2)} dB (expect −12.04)`)
  ok(Math.abs((hi.dBc[0] - lo.dBc[0]) / 24 - 3) < 0.05,
    `planted x⁴ reads H2 slope ${((hi.dBc[0] - lo.dBc[0]) / 24).toFixed(3)} dB/dB (expect 3.00)`)
  ok(hi.highSharePct < 0.01,
    `a degree-4 curve has no content above H5 (share ${hi.highSharePct.toFixed(4)}%)`)

  /**
   * 2. The grit column can see high-order content when it is there.
   *
   * ⚠ THE PROBE IS CLIPPED HARD (0.05 against a 0.5 peak) BECAUSE THE SHARE IS
   * A RATIO AND IS NOT MONOTONE IN CLIP DEPTH. Measured across clip levels at
   * −6 dBFS: 0.45 → 9.3 %, 0.30 → 3.0, 0.20 → 1.3, 0.10 → 10.7, 0.05 → 21.3.
   * The dip is real — at moderate clipping H3 grows faster than H7 and up, so
   * the denominator outruns the numerator. A mild clipper is therefore a weak
   * discriminator and a first version of this check asserted > 10 % against one,
   * which failed for a reason that had nothing to do with the instrument.
   */
  const clipper = { transfer: x => Math.max(-0.05, Math.min(0.05, x)) }
  ok(ladderRow(clipper, -6).highSharePct > 15,
    `a hard clipper reads ${ladderRow(clipper, -6).highSharePct.toFixed(1)}% above H5`)

  // 3. Residual metric: exactly zero on a pure gain, non-zero on a curve.
  const n = 4096
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 13 * i / n)
  const rLin = residualBands({ transfer: v => 0.7 * v }, x)
  ok(rLin.totalDb < -120, `a pure gain leaves no residual (${rLin.totalDb.toFixed(1)} dB)`)
  ok(Math.abs(rLin.gainDb - db(0.7)) < 1e-9,
    `and the fitted gain recovers it exactly (${rLin.gainDb.toFixed(6)} vs ${db(0.7).toFixed(6)})`)
  const rNl = residualBands(makeQuarticSatCurve({ drive: 2 }), x)
  ok(rNl.totalDb > rLin.totalDb + 60, `a quartic leaves one (${rNl.totalDb.toFixed(1)} dB)`)
  ok(rNl.bandDb[3] > rNl.bandDb[0],
    `and it is larger on peaks than on the body (${rNl.bandDb[3].toFixed(1)} vs ${rNl.bandDb[0].toFixed(1)} dB)`)

  // 4. The identification reproduces every held-out reading.
  const worst = sectionIdentification()
  ok(worst < 0.1, `held-out LALA readings reproduce to ${worst.toFixed(2)} dB`)

  // 5. Curve contract: continuity at XMAX, and the inverse round-trips.
  const c = makeQuarticSatCurve({ drive: 1.5 })
  const eps = 1e-7
  ok(Math.abs(c.transfer(QUARTIC_XMAX + eps) - c.transfer(QUARTIC_XMAX - eps)) < 1e-6,
    'the linear continuation is continuous at +XMAX')
  ok(Math.abs(c.transfer(-QUARTIC_XMAX + eps) - c.transfer(-QUARTIC_XMAX - eps)) < 1e-6,
    'and at −XMAX')
  let worstInv = 0
  for (let v = -0.95; v <= 0.95; v += 0.05) {
    const back = c.inverse(c.transfer(v))
    worstInv = Math.max(worstInv, Math.abs(back - v))
  }
  ok(worstInv < 1e-6, `inverse round-trips to ${worstInv.toExponential(1)}`)
  /**
   * ⚠ THIS CHECK USED TO ASSERT THE OPPOSITE — that a deep drive folds the curve
   * and `inverse` returns null. It passed against the bench's old x-space domain
   * guard, which is exactly how a wrong guard got reported as a property of the
   * curve for a whole session. Guarded in u the drive cancels out of the slope,
   * so the invariant is monotone-at-every-drive and this pins THAT.
   */
  let worstSlope = Infinity
  for (const d of [0.25, 1, 2.7, 6, 12, 40]) {
    worstSlope = Math.min(worstSlope, makeQuarticSatCurve({ drive: d }).minSlope)
  }
  ok(worstSlope > 0.8,
    `monotone at every drive 0.25–40, worst slope ${worstSlope.toFixed(4)}`)
  const deep = makeQuarticSatCurve({ drive: 12 })
  let worstDeep = 0
  for (let v = -0.95; v <= 0.95; v += 0.05) {
    worstDeep = Math.max(worstDeep, Math.abs(deep.inverse(deep.transfer(v)) - v))
  }
  ok(worstDeep < 1e-6, `and inverse still round-trips at drive 12 (${worstDeep.toExponential(1)})`)

  // 6. transferAt matches transfer at the built drive — the cell path and the
  //    hoisted path must not disagree, or preview and apply diverge.
  let worstAt = 0
  for (let v = -1.2; v <= 1.2; v += 0.05) {
    worstAt = Math.max(worstAt, Math.abs(c.transferAt(v, 1.5) - c.transfer(v)))
  }
  ok(worstAt < 1e-12, `transferAt agrees with transfer at the built drive (${worstAt.toExponential(1)})`)
  ok(c.transferAt(0.5, 0) === 0.5, 'and is the identity at zero drive, as the cell needs')

  // 7. The restated FET constants still match the shipping kernel's curve.
  //    Rendered rather than compared as literals — the point is the CURVE.
  const fet = makeFetCurve()
  ok(Math.abs(fet.transfer(1) - 1) < 1e-12,
    'FET poly is exactly unity at x=1 (the x⁵ partner cancels the x⁴)')
  ok(Math.abs(db(fet.transfer(-1) / -1) - 0.172) < 0.005,
    `FET poly reads ${db(fet.transfer(-1) / -1).toFixed(3)} dB at x=−1 (expect 0.172)`)

  console.log(`\n   ${fail === 0 ? 'all checks passed' : `${fail} FAILED`}`)
  return fail
}

// ── Entry ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--selftest')) process.exit(selftest() === 0 ? 0 : 1)

  const depthArg = args.find(a => a.startsWith('--depth='))
  const depth = depthArg ? Number(depthArg.split('=')[1]) : 1.5
  const flip = args.includes('--flip')
  const write = args.includes('--write')
  const cellOnly = args.includes('--cell-only')
  const fileArg = args.find(a => a.startsWith('--file='))

  if (!Number.isFinite(depth) || depth <= 0) {
    console.error(`--depth must be a positive number, got "${depthArg}"`)
    process.exit(1)
  }

  console.log('OptoSmooth curve bench')
  console.log(`  candidate drive ${depth}${flip ? ', sign FLIPPED' : ''}`)

  sectionIdentification()
  sectionDepth(flip)
  const cands = candidates({ depth, flip })
  sectionLadder(cands)

  if (!existsSync(CORPUS)) {
    console.log(`\n⚠ No corpus at ${path.relative(ROOT, CORPUS)} — sections B and C skipped.`)
    console.log('  Drop narrator recordings there (gitignored) and re-run.')
    return
  }
  const files = readdirSync(CORPUS).filter(f => /\.wav$/i.test(f)).sort()
  const chosen = fileArg ? files.filter(f => f.includes(fileArg.split('=')[1])) : files
  if (chosen.length === 0) {
    console.log(`\n⚠ No matching WAVs in ${path.relative(ROOT, CORPUS)} — sections B and C skipped.`)
    return
  }
  for (const file of chosen) {
    const { mono, sampleRate } = readWav(path.join(CORPUS, file))
    sectionPassage(cands, mono, sampleRate, file)
    sectionRender(mono, sampleRate, { depth, flip, write, cellOnly })
  }
}

if (path.basename(process.argv[1] ?? '') === 'la2a-curve-bench.mjs') main()
