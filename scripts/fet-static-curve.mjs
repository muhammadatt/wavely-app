#!/usr/bin/env node
/**
 * FET Punch — fit a reference's STATIC transfer curve from its null1 capture.
 *
 *   npm run fet:curve            fit whatever null1 captures are present
 *   npm run fet:curve:selftest   prove the fitter on curves we chose ourselves
 *
 * null1 is the bounce with NO gain reduction anywhere in it, so the capture is
 * the reference's memoryless curve applied to a known tone, and nothing else.
 * Five tones 6 dB apart give the curve over 24 dB of level.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ THREE THINGS HAVE TO BE RIGHT OR THE FIT IS QUIETLY WRONG. All three were
 * found the expensive way, on FETish's real capture.
 *
 * 1. REFERENCE THE FIT TO THE CAPTURE'S OWN FUNDAMENTAL PHASE.
 *    A memoryless polynomial cannot express a delay, and the capture has one —
 *    3 samples of envelope-measured lag here, plus whatever fractional shift the
 *    plugin's own filtering adds. Fitting against the raw stimulus left a
 *    residual of **−14.1 dB** and a linear term of 0.980 on a plugin that is
 *    unity to five decimals. Rebuilding the input as a sine at the OUTPUT's
 *    fundamental phase absorbs any pure delay and takes the residual to −70 dB.
 *
 * 2. FIT THE AC COMPONENT ONLY — MEAN-CENTRE EVERY WINDOW.
 *    An even-order term carries DC: x⁴ on a sine of amplitude A contributes
 *    3A⁴/8 of it. The capture does not (DC blockers, and the plugin's own
 *    output stage), so an uncentred least squares trades real fourth-order
 *    amplitude away to avoid adding DC that is not there. Measured on FETish:
 *    **c₄ came out 2.06× too small**, and the tell was that the fitted H2 and H4
 *    were low by exactly 6.3 dB at *every* level — the right shape at the wrong
 *    amplitude. Centring both basis and target per window fixes it, and the
 *    odd-order terms are unaffected either way.
 *
 * 3. FIT ONLY THE ORDERS THE HARMONICS SUPPORT, AND FIT ALL LEVELS AT ONCE.
 *    A raw monomial basis is badly conditioned: fitting FETish at orders 1-7
 *    gave c₄ = −0.070 and c₆ = +0.136, and at orders 1-5 gave c₄ = −0.022 —
 *    unstable, because the high terms were fitting noise. The harmonic SLOPES
 *    say which orders are real (a term of order n makes its harmonics rise
 *    (n−1) dB per dB of level), so the basis is chosen from the data. And one
 *    curve has to explain every level, so all five tones enter one fit — a
 *    per-level fit will always look good and means nothing.
 */

import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { readCapture, alignByEnvelope } from './lib/probeCapture.js'
import { harmonicsAt } from './lib/harmonics.js'
import { buildProbe } from './lib/probeStimulus.js'
import { readWav } from './lib/wav.js'
import { STIM_DIR, CAP_DIR, PLANS } from './fet-ballistics.mjs'

const TONE_SKIP_HEAD_S = 0.8
const TONE_SKIP_TAIL_S = 0.2
/** A harmonic this far down is the float noise of the path, not a reading. */
const HARMONIC_FLOOR_DBC = -150
/** Highest polynomial order considered when reading the harmonic slopes. */
const MAX_ORDER = 9

/**
 * One analysis window per tone, with the input rebuilt at the CAPTURE's
 * fundamental phase — see note 1 in the header.
 */
function toneWindows(y, plan, sampleRate, lag) {
  return plan.events.map(ev => {
    const f = ev.freqHz
    const a = Math.round((ev.up + TONE_SKIP_HEAD_S) * sampleRate) + lag
    const end = Math.round((ev.down - TONE_SKIP_TAIL_S) * sampleRate) + lag
    // Whole cycles, so the exact-bin DFT downstream needs no window function.
    const cyc = sampleRate / f
    const N = Math.round(Math.floor((end - a) / cyc) * cyc)
    if (a < 0 || a + N > y.length || N < cyc * 8) return null

    let re = 0, im = 0
    for (let i = 0; i < N; i++) {
      const p = 2 * Math.PI * f * i / sampleRate
      re += y[a + i] * Math.sin(p)
      im += y[a + i] * Math.cos(p)
    }
    const phi = Math.atan2(im, re)
    const amp = Math.pow(10, ev.hiDb / 20)
    const x = new Float64Array(N)
    for (let i = 0; i < N; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sampleRate + phi)
    return { ev, a, N, x, f, amp }
  }).filter(Boolean)
}

