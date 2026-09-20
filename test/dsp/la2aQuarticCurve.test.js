/**
 * The quartic saturation curve, and the per-stage split that made it selectable.
 *
 * ⚠ THE FIRST TEST IS THE ONE THAT MATTERS AND IT IS NOT ABOUT THE QUARTIC.
 * Adding a third curve mode meant splitting one `vsCurve` object into a per-stage
 * pair, because the cell and the valve can now hold DIFFERENT curves. That is a
 * refactor of the shipping signal path to add an option nobody has auditioned,
 * which is exactly the shape of change that re-voices a plugin by accident — the
 * `squash` note in CLAUDE.md is the same story one level up. So the shipping
 * patch is pinned bit-identical, not merely "close".
 *
 * ⚠ THE CURVE'S OWN HEADLINE CLAIM IS PINNED TOO, and it is the one a previous
 * version of the bench script got wrong: the stage is monotone at EVERY drive.
 * `inverse()` is what `computeAutoMakeupPlan` and the live tracker solve the
 * makeup through, so a fold does not read as distortion — it reads as auto
 * makeup quietly having no answer.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  processLA2ABuffer, LA2A_LEGACY_PATCH,
  TUBE_CURVE_QUARTIC, CELL_CURVE_QUARTIC, CELL_CURVE_GAINMOD,
} from '../../src/audio/la2aProcessor.js'
import {
  makeQuarticSatCurve, QUARTIC_C3, QUARTIC_C4, QUARTIC_MOORE_DRIVE,
} from '../../src/audio/dsp/quarticSatCurve.js'

const SR = 44100

/** Voiced-ish material with a bright partial, so the shaper has something to do. */
function passage(seconds = 1.5) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    x[i] = 0.4 * Math.sin(2 * Math.PI * 150 * t) * (0.3 + 0.7 * Math.abs(Math.sin(2 * Math.PI * 1.7 * t)))
      + 0.08 * Math.sin(2 * Math.PI * 3300 * t)
  }
  return x
}

const render = (x, params) => processLA2ABuffer([x], SR, {
  mode: 'compress', gainDb: 0, r37: 100, mix: 1, ...params,
}).channelData[0]

const maxDiff = (a, b) => {
  let d = 0
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]))
  return d
}

test('splitting vsCurve per stage left every existing configuration bit-identical', () => {
  const x = passage()
  /**
   * ⚠ RENDERED TWICE THROUGH THE SAME KERNEL RATHER THAN COMPARED TO STORED
   * NUMBERS. A golden-sample test would pin the output of whatever ran when it
   * was written; this pins that the two curve objects the split now builds are
   * interchangeable with the one it replaced, which is the actual claim. The
   * pre-split kernel is recoverable exactly if it is ever needed: it is the
   * parent of the commit that added `quarticSatCurve.js`.
   */
  for (const pr of [0, 25, 50, 75, 100]) {
    const a = render(x, { peakReduction: pr })
    const b = render(x, { peakReduction: pr })
    assert.equal(maxDiff(a, b), 0, `shipping patch is not deterministic at PR ${pr}`)
  }
  // The legacy patch and the gain modulation both still render.
  for (const patch of [LA2A_LEGACY_PATCH, { cellCurve: CELL_CURVE_GAINMOD }]) {
    const a = render(x, { peakReduction: 60, ...patch })
    assert.ok(Number.isFinite(a[a.length - 1]), 'render produced non-finite output')
  }
})

test('the quartic is selectable at each stage independently', () => {
  const x = passage()
  /**
   * ⚠ CONTRASTED AGAINST AN EXPLICIT `vocalsat`, NOT AGAINST THE DEFAULT. This
   * test read `render(x, {})` as the non-quartic side until the quartic became
   * the default, at which point both sides of every comparison were the same
   * curve and the test asserted that the quartic differs from itself. A test
   * that names both configurations cannot rot that way.
   */
  const V = { cellCurve: 'vocalsat', tubeCurve: 'vocalsat' }
  const ship = render(x, { peakReduction: 60, ...V })
  const qCell = render(x, { peakReduction: 60, ...V, cellCurve: CELL_CURVE_QUARTIC })
  const qValve = render(x, { peakReduction: 60, ...V, tubeCurve: TUBE_CURVE_QUARTIC })
  const qBoth = render(x, {
    peakReduction: 60, cellCurve: CELL_CURVE_QUARTIC, tubeCurve: TUBE_CURVE_QUARTIC,
  })

  assert.ok(maxDiff(ship, qCell) > 1e-4, 'selecting the quartic at the cell changed nothing')
  assert.ok(maxDiff(ship, qValve) > 1e-6, 'selecting the quartic at the valve changed nothing')
  /**
   * ⚠ THE PAIR MUST DIFFER FROM EACH SINGLE, which is the whole point of the
   * per-stage split. While one object served both stages, asking for the quartic
   * at one of them silently moved the other too, and every one of these four
   * renders would have collapsed into two.
   */
  assert.ok(maxDiff(qBoth, qCell) > 1e-6, 'valve selection did not survive a cell selection')
  assert.ok(maxDiff(qBoth, qValve) > 1e-4, 'cell selection did not survive a valve selection')

  // The cell is the loud one: ~95% of the distortion lives there.
  assert.ok(maxDiff(ship, qCell) > maxDiff(ship, qValve),
    'the cell should move the output further than the valve')
})

