import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DRIVE_RATIOS, driveTuningEnabled, clampRatio,
} from '../../src/audio/softClipperTuning.js'

test('the tuning panel is off unless explicitly asked for', () => {
  // ⚠ THE POINT OF THE FLAG. These ratios are scaffolding; the failure to
  // prevent is a half-finished tuning session reaching a user, so the default
  // has to be off with no window, no query string and no stored preference.
  assert.equal(driveTuningEnabled(), false, 'drive tuning is on by default')
})

test('ratios are clamped to a range where the knob still teaches you something', () => {
  // Above 1.5 a component reaches its own full travel before Drive is halfway
  // and the rest of the sweep does nothing — the saturating-control failure
  // this collapse existed to remove.
  assert.equal(clampRatio(2.5), 1.5)
  assert.equal(clampRatio(-1), 0)
  assert.equal(clampRatio(0.65), 0.65)
  // Garbage from a stored string must not become NaN and silently disable a
  // component: NaN * anything is NaN, and clamp() would pass it through.
  assert.equal(clampRatio('nonsense'), 0)
  assert.equal(clampRatio(undefined), 0)
})

test('the seeded ratios match what the kernel ships', async () => {
  // The panel seeds its knobs from here rather than from the kernel, so the
  // two can drift. If they do, opening the tuning panel would silently change
  // the sound before anyone touched a knob — and the first measurement taken
  // in that session would be against a build nobody chose.
  const kernel = await import('../../src/audio/softClipperProcessor.js')
  const src = await import('node:fs').then(fs =>
    fs.readFileSync('src/audio/softClipperProcessor.js', 'utf8'))
  const read = name => Number(src.match(new RegExp(`^const ${name} = ([\\d.]+)`, 'm'))[1])
  assert.equal(DEFAULT_DRIVE_RATIOS.asymmetry, read('DRIVE_ASYM_RATIO'))
  assert.equal(DEFAULT_DRIVE_RATIOS.hfLoss, read('DRIVE_HF_LOSS_RATIO'))
  assert.equal(DEFAULT_DRIVE_RATIOS.soften, read('DRIVE_SOFTEN_RATIO'))
  assert.ok(kernel.SOFT_CLIPPER_KERNEL_DEFAULTS.drive === 0)
})
