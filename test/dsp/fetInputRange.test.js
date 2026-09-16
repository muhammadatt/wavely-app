/**
 * The Input knob's extended top: that it reaches the reference, and that
 * extending it did not quietly re-voice everything already saved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FET1176Kernel } from '../../src/audio/fet1176Processor.js'
import { FET_PUNCH_PRESETS } from '../../src/audio/pluginPresets/fetPunch.js'

const SR = 96000
const driveDbAt = knob => {
  const k = new FET1176Kernel(SR)
  k.setParams({ inputDrive: knob })
  return k.inputDriveDb
}

/**
 * ⚠ THIS IS THE GUARANTEE THE WHOLE DESIGN EXISTS FOR. `inputDrive` is a value
 * presets SAVE, so raising IN_DRIVE_SPAN_DB — the obvious fix — would have
 * re-voiced all five factory presets and every stored user patch, silently: at
 * span 47 the knob's midpoint runs 3.4 dB hotter than the number beside it used
 * to mean. The extra travel is therefore added above a knee, and below that knee
 * the law is untouched.
 */
const LEGACY = [
  [0, -24.000], [25, -10.805], [40, -4.782], [50, -1.026], [55, 0.794],
  [60, 2.582], [70, 6.070], [75, 7.777], [80, 9.460],
]

test('below the knee the drive is exactly what it always was', () => {
  for (const [knob, db] of LEGACY) {
    assert.ok(Math.abs(driveDbAt(knob) - db) < 0.001,
      `knob ${knob}: ${driveDbAt(knob).toFixed(3)} dB against the legacy ${db}`)
  }
})

/**
 * ⚠ AND THE GUARANTEE ONLY HOLDS WHILE THE PRESETS STAY UNDER THE KNEE. A
 * factory preset added at 90 would be silently re-voiced by this change, so the
 * invariant is pinned here rather than left to whoever adds the next one.
 */
test('every factory preset sits below the knee, which is why they are untouched', () => {
  const hottest = Math.max(...FET_PUNCH_PRESETS.map(p => p.params.inputDrive ?? 50))
  assert.ok(hottest <= 80,
    `a factory preset sits at inputDrive ${hottest}, above the knee — it has been re-voiced`)
})

test('the knee has no kink in it', () => {
  const slope = k => (driveDbAt(k + 0.01) - driveDbAt(k - 0.01)) / 0.02
  const below = slope(79.5), above = slope(80.5)
  // A linear ramp would step the slope; the smoothstep leaves it continuous.
  assert.ok(Math.abs(above - below) < 0.1,
    `slope steps ${below.toFixed(3)} -> ${above.toFixed(3)} at the knee`)
})

test('the top of the travel clears the depth the reference reached', () => {
  // FETish sat at 21.86 dB of reduction in the capture our knob could not
  // follow. The knob must clear that, not land under it.
  assert.ok(driveDbAt(100) >= 24 - 1e-9)
  assert.ok(driveDbAt(100) > driveDbAt(99), 'and must still be rising at the top')
})

test('the law stays monotonic across the join', () => {
  let prev = -Infinity
  for (let knob = 0; knob <= 100; knob += 0.5) {
    const db = driveDbAt(knob)
    assert.ok(db > prev, `drive fell at knob ${knob}`)
    prev = db
  }
})
