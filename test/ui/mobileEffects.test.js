/**
 * The phone's effect-list sheet (components/mobile/MobileEffectSheet.vue):
 * which effects it leads with, and its target line (ui/mobileEffects.js).
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MOBILE_V1_OPERATION_IDS, isMobileV1, splitForMobile, targetLine } from '../../src/ui/mobileEffects.js'

test('every v1 id names a released operation in the registry', () => {
  // Read as source: the registry imports every panel's .vue file.
  const src = readFileSync(new URL('../../src/ui/registry.js', import.meta.url), 'utf8')
  const entries = src.split(/\n  \{\n/).slice(1)
  const byId = new Map()
  for (const e of entries) {
    const id = e.match(/^\s+id: '([^']+)'/m)?.[1]
    if (id) byId.set(id, e)
  }
  for (const id of MOBILE_V1_OPERATION_IDS) {
    assert.ok(byId.has(id), `${id} is in the registry`)
    assert.ok(!/release: 'dev'/.test(byId.get(id)), `${id} ships in production`)
  }
  assert.ok(!MOBILE_V1_OPERATION_IDS.includes('plugin-chain'), 'the chain is a tab and a door, not a row')
})

test('the split keeps groups and order, and puts the rest under More', () => {
  const op = id => ({ id })
  const groups = [
    { group: 'Noise', operations: [op('noise-reduction')] },
    { group: 'Harshness', operations: [op('de-esser'), op('hf-limiter')] },
    { group: 'Pops & Hum', operations: [op('hum-remover')] },
  ]
  const { primary, more } = splitForMobile(groups)
  assert.deepEqual(primary.map(g => [g.group, g.operations.map(o => o.id)]), [
    ['Noise', ['noise-reduction']],
    ['Harshness', ['de-esser']],
  ], 'a group with no v1 effect is dropped from the lead list')
  assert.deepEqual(more.map(o => o.id), ['hf-limiter', 'hum-remover'])
  assert.equal(isMobileV1(null), false)
})

test('the target line says what an effect would act on', () => {
  assert.equal(targetLine(null, false), 'No file open')
  assert.equal(targetLine(null, true), 'Nothing selected')
  assert.equal(targetLine({ start: 1, end: 13.54 }, true), 'Selection · 12.54 s')
  assert.equal(targetLine({ start: 0, end: 125.4 }, true), 'Selection · 2:05.4')
  assert.equal(targetLine({ start: 2, end: 2 }, true), 'Nothing selected')
})
