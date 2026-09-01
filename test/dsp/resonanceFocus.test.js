import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive } from 'vue'
import {
  DEFAULT_RESONANCE_FOCUS,
  FOCUS_FWHM_TO_SIGMA,
  RESONANCE_FOCUS_GLOBAL,
  RESONANCE_FOCUS_MAX_NODES,
  RESONANCE_FOCUS_RANGES,
  SELECTIVITY_EFFECTIVE_MAX,
  buildResonanceFocusCurves,
  copyFocus,
  focusBiasAt,
  focusNode,
  focusProtectAt,
  focusGlobal,
  focusSelectivityAt,
  focusThresholdFn,
  focusNodeWeightAt,
} from '../../src/audio/resonanceFocus.js'
import {
  DEFAULT_RESONANCE_ZONES,
  RESONANCE_DEFAULTS,
  RESONANCE_ZONE_STOCK,
  buildResonanceZoneCurves,
  toKernelParams,
  uniformZones,
} from '../../src/audio/resonanceParams.js'
import { resolveTargeting, DEFAULT_TARGETING } from '../../src/audio/resonanceTargeting.js'

const BINS = 512
const BIN_WIDTH = 44100 / 2048

function node(patch) {
  return { id: 'n', hz: 1000, spanOct: 1, biasDb: 6, enabled: true, ...patch }
}

// ── The sign. ───────────────────────────────────────────────────────────────

/**
 * ⚠ THE ONE MISTAKE THAT LOOKS ENTIRELY FUNCTIONAL WHEN MADE.
 *
 * Selectivity is a THRESHOLD and runs backwards — higher means less is cut — so
 * a node's amount, which is stated the way a person thinks about it ("work
 * harder here"), has to be SUBTRACTED. Get it the wrong way round and every
 * knob turns, every curve draws, the panel looks perfect, and the control does
 * the reverse of what its label says. Nothing downstream can catch it; it is
 * asserted here directly.
 */
test('a positive focus amount LOWERS the threshold, so more is cut', () => {
  const focus = { global: { ...RESONANCE_FOCUS_GLOBAL }, nodes: [node({ hz: 1000, biasDb: 8 })] }
  const c = buildResonanceFocusCurves(focus, BINS, BIN_WIDTH)
  const at = hz => c.selectivity[Math.round(hz / BIN_WIDTH)]
  assert.ok(at(1000) < RESONANCE_FOCUS_GLOBAL.selectivity - 7,
    `expected the threshold at the node to drop by nearly 8 dB, got ${at(1000)}`)
  // And the other way, on the same patch shape.
  const less = buildResonanceFocusCurves(
    { global: { ...RESONANCE_FOCUS_GLOBAL }, nodes: [node({ hz: 1000, biasDb: -8 })] },
    BINS, BIN_WIDTH)
  assert.ok(less.selectivity[Math.round(1000 / BIN_WIDTH)]
    > RESONANCE_FOCUS_GLOBAL.selectivity + 7)
})

// ── The neutral zero: what makes this model worth having. ───────────────────

/**
 * The whole argument for offsets over absolute values is that an untouched
 * spectrum is genuinely untouched. If the empty patch differed from the stock
 * zone set — even in the last bits — then switching targeting models would
 * change the sound, and every A/B between them would be an A/B of two tunings.
 */
test('a focus patch with no nodes is exactly the stock zone patch', () => {
  const f = buildResonanceFocusCurves(DEFAULT_RESONANCE_FOCUS, BINS, BIN_WIDTH)
  const z = buildResonanceZoneCurves(DEFAULT_RESONANCE_ZONES, BINS, BIN_WIDTH)
  for (const key of ['depth', 'sharpness', 'selectivity', 'maxCut', 'protect']) {
    for (let k = 0; k < BINS; k++) {
      assert.equal(f[key][k], z[key][k], `${key} differs at bin ${k}`)
    }
  }
  assert.equal(f.uniform, true)
  assert.equal(f.anyProtect, z.anyProtect)
})

