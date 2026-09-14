#!/usr/bin/env node
/**
 * DENSITY SWEEP BENCH — the sampled sweep against the bisect it replaces.
 *
 *   npm run dynamics:sweep -- path/to/narration.wav
 *
 * `solveDynamics` bisects two knobs per Density move: ~16 kernel renders, 7.3–
 * 7.9 s on a 30 s window, which is not a live knob. `sweepDynamics` samples
 * every curve ONCE and `solveFromSweep` interpolates, so a move costs nothing.
 *
 * ⚠ THE SCORE THAT MATTERS IS WHAT THE SECTION DELIVERS, NOT WHERE THE KNOBS
 * LAND. Both curves are shallow near the solution, so the bisect's last digits
 * were never load-bearing and the two paths disagree on knob positions by far
 * more than they disagree on the result. Scoring knobs would reject a sweep
 * that is audibly identical — so this renders BOTH sets of params through the
 * real stages and compares the measured output.
 *
 * ⚠ AND EVERY NUMBER IT PRINTS IS ONE VOICE. Point it at another narrator
 * before treating the tolerances as settled.
 */
import { readWav } from '../test/voicerx/wav.js'
import { SoftClipperKernel } from '../src/audio/softClipperProcessor.js'
import { FET1176Kernel } from '../src/audio/fet1176Processor.js'
import {
  clipParamsFor, fetParamsFor, clipEnabled, processDynamicsBuffer,
  DYNAMICS_KERNEL_DEFAULTS,
} from '../src/audio/dynamicsProcessor.js'
import { inputAlignDbFor } from '../src/audio/dsp/inputAlign.js'
import {
  measureDynamics, solveDynamics, sweepDynamics, solveFromSweep,
} from '../src/audio/dynamicsSolve.js'

const PATCH = { ...DYNAMICS_KERNEL_DEFAULTS, oversample: false }
function runKernel(kernel, channels) {
  const out = channels.map(c => new Float32Array(c.length))
  const n = channels[0].length
  for (let off = 0; off < n; off += 128) {
    const len = Math.min(128, n - off)
    kernel.process(channels.map(c => c.subarray(off, off + len)),
      out.map(c => c.subarray(off, off + len)), len)
  }
  return out
}

const file = process.argv[2]
if (!file) {
  console.error('usage: npm run dynamics:sweep -- path/to/narration.wav')
  process.exit(1)
}
const { mono, sampleRate, seconds } = readWav(file)
const WIN = Math.round(Math.min(30, seconds) * sampleRate)
const x = [mono.subarray(0, WIN)]
const input = measureDynamics(x, sampleRate)
console.log(`window ${(WIN / sampleRate).toFixed(1)} s @ ${sampleRate}`)
console.log(`input  peak ${input.peakDb.toFixed(2)}  crest ${input.crestDb.toFixed(2)}  `
  + `impact ${input.impactDb.toFixed(2)}\n`)

/** What the head actually delivers for a set of solved params. */
function deliver(params) {
  let sig = x
  if (clipEnabled(params)) {
    const k = new SoftClipperKernel(sampleRate)
    k.setParams(clipParamsFor({ ...PATCH, ...params }))
    sig = runKernel(k, sig)
  }
  const align = inputAlignDbFor(sig, sampleRate)
  const k = new FET1176Kernel(sampleRate)
  k.setParams(fetParamsFor({ ...PATCH, ...params, fetAlignDb: align }))
  return measureDynamics(runKernel(k, sig), sampleRate)
}

const tSweep = performance.now()
const sweep = sweepDynamics(x, sampleRate)
const sweepMs = performance.now() - tSweep

const DENSITIES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
let truthMs = 0
const rows = []
for (const d of DENSITIES) {
  const t = performance.now()
  const truth = solveDynamics(x, sampleRate, { density: d })
  truthMs += performance.now() - t
  const swept = solveFromSweep(sweep, { density: d })
  rows.push({ d, truth, swept, tImp: deliver(truth.params).impactDb, sImp: deliver(swept.params).impactDb })
}

console.log(`sweep build : ${(sweepMs / 1000).toFixed(2)} s, ONCE`)
console.log(`bisect      : ${(truthMs / 1000).toFixed(2)} s for ${DENSITIES.length} densities `
  + `(${(truthMs / 1000 / DENSITIES.length).toFixed(2)} s EACH)`)
console.log(`a Density move on the sweep costs no renders at all\n`)