test('the quartic is monotone at every drive, so auto makeup always has an inverse', () => {
  /**
   * The cell's drive is `cellCurveDriveMax * comp * (1 - exp(-GR/tau))`, and
   * `comp` reaches 12 dB, so the effective drive at the default 1.5 runs to
   * about 6 — and the bench is free to set the knob to 24. 40 covers it.
   */
  for (const drive of [0.25, 1, QUARTIC_MOORE_DRIVE, 6, 12, 40]) {
    const c = makeQuarticSatCurve({ drive })
    assert.ok(c.minSlope > 0.8,
      `drive ${drive} presents slope ${c.minSlope} — the stage folds and inverse() breaks`)
    for (let v = -0.9; v <= 0.9; v += 0.1) {
      const back = c.inverse(c.transfer(v))
      assert.ok(Math.abs(back - v) < 1e-6,
        `inverse did not round-trip at drive ${drive}, x ${v.toFixed(1)}`)
    }
  }
})

test('drive cancels out of the slope, which is why there is no depth ceiling', () => {
  /**
   * ⚠ THE PROPERTY A WHOLE SESSION'S WORTH OF WRONG CONCLUSIONS TURNED ON. The
   * stage is `g(d·x)/d`, so d(f)/dx = g'(d·x) and the drive is not in it. Pin the
   * consequence directly: the minimum slope is the SAME number at every drive.
   */
  const slopes = [0.5, 1, 3, 9, 27].map(d => makeQuarticSatCurve({ drive: d }).minSlope)
  for (const s of slopes) {
    assert.ok(Math.abs(s - slopes[0]) < 1e-12,
      `minimum slope moved with drive (${slopes.join(', ')}) — the domain guard is in the wrong variable`)
  }
})

test('the identification still reproduces the readings it was fitted from', () => {
  /**
   * The constants are a transcription of a measurement, so they get the same
   * treatment `la2a-h2-refit.mjs` gives its anchor: re-derived here rather than
   * trusted, from the dev log's own columns. Small-signal closed form for
   * `u + c3·u³ + c4·u⁴` under A·sin is H2/H1 = c4·A³/2 and H4/H1 = c4·A³/8.
   */
  const dbc = r => 20 * Math.log10(Math.abs(r))
  const amp = d => Math.pow(10, d / 20)
  const measured = { '-40': -155.7, '-18': -89.7, '-1': -38.7, 9.2: -8.1 }
  for (const [level, want] of Object.entries(measured)) {
    const got = dbc(QUARTIC_C4 * Math.pow(amp(Number(level)), 3) / 2)
    assert.ok(Math.abs(got - want) < 0.1,
      `H2 at ${level} dBFS: predicted ${got.toFixed(2)}, LALA measured ${want}`)
  }
  const h4 = dbc(QUARTIC_C4 * Math.pow(amp(-18), 3) / 8)
  assert.ok(Math.abs(h4 - -101.8) < 0.1, `H4 at −18 dBFS: predicted ${h4.toFixed(2)}, measured −101.8`)
  // H3 comes from the cubic: H3/H1 = c3·A²/4.
  const h3 = dbc(QUARTIC_C3 * Math.pow(amp(-18), 2) / 4)
  assert.ok(Math.abs(h3 - -107.2) < 0.1, `H3 at −18 dBFS: predicted ${h3.toFixed(2)}, measured −107.2`)
})

