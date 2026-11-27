import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { HELP_META } from '../../src/content/help/index.js'

/**
 * Which operations a production build hides (`release: 'dev'` in the registry).
 *
 * Read from the source rather than imported: the registry imports every panel's
 * .vue file, which node cannot load. The registry is the one place that says
 * what ships, so nothing here lists the released or the hidden plugins — the
 * tests follow whatever `release` says.
 */
const ROOT = new URL('../../', import.meta.url)
const registry = readFileSync(new URL('src/ui/registry.js', ROOT), 'utf8').replace(/\r\n/g, '\n')

/** { id: 'dev' | undefined } for every operation, wherever `release` sits in it. */
function operationReleases(src) {
  const ops = src.slice(src.indexOf('const ALL_OPERATIONS = ['))
  const out = {}
  for (const m of ops.matchAll(/\n  \{\n([\s\S]*?)\n  \},/g)) {
    const id = /\n?    id: '([^']+)',/.exec(m[1])[1]
    out[id] = /\n    release: '([^']+)',/.exec(m[1])?.[1]
  }
  return out
}

test('an operation marked release: dev is hidden from production, and nothing else is', () => {
  const ops = operationReleases(registry)
  assert.ok(Object.keys(ops).length > 20, 'the registry parse found its operations')
  // The gate is one rule — the registry's own isReleased — so a hidden id and
  // a released one differ only by this line.
  assert.match(registry, /return op\.release !== 'dev' \|\| devBuild/)
  assert.match(registry, /DEV_ONLY_OPERATION_IDS = ALL_OPERATIONS\s*\n\s*\.filter\(op => op\.release === 'dev'\)/)
  for (const [id, release] of Object.entries(ops)) {
    assert.ok(release === undefined || release === 'dev', `${id}: unknown release value ${release}`)
  }
})

test('the work-in-progress plugins are hidden from production builds', () => {
  // Kept as a list on purpose: shipping or hiding a plugin should be a
  // deliberate edit here as well as in the registry, never a side effect.
  const hidden = Object.entries(operationReleases(registry))
    .filter(([, release]) => release === 'dev')
    .map(([id]) => id)
    .sort()
  assert.deepEqual(hidden, [
    'clip-gain-deesser',
    'modula-kit',
    'plosive',
    'saturation-bench',
    'scheps-parallel',
    'spectral-denoise',
    'split',
    'vocal-saturation',
    'voicerx',
  ])
})

test('a help page is gated exactly as its operation is', () => {
  // The help entry carries its own copy of `release` (the editor cannot import
  // the registry from there); it has to follow the registry, whatever it says.
  const ops = operationReleases(registry)
  for (const [id, meta] of Object.entries(HELP_META)) {
    assert.ok(id in ops, `${id}: help page for an operation the registry does not have`)
    assert.equal(meta.release, ops[id], `${id}: help release differs from the registry`)
  }
})

test('every surface reads the gated list, not the full one', () => {
  // ALL_OPERATIONS is private; only the filtered OPERATIONS is exported, and
  // the lookups, groupings, window table and search are all built from it.
  assert.match(registry, /^const ALL_OPERATIONS = \[/m)
  assert.doesNotMatch(registry, /export const ALL_OPERATIONS/)
  assert.match(registry, /export const OPERATIONS = ALL_OPERATIONS\.filter\(op => isReleased\(op\)\)/)
})

test('the placeholder Noise Reduction and Remove Silence panels are gone', () => {
  // The id 'noise-reduction' is reused by the real (server-backed) plugin,
  // NoiseReductionModal; the placeholder window without DSP must not return.
  assert.doesNotMatch(registry, /remove-silence|NoiseReductionWindow|RemoveSilenceWindow/)
  for (const f of [
    'src/components/panels/windows/NoiseReductionWindow.vue',
    'src/components/panels/windows/RemoveSilenceWindow.vue',
  ]) assert.equal(existsSync(new URL(f, ROOT)), false, f)
})

test('the Master category is hidden from production builds', () => {
  // Categories gate the same way operations do; the toolbar reads the filtered
  // CATEGORIES, never the full list.
  assert.match(registry, /id: 'master',[\s\S]*?release: 'dev',\s*\n\s*\},\s*\n\]/)
  assert.match(registry, /^const ALL_CATEGORIES = \[/m)
  assert.match(registry, /export const CATEGORIES = ALL_CATEGORIES\.filter\(c => isReleased\(c\)\)/)
})
