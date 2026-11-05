/**
 * Plugin Chain calibration (usePluginChain.js): a slot's preview measures what
 * the slots above it hand it. AUTO re-calibrates when something upstream
 * changes, judged by each slot's `settingsKey()` — its USER settings only.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { settingsKeyOf } from '../../src/composables/chainSettingsKey.js'

const DIR = 'src/composables'

test('settingsKeyOf keys the user settings and ignores the measured ones', () => {
  const a = settingsKeyOf({ peakReduction: 50, gain: 3.2, ceilingDb: -1 }, ['gain', 'ceilingDb'])
  const b = settingsKeyOf({ ceilingDb: -4, gain: 7.9, peakReduction: 50 }, ['gain', 'ceilingDb'])
  assert.equal(a, b, 'a re-measure (or key order) is not a change')
  assert.notEqual(a, settingsKeyOf({ peakReduction: 51, gain: 3.2, ceilingDb: -1 }, ['gain', 'ceilingDb']))
})

test('every chainable plugin declares its user settings (`settingsKey`)', () => {
  // ⚠ Without one, a knob turned on that slot neither marks the slots after it
  // STALE nor re-calibrates them in AUTO: they go on measuring audio the chain
  // no longer produces, with nothing on screen to say so.
  const missing = []
  let found = 0
  for (const f of readdirSync(DIR).filter(n => n.endsWith('.js') && n !== 'usePluginChain.js')) {
    const src = readFileSync(join(DIR, f), 'utf8')
    for (const m of src.matchAll(/registerChainPlugin\(\{([\s\S]*?)\n\s*\}\)/g)) {
      found++
      if (!/\bsettingsKey\s*:/.test(m[1])) missing.push(f)
    }
  }
  assert.ok(found >= 17, `found only ${found} registrations — the scan no longer matches them`)
  assert.deepEqual(missing, [])
})
