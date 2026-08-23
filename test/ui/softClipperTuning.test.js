import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DRIVE_RATIOS, driveTuningEnabled, clampRatio,
} from '../../src/audio/softClipperTuning.js'
import {
  SOFT_CLIPPER_DEFAULTS, toKernelParams,
} from '../../src/audio/effects/softClipperParams.js'

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

test('every param the panel can set survives the setParam guard', () => {
  // ⚠ THE BUG THIS EXISTS FOR, and it was found by ear rather than by the
  // suite. `createSoftClipper.setParam` guards with `name in params`, where
  // params is a copy of SOFT_CLIPPER_DEFAULTS — so a key missing from that
  // object is not rejected, it is SILENTLY DROPPED. `driveRatios` was missing,
  // the ratio knobs pushed updates that never reached the kernel, the fixed
  // constants ran unchanged, and the panel showed values that described
  // nothing. A whole listening session was spent tuning a dead control.
  //
  // The guard is worth keeping — it stops a typo'd param name from reaching
  // the worklet — so what has to be pinned is that the panel's surface and the
  // guard's allowlist agree.
  for (const key of ['headroomDb', 'outputTrimDb', 'thresholdMode',
    'fixedThresholdDb', 'shape', 'drive', 'driveRatios']) {
    assert.ok(key in SOFT_CLIPPER_DEFAULTS,
      `${key} is not in SOFT_CLIPPER_DEFAULTS — setParam will drop it silently`)
  }
})

test('toKernelParams forwards exactly what the kernel reads, and nothing pinned', () => {
  const out = toKernelParams({ ...SOFT_CLIPPER_DEFAULTS, drive: 40, driveRatios: { asymmetry: 0 } })
  assert.equal(out.drive, 40)
  assert.deepEqual(out.driveRatios, { asymmetry: 0 })
  // The pinned params must NOT be forwarded: an absent key would overwrite the
  // kernel's pin with undefined. See HYST_MAX_DB and the emphasis pin.
  assert.ok(!('hysteresis' in out), 'hysteresis is forwarded, which would unpin it')
  assert.ok(!('emphasisDb' in out), 'emphasisDb is forwarded, which would unpin it')
})

test('a zeroed ratio actually zeroes its component', () => {
  // The failure mode the ear caught: ratios at 0 still colouring. `??` only
  // falls back on null/undefined, so a real 0 must survive to the kernel.
  assert.equal(clampRatio(0), 0)
  const out = toKernelParams({
    ...SOFT_CLIPPER_DEFAULTS, drive: 100,
    driveRatios: { asymmetry: 0, hfLoss: 0, soften: 0 },
  })
  assert.deepEqual(out.driveRatios, { asymmetry: 0, hfLoss: 0, soften: 0 })
})