/** dBc slope per dB of level for each harmonic — identifies the generating order. */
function harmonicSlopes(y, wins, sampleRate) {
  const rows = wins.map(w => harmonicsAt(y, w.a, w.N, sampleRate, w.f, MAX_ORDER))
  const out = []
  for (let k = 0; k < MAX_ORDER - 1; k++) {
    const pts = rows.map((r, i) => [r.fundamentalDbfs, r.dBc[k]])
      .filter(p => p[1] > HARMONIC_FLOOR_DBC)
    if (pts.length < 3) { out.push({ harmonic: k + 2, slope: null, n: pts.length }); continue }
    const n = pts.length
    const sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0)
    const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0)
    const sxy = pts.reduce((a, p) => a + p[0] * p[1], 0)
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    out.push({ harmonic: k + 2, slope, order: slope + 1, n })
  }
  return { rows, slopes: out }
}

/**
 * Which polynomial powers the harmonics actually call for.
 *
 * A term of order n produces harmonics whose dBc rises (n−1) dB per dB of
 * level. So each measurable harmonic names its own generating order, and the
 * basis is read off the data rather than assumed. The linear term is always in.
 */
function basisFromSlopes(slopes) {
  const orders = new Set([1])
  const evidence = []
  for (const s of slopes) {
    if (s.slope === null) continue
    const n = Math.round(s.order)
    // A harmonic of order k can only come from a term of order >= k, and of the
    // same parity — x^4 makes H2 and H4, x^5 makes H3 and H5. A slope that
    // implies otherwise is not a measurement of a polynomial term.
    const consistent = n >= s.harmonic && (n - s.harmonic) % 2 === 0 && n <= MAX_ORDER
    if (consistent) orders.add(n)
    evidence.push({ ...s, inferred: n, consistent })
  }
  return { powers: [...orders].sort((a, b) => a - b), evidence }
}

/**
 * ⚠ IS A MEMORYLESS CURVE EVEN THE RIGHT MODEL? ASK BEFORE FITTING ONE.
 *
 * Every harmonic of a memoryless polynomial names its own generating order: a
 * term of order n makes harmonics that rise (n−1) dB per dB of level, and it
 * can only make harmonics of the same parity at or below n. When the measured
 * slopes disagree with that, no memoryless curve of any shape reproduces the
 * capture — and fitting one anyway produces a basis that silently cannot
 * express most of what was measured.
 *
 * ⚠ THIS IS NOT HYPOTHETICAL AND IT CHANGES A CONCLUSION. CLA-76's H2, H3, H5,
 * H7 and H9 ALL rise at ~1.0 dB per dB. H2 at 1.0 is a clean quadratic term;
 * H3 at 1.0 is impossible, because a cubic term would give 2.0. Every harmonic
 * rising together means the distortion residual has a FIXED SHAPE whose
 * amplitude grows as the square of level — the signature of a drive that tracks
 * an envelope, or of hysteresis, not of a static curve.
 *
 * The first version of this script had no such check: it quietly dropped the
 * four inconsistent harmonics, fitted x + c₂x², and reported a worst error of
 * **257 dB** against harmonics its basis could not produce at all. The right
 * answer is that the question is wrong, not that the fit is bad.
 */
function memorylessVerdict(evidence) {
  const usable = evidence.filter(e => e.slope !== null)
  const bad = usable.filter(e => !e.consistent)
  return {
    usable: usable.length,
    bad,
    isMemoryless: usable.length > 0 && bad.length === 0,
  }
}

/**
 * Joint least squares across every window, AC only.
 * @param {number[]} powers
 */