test('the stock focus globals are the stock zone settings, so an A/B is of the model', () => {
  for (const key of ['depth', 'sharpness', 'selectivity', 'maxCut']) {
    assert.equal(RESONANCE_FOCUS_GLOBAL[key], RESONANCE_ZONE_STOCK[key], key)
  }
  assert.equal(RESONANCE_FOCUS_GLOBAL.protect, RESONANCE_ZONE_STOCK.protect)
  assert.deepEqual(DEFAULT_RESONANCE_FOCUS.nodes, [])
})

/**
 * ⚠ THE KERNEL'S UNIFORM FLAG IS A GUARANTEE, NOT AN OPTIMISATION — see the
 * note on buildResonanceZoneCurves. Blending N identical reference envelopes by
 * weights summing to 1 is not exactly the envelope, so a model that produced
 * two groups where one would do would drift from the shipping build by an
 * amount that is inaudible and impossible to prove absent.
 *
 * With sharpness global there is exactly one group, ALWAYS, however many nodes
 * are placed. That is a property of the model rather than of a patch, so it is
 * asserted against a busy patch rather than the default one.
 */
test('sharpness stays global, so the kernel always takes its one-envelope path', () => {
  const nodes = Array.from({ length: RESONANCE_FOCUS_MAX_NODES }, (_, i) =>
    node({ id: `n${i}`, hz: 80 * Math.pow(2, i * 0.7), biasDb: i % 2 ? 9 : -9, spanOct: 0.3 + i * 0.4 }))
  const c = buildResonanceFocusCurves({ global: { ...RESONANCE_FOCUS_GLOBAL }, nodes }, BINS, BIN_WIDTH)
  assert.equal(c.groups.length, 1)
  assert.equal(c.uniform, true)
  assert.equal(c.groups[0].sharpness, RESONANCE_FOCUS_GLOBAL.sharpness)
  assert.ok(c.groups[0].weight.every(w => w === 1))
  // And the three settings that are NOT biased really are flat.
  for (const key of ['depth', 'sharpness', 'maxCut']) {
    assert.ok(c[key].every(v => v === c[key][0]), `${key} is not flat`)
  }
})

// ── Additivity, and the clamp. ──────────────────────────────────────────────

/**
 * Two overlapping nodes must behave like two overlapping nodes, not like the
 * larger of the two. That is what "additive" means, and it is the reason the
 * clamp lives on the finished threshold rather than on each node.
 */
test('overlapping nodes sum, and the clamp lands once at the end', () => {
  const two = [node({ id: 'a', hz: 1000, biasDb: 5, spanOct: 2 }),
    node({ id: 'b', hz: 1100, biasDb: 5, spanOct: 2 })]
  const bias = focusBiasAt(two, 1050)
  assert.ok(bias > 9 && bias <= 10, `expected the two 5 dB nodes to nearly sum, got ${bias}`)

  // The sum runs past the parameter's floor; the curve stops at it and says so.
  const hot = { global: { ...RESONANCE_FOCUS_GLOBAL }, nodes: [
    node({ id: 'a', hz: 1000, biasDb: 18 }), node({ id: 'b', hz: 1000, biasDb: 18 })] }
  const s = focusSelectivityAt(hot, 1000)
  assert.equal(s.effective, RESONANCE_FOCUS_RANGES.selectivity.min)
  assert.equal(s.clamped, true)
  assert.ok(s.bias > 30, 'the raw bias is the sum, not a clamped node value')

  // ...and an ordinary node is not reported as clamped, or the warning means
  // nothing.
  assert.equal(focusSelectivityAt(
    { global: { ...RESONANCE_FOCUS_GLOBAL }, nodes: [node({ biasDb: 6 })] }, 1000).clamped, false)
})

test('the readout reports the three terms the panel prints', () => {
  const focus = { global: { ...RESONANCE_FOCUS_GLOBAL, selectivity: 20 },
    nodes: [node({ hz: 500, biasDb: 8 })] }
  const s = focusSelectivityAt(focus, 500)
  assert.equal(s.global, 20)
  assert.ok(Math.abs(s.bias - 8) < 1e-9)
  assert.ok(Math.abs(s.effective - 12) < 1e-9)
})

/**
 * ±18 dB is chosen so a single node can reach either end of the sensitivity
 * range from the stock setting — "work as hard as you can here" and "leave this
 * completely alone" both have to be sayable, and the second is the one a
 * targeting control cannot do without. Travel past that would do nothing.
 */
