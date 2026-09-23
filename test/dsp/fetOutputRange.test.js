/**
 * The Output knob's travel is the Input knob's drive, mirrored — derived, so
 * the two cannot drift apart again. It was -36..+24; the -36 was the makeup
 * plan's generic default and no setting could use the bottom 12 dB of it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FET1176Kernel, FET1176_OUTPUT_MIN_DB, FET1176_OUTPUT_MAX_DB, inputDriveDbForKnob,
} from '../../src/audio/fet1176Processor.js'
import { INPUT_TRIM_MAX_DB } from '../../src/audio/dsp/inputAlign.js'
import { pickParams } from '../../src/audio/pluginPresets/store.js'
import { registerPluginPresets } from '../../src/audio/pluginPresets/index.js'
import { FET_PUNCH_PRESET_PLUGIN } from '../../src/audio/pluginPresets/fetPunch.js'

const SR = 96000

test('Output spans exactly the Input drive, mirrored about unity', () => {
  assert.equal(FET1176_OUTPUT_MAX_DB, -FET1176_OUTPUT_MIN_DB, 'symmetric about 0 dB')
  assert.equal(FET1176_OUTPUT_MAX_DB, -inputDriveDbForKnob(0),
    'the top undoes the least drive Input can apply')
  assert.equal(FET1176_OUTPUT_MIN_DB, -inputDriveDbForKnob(100),
    'the bottom undoes the most drive Input can apply')
})

/**
 * The derivation, checked on the audio rather than the arithmetic: at each end
 * of Input, with Align trimmed so the detector sees nothing to compress, the
 * matching end of Output lands the wet path back on unity. Any setting that
 * compresses needs less cut than this, so these are the extremes.
 */
test('each end of Output exactly cancels the matching end of Input', () => {
  for (const [inputDrive, inputAlignDb, outputGainDb] of [
    [100, -INPUT_TRIM_MAX_DB, FET1176_OUTPUT_MIN_DB],
    [0, 0, FET1176_OUTPUT_MAX_DB],
  ]) {
    const k = new FET1176Kernel(SR)
    k.setParams({ inputDrive, inputAlignDb, outputGainDb, mix: 1, oversample: false })
    const x = new Float32Array(SR)
    for (let i = 0; i < x.length; i++) x[i] = 0.03 * Math.sin(2 * Math.PI * 1000 * i / SR)
    const y = new Float32Array(x.length)
    for (let f = 0; f < x.length; f += 128) {
      const l = Math.min(128, x.length - f)
      k.process([x.subarray(f, f + l)], [y.subarray(f, f + l)], l)
    }
    // Second half only, past the output-gain smoothing.
    const rms = a => Math.sqrt(a.subarray(SR / 2).reduce((s, v) => s + v * v, 0) / (SR / 2))
    const netDb = 20 * Math.log10(rms(y) / rms(x))
    assert.ok(Math.abs(netDb) < 0.05,
      `Input ${inputDrive} / Output ${outputGainDb}: net ${netDb.toFixed(3)} dB, expected unity`)
  }
})

test('a saved manual Output outside the travel clamps to it', () => {
  registerPluginPresets()
  const at = output => pickParams(FET_PUNCH_PRESET_PLUGIN, { autoMakeup: false, output }).output
  assert.equal(at(-36), FET1176_OUTPUT_MIN_DB)
  assert.equal(at(30), FET1176_OUTPUT_MAX_DB)
  assert.equal(at(-12.5), -12.5)
})
