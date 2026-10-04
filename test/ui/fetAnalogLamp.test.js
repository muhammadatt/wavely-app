import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toKernelParams, FET1176_DEFAULTS, FET1176_LATENCY_SAMPLES } from '../../src/audio/effects/fet1176Params.js'
import { FET_PUNCH_PRESET_PLUGIN, FET_PUNCH_PRESETS } from '../../src/audio/pluginPresets/fetPunch.js'
import { getPluginPresetDef } from '../../src/audio/pluginPresets/store.js'

test('the Classic 76 lamp zeroes the FET stage and nothing else', () => {
  const on = toKernelParams({ ...FET1176_DEFAULTS, fetDrive: 0.4 })
  const off = toKernelParams({ ...FET1176_DEFAULTS, fetDrive: 0.4, analog: false })
  assert.equal(on.fetDrive, 0.4)
  assert.equal(off.fetDrive, 0)
  // Oversampling is never switched off from the panel, so latency cannot move.
  assert.notEqual(off.oversample, false)
  assert.ok(FET1176_LATENCY_SAMPLES > 0)
  const { fetDrive: _a, ...restOn } = on
  const { fetDrive: _b, ...restOff } = off
  assert.deepEqual(restOff, restOn)
})

test('FET Punch presets carry the lamp, and absent means on', () => {
  assert.ok(FET_PUNCH_PRESETS.every(p => p.params.analog === true))
  const { normalize } = getPluginPresetDef(FET_PUNCH_PRESET_PLUGIN)
  assert.equal(normalize({}).analog, true)
  assert.equal(normalize({ analog: false }).analog, false)
})