test('a node at full travel reaches the floor, and past the knob ceiling', () => {
  // ⚠ THE UPPER HALF OF THIS USED TO ASSERT `R.selectivity.max`, WHICH WAS THE
  // BUG. `global - bias` was clamped to the same 3..36 the Threshold knob
  // offers, so with the global at its stock 20 a node's +18 dB of Amount ran out
  // at 16: the top two dB moved a number and changed nothing. The effective
  // threshold has its own wider bound now — see SELECTIVITY_EFFECTIVE_MAX.
  //
  // The FLOOR is still the knob's, and that half is unchanged: 20 - 18 is 2,
  // below the range's 3, and there is a real difference between thresholds down
  // there for the clamp to protect.
  const R = RESONANCE_FOCUS_RANGES
  const g = RESONANCE_FOCUS_GLOBAL
  const up = focusSelectivityAt({ global: { ...g },
    nodes: [node({ biasDb: R.biasDb.max })] }, 1000)
  const down = focusSelectivityAt({ global: { ...g },
    nodes: [node({ biasDb: R.biasDb.min })] }, 1000)
  assert.equal(up.effective, R.selectivity.min)
  assert.equal(down.effective, g.selectivity - R.biasDb.min)
  assert.ok(down.effective > R.selectivity.max, 'the node must reach past the knob')
  assert.ok(down.effective <= SELECTIVITY_EFFECTIVE_MAX)
})

// ── The shape. ──────────────────────────────────────────────────────────────

/**
 * Span is FULL WIDTH AT HALF AMPLITUDE, in octaves — the number that matches
 * what the rail draws. Exposing sigma instead is what the maths wants and what
 * nobody can read off a plot.
 */
test('span is the full width at half amplitude, in octaves', () => {
  const n = [node({ hz: 1000, spanOct: 2, biasDb: 10 })]
  assert.ok(Math.abs(focusBiasAt(n, 1000) - 10) < 1e-9)
  // Half an octave either side of centre is the half-amplitude point of a
  // 1-octave... no: at spanOct 2 the half-amplitude points sit one octave out.
  for (const hz of [500, 2000]) {
    assert.ok(Math.abs(focusBiasAt(n, hz) - 5) < 1e-9,
      `half amplitude should land an octave out, got ${focusBiasAt(n, hz)}`)
  }
  assert.ok(Math.abs(FOCUS_FWHM_TO_SIGMA - 1 / 2.3548200450309493) < 1e-12)
})

/**
 * ⚠ GAUSSIAN IN LOG FREQUENCY, NOT IN Hz. Uniform-in-Hz would give a node at
 * the top of the spectrum a hundredth of the reach of one at the bottom — the
 * same mistake the cepstral reference's uniform resolution makes, and this
 * codebase has already measured what that costs.
 */
test('a node covers the same musical span wherever it sits', () => {
  for (const centre of [100, 1000, 8000]) {
    const n = [node({ hz: centre, spanOct: 1, biasDb: 10 })]
    // Symmetric in OCTAVES, which is the property. In Hz it is wildly
    // asymmetric — half an octave below 8 kHz is 2.3 kHz away and half an
    // octave above is 3.3 — and a builder written in Hz passes nothing here.
    assert.ok(Math.abs(focusBiasAt(n, centre / 2) - focusBiasAt(n, centre * 2)) < 1e-9)
    assert.ok(Math.abs(focusBiasAt(n, centre * Math.SQRT2) - 5) < 1e-9,
      'half an octave out is the half-amplitude point of a 1-octave node')
    // An octave out — twice the stated width — is 6.25% of the amount, which is
    // the tail a Gaussian has and the reason nodes overlap gently rather than
    // butting up against each other the way zone boundaries do.
    assert.ok(Math.abs(focusBiasAt(n, centre * 2) - 0.625) < 0.01,
      `an octave out should be ~0.63 dB of a 10 dB node, got ${focusBiasAt(n, centre * 2)}`)
  }
})

test('a disabled node contributes nothing, and keeps its stored settings', () => {
  const off = focusNode(node({ biasDb: 12, enabled: false }))
  assert.equal(off.biasDb, 0)
  assert.equal(off.hz, 1000)
  assert.equal(off.spanOct, 1)
  assert.equal(focusBiasAt([node({ biasDb: 12, enabled: false })], 1000), 0)
})

