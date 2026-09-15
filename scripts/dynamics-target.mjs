#!/usr/bin/env node
/**
 * THE FET'S IMPACT TARGET — ABSOLUTE AGAINST RELATIVE.
 *
 *   npm run dynamics:target                    # both synthetic stimuli
 *   npm run dynamics:target -- narration.wav   # and a real voice
 *
 * ⚠ THE ABSOLUTE TARGET MAKES DENSITY MEAN "DISTANCE TO 12.2". That distance is
 * a property of the FILE, so the same knob position buys a different amount of
 * processing on every recording — and on material that already meets the target
 * it buys none at all, because the FET bypasses at every Density.
 *
 * The relative form asks for a guaranteed drop from wherever the audio starts,
 * with the absolute target still binding as a floor. This scores the two on the
 * things that decide it:
 *
 *   1. DELIVERED impact — what the section actually hands on, rendered, not the
 *      target it was aiming at. A target that rails is not a target that worked.
 *   2. The FET's gain reduction, which is what a user reads off the meter.
 *   3. The SHORTFALL, and how often the stage bypasses outright. ⚠ AN
 *      UNREACHABLE TARGET IS THE FAILURE MODE THIS SECTION ALREADY HAD ONCE, and
 *      it failed silently: impact has only ~3 dB of travel through this device,
 *      so asking for more pins the drive and looks exactly like success.
 *
 * ⚠ AND ONE FILE IS NOT A BENCH. The house rule on this section, learned three
 * times: the synthetic probe, the reference narrator and a second narrator each
 * found something the other two could not see.
 */
import { readWav } from '../test/voicerx/wav.js'
import {
  measureDynamics, sweepDynamics, solveFromSweep,
  DYNAMICS_TARGET, MAX_IMPACT_DROP_DB,
} from '../src/audio/dynamicsSolve.js'
import { processDynamicsBuffer } from '../src/audio/dynamicsProcessor.js'

const SR = 44100
const DENSITIES = [10, 30, 50, 70, 100]

/**
 * ⚠ ONE SYLLABLE IN SEVEN IS ACCENTED, because a flat train of identical
 * syllables reads impact 10.8-11.3 against real narration's 13.2-14.8 — and
 * impact is the exact statistic every target here is expressed in. `accent`
 * scales it, which is how this bench gets a low-impact stimulus to test the
 * bypass case without reaching for a different generator.
 */
function narration(seconds, peakDbfs, accentGain = 2.6, seed = 4242) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const syl = t % 0.32
    const burst = syl < 0.2 ? Math.min(1, syl / 0.005) * Math.exp(-syl * 3.2) : 0
    const phrase = 0.45 + 0.55 * (Math.floor(t / 1.7) % 3) / 2
    const accent = Math.floor(t / 0.32) % 7 === 0 ? accentGain : 1
    x[i] = burst * phrase * accent * (0.6 * Math.sin(2 * Math.PI * 165 * t)
      + 0.25 * Math.sin(2 * Math.PI * 880 * t) + 0.15 * rnd())
  }
  let pk = 0
  for (const v of x) pk = Math.max(pk, Math.abs(v))
  const g = Math.pow(10, peakDbfs / 20) / pk
  for (let i = 0; i < n; i++) x[i] = Math.fround(x[i] * g)
  return x
}

const stimuli = [
  ['synthetic punchy', [narration(12, -1, 2.6)]],
  ['synthetic flat  ', [narration(12, -1, 1.0)]],
]
const file = process.argv[2]
if (file) {
  const { mono, sampleRate, seconds } = readWav(file)
  if (sampleRate !== SR) console.log(`note: ${file} is ${sampleRate} Hz`)
  const win = Math.round(Math.min(30, seconds) * sampleRate)
  stimuli.push([file.split('/').pop().slice(0, 16).padEnd(16), [mono.subarray(0, win)], sampleRate])
}

/** What the section DELIVERS, rendered — never the target it aimed at. */
function deliver(x, sr, params) {
  const r = processDynamicsBuffer(x, sr, { ...params, oversample: false })
  return measureDynamics([r.channelData[0].subarray(r.latencySamples)], sr)
}

const DROPS = [1.5, 2.0, 2.5, 3.0]

for (const [label, x, sr = SR] of stimuli) {
  const input = measureDynamics(x, sr)
  console.log(`\n═══ ${label}  peak ${input.peakDb.toFixed(2)}  crest `
    + `${input.crestDb.toFixed(2)}  impact ${input.impactDb.toFixed(2)}`)
  console.log(`    absolute target ${DYNAMICS_TARGET.impactDb} — `
    + `${(input.impactDb - DYNAMICS_TARGET.impactDb).toFixed(2)} dB of room`)
  const sweep = sweepDynamics(x, sr)

  const run = (density, opts) => {
    const { params, report } = solveFromSweep(sweep, { density, ...opts })
    const out = deliver(x, sr, params)
    return {
      drive: params.fetDrive,
      gr: report.fet.peakDb,
      target: report.fet.targetImpactDb,
      short: report.fet.shortfallDb,
      impact: out.impactDb,
      crest: out.crestDb,
    }
  }

  console.log('\n  ABSOLUTE')
  console.log('   D | drive   GR | target  delivered impact  short')
  for (const d of DENSITIES) {
    const r = run(d, { relativeTarget: false })
    console.log(`${String(d).padStart(4)} |${(r.drive === null ? 'byp' : r.drive.toFixed(1)).padStart(6)}`
      + `${r.gr.toFixed(2).padStart(6)} |${r.target.toFixed(2).padStart(7)}`
      + `${r.impact.toFixed(2).padStart(18)}${r.short.toFixed(2).padStart(7)}`)
  }

  for (const drop of DROPS) {
    console.log(`\n  RELATIVE, max drop ${drop.toFixed(1)} dB`
      + (drop === MAX_IMPACT_DROP_DB ? '   <- current constant' : ''))
    console.log('   D | drive   GR | target  delivered impact  short')
    let bypassed = 0
    let capped = 0
    for (const d of DENSITIES) {
      const r = run(d, { relativeTarget: true, maxImpactDropDb: drop })
      if (r.drive === null) bypassed++
      if (r.short > 0.05) capped++
      console.log(`${String(d).padStart(4)} |${(r.drive === null ? 'byp' : r.drive.toFixed(1)).padStart(6)}`
        + `${r.gr.toFixed(2).padStart(6)} |${r.target.toFixed(2).padStart(7)}`
        + `${r.impact.toFixed(2).padStart(18)}${r.short.toFixed(2).padStart(7)}`)
    }
    console.log(`       bypassed ${bypassed}/${DENSITIES.length}, `
      + `short of target ${capped}/${DENSITIES.length}`)
  }
}
