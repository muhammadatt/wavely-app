import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tuningEnabled } from '../../src/audio/softClipperTuning.js'
import {
  SOFT_CLIPPER_DEFAULTS, toKernelParams,
} from '../../src/audio/effects/softClipperParams.js'
import {
  SOFT_CLIPPER_KERNEL_DEFAULTS, SOFT_CLIPPER_LATENCY_SAMPLES, softClipperLatencySamples,
} from '../../src/audio/softClipperProcessor.js'

test('the tuning panel is off unless explicitly asked for', () => {
  // ⚠ THE POINT OF THE FLAG. What is behind it is scaffolding (the drive
  // ratios) and research controls (Limiter, Knee, HF Emphasis); the failure to
  // prevent is a half-finished tuning session reaching a user, so the default
  // has to be off with no window, no query string and no stored preference.
  assert.equal(tuningEnabled(), false, 'admin tuning is on by default')
})

// ── The Drive ratios and their two tests are gone ──────────────────────────
//
// They pinned that the ratios clamped to [0, 1.5] (above which a component
// reaches full travel before Drive is halfway and the rest of the knob does
// nothing) and that the panel's seeded values matched the kernel's constants
// (if they drifted, opening the tuning panel changed the sound before anyone
// touched a knob). Both described a knob that split Drive between Asymmetry,
// HF Loss and Soften. Asymmetry is deleted and HF Loss moved to Tube
// Saturation, so there is one member left and nothing to split.

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
    'fixedThresholdDb', 'shape', 'soften', 'limiter']) {
    assert.ok(key in SOFT_CLIPPER_DEFAULTS,
      `${key} is not in SOFT_CLIPPER_DEFAULTS — setParam will drop it silently`)
  }
})

test('toKernelParams forwards exactly what the kernel reads, and nothing pinned', () => {
  const out = toKernelParams({ ...SOFT_CLIPPER_DEFAULTS, soften: 40 })
  assert.equal(out.soften, 40)
  assert.ok(!('drive' in out), 'the drive knob is back')
  assert.ok(!('driveRatios' in out), 'the ratio override is back')
  // The pinned params must NOT be forwarded: an absent key would overwrite the
  // kernel's pin with undefined. See HYST_MAX_DB and the emphasis pin.
  assert.ok(!('hysteresis' in out), 'hysteresis is forwarded, which would unpin it')
  assert.ok(!('emphasisDb' in out), 'emphasisDb is forwarded, which would unpin it')
})

test('a real zero reaches the kernel rather than reading as absent', () => {
  // ⚠ THE FAILURE MODE THE EAR CAUGHT, kept after the ratios went. The kernel
  // reads these with `??`, which falls back only on null and undefined — so a
  // genuine 0 has to survive the whole path or a control set to off keeps
  // colouring. It cost a listening session once already.
  assert.equal(toKernelParams({ ...SOFT_CLIPPER_DEFAULTS, soften: 0 }).soften, 0)
  assert.equal(toKernelParams({ ...SOFT_CLIPPER_DEFAULTS, limiter: 0 }).limiter, 0)
})

test('the faceplate defaults come from the kernel, not from a second copy', () => {
  // Limiter and the knee came OFF the faceplate onto the hidden tuning panel,
  // which only works if the values a user gets are the kernel's own. A panel
  // default restated here would be a second source of truth for a control
  // nobody can see to correct — the worst possible place for a divergence.
  assert.equal(SOFT_CLIPPER_DEFAULTS.limiter, SOFT_CLIPPER_KERNEL_DEFAULTS.limiter)
  assert.equal(SOFT_CLIPPER_DEFAULTS.shape, SOFT_CLIPPER_KERNEL_DEFAULTS.shape)
  // And the two the panel now ships with, stated so a silent move fails here.
  assert.equal(SOFT_CLIPPER_DEFAULTS.limiter, 100)
  assert.equal(SOFT_CLIPPER_DEFAULTS.shape, 'tanh4')
})

test('emphasisDb reaches the kernel only when the tuning panel sets a number', () => {
  // ⚠ THE PIN AND THE KNOB HAVE TO COEXIST. emphasisDb is pinned in the kernel
  // and reachable from the hidden panel, which means three states rather than
  // two: shipped (forward nothing, the pin governs), tuned (forward the
  // number), and the trap in between — forwarding the key with no value. The
  // kernel merges partials over its own defaults, so `emphasisDb: undefined`
  // does not fall back to the pin, it OVERWRITES it and NaNs its way through
  // the recompute guard. Hence null in the defaults and a spread-or-nothing in
  // toKernelParams.
  assert.equal(SOFT_CLIPPER_DEFAULTS.emphasisDb, null,
    'the panel mirrors the pin, which is one stale copy away from overriding it')
  assert.ok(!('emphasisDb' in toKernelParams(SOFT_CLIPPER_DEFAULTS)),
    'the shipped path forwards emphasisDb, which unpins it')
  assert.ok(!('emphasisDb' in toKernelParams({ ...SOFT_CLIPPER_DEFAULTS, emphasisDb: undefined })))
  assert.ok(!('emphasisDb' in toKernelParams({ ...SOFT_CLIPPER_DEFAULTS, emphasisDb: NaN })))
  assert.equal(toKernelParams({ ...SOFT_CLIPPER_DEFAULTS, emphasisDb: 6 }).emphasisDb, 6)
  // 0 is a real setting — the cleanest one, measured — so it must not be read
  // as "absent" the way the ratio knobs' 0 nearly was.
  assert.equal(toKernelParams({ ...SOFT_CLIPPER_DEFAULTS, emphasisDb: 0 }).emphasisDb, 0)
})

test('every param the hidden panel can set survives the setParam guard', () => {
  // Same failure the drive ratios hit: `setParam` guards with `name in params`,
  // so a key missing from SOFT_CLIPPER_DEFAULTS is silently dropped and the
  // knob describes nothing. The hidden knobs are the ones this matters most
  // for — nobody is watching them by accident.
  for (const key of ['limiter', 'shape', 'emphasisDb']) {
    assert.ok(key in SOFT_CLIPPER_DEFAULTS,
      `${key} is not in SOFT_CLIPPER_DEFAULTS — setParam will drop it silently`)
  }
})

test('the apply path can reach the real latency, not just the bypass constant', () => {
  // ⚠ THE BUILD CAUGHT THIS AND THE SUITE COULD NOT. `effects/softClipper.js`
  // pulls a Vite `?worker&url` specifier, so nothing in it is reachable from
  // node — the same blind spot that hid a silently-dropped param once already.
  // processing.js imports the latency function THROUGH that file, so a missing
  // re-export is a broken build rather than a failing test.
  //
  // This pins the contract from the importable side: the processor exports the
  // function, it disagrees with the bypass constant at the shipped default, and
  // it agrees with it when the limiter is off.
  const SR = 44100
  assert.equal(typeof softClipperLatencySamples, 'function')
  assert.equal(softClipperLatencySamples({ limiter: 0 }, SR), SOFT_CLIPPER_LATENCY_SAMPLES)
  assert.ok(softClipperLatencySamples(SOFT_CLIPPER_KERNEL_DEFAULTS, SR) > SOFT_CLIPPER_LATENCY_SAMPLES,
    'the shipped default reports the bypass latency — the apply path will mis-trim')
})
