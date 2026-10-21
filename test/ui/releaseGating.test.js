import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

/**
 * Which operations a production build hides (`release: 'dev'` in the registry).
 *
 * Read from the source rather than imported: the registry imports every panel's
 * .vue file, which node cannot load. Changing what ships should be a deliberate
 * edit to this list as well as to the registry, not a side effect.
 */
const ROOT = new URL('../../', import.meta.url)
const registry = readFileSync(new URL('src/ui/registry.js', ROOT), 'utf8')

function devOnlyIds(src) {
  const ids = []
  const re = /id: '([^']+)',\s*\n\s*release: 'dev',/g
  for (let m; (m = re.exec(src));) ids.push(m[1])
  return ids.sort()
}

test('the work-in-progress plugins are hidden from production builds', () => {
  assert.deepEqual(devOnlyIds(registry), [
    'clip-gain-deesser',
    'modula-kit',
    'plosive',
    'saturation-bench',
    'scheps-parallel',
    'vocal-saturation',
    'voicerx',
  ])
})

test('every surface reads the gated list, not the full one', () => {
  // ALL_OPERATIONS is private; only the filtered OPERATIONS is exported, and
  // the lookups, groupings, window table and search are all built from it.
  assert.match(registry, /^const ALL_OPERATIONS = \[/m)
  assert.doesNotMatch(registry, /export const ALL_OPERATIONS/)
  assert.match(registry, /export const OPERATIONS = ALL_OPERATIONS\.filter\(op => isReleased\(op\)\)/)
})

test('the placeholder Noise Reduction and Remove Silence panels are gone', () => {
  assert.doesNotMatch(registry, /noise-reduction|remove-silence|NoiseReductionWindow|RemoveSilenceWindow/)
  for (const f of [
    'src/components/panels/windows/NoiseReductionWindow.vue',
    'src/components/panels/windows/RemoveSilenceWindow.vue',
  ]) assert.equal(existsSync(new URL(f, ROOT)), false, f)
})
