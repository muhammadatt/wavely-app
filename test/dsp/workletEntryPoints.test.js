/**
 * Run with:  npm test
 *
 * NO WORKLET ENTRY POINT MAY IMPORT ANOTHER, DIRECTLY OR TRANSITIVELY.
 *
 * ⚠ THIS EXISTS BECAUSE A REVIEWER CAUGHT WHAT THE WHOLE SUITE COULD NOT.
 * A module that calls `registerProcessor` at module scope is an ENTRY POINT,
 * not a library: it is bundled and handed to `addModule()`. Import one entry
 * point from another and the second bundle re-runs the first's registration,
 * `addModule()` rejects with NotSupportedError, and the module that threw is
 * aborted — so one of the two plugins is silently dead, decided by load order.
 *
 * It shipped: `la2aProcessor.js` imported the transfer curves from
 * `vocalSatProcessor.js`, which registers `vocal-sat-processor`. OptoSmooth or
 * Scheps loaded alongside Tube Saturation in one AudioContext would have
 * broken one of them. `npm run smoke` did not see it — it opens panels, and
 * whether two worklets ever share a context there is incidental — and no unit
 * test loads a worklet at all. Nothing but this rule catches it.
 *
 * ⚠ A try/catch AROUND `registerProcessor` IS NOT THE FIX AND MUST NOT BE
 * TREATED AS ONE. `la2aProcessor.js` has one, for a real reason: Scheps
 * composes LA2AKernel, so that duplicate is legitimate and expected. It made
 * the LA-2A survive a collision it was designed for, and did nothing for a
 * plugin that never anticipated one. Shared code belongs in a module that
 * registers nothing — `dsp/satCurves.js` is that for the curves.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AUDIO = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/audio')

/** Every .js under src/audio, recursively. */
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

/**
 * ⚠ COMMENTS ARE STRIPPED BEFORE ANY OF THIS IS SCANNED. The first version was
 * not, and it flagged `dsp/satCurves.js` — the very module written to have no
 * registration — because its header DESCRIBES the bug and quotes
 * `registerProcessor(`. A checker that reads prose as code is worse than none:
 * it fails on the fix.
 */
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

const FILES = walk(AUDIO)
const source = new Map(FILES.map(f => [f, stripComments(readFileSync(f, 'utf8'))]))

/** Relative imports of one file, resolved to absolute paths. */
function importsOf(file) {
  const src = source.get(file)
  const out = []
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
    out.push(resolve(dirname(file), m[1]))
  }
  return out.filter(p => source.has(p))
}