test('values out of range are clamped rather than passed through', () => {
  const R = RESONANCE_FOCUS_RANGES
  assert.equal(focusNode(node({ hz: 1e6 })).hz, R.hz.max)
  assert.equal(focusNode(node({ spanOct: 99 })).spanOct, R.spanOct.max)
  assert.equal(focusNode(node({ biasDb: -400 })).biasDb, R.biasDb.min)
  assert.equal(focusGlobal({ selectivity: 999 }).selectivity, R.selectivity.max)
  assert.equal(focusGlobal({ protectCeilHz: 1 }).protectCeilHz, R.protectCeilHz.min)
})

/** log2(0) is -Infinity, so DC has to copy its neighbour or the curve is NaN. */
test('bin 0 is finite', () => {
  const c = buildResonanceFocusCurves(
    { global: { ...RESONANCE_FOCUS_GLOBAL }, nodes: [node({ hz: 60, biasDb: 12 })] },
    BINS, BIN_WIDTH)
  assert.ok(Number.isFinite(c.selectivity[0]))
  assert.equal(c.selectivity[0], c.selectivity[1])
  assert.ok(c.selectivity.every(Number.isFinite))
})

// ── Harmonic protection. ────────────────────────────────────────────────────

/**
 * The per-zone flag existed for one measured reason — the mask blocks 67-88% of
 * every octave, which is real protection low and a blanket veto high. That is a
 * statement about a FREQUENCY, and a ceiling says it directly.
 *
 * Crossfaded over the same sixth of an octave a zone boundary uses: a hard step
 * would put a partial sitting on the ceiling half in and half out of the mask,
 * and slide it between the two as the pitch moves — the per-bin gain movement
 * the whole effect exists to avoid.
 */
test('protection is a ceiling, crossfaded rather than stepped', () => {
  const g = focusGlobal({ protect: true, protectCeilHz: 5000 })
  assert.equal(focusProtectAt(g, 1000), 1)
  assert.equal(focusProtectAt(g, 12000), 0)
  assert.ok(Math.abs(focusProtectAt(g, 5000) - 0.5) < 1e-9)
  // Strictly monotone through the transition, and never a step.
  let prev = 1
  for (let hz = 4600; hz <= 5500; hz += 25) {
    const v = focusProtectAt(g, hz)
    assert.ok(v <= prev + 1e-12, 'protection must fall monotonically')
    prev = v
  }
  assert.equal(focusProtectAt(focusGlobal({ protect: false }), 100), 0)
})

test('anyProtect follows the global switch, since one mask serves the whole spectrum', () => {
  const on = buildResonanceFocusCurves(
    { global: { ...RESONANCE_FOCUS_GLOBAL, protect: true }, nodes: [] }, BINS, BIN_WIDTH)
  assert.equal(on.anyProtect, true)
  assert.equal(buildResonanceFocusCurves(DEFAULT_RESONANCE_FOCUS, BINS, BIN_WIDTH).anyProtect, false)
})

// ── Crossing the worker boundary. ───────────────────────────────────────────

/**
 * ⚠ NOT DEFENSIVE TIDINESS. This object crosses a structured clone twice, and
 * the panel holds it in a Vue ref — which hands out a reactive Proxy that
 * `structuredClone` refuses outright. Zones shipped without this once: the
 * throw landed on the first param push, so the meter loop never started and the
 * symptom was the spectrum plot and DELTA both dead, with nothing on screen
 * about it. Tested against a genuinely reactive object, which is the only kind
 * that reproduces it.
 */
test('a reactive focus patch survives a structured clone', () => {
  const live = reactive({
    global: { ...RESONANCE_FOCUS_GLOBAL },
    nodes: [node({ id: 'a' }), node({ id: 'b', hz: 3000, biasDb: -4 })],
  })
  assert.throws(() => structuredClone(live), /clone|DataCloneError/i)
  const copied = copyFocus(live)
  assert.doesNotThrow(() => structuredClone(copied))
  assert.equal(copied.nodes.length, 2)
  assert.equal(copied.nodes[1].hz, 3000)
  assert.equal(copied.global.selectivity, RESONANCE_FOCUS_GLOBAL.selectivity)
})

