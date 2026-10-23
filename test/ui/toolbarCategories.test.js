import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * The toolbar's category layout. Read from the source rather than imported:
 * the registry imports every panel's .vue file, which node cannot load. Moving
 * an operation between menus should be a deliberate edit here too.
 */
const registry = readFileSync(new URL('../../src/ui/registry.js', import.meta.url), 'utf8')
const catSrc = registry.slice(registry.indexOf('const ALL_CATEGORIES = ['), registry.indexOf('const ALL_OPERATIONS = ['))
const opSrc = registry.slice(registry.indexOf('const ALL_OPERATIONS = ['))

const categoryIds = [...catSrc.matchAll(/\n    id: '([^']+)',/g)].map(m => m[1])

/** { category: [ [group, id], ... ] } in declaration order. */
function layout() {
  const out = {}
  for (const m of opSrc.matchAll(/\n  \{\n([\s\S]*?)\n  \},/g)) {
    const body = m[1]
    const id = body.match(/\n?    id: '([^']+)',/)[1]
    const cat = body.match(/    category: (?:'([^']+)'|null),/)[1] ?? null
    const group = body.match(/    group: '([^']+)',/)?.[1] ?? ''
    ;(out[cat] ??= []).push(group ? `${group}: ${id}` : id)
  }
  return out
}

test('the toolbar is Edit, Level, Dynamics, Tone, Clean, then Master', () => {
  assert.deepEqual(categoryIds, ['edit', 'level', 'dynamics', 'tone', 'clean', 'master'])
})

test('every operation sits in its menu, in order', () => {
  assert.deepEqual(layout(), {
    edit: [
      'Clipboard: cut', 'Clipboard: copy', 'Clipboard: paste', 'Clipboard: select-all',
      'Arrange: trim', 'Arrange: split', 'Arrange: silence',
    ],
    level: ['normalize', 'loudness', 'fade', 'volume'],
    dynamics: ['auto-leveler', 'soft-clipper', 'opto-smooth', 'fet-punch', 'scheps-parallel', 'inflator'],
    tone: ['manual-eq', 'voicerx', 'air-band', 'phatass', 'vocal-saturation', 'saturation-bench'],
    clean: [
      'Harshness: hf-softener', 'Harshness: clip-gain-deesser', 'Harshness: hf-limiter',
      'Harshness: resonance-suppressor',
      'Pops & Hum: plosive', 'Pops & Hum: hum-remover',
      'Analysis: spectrum-analyzer', 'Analysis: modula-kit',
    ],
    null: ['plugin-chain'],
  })
})

test('every category an operation names exists', () => {
  for (const m of opSrc.matchAll(/    category: '([^']+)',/g)) {
    assert.ok(categoryIds.includes(m[1]), m[1])
  }
})
