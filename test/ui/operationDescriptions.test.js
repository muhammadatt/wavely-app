import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Every operation's description must fit its rail row on ONE line. The rail
 * (ContextPanel, 300 px) leaves the description ~195 px — ~180 with a classic
 * scrollbar — at 11 px Inter medium, and the rows are not allowed to grow
 * taller (owner, November 2026). Node cannot measure a font, so the cap is in
 * characters: the shipped set measures 98–180 px at up to 34 characters. A
 * description over the cap needs rewording, not a wider rail.
 *
 * Read from the source rather than imported: the registry imports every
 * panel's .vue file, which node cannot load.
 */
const MAX_DESC_CHARS = 34

const registry = readFileSync(new URL('../../src/ui/registry.js', import.meta.url), 'utf8')
const opSrc = registry.slice(registry.indexOf('const ALL_OPERATIONS = ['))

const descs = [...opSrc.matchAll(/\n    id: '([^']+)',[\s\S]*?\n    desc: '([^']+)',/g)]
  .map(m => ({ id: m[1], desc: m[2] }))

test('every operation has a description', () => {
  assert.ok(descs.length >= 30, `found only ${descs.length}`)
})

test(`operation descriptions fit the rail row (≤ ${MAX_DESC_CHARS} characters)`, () => {
  const long = descs.filter(d => d.desc.length > MAX_DESC_CHARS)
  assert.deepEqual(long.map(d => `${d.id}: ${d.desc} (${d.desc.length})`), [])
})