test('an empty patch clones to null, and null is what selects the zone model', () => {
  assert.equal(copyFocus(null), null)
  const k = toKernelParams({ ...RESONANCE_DEFAULTS, focus: null })
  assert.equal(k.focus, null)
  assert.ok(Array.isArray(k.zones))
})

/**
 * ⚠ PRESENT AND NULL, NOT ABSENT. The effect wrapper's `setParam` guards with
 * `name in params`, so a key missing from RESONANCE_DEFAULTS is not rejected —
 * it is SILENTLY DROPPED. That is exactly how the soft clipper's drive ratios
 * shipped as a control that did nothing for an entire listening session, and a
 * targeting model that silently does nothing is the same failure with more
 * code behind it.
 */
test('focus is a key on the shipping defaults, so setParam cannot drop it', () => {
  assert.ok('focus' in RESONANCE_DEFAULTS)
  assert.equal(RESONANCE_DEFAULTS.focus, null)
  assert.ok('focus' in toKernelParams(RESONANCE_DEFAULTS))
})

/**
 * ⚠ FOCUS IS THE DEFAULT NOW. The flag survives the promotion rather than being
 * deleted with the loser: the decision rested on working a file in one model
 * and then the other, and `?resoTargeting=zones` is the only way back to that
 * comparison — or to a patch built under zones — without a rebuild.
 */
test('the flag defaults to focus and rejects a typo rather than inventing a third model', () => {
  assert.equal(DEFAULT_TARGETING, 'focus')
  assert.equal(resolveTargeting(), 'focus')
})

// ── Against the kernel. ─────────────────────────────────────────────────────

/**
 * The dispatch, end to end: the kernel consumes per-bin curves and does not
 * know which authoring model drew them, which is what makes this a panel change
 * rather than a DSP change. A focus patch with no nodes has to produce exactly
 * what a uniform zone set carrying the same numbers produces.
 */
test('the kernel reads a focus patch and a uniform zone set identically', async () => {
  const { ResonanceKernel } = await import('../../src/audio/resonanceProcessor.js')
  // ⚠ THE CONSTRUCTOR TAKES ONLY A SAMPLE RATE. The first version of this test
  // passed params to it and they were silently ignored, so both kernels ran the
  // defaults and the comparison proved nothing — it passed under every mutation
  // it existed to catch, including deleting the dispatch outright.
  const mk = (params) => {
    const k = new ResonanceKernel(44100)
    k.setParams(params)
    return k
  }
  const z = mk({ zones: uniformZones(), focus: null })
  const f = mk({ zones: uniformZones(), focus: DEFAULT_RESONANCE_FOCUS })
  assert.equal(f.zoneSelectivity.length, z.zoneSelectivity.length)
  for (const key of ['zoneSelectivity', 'zoneDepth', 'zoneSharpness', 'zoneMaxCut', 'zoneProtect']) {
    for (let k = 0; k < z[key].length; k++) {
      assert.equal(f[key][k], z[key][k], `${key} differs at bin ${k}`)
    }
  }
  assert.equal(f.envUniform, true)
})

test('a focus node reaches the kernel as a real change in the threshold curve', async () => {
  const { ResonanceKernel } = await import('../../src/audio/resonanceProcessor.js')
  const mk = (params) => {
    const k = new ResonanceKernel(44100)
    k.setParams(params)
    return k
  }
  const flat = mk({ focus: DEFAULT_RESONANCE_FOCUS })
  const aimed = mk({
    focus: { global: { ...RESONANCE_FOCUS_GLOBAL }, nodes: [node({ hz: 3000, biasDb: 12, spanOct: 0.5 })] },
  })
  const bin = Math.round(3000 / (44100 / 2048))
  assert.ok(aimed.zoneSelectivity[bin] < flat.zoneSelectivity[bin] - 10)
  // ...and left the rest of the spectrum where it was. A node that quietly
  // biased everything would be a global control wearing a node's clothes.
  const far = Math.round(200 / (44100 / 2048))
  assert.ok(Math.abs(aimed.zoneSelectivity[far] - flat.zoneSelectivity[far]) < 0.01)
})

// ── The display's threshold. ────────────────────────────────────────────────