// ⚠ A BYPASSED STAGE HAS A NULL KNOB, which is a setting, not a missing
// number — the stages learned to bypass after this bench was written and a
// `?? 0` here would print drive 0, the 24 dB attenuator.
const fmt = (v, w = 7, p = 2) => (v === null ? 'byp' : v.toFixed(p)).padStart(w)
const diff = (a, b, w, p) => (a === null || b === null ? '-' : (a - b).toFixed(p)).padStart(w)
console.log('  D | clip threshold dB |    FET drive     | DELIVERED impact dB | opto GR pk')
console.log('    | bisect  sweep err | bisect sweep err | bisect  sweep   err | bis   swp')
let maxImp = 0
let maxOpto = 0
for (const r of rows) {
  const t = r.truth.params
  const s = r.swept.params
  const th = t.clipThresholdDb
  const sh = s.clipThresholdDb
  const impErr = r.sImp - r.tImp
  const optoErr = r.swept.report.opto.peakDb - r.truth.report.opto.peakDb
  maxImp = Math.max(maxImp, Math.abs(impErr))
  maxOpto = Math.max(maxOpto, Math.abs(optoErr))
  console.log(`${String(r.d).padStart(4)}|${fmt(th)}${fmt(sh)}${diff(sh, th, 5, 2)} |`
    + `${fmt(t.fetDrive, 6, 1)}${fmt(s.fetDrive, 6, 1)}${diff(s.fetDrive, t.fetDrive, 5, 1)} |`
    + `${fmt(r.tImp)}${fmt(r.sImp)}${fmt(impErr, 7, 3)} |`
    + `${fmt(r.truth.report.opto.peakDb, 6)}${fmt(r.swept.report.opto.peakDb, 6)}`)
}
console.log(`\nmax |err|  DELIVERED IMPACT ${maxImp.toFixed(3)} dB   opto GR ${maxOpto.toFixed(3)} dB`)

// ── The assumption the whole thing rests on ────────────────────────────────
console.log('\nHow far does the FET curve move as the clipper moves under it?')
const probes = [rows[0], rows[4], rows[9]].map(r => r.swept.params.clipThresholdDb)
const DRIVES = [0, 20, 40, 60, 100]
const curves = probes.map((th) => {
  const k = new SoftClipperKernel(sampleRate)
  k.setParams(clipParamsFor({ ...PATCH, clipThresholdDb: th }))
  const c = runKernel(k, x)
  const al = inputAlignDbFor(c, sampleRate)
  return DRIVES.map((d) => {
    const kf = new FET1176Kernel(sampleRate)
    kf.setParams(fetParamsFor({ ...PATCH, fetDrive: d, fetAlignDb: al }))
    return measureDynamics(runKernel(kf, c), sampleRate).impactDb
  })
})
console.log('  clip dB |' + DRIVES.map(d => `drive ${String(d).padStart(3)}`).join(''))
probes.forEach((th, i) => {
  console.log(`${fmt(th, 9)} |` + curves[i].map(v => fmt(v, 9)).join(''))
})
const spread = DRIVES.map((_, i) => {
  const vs = curves.map(c => c[i])
  return Math.max(...vs) - Math.min(...vs)
})
console.log('   spread |' + spread.map(v => fmt(v, 9)).join(''))
console.log(`\nmax spread across the whole clip range: ${Math.max(...spread).toFixed(3)} dB`)

// ── Balance: does the report follow it? ────────────────────────────────────
/**
 * ⚠ THE OPTO'S REPORTED REDUCTION IS THE FRAGILE FIGURE HERE, and Balance is
 * what broke it twice. It depends on the FET's drive AND the opto's depth, and
 * Balance moves those in OPPOSITE directions at a fixed Density — so a curve in
 * either one alone reads the wrong cell. The audio is not at risk (`squash` is
 * computed, `optoAlignDb` comes off the FET curve); the panel's number is.
 */
console.log('\nBalance — reported opto GR against what the opto really does')
console.log('  D  bal | FET GR  opto GR | reported   err')
let worstOpto = 0
let worstImpact = 0
for (const d of [30, 50, 60]) {
  for (const bal of [-1, -0.5, 0, 0.5, 1]) {
    const truth = solveDynamics(x, sampleRate, { density: d, balance: bal })
    const swept = solveFromSweep(sweep, { density: d, balance: bal })
    const r = processDynamicsBuffer(x, sampleRate, { ...swept.params, oversample: false })
    const real = r.metering.opto.peak
    const optoErr = swept.report.opto.peakDb - real
    const impErr = deliver(swept.params).impactDb - deliver(truth.params).impactDb
    worstOpto = Math.max(worstOpto, Math.abs(optoErr))
    worstImpact = Math.max(worstImpact, Math.abs(impErr))
    console.log(`${String(d).padStart(4)}${fmt(bal, 5, 1)} |${fmt(r.metering.fet.peak, 7)}`
      + `${fmt(real, 9)} |${fmt(swept.report.opto.peakDb, 9)}${fmt(optoErr, 7)}`)
  }
}
console.log(`\nunder Balance: delivered impact ${worstImpact.toFixed(3)} dB, `
  + `REPORTED opto GR ${worstOpto.toFixed(2)} dB`)
