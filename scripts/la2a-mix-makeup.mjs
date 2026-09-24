/**
 * OptoSmooth auto makeup across Peak Reduction x Mix: the shipping solve
 * against a fully converged one, and the level each actually delivers through
 * the real mixed kernel output.
 *
 *   node scripts/la2a-mix-makeup.mjs
 *
 * The record behind the blend-aware solve in `solveMakeupPlan`. Before it,
 * the plain loop left the makeup up to 9.8 dB short at mix 0.1 (PR 70); after,
 * "short-by" is 0.00 everywhere.
 */
import { pathToFileURL } from 'node:url'
import { processLA2ABuffer, computeAutoMakeupPlan, la2aLatencySamples } from '../src/audio/la2aProcessor.js'
import { percentileOfChannels, MAKEUP_PERCENTILE } from '../src/audio/dsp/makeupReference.js'
const SR = 44100
const db = x => 20 * Math.log10(Math.max(x, 1e-12))

// The suite's narration stimulus: syllables and one hot onset after a pause.
function narration(seconds = 4) {
  const n = Math.round(SR * seconds), x = new Float32Array(n); let ph = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR; ph += 2 * Math.PI * 130 / SR
    let s = 0; for (let h = 1; h <= 10; h++) s += Math.sin(ph * h) / (h * h)
    const gap = t > 1.6 && t < 1.9
    const syl = Math.max(0, Math.sin(2 * Math.PI * 3 * t)) ** 2
    const hot = t >= 1.9 && t < 1.95 ? 2.2 : 1
    x[i] = gap ? 0.0005 * s : 0.42 * s * syl * hot
  }
  return x
}
// Denser: continuous phrases with a slow level drift and no hot onset.
function dense(seconds = 4) {
  const n = Math.round(SR * seconds), x = new Float32Array(n); let ph = 0, seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < n; i++) {
    const t = i / SR; ph += 2 * Math.PI * (110 + 20 * Math.sin(t)) / SR
    let s = 0; for (let h = 1; h <= 14; h++) s += Math.sin(ph * h) / h ** 1.6
    const env = (0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 4.1 * t))) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.3 * t))
    x[i] = 0.3 * env * s + 0.01 * (rnd() - 0.5)
  }
  return x
}

// The achieved level at a given makeup: render (no ceiling, as the solve
// measures) and compare the output's reference statistic to the input's.
function achieved(x, params, makeupDb) {
  const p = { ...params, oversample: false, ceilingDb: null, gainDb: makeupDb }
  const lat = la2aLatencySamples(p, SR)
  const padded = new Float32Array(x.length + lat); padded.set(x)
  const out = processLA2ABuffer([padded], SR, p).channelData[0].subarray(lat, lat + x.length)
  return db(percentileOfChannels([out], MAKEUP_PERCENTILE)) - db(percentileOfChannels([x], MAKEUP_PERCENTILE))
}

export { narration, dense, achieved }

function main() {
  for (const [name, x] of [['narration', narration()], ['dense', dense()]]) {
    console.log(`\n== ${name} ==   error = output p99.9 − input p99.9 (dB), 0 is on target`)
    console.log('PR   mix   solved     err     converged  err     short-by')
    for (const pr of [30, 50, 70]) {
      for (const mix of [1, 0.7, 0.5, 0.3, 0.1]) {
        const params = { peakReduction: pr, mix, lookaheadMs: 0 }
        const solved = computeAutoMakeupPlan([x], SR, params, { reference: 'percentile' })
        const conv = computeAutoMakeupPlan([x], SR, params, { reference: 'percentile', maxIterations: 200, toleranceDb: 0.001 })
        const eShip = achieved(x, params, solved.makeupDb)
        const eConv = achieved(x, params, conv.makeupDb)
        console.log(`${String(pr).padEnd(4)} ${mix.toFixed(1)}   ${solved.makeupDb.toFixed(2).padStart(7)}  ${eShip.toFixed(2).padStart(6)}   ${conv.makeupDb.toFixed(2).padStart(7)}  ${eConv.toFixed(2).padStart(6)}   ${(conv.makeupDb - solved.makeupDb).toFixed(2).padStart(6)}`)
      }
    }
  }
}

/**
 * The report runs only when this file is the entry point: the stimuli and
 * `achieved` are importable, and importing must not render the whole matrix.
 * Same guard as `scripts/fet-ballistics.mjs`.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