function jointFit(y, wins, powers) {
  const K = powers.length
  const A = Array.from({ length: K }, () => new Float64Array(K).fill(0))
  const B = new Float64Array(K)
  const centre = v => {
    let m = 0
    for (let i = 0; i < v.length; i++) m += v[i]
    m /= v.length
    for (let i = 0; i < v.length; i++) v[i] -= m
    return v
  }
  for (const w of wins) {
    const cols = powers.map(n => {
      const v = new Float64Array(w.N)
      for (let i = 0; i < w.N; i++) v[i] = Math.pow(w.x[i], n)
      return centre(v)
    })
    const t = new Float64Array(w.N)
    for (let i = 0; i < w.N; i++) t[i] = y[w.a + i]
    centre(t)
    for (let i = 0; i < w.N; i++) {
      for (let r = 0; r < K; r++) {
        B[r] += cols[r][i] * t[i]
        for (let c = 0; c < K; c++) A[r][c] += cols[r][i] * cols[c][i]
      }
    }
  }
  for (let i = 0; i < K; i++) {
    let piv = i
    for (let r = i + 1; r < K; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r
    ;[A[i], A[piv]] = [A[piv], A[i]]
    const t = B[i]; B[i] = B[piv]; B[piv] = t
    for (let r = 0; r < K; r++) {
      if (r === i) continue
      const f = A[r][i] / A[i][i]
      for (let c = i; c < K; c++) A[r][c] -= f * A[i][c]
      B[r] -= f * B[i]
    }
  }
  if (A.some((row, i) => !Number.isFinite(B[i] / row[i]))) return null
  return powers.map((n, i) => ({ power: n, coef: B[i] / A[i][i] }))
}

const evalPoly = (coef, x) => coef.reduce((s, c) => s + c.coef * Math.pow(x, c.power), 0)

/** Render the fitted curve through each window and compare harmonics. */
function verify(y, wins, coef, sampleRate, nHarm = 5) {
  return wins.map(w => {
    const z = new Float64Array(w.N)
    for (let i = 0; i < w.N; i++) z[i] = evalPoly(coef, w.x[i])
    const fit = harmonicsAt(z, 0, w.N, sampleRate, w.f, nHarm)
    const meas = harmonicsAt(y, w.a, w.N, sampleRate, w.f, nHarm)
    const errs = meas.dBc.map((v, k) => v > HARMONIC_FLOOR_DBC ? Math.abs(fit.dBc[k] - v) : null)
    return { w, fit, meas, errs }
  })
}

function report(label, y, plan, stim, sampleRate) {
  const lag = alignByEnvelope(stim.env, y, sampleRate)
  const wins = toneWindows(y, plan, sampleRate, lag)
  if (wins.length < 3) { console.log(`  ⚠ ${label}: only ${wins.length} usable tone windows`); return null }

  const { slopes } = harmonicSlopes(y, wins, sampleRate)
  console.log(`\n  harmonic slopes — dBc per dB of level, and the order each implies`)
  for (const s of slopes) {
    if (s.slope === null) { console.log(`    H${s.harmonic}   — below the float noise floor —`); continue }
    console.log(`    H${s.harmonic}   slope ${s.slope.toFixed(2).padStart(5)}  ->  order ${s.order.toFixed(2)}   (${s.n} points)`)
  }

  const { powers, evidence } = basisFromSlopes(slopes)
  const verdict = memorylessVerdict(evidence)

  if (!verdict.isMemoryless) {
    console.log('\n  ⚠⚠ THIS IS NOT A MEMORYLESS CURVE, AND NO STATIC SHAPER WILL REPRODUCE IT.')
    for (const r of verdict.bad) {
      console.log(`     H${r.harmonic} rises ${r.slope.toFixed(2)} dB/dB, implying order ${r.inferred} — but order ` +
        `${r.inferred} cannot generate H${r.harmonic} (${r.inferred < r.harmonic ? 'lower than the harmonic' : 'wrong parity'}).`)
    }
    console.log('\n     A memoryless term of order n makes harmonics that rise (n−1) dB per dB,')
    console.log('     of its own parity, at or below n. Harmonics that all rise TOGETHER mean the')
    console.log('     distortion residual has a fixed SHAPE whose amplitude tracks level — a drive')
    console.log('     following an envelope, or hysteresis. Not a curve.')
    console.log('\n     ⚠ Our own shaper is memoryless too, so this is not a `fetDrive` value we')
    console.log('     are missing — it is a mechanism we do not have. Fitting a curve here would')
    console.log('     produce a basis that cannot express most of what was measured, and a')
    console.log('     confident-looking number. Not fitted.')
    return { notMemoryless: true, evidence }
  }

  console.log(`\n  basis chosen from the data: x^[${powers.join(', ')}]`)

  const coef = jointFit(y, wins, powers)
  if (!coef) { console.log('  ⚠ the fit is singular — too few distinct levels for this basis'); return null }
  console.log('  fitted coefficients (joint over every level, AC only):')
  for (const c of coef) {
    console.log(`    c${c.power}  ${(Math.abs(c.coef) < 1e-5 ? c.coef.toExponential(4) : c.coef.toFixed(7)).padStart(14)}`)
  }

  const v = verify(y, wins, coef, sampleRate)
  console.log('\n  VERIFY — the fitted curve rendered through the same tones (dBc):')
  console.log('    A(dBFS)      H2 meas   fit      H3 meas   fit      H4 meas   fit      H5 meas   fit')
  for (const r of v) {
    const cell = k => r.meas.dBc[k] > HARMONIC_FLOOR_DBC
      ? r.meas.dBc[k].toFixed(1).padStart(9) + r.fit.dBc[k].toFixed(1).padStart(7)
      : '    (flr)'.padStart(9) + ''.padStart(7)
    console.log('    ' + r.meas.fundamentalDbfs.toFixed(2).padStart(7) + '  ' + [0, 1, 2, 3].map(cell).join(''))
  }
  const all = v.flatMap(r => r.errs).filter(e => e !== null)
  const worst = Math.max(...all)
  console.log(`\n  worst harmonic error over ${all.length} usable readings: ${worst.toFixed(2)} dB`)

  /**
   * ⚠ HOLD OUT THE LOUDEST TONE. A memoryless curve fitted over 24 dB must
   * predict a level it never saw; if it cannot, the curve is level-dependent
   * and no memoryless shaper will reproduce it.
   */
  if (wins.length >= 4) {
    const held = wins[wins.length - 1]
    const sub = jointFit(y, wins.slice(0, -1), powers)
    if (sub) {
      const hv = verify(y, [held], sub, sampleRate)[0]
      const he = hv.errs.filter(e => e !== null)
      console.log(`  HOLD-OUT — fitted without the ${held.ev.tag} tone, then asked to predict it:`)
      console.log(`    worst error there: ${Math.max(...he).toFixed(2)} dB` +
        `${Math.max(...he) < 2 ? '  ✓ the curve extrapolates' : '  ⚠ it does not extrapolate — not memoryless'}`)
    }
  }
  return { coef, worst, lag }
}

// ── Self-test ───────────────────────────────────────────────────────────────

function selftest(sampleRate) {
  const plan = PLANS['thd.wav']()
  const stim = buildProbe(plan, sampleRate)
  const cases = [
    { name: 'x - 0.01·x⁴ + 0.01·x⁵  (FETish-like)', f: x => x - 0.01 * x ** 4 + 0.01 * x ** 5 },
    { name: 'asymmetric tanh        (our shaper)', f: x => (Math.tanh(1.07 * x + 0.0525) - Math.tanh(0.0525)) / (1.07 * (1 - Math.tanh(0.0525) ** 2)) },
    { name: 'pure cubic             x - 0.2·x³', f: x => x - 0.2 * x ** 3 },
  ]
  for (const c of cases) {
    console.log('\n' + '═'.repeat(78))
    console.log(`SELF-TEST: ${c.name}`)
    console.log('═'.repeat(78))
    const y = new Float32Array(stim.x.length)
    for (let i = 0; i < y.length; i++) y[i] = c.f(stim.x[i])
    report(c.name, y, plan, stim, sampleRate)
  }
  console.log('\n⚠ The tanh row is the point of comparison: its H2 slope is ~1, where')
  console.log('  FETish measures 3.0. That is why no value of `fetDrive` reaches it.\n')
}

// ── Entry ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

if (args.includes('--selftest')) {
  selftest(readWav(join(STIM_DIR, 'thd.wav')).sampleRate)
} else {
  const rate = readWav(join(STIM_DIR, 'thd.wav')).sampleRate
  const plan = PLANS['thd.wav']()
  const stim = buildProbe(plan, rate)
  const files = existsSync(CAP_DIR)
    ? readdirSync(CAP_DIR).filter(f => /^null1_.+\.wav$/i.test(f)).sort()
    : []
  if (!files.length) {
    console.log(`\nNo null1 captures in ${CAP_DIR}. The static curve is fitted from null1,`)
    console.log('the bounce with no gain reduction anywhere in it.\n')
  } else {
    console.log(`\nFET Punch static curve — stimulus at ${rate} Hz\n`)
    for (const f of files) {
      console.log('═'.repeat(78))
      console.log(`REFERENCE: ${f.replace(/^null1_|\.wav$/gi, '')}   (${f})`)
      console.log('═'.repeat(78))
      try {
        report(f, readCapture(join(CAP_DIR, f), rate).y, plan, stim, rate)
      } catch (e) {
        console.log(`  ⚠ ${e.message}`)
      }
      console.log()
    }
  }
}