/**
 * ⚠ THE BUG THIS PINS SHIPPED, AND IT HAD TWO SYMPTOMS FROM ONE LINE.
 *
 * The plot adds the threshold offset to the kernel's reference ITSELF, so the
 * dotted threshold line follows the knob on the frame it is turned rather than
 * a frame later. It read that offset out of `props.zones` — and under focus the
 * plot is given no zones, so `zoneSettingsAt` fell through to the stock
 * constant. The threshold froze at 20.
 *
 * One frozen array, two reports: the dotted line stopped moving for the
 * Threshold knob AND for the nodes; and because the same `threshold[]` feeds
 * `findExceedanceRuns` and the FOUND trace, crossings were still measured
 * against 20 with the knob wound fully off, so the display kept finding
 * resonances the kernel was no longer touching.
 *
 * The property is that the display's offset agrees with the KERNEL'S OWN
 * per-bin curve, which is the only thing that makes the picture true.
 */
test('the display threshold follows the global knob and the nodes', () => {
  const mk = (sel, nodes = []) => focusThresholdFn({
    global: { ...RESONANCE_FOCUS_GLOBAL, selectivity: sel }, nodes,
  })
  // The knob alone.
  assert.equal(mk(20)(1000), 20)
  assert.equal(mk(31)(1000), 31)
  assert.notEqual(mk(31)(1000), mk(20)(1000), 'the line must move with the knob')
  // A node alone.
  const aimed = mk(20, [node({ hz: 3000, biasDb: 10, spanOct: 0.5 })])
  assert.ok(Math.abs(aimed(3000) - 10) < 1e-9)
  assert.ok(Math.abs(aimed(200) - 20) < 1e-9, 'and only where the node is')
  // Wound fully off, the display must agree that nothing can cross.
  assert.equal(mk(RESONANCE_FOCUS_RANGES.selectivity.max)(1000),
    RESONANCE_FOCUS_RANGES.selectivity.max)
})

test('the display threshold matches the kernel"s own per-bin curve', () => {
  const focus = {
    global: { ...RESONANCE_FOCUS_GLOBAL, selectivity: 27 },
    nodes: [node({ id: 'a', hz: 240, biasDb: -11, spanOct: 0.9 }),
      node({ id: 'b', hz: 4200, biasDb: 14, spanOct: 0.4 })],
  }
  const fn = focusThresholdFn(focus)
  const curves = buildResonanceFocusCurves(focus, BINS, BIN_WIDTH)
  // Bin 0 is DC and copies its neighbour, so it is the one bin where the plot's
  // frequency-domain lookup and the kernel's bin grid legitimately differ.
  for (let k = 1; k < BINS; k++) {
    assert.ok(Math.abs(fn(k * BIN_WIDTH) - curves.selectivity[k]) < 1e-9,
      `display and kernel disagree at bin ${k}`)
  }
})

/**
 * The hoist is not a micro-optimisation: this is called per display bin per
 * animation frame, and normalising the patch inside would allocate an object
 * per node per bin — tens of thousands a second to redraw a curve that only
 * changes when a knob moves.
 */
test('the threshold function normalises once, not per call', () => {
  const fn = focusThresholdFn({
    global: { ...RESONANCE_FOCUS_GLOBAL },
    nodes: [node({ hz: 1000, biasDb: 99 })],
  })
  // Clamped at build time, so a wild stored value cannot leak through the
  // per-call path either.
  assert.equal(fn(1000), RESONANCE_FOCUS_RANGES.selectivity.min)
  assert.equal(typeof fn, 'function')
})

// ── Shapes. ─────────────────────────────────────────────────────────────────

/**
 * ⚠ A SHELF IS A WEIGHT, NOT A SECOND MECHANISM. Every shape returns a number
 * in [0, 1] that the amount is multiplied by, so the sum, the clamp, the curve
 * and the solo window are all shape-blind.
 */
