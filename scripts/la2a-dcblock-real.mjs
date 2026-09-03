/**
 * OptoSmooth's DC blocker corner — what it costs on real narration.
 *
 *   npm run dcblock:real
 *
 * Drop narrator recordings in `data/corpus/la2a/` (gitignored — `*.wav` is
 * ignored repo-wide, so nothing commercial reaches the repo).
 *
 * WHY THIS EXISTS. `DC_BLOCK_HZ` was a bare `5` in the constructor with no
 * derivation, beside a tape blocker at 2 Hz that had one. The synthetic sweep
 * that first compared them said the corner mattered: undershoot after a gated
 * 60 Hz burst ran -33 dBc at 2 Hz against -23 at 5. This is that measurement on
 * real speech, and it says the opposite — see the TILT column.
 *
 * ⚠ THE BLOCKER IS LINEAR AND SITS LAST, WHICH BOUNDS WHAT ANY COLUMN HERE CAN
 * FIND. With `y_c = H_c(wet)` and `ideal = wet - mean(wet)`, the error is
 * exactly `(H_c - 1)(wet) + mean(wet)` — the filter's own deviation from unity,
 * applied to the output. There is no mechanism for a transient artefact
 * distinct from the frequency response, so no window this script chooses can
 * discover one. What the columns establish is the SIZE of that deviation on
 * material the product actually sees, which is the part a Bode plot cannot say.
 *
 * COLUMNS
 *
 *   residual DC   what survives the blocker. Total at any corner >= 1 Hz, so
 *                 nothing here trades against the job the filter does.
 *
 *   err           the whole error, and its part below 100 Hz, against output
 *                 rms. Dominated by LF phase rotation, which is inaudible; kept
 *                 because it is what a naive sweep reports and it is worth
 *                 seeing that it says nothing.
 *
 *   peak shift    THE COLUMN THAT MATTERS. This blocker exists to protect the
 *                 peak measurement ACX compliance is built on, so the honest
 *                 cost of a corner is how far it moves that peak.
 *
 *   TILT          error energy in the 20-150 ms tail of the twelve largest LF
 *                 onsets, against each onset's own peak — the synthetic burst
 *                 metric ported to real plosives.
 */

import { readdirSync } from 'node:fs'
import path from 'node:path'
import { readWav } from '../test/voicerx/wav.js'
import { LA2AKernel, DC_BLOCK_HZ } from '../src/audio/la2aProcessor.js'

const CORPUS = path.join(process.cwd(), 'data/corpus/la2a')
const CORNERS = [1, 2, DC_BLOCK_HZ, 10, 20]
const DRIVES = [0.3, 1.0] // the shipped default, and the top of the knob

const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))
const rms = (y, a = 0, b = y.length) => { let s = 0; for (let i = a; i < b; i++) s += y[i] * y[i]; return Math.sqrt(s / (b - a)) }
const mean = y => { let s = 0; for (const v of y) s += v; return s / y.length }
const peak = y => { let m = 0; for (const v of y) m = Math.max(m, Math.abs(v)); return m }

/**
 * `corner: null` bypasses the blocker EXACTLY: `y = x - x[-1] + y[-1]`
 * telescopes to `y[n] = x[n] - x[0] + y[0]`, i.e. the signal itself, with the
 * oversampler, the T4 ballistics and the shaper left bit-identical. That is
 * what makes a sweep a measurement of the filter and of nothing else.
 */
function run(x, sr, { corner, ...p }) {
  const k = new LA2AKernel(sr)
  k.setParams({ mode: 'compress', peakReduction: 60, gainDb: 0, tubeDrive: 0.3, mix: 1, ...p })
  if (corner !== undefined) k.dcR = corner === null ? 1 : 1 - 2 * Math.PI * corner / sr
  const n = x.length, o = new Float32Array(n)
  for (let f = 0; f < n; f += 128) {
    const l = Math.min(128, n - f)
    k.process([x.subarray(f, f + l)], [o.subarray(f, f + l)], l)
  }
  return o
}

const lp = (y, sr, hz) => {
  const a = 1 - Math.exp(-2 * Math.PI * hz / sr)
  const o = new Float32Array(y.length); let s = 0
  for (let i = 0; i < y.length; i++) { s += a * (y[i] - s); o[i] = s }
  return o
}

/** The largest rises in a 120 Hz-limited envelope, spaced so one plosive is not counted three times. */
function onsets(y, sr, count) {
  const env = lp(Float32Array.from(lp(y, sr, 120), Math.abs), sr, 30)
  const back = Math.round(sr * 0.03)
  const cand = []
  for (let i = back; i < env.length - Math.round(sr * 0.2); i++) cand.push([env[i] - env[i - back], i])
  cand.sort((a, b) => b[0] - a[0])
  const picked = []
  for (const [, i] of cand) {
    if (picked.every(p => Math.abs(p - i) > sr * 0.25)) picked.push(i)
    if (picked.length >= count) break
  }
  return picked
}

const files = readdirSync(CORPUS).filter(f => /\.wav$/i.test(f)).sort()
if (files.length === 0) {
  console.error(`No WAVs in ${CORPUS} — drop narrator recordings there and re-run.`)
  process.exit(1)
}

for (const file of files) {
  const { mono, sampleRate: sr, seconds } = readWav(path.join(CORPUS, file))
  console.log(`\n=== ${file.replace(/\.wav$/i, '')} — ${seconds.toFixed(1)} s, ${sr} Hz, peak ${db(peak(mono)).toFixed(2)} dBFS ===`)
  const marks = onsets(mono, sr, 12)

  for (const drive of DRIVES) {
    const bypass = run(mono, sr, { corner: null, tubeDrive: drive })
    const dc = mean(bypass)
    const ideal = Float32Array.from(bypass, v => v - dc)
    const oPeak = peak(ideal), oRms = rms(ideal)
    console.log(`\n  tubeDrive ${drive.toFixed(2)}  —  DC the shaper leaves: ${db(dc).toFixed(1)} dBFS (${(db(dc) - db(oPeak)).toFixed(1)} dBc)`)
    console.log('  corner  residualDC    err(all)  err(<100Hz)   peak shift   TILT after plosives')

    for (const c of CORNERS) {
      const y = run(mono, sr, { corner: c, tubeDrive: drive })
      const err = Float32Array.from(y, (v, i) => v - ideal[i])
      const errLow = lp(err, sr, 100)
      let worst = -Infinity, sum = 0
      for (const m of marks) {
        const a = m + Math.round(sr * 0.02), b = m + Math.round(sr * 0.15)
        const t = db(rms(errLow, a, b)) - db(peak(ideal.subarray(m, b)))
        worst = Math.max(worst, t); sum += t
      }
      const flag = c === DC_BLOCK_HZ ? ' <- shipped' : ''
      console.log(`  ${String(c).padStart(5)}   ${db(mean(y)).toFixed(1).padStart(7)} dBFS  `
        + `${(db(rms(err)) - db(oRms)).toFixed(1).padStart(6)} dBc  `
        + `${(db(rms(errLow)) - db(oRms)).toFixed(1).padStart(6)} dBc  `
        + `${(db(peak(y)) - db(oPeak)).toFixed(4).padStart(9)} dB  `
        + `mean ${(sum / marks.length).toFixed(1).padStart(6)} / worst ${worst.toFixed(1).padStart(6)} dBc${flag}`)
    }
  }
}