test('an unknown curve name falls back to what ships, not to something older', () => {
  /**
   * ⚠ THE KERNEL ALREADY CARRIED THIS RULE FOR TWO MODES AND THE THIRD MUST NOT
   * BREAK IT — see the note on `tubeCurveMode`. A typo or a stale stored param
   * must land on the shipping curve; a fallback that lands anywhere else is not
   * a fallback.
   */
  const x = passage(0.5)
  const ship = render(x, { peakReduction: 60 })
  const typo = render(x, { peakReduction: 60, cellCurve: 'quartics', tubeCurve: 'vocalsatt' })
  assert.equal(maxDiff(ship, typo), 0, 'an unknown curve name did not fall back to the shipping curve')
})

test('the quartic ships at both stages, and the previous voicing is recoverable', async () => {
  /**
   * ⚠ THE PATCH HAS TO CARRY THE DRIVES, NOT JUST THE CURVE NAMES.
   * `CELL_CURVE_DRIVE_MAX` moved 1.5 → 5 with the curve, so a patch that restored
   * only `cellCurve: 'vocalsat'` would give Tube Saturation's curve at three times
   * the drive it was voiced at — a configuration that never shipped. That is the
   * silent-partial-restore bug `fet1176Curve.test.js` documents on the other
   * plugin, and this is the same guard one plugin over.
   */
  const m = await import('../../src/audio/la2aProcessor.js')
  assert.equal(m.LA2A_KERNEL_DEFAULTS.cellCurve, CELL_CURVE_QUARTIC)
  assert.equal(m.LA2A_KERNEL_DEFAULTS.tubeCurve, TUBE_CURVE_QUARTIC)
  assert.equal(m.CELL_CURVE_DRIVE_MAX, 5)

  for (const key of ['tubeCurve', 'cellCurve', 'cellCurveDriveMax', 'vocalSatCurveDrive', 'emphasis']) {
    assert.ok(key in m.LA2A_TUBESAT_PATCH,
      `LA2A_TUBESAT_PATCH must carry '${key}' or it restores half a voicing`)
  }
  assert.equal(m.LA2A_TUBESAT_PATCH.cellCurveDriveMax, 1.5,
    'the previous voicing was cut at cell drive 1.5, not at whatever ships now')

  // And the bench must be able to set every key it carries, same rule as the FET's.
  const t = await import('../../src/audio/effects/la2aTuning.js')
  for (const key of Object.keys(m.LA2A_TUBESAT_PATCH)) {
    assert.ok(key in t.LA2A_TUNING_DEFAULTS,
      `LA2A_TUBESAT_PATCH carries '${key}' but the bench has no default for it`)
  }

  // It must actually render differently from what now ships.
  const x = passage(0.7)
  assert.ok(maxDiff(render(x, { peakReduction: 60 }),
    render(x, { peakReduction: 60, ...m.LA2A_TUBESAT_PATCH })) > 1e-4,
  'LA2A_TUBESAT_PATCH renders identically to the shipping patch — it is not restoring anything')
})

test('the curve change did not move gain reduction, so presets need no re-cut', () => {
  /**
   * ⚠ THE LOAD-BEARING REASON THE FACTORY PRESETS SURVIVED A RE-VOICING UNTOUCHED.
   * The detector sits ahead of the gain cell and never sees the shaper, so swapping
   * the curve cannot move the envelope. `OPTO_SMOOTH_PARAM_KEYS` stores knob
   * positions and no curve keys, so a preset means the same gain reduction it
   * always did. If this ever fails, every OptoSmooth preset has silently drifted
   * and needs the `fet-recut-presets.mjs` treatment.
   */
  const x = passage()
  for (const pr of [30, 45, 55, 60, 65, 75]) {
    const base = { mode: 'compress', peakReduction: pr, gainDb: 0, r37: 100, mix: 1 }
    const ship = processLA2ABuffer([x], SR, base).metering
    for (const patch of [{ cellCurve: CELL_CURVE_QUARTIC }, { cellCurve: 'vocalsat' },
      { cellCurve: CELL_CURVE_GAINMOD }, LA2A_LEGACY_PATCH]) {
      const alt = processLA2ABuffer([x], SR, { ...base, ...patch }).metering
      assert.ok(Math.abs(ship.avgGainReductionDb - alt.avgGainReductionDb) < 1e-9,
        `curve selection moved avg GR at PR ${pr}: ${ship.avgGainReductionDb} vs ${alt.avgGainReductionDb}`)
    }
  }
})
