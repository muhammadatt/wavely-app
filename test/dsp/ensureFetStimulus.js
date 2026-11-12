/**
 * Make sure `thd.wav` exists before a self-test that needs it.
 *
 * ⚠⚠ THREE TEST FILES USED TO SKIP THEMSELVES WHEN IT WAS MISSING, WHICH ON A
 * CLEAN CHECKOUT IS ALWAYS. The stimulus is gitignored (it is generated, not
 * authored) and `npm test` never runs `npm run fet:stimulus`, so
 * `fetNullVerdicts`, `fetBallisticsFit` and `fetStaticCurve` reported green
 * without executing a single one of their assertions. A guard that silently
 * disables itself in CI is worse than no guard: it reads as coverage.
 *
 * Generating it is cheap and deterministic — it is a synthesised tone plan, not
 * a capture — so the tests build it on demand instead of asking to be excused.
 *
 * ⚠ IT IS WRITTEN WHERE THE TOOLING EXPECTS IT rather than to a temp directory,
 * because `fet-null.mjs` and the curve fitter resolve `STIM_DIR` themselves.
 * The path is gitignored scratch that this tooling owns.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PLANS, STIM_DIR } from '../../scripts/fet-ballistics.mjs'
import { buildProbe } from '../../scripts/lib/probeStimulus.js'
import { writeFloatWav } from '../../scripts/lib/wav.js'

/** The rate the tooling writes by default; the readers assume nothing else. */
export const STIMULUS_SR = 96000

export function ensureFetStimulus(file = 'thd.wav', sampleRate = STIMULUS_SR) {
  const path = join(STIM_DIR, file)
  if (existsSync(path)) return path
  mkdirSync(STIM_DIR, { recursive: true })
  const { x } = buildProbe(PLANS[file](), sampleRate)
  writeFloatWav(path, x, sampleRate)
  return path
}
