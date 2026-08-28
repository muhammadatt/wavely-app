import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive } from 'vue'
import {
  DEFAULT_RESONANCE_FOCUS,
  FOCUS_FWHM_TO_SIGMA,
  RESONANCE_FOCUS_GLOBAL,
  RESONANCE_FOCUS_MAX_NODES,
  RESONANCE_FOCUS_RANGES,
  buildResonanceFocusCurves,
  copyFocus,
  focusBiasAt,
  focusNode,
  focusProtectAt,
  focusGlobal,
  focusSelectivityAt,
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
test('one node at full travel reaches both ends of the sensitivity range', () => {
  const R = RESONANCE_FOCUS_RANGES
  const up = focusSelectivityAt({ global: { ...RESONANCE_FOCUS_GLOBAL },
    nodes: [node({ biasDb: R.biasDb.max })] }, 1000)
  const down = focusSelectivityAt({ global: { ...RESONANCE_FOCUS_GLOBAL },
    nodes: [node({ biasDb: R.biasDb.min })] }, 1000)
  assert.equal(up.effective, R.selectivity.min)
  assert.equal(down.effective, R.selectivity.max)
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

test('the flag defaults to zones and rejects a typo rather than inventing a third model', () => {
  assert.equal(DEFAULT_TARGETING, 'zones')
  assert.equal(resolveTargeting(), 'zones')
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