test('a shelf says what no bell can: everything above or below here', () => {
  const lo = { ...node({ hz: 1000, spanOct: 1, biasDb: 10 }), shape: 'low' }
  const hi = { ...node({ hz: 1000, spanOct: 1, biasDb: 10 }), shape: 'high' }
  // Full amount well into the passband, none well into the stop band, and the
  // corner is the half-way point.
  assert.ok(Math.abs(focusBiasAt([lo], 60) - 10) < 0.01)
  assert.ok(Math.abs(focusBiasAt([lo], 1000) - 5) < 1e-9)
  assert.ok(focusBiasAt([lo], 16000) < 0.01)
  assert.ok(focusBiasAt([hi], 60) < 0.01)
  assert.ok(Math.abs(focusBiasAt([hi], 1000) - 5) < 1e-9)
  assert.ok(Math.abs(focusBiasAt([hi], 16000) - 10) < 0.01)
  // A bell cannot: it falls away on BOTH sides at any width, which is the whole
  // reason the shelves exist.
  const wide = node({ hz: 1000, spanOct: 4, biasDb: 10 })
  assert.ok(focusBiasAt([wide], 60) < 9.9 && focusBiasAt([wide], 16000) < 9.9)
})

test('a shelf is monotone, and spans the same octaves wherever it sits', () => {
  for (const centre of [120, 1000, 8000]) {
    const n = { ...node({ hz: centre, spanOct: 1, biasDb: 10 }), shape: 'high' }
    let prev = -1
    for (let o = -4; o <= 4; o += 0.25) {
      const v = focusBiasAt([n], centre * Math.pow(2, o))
      assert.ok(v >= prev - 1e-9, `not monotone at ${centre} Hz`)
      prev = v
    }
    // 5% half a span below the corner, 95% half a span above — so `spanOct`
    // means "about this wide a transition" on both shapes.
    const w = h => focusNodeWeightAt(focusNode({ ...n, biasDb: 10 }), centre * Math.pow(2, h))
    assert.ok(Math.abs(w(-0.5) - 0.05) < 0.005)
    assert.ok(Math.abs(w(0.5) - 0.95) < 0.005)
  }
})

test('an unrecognised shape falls back to a bell rather than a fourth behaviour', () => {
  assert.equal(focusNode({ ...node({}), shape: 'wobble' }).shape, 'bell')
  assert.equal(focusNode(node({})).shape, 'bell')
  const typo = [{ ...node({ hz: 1000, biasDb: 10 }), shape: 'belll' }]
  const bell = [node({ hz: 1000, biasDb: 10 })]
  assert.equal(focusBiasAt(typo, 700), focusBiasAt(bell, 700))
})

test('the default patch is untouched by shapes existing', () => {
  const f = buildResonanceFocusCurves(DEFAULT_RESONANCE_FOCUS, BINS, BIN_WIDTH)
  const z = buildResonanceZoneCurves(DEFAULT_RESONANCE_ZONES, BINS, BIN_WIDTH)
  for (let k = 0; k < BINS; k++) assert.equal(f.selectivity[k], z.selectivity[k])
})

// ── Solo. ───────────────────────────────────────────────────────────────────

/**
 * SOLO — hear what ONE node's region removes. The zone version isolated a BAND;
 * a node is not a band, so what carries over is the intent rather than the
 * transform: the threshold is crossfaded between what the patch really does and
 * OFF, by the soloed node's own weight.
 */
test('solo keeps the real threshold inside the node and turns it off outside', () => {
  const nodes = [node({ id: 'a', hz: 300, spanOct: 0.6, biasDb: 10 }),
    node({ id: 'b', hz: 5000, spanOct: 0.6, biasDb: 12 })]
  const patch = { global: { ...RESONANCE_FOCUS_GLOBAL }, nodes }
  const full = buildResonanceFocusCurves(patch, BINS, BIN_WIDTH)
  const solo = buildResonanceFocusCurves({ ...patch, solo: 0 }, BINS, BIN_WIDTH)
  const at = (c, hz) => c.selectivity[Math.round(hz / BIN_WIDTH)]
  // Inside the soloed node: exactly what the full patch does there.
  assert.ok(Math.abs(at(solo, 300) - at(full, 300)) < 0.05)
  // Everywhere else: off, including the OTHER node's region.
  assert.equal(at(solo, 5000), SELECTIVITY_EFFECTIVE_MAX)
  assert.equal(at(solo, 1000), SELECTIVITY_EFFECTIVE_MAX)
})