/** Registers a processor at module scope, i.e. is an addModule() entry point. */
const isEntryPoint = f => /\bregisterProcessor\s*\(/.test(source.get(f))

const ENTRY_POINTS = FILES.filter(isEntryPoint)
const rel = f => f.slice(AUDIO.length + 1)

/**
 * The legitimate entry-point-to-entry-point imports, allowlisted by name.
 *
 * ⚠ THESE ARE EXCEPTIONS, NOT A PRECEDENT, AND EACH IS ONLY SAFE BECAUSE THE
 * COLLISION WAS DESIGNED FOR. Scheps Parallel COMPOSES `LA2AKernel` — holding
 * the kernel rather than copying it is the whole architecture — so its bundle
 * necessarily carries the LA-2A module, and `la2aProcessor.js` wraps its own
 * `registerProcessor` in a try/catch that swallows exactly NotSupportedError
 * for this reason.
 *
 * Anything added here needs the same two things: a real structural need, and a
 * guarded registration on the imported side. The second half is not a matter of
 * good intentions — `every allowlisted import guards its own registration`
 * below checks it, because an entry added without the guard makes the duplicate
 * real rather than handled, and nothing would notice until two plugins were
 * open at once.
 */
const ALLOWED = new Map([
  ['schepsProcessor.js', new Set(['la2aProcessor.js'])],
  /**
   * ⚠ THE VOCAL CHAIN'S DYNAMICS SECTION COMPOSES ALL THREE, and that IS its
   * architecture rather than a convenience: holding the shipping kernels means
   * every module constant — the clipper's shape table, the FET's ballistics,
   * the opto's taper and cell and tube laws — reaches the composite with no
   * conforming change. A copy would be three more places for a retune to stop
   * arriving.
   *
   * ⚠ ALL THREE IMPORTED SIDES ARE GUARDED, which is the other half of what
   * this allowlist requires. `fet1176Processor.js` and `softClipperProcessor.js`
   * were NOT before this entry was added — only the LA-2A was, for Scheps — so
   * adding the composite meant adding their guards too. Allowlisting without
   * that would have made the duplicate registration real rather than handled.
   */
  ['dynamicsProcessor.js', new Set([
    'la2aProcessor.js', 'fet1176Processor.js', 'softClipperProcessor.js',
  ])],
])
const allowed = (from, to) => ALLOWED.get(rel(from))?.has(rel(to)) ?? false

test('the audio tree actually contains worklet entry points to check', () => {
  // Guards the guard: a matcher that silently stops matching would make every
  // assertion below vacuous.
  assert.ok(ENTRY_POINTS.length >= 5,
    `expected several registerProcessor modules, found ${ENTRY_POINTS.length}`)
})

test('no worklet entry point reaches another one through its imports', () => {
  for (const entry of ENTRY_POINTS) {
    const seen = new Set([entry])
    const stack = [...importsOf(entry)]
    const via = new Map(stack.map(d => [d, [rel(entry), rel(d)]]))
    while (stack.length) {
      const cur = stack.pop()
      if (seen.has(cur)) continue
      seen.add(cur)
      const path = via.get(cur)
      assert.ok(!isEntryPoint(cur) || allowed(entry, cur),
        `${rel(entry)} imports the worklet entry point ${rel(cur)} via `
        + `${path.join(' -> ')}. Both register a processor at module scope, so `
        + 'whichever AudioContext loads both gets a duplicate registration and '
        + 'one plugin is silently dead. Move the shared code into a module '
        + 'that registers nothing (see dsp/satCurves.js).')
      for (const d of importsOf(cur)) {
        if (!seen.has(d)) { stack.push(d); via.set(d, [...path, rel(d)]) }
      }
    }
  }
})

test('every allowlisted import guards its own registration', () => {
  /**
   * ⚠ THE ALLOWLIST IS ONLY SAFE WHILE THIS HOLDS. An entry allows a composite
   * to carry another processor's module into a shared AudioContext; the guard
   * on the imported side is what makes the resulting duplicate a no-op rather
   * than an aborted module. Allowlisting without guarding would turn this
   * file's whole argument inside out, and nothing else would notice until two
   * plugins were open at once.
   */
  for (const [from, tos] of ALLOWED) {
    for (const to of tos) {
      const src = source.get(join(AUDIO, to))
      assert.ok(src, `${to} is allowlisted for ${from} but does not exist`)
      assert.match(
        src, /try\s*\{\s*registerProcessor\(/,
        `${to} is allowlisted as a dependency of ${from} but registers `
        + 'unguarded — a second load into one AudioContext would abort it',
      )
      assert.match(
        src, /NotSupportedError/,
        `${to} must swallow exactly NotSupportedError and nothing else`,
      )
    }
  }
})

test('the curves are still Tube Saturation\'s own, not a second copy', () => {
  // The whole reason for importing rather than pasting. If satCurves.js were
  // ever forked, a retune of Tube Saturation would stop reaching OptoSmooth.
  const proc = source.get(join(AUDIO, 'vocalSatProcessor.js'))
  assert.match(proc, /from '\.\/dsp\/satCurves\.js'/,
    'vocalSatProcessor must consume the shared curves, not redefine them')
  assert.doesNotMatch(proc, /^(export )?function shape\(/m,
    'a second definition of shape() has appeared in the processor')
})
