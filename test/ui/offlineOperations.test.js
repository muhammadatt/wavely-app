/**
 * Offline processes are marked as such everywhere they appear (registry
 * `offline` → the OFFLINE tag in lists and the palette, FloatingWindow's
 * `offline` mode), and the registry and the plan table agree on which they are.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FEATURES } from '../../src/auth/plans.js'

const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

/** id -> { feature, offline } read from the registry source (it imports .vue files). */
function registryEntries() {
  const src = read('src/ui/registry.js')
  const out = {}
  for (const block of src.split(/\n  \{\n/).slice(1)) {
    const id = /\n?\s*id: '([^']+)'/.exec(block)?.[1]
    if (!id) continue
    out[id] = {
      feature: /feature: '([^']+)'/.exec(block)?.[1] ?? null,
      offline: /\n\s*offline: true,/.test(block),
      chain: /\n\s*chain: true,/.test(block),
    }
  }
  return out
}

test('the registry and the plan table agree on which operations are offline', () => {
  const ops = registryEntries()
  assert.ok(ops['noise-reduction']?.offline)
  assert.ok(ops['auto-leveler']?.offline)
  for (const [id, op] of Object.entries(ops)) {
    const featureOffline = op.feature ? FEATURES[op.feature]?.offline === true : false
    assert.equal(op.offline, featureOffline, `${id}: registry offline ≠ plan feature offline`)
    // An offline process has no live node, so it cannot take a chain slot.
    if (op.offline) assert.equal(op.chain, false, `${id}: offline and chainable`)
  }
})

test('every operation list shows the offline badge', () => {
  for (const p of ['src/components/ui/OperationList.vue', 'src/components/CommandPalette.vue']) {
    assert.match(read(p), /<OfflineBadge :show="!!op\.offline" \/>/, p)
  }
})

test('offline windows use the offline chrome and no real-time controls', () => {
  for (const p of ['src/components/panels/NoiseReductionModal.vue', 'src/components/panels/AutoLevelModal.vue']) {
    const src = read(p)
    assert.match(src, /\n\s+offline\n/, `${p}: missing the offline prop`)
    assert.match(src, /:show-engage="false"/, `${p}: shows ON/BYPASS`)
    assert.doesNotMatch(src, /show-preview|show-delta/, `${p}: shows Preview or Delta`)
  }
})