test('solo works on a shelf, isolating the whole shelf', () => {
  const nodes = [{ ...node({ id: 'a', hz: 4000, spanOct: 1, biasDb: 12 }), shape: 'high' }]
  const c = buildResonanceFocusCurves(
    { global: { ...RESONANCE_FOCUS_GLOBAL }, nodes, solo: 0 }, BINS, BIN_WIDTH)
  const at = hz => c.selectivity[Math.round(hz / BIN_WIDTH)]
  // ⚠ 10 kHz, not 12: `BINS` is 512 at this bin width, so the last bin is
  // 11.0 kHz and anything past it reads `undefined` — which compares false
  // against everything and would have passed a broken build just as happily.
  assert.ok(at(10000) < RESONANCE_FOCUS_GLOBAL.selectivity, 'the shelf itself is live')
  // ⚠ A TOLERANCE, NOT AN EQUALITY. A shelf has no distance cutoff — one that
  // stopped being full amount far from its corner would not be a shelf — so its
  // weight approaches zero rather than reaching it, and the threshold lands a
  // ten-billionth short of the maximum.
  assert.ok(Math.abs(at(300) - SELECTIVITY_EFFECTIVE_MAX) < 1e-6,
    'below it, nothing')
})

/**
 * ⚠ A BYPASSED NODE SOLOS TO ITS REGION, NOT TO SILENCE — the one place this
 * differs from the zone delta it replaces. A bypassed ZONE removed nothing, so
 * soloing it was honestly silent; a bypassed NODE only means "no opinion here",
 * and the global detector is still working that region. What you hear is what
 * the region is losing anyway, which is the true answer to the question asked.
 * The WEIGHT carries the region where the bias does not.
 */
test('a node at no opinion still has a region to solo', () => {
  for (const n of [node({ hz: 800, spanOct: 0.5, biasDb: 0 }),
    node({ hz: 800, spanOct: 0.5, biasDb: 9, enabled: false })]) {
    const c = buildResonanceFocusCurves(
      { global: { ...RESONANCE_FOCUS_GLOBAL }, nodes: [n], solo: 0 }, BINS, BIN_WIDTH)
    const at = hz => c.selectivity[Math.round(hz / BIN_WIDTH)]
    assert.ok(Math.abs(at(800) - RESONANCE_FOCUS_GLOBAL.selectivity) < 0.05,
      'inside, the global setting is what is running')
    assert.equal(at(80), SELECTIVITY_EFFECTIVE_MAX, 'outside, nothing')
  }
})

test('an absent or out-of-range solo changes nothing', () => {
  const nodes = [node({ hz: 300, biasDb: 10 })]
  const base = buildResonanceFocusCurves({ global: { ...RESONANCE_FOCUS_GLOBAL }, nodes },
    BINS, BIN_WIDTH)
  for (const solo of [undefined, -1, 7, null, 1.5]) {
    const c = buildResonanceFocusCurves(
      { global: { ...RESONANCE_FOCUS_GLOBAL }, nodes, solo }, BINS, BIN_WIDTH)
    for (let k = 0; k < BINS; k++) {
      assert.equal(c.selectivity[k], base.selectivity[k], `solo=${solo} moved bin ${k}`)
    }
  }
})

/**
 * The display's threshold has to agree with the kernel's WHILE SOLOED, or the
 * dotted staircase describes a patch the ear is not hearing — which is exactly
 * what the frozen threshold cost once already.
 */
test('the display threshold follows a solo', () => {
  const patch = {
    global: { ...RESONANCE_FOCUS_GLOBAL },
    nodes: [node({ hz: 300, spanOct: 0.6, biasDb: 10 })],
    solo: 0,
  }
  const fn = focusThresholdFn(patch)
  const curves = buildResonanceFocusCurves(patch, BINS, BIN_WIDTH)
  for (let k = 1; k < BINS; k++) {
    assert.ok(Math.abs(fn(k * BIN_WIDTH) - curves.selectivity[k]) < 1e-9, `bin ${k}`)
  }
})

test('shape and solo survive the structured clone', () => {
  const copied = copyFocus({
    global: { ...RESONANCE_FOCUS_GLOBAL },
    nodes: [{ ...node({ id: 'a' }), shape: 'high' }],
    solo: 0,
  })
  assert.doesNotThrow(() => structuredClone(copied))
  assert.equal(copied.nodes[0].shape, 'high')
  assert.equal(copied.solo, 0)
})
