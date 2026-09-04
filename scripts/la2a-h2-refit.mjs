/**
 * TUBE_DRIVE_LIN, re-derived against the paper's H2 column.
 *
 *   npm run la2a:h2:refit          report at the shipping constant
 *   npm run la2a:h2:refit -- --fit solve for the constant that hits the target
 *
 * WHY THIS EXISTS RATHER THAN A NUMBER IN A COMMENT. The previous derivation of
 * this constant was recorded in prose and could not be re-run, and two of its
 * stated premises did not survive being checked (see CORRECTIONS below). This
 * script is the derivation, so the next person can disagree with it by running
 * it rather than by trusting it.
 *
 * THE TARGET. A. Moore, "Objective Analysis and Perceptual Evaluation of LA-2A
 * Compressors and Vocal Recordings," JAES 74(1/2):61-72 (2026) — six units,
 * five tones, +4 dBu in, 6 dB of gain reduction. The median of its 30 H2
 * measurements is -63.80 dBc. That figure is inherited from the previous
 * derivation and is NOT re-derived here: this repo has no copy of the paper's
 * per-unit table, so the median cannot be recomputed. It is the one number
 * below taken on trust.
 *
 * THE OPERATING POINT. +4 dBu is nominal line level, which this model anchors
 * at NOMINAL_DBFS = -18 dBFS, so the probe is a -18 dBFS tone with Gain at 0.
 * The knob is then solved PER FREQUENCY for 6.0 dB of gain reduction, because
 * the side-chain's 80 Hz high-pass makes a fixed knob produce different
 * reduction at 63 Hz and at 1 kHz.
 *
 * ⚠ CORRECTIONS TO THE PREVIOUS DERIVATION, both measured by this script.
 *
 *  1. THE OPERATING POINT WAS WRONG. It fitted at "Peak Reduction 54 for 6 dB
 *     GR". PR 54 produces 8.4 dB at 1 kHz and 9.2 dB at 250 Hz; 6 dB lands near
 *     PR 48. Fitting at ~2.5-3 dB more reduction means the valves saw that much
 *     less level, so the drive that hit the target there is hot at the paper's
 *     actual point — measured, H2 came out near -59.8 dBc against a -63.80
 *     target, about 4 dB hot.
 *
 *  2. THE REASON FOR USING ONLY TWO FREQUENCIES DID NOT HOLD. It excluded the
 *     low tones because "the compressor's OWN gain ripple swamps H2" there, at
 *     "-47 to -50 dBc" with the tanh bypassed. Bypassed, H2 at those
 *     frequencies measures -83 to -88 dBc — twenty-odd dB BELOW the tanh's own
 *     contribution, not above it. What sits at -51 to -66 dBc bypassed is H3,
 *     which is the detector ripple doing exactly what the cell-modulation note
 *     describes: a 2f ripple on an f carrier lands at f and 3f, odd content.
 *     H3 appears to have been read for H2. The `--verify` column below re-runs
 *     that check every time, so the claim stays falsifiable.
 *
 *     Consequence: all the tones are usable, and the fit spans them.
 *
 * ⚠ WHICH FIVE TONES THE PAPER USED IS NOT RECORDED CONSISTENTLY. The file
 * header says "five tones (63 Hz-1 kHz)"; the exclusion note names "80 / 120 /
 * 125 / 160 Hz" plus the two fitted, which is six. Without the paper this
 * cannot be settled, so PROBE_HZ below is the union of every frequency the
 * record names. It matters little: the model's H2 varies about 1.2 dB across
 * the whole span, so the tone set moves the fitted constant by well under a dB.
 *
 * ⚠ ONE TARGET, TWO CONSTANTS. H2 for a biased tanh goes as drive^2 * tanh(bias)
 * for weak drive, so -63.80 dBc defines a CURVE in (TUBE_DRIVE_LIN, TUBE_BIAS),
 * not a point. This script solves for the drive with the bias held. See
 * TUBE_BIAS in la2aProcessor.js for why that constant is held rather than
 * fitted, and for what it is not.
 */

import { LA2AKernel, TUBE_DRIVE_LIN, TUBE_BIAS } from '../src/audio/la2aProcessor.js'

const SR = 44100
const PROBE_DBFS = -18        // nominal line level, = the paper's +4 dBu
const TARGET_GR_DB = 6        // the paper's operating point
const H2_TARGET_DBC = -63.80  // median of the paper's 30 H2 measurements
const PROBE_HZ = [63, 80, 120, 125, 160, 250, 1000]

const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))
const lin = d => Math.pow(10, d / 20)

/**
 * Harmonic ratios of a settled tone, by exact-harmonic DFT over whole cycles —
 * the same no-window method `la2a-tube-fit.mjs` and `la2aTube.test.js` use, so
 * the numbers here are comparable to theirs.
 */
