/**
 * The phone's Effects menu (components/mobile/MobileEffectsMenu.vue): which
 * operations it lists and in what group order, and the tool sheet's target
 * line (ui/mobileEffects.js).
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MOBILE_EXCLUDED_CATEGORIES, MOBILE_MENU_CATEGORY_ORDER, mobileMenuOperations, targetLine,
} from '../../src/ui/mobileEffects.js'

test('the menu lists every effect, but not the one-tap edits or other surfaces', () => {
  const ops = [
    { id: 'cut', category: 'edit', surface: 'immediate' },
    { id: 'trim', category: 'edit', surface: 'rail' },
    { id: 'fade', category: 'level', surface: 'rail' },
    { id: 'fet-punch', category: 'dynamics', surface: 'window' },
    { id: 'presets', category: 'master', surface: 'rail' },
    { id: 'plugin-chain', category: null, surface: 'window' },
  ]
  assert.deepEqual(mobileMenuOperations(ops).map(o => o.id), ['trim', 'fade', 'fet-punch'])
})

test('the group order names every toolbar category but the excluded ones', () => {
  // Read as source: the registry imports every panel's .vue file.
  const src = readFileSync(new URL('../../src/ui/registry.js', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf('const ALL_CATEGORIES'), src.indexOf('const ALL_OPERATIONS'))
  const ids = [...block.matchAll(/^\s+id: '([^']+)'/gm)].map(m => m[1])
  assert.ok(ids.length >= 5, 'read the categories')
  const expected = ids.filter(id => !MOBILE_EXCLUDED_CATEGORIES.has(id)).sort()
  assert.deepEqual([...MOBILE_MENU_CATEGORY_ORDER].sort(), expected)
})

test('the target line says what a tool would act on', () => {
  assert.equal(targetLine(null, false), 'No file open')
  assert.equal(targetLine(null, true), 'Nothing selected')
  assert.equal(targetLine({ start: 1, end: 13.54 }, true), 'Selection · 12.54 s')
  assert.equal(targetLine({ start: 0, end: 125.4 }, true), 'Selection · 2:05.4')
  assert.equal(targetLine({ start: 2, end: 2 }, true), 'Nothing selected')
})