function probe(freq, { peakReduction, driveLin = null, seconds = 3, ...extra }) {
  const n = Math.round(SR * seconds)
  const amp = lin(PROBE_DBFS) * Math.SQRT2
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / SR)

  const k = new LA2AKernel(SR)
  k.setParams({ mode: 'compress', peakReduction, gainDb: 0, r37: 100, mix: 1, cellMod: 0, ...extra })
  // The shaper's constants are module-level, so a sweep overrides them on the
  // instance after setParams — which is the only thing setParams derives from
  // them, so nothing else goes stale.
  if (driveLin !== null) {
    k.tubeDriveLin = driveLin
    k.tubeNorm = driveLin * (1 - k.tanhBias * k.tanhBias)
  }

  const y = new Float32Array(n)
  for (let f = 0; f < n; f += 128) {
    const l = Math.min(128, n - f)
    k.process([x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
  }

  const cycle = SR / freq
  const off = 1000 + Math.round(SR * 0.2)          // past the cell settling
  const N = Math.floor((n - off - 1000) / cycle) * cycle
  const mag = (h) => {
    let re = 0, im = 0
    for (let i = 0; i < N; i++) {
      const p = 2 * Math.PI * h * freq * (off + i) / SR
      re += y[i + off] * Math.cos(p)
      im += y[i + off] * Math.sin(p)
    }
    return 2 * Math.hypot(re, im) / N
  }
  const h1 = mag(1)
  let thdSq = 0
  for (let h = 2; h <= 8; h++) thdSq += mag(h) ** 2
  return {
    h2: db(mag(2) / h1), h3: db(mag(3) / h1),
    thdPct: 100 * Math.sqrt(thdSq) / h1, gr: k.grDb,
  }
}

/** The Peak Reduction that puts this frequency at TARGET_GR_DB, by bisection. */
function knobFor(freq) {
  let lo = 0, hi = 100
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (probe(freq, { peakReduction: mid, seconds: 1.2 }).gr < TARGET_GR_DB) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

const knobs = new Map(PROBE_HZ.map(f => [f, knobFor(f)]))

/** Mean H2 across the probe tones, each at its own 6 dB knob. */
function meanH2(driveLin) {
  let s = 0
  for (const f of PROBE_HZ) s += probe(f, { peakReduction: knobs.get(f), driveLin }).h2
  return s / PROBE_HZ.length
}

const args = process.argv.slice(2)
const fit = args.includes('--fit')

console.log('Operating point: %s dBFS tone, %s dB gain reduction, Gain 0, cell modulation off',
  PROBE_DBFS, TARGET_GR_DB)
console.log('Target: H2 = %s dBc (median of the paper\'s 30 measurements)\n', H2_TARGET_DBC.toFixed(2))

console.log('  freq    knob for 6 dB GR    actual GR')
for (const f of PROBE_HZ) {
  const r = probe(f, { peakReduction: knobs.get(f) })
  console.log('  %s Hz        %s          %s dB',
    String(f).padStart(4), knobs.get(f).toFixed(1).padStart(5), r.gr.toFixed(2).padStart(5))
}

// Correction 2, re-run: is the detector's own H2 anywhere near the tanh's?
console.log('\n  freq    H2 (tanh on)   H2 (tanh bypassed)   headroom')
for (const f of PROBE_HZ) {
  const on = probe(f, { peakReduction: knobs.get(f) })
  const off = probe(f, { peakReduction: knobs.get(f), tube: false })
  console.log('  %s Hz     %s dBc        %s dBc      %s dB',
    String(f).padStart(4), on.h2.toFixed(2).padStart(7), off.h2.toFixed(2).padStart(8),
    (on.h2 - off.h2).toFixed(1).padStart(5))
}

let drive = TUBE_DRIVE_LIN
if (fit) {
  // H2 is monotone in drive over any range worth searching.
  let lo = 0.01, hi = 2
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (meanH2(mid) < H2_TARGET_DBC) lo = mid
    else hi = mid
  }
  drive = (lo + hi) / 2
  console.log('\nFITTED TUBE_DRIVE_LIN = %s   (shipping: %s)', drive.toFixed(4), TUBE_DRIVE_LIN)
} else {
  console.log('\nAt the shipping TUBE_DRIVE_LIN = %s:', TUBE_DRIVE_LIN)
}

console.log('\n  freq       H2        H3     H3-H2      THD')
for (const f of PROBE_HZ) {
  const r = probe(f, { peakReduction: knobs.get(f), driveLin: drive })
  console.log('  %s Hz  %s   %s   %s   %s %%',
    String(f).padStart(4), r.h2.toFixed(2).padStart(7), r.h3.toFixed(2).padStart(8),
    (r.h3 - r.h2).toFixed(1).padStart(6), r.thdPct.toFixed(3).padStart(6))
}
console.log('  mean H2 %s dBc   (target %s)', meanH2(drive).toFixed(2), H2_TARGET_DBC.toFixed(2))

// With the cell modulation ON — the shipping configuration, and the one the
// paper's THD and H3-H2 bands apply to.
console.log('\nShipping configuration (cell modulation on), same operating point:')
console.log('  freq       H2        H3     H3-H2      THD     paper: THD 0.94-4.22 %, H3-H2 +16..+44')
for (const f of PROBE_HZ) {
  const r = probe(f, { peakReduction: knobs.get(f), driveLin: drive, cellMod: 1 })
  const inBand = r.thdPct >= 0.94 && r.thdPct <= 4.22 && (r.h3 - r.h2) >= 16 && (r.h3 - r.h2) <= 44
  console.log('  %s Hz  %s   %s   %s   %s %%   %s',
    String(f).padStart(4), r.h2.toFixed(2).padStart(7), r.h3.toFixed(2).padStart(8),
    (r.h3 - r.h2).toFixed(1).padStart(6), r.thdPct.toFixed(3).padStart(6),
    inBand ? 'in band' : 'OUT OF BAND')
}

// The knee is where the shaper's argument reaches 1, i.e. input = 1 / drive.
const knee = db(1 / drive)
console.log('\nKnee: %s dBFS (%s dB above NOMINAL_DBFS), bias held at %s',
  knee.toFixed(1), (knee + 18).toFixed(1), TUBE_BIAS)
