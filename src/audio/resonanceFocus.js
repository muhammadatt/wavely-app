/**
 * FOCUS: the alternative targeting model for the resonance suppressor.
 *
 * PROTOTYPE, BEHIND A FLAG. Zones ship; this is the thing to A/B them against
 * by ear. See resonanceTargeting.js for how to reach it.
 *
 * ── What it is ──────────────────────────────────────────────────────────────
 *
 * One global detector — depth, sharpness, selectivity, max cut, protection —
 * plus a sparse overlay of FOCUS NODES that bias the detection threshold up or
 * down over a span of the spectrum. The bias is a signed offset in dB, flat at
 * zero by default, and the nodes sum.
 *
 *   selectivity[k] = clamp(global.selectivity - bias(f_k))
 *
 * ⚠ THE SIGN IS THE OPPOSITE OF THE ARITHMETIC AND IT IS THE WHOLE CONTROL.
 * Selectivity is a THRESHOLD, so it runs backwards: higher means less gets
 * through and less is cut. A node's amount is stated the way a person thinks
 * about it — positive is "work harder here" — which means SUBTRACTING it from
 * the threshold. Getting this backwards produces a control that looks entirely
 * functional and does the reverse of what its label says, so it is asserted
 * directly in the tests rather than left to a downstream measurement.
 *
 * ── Why an offset rather than a value ───────────────────────────────────────
 *
 * This is the whole reason the model exists, and it answers the question that
 * blocked node-style targeting: do per-node settings OVERRIDE the global ones,
 * or add to them?
 *
 * A zone's settings are ABSOLUTE. That has one consequence that makes zones
 * unwieldy in a way no amount of UI work fixes: there is no "no opinion" value.
 * A zone carrying selectivity 20 is not saying "leave this alone", it is saying
 * "twenty", and it says it whether or not anyone chose it. So the whole
 * spectrum must be partitioned, and every partition must be tuned, before the
 * panel means anything.
 *
 * An offset has a true zero. An untouched spectrum is genuinely untouched, the
 * default panel is just the global knobs, and a file that needs nothing costs
 * no setup at all. And "override or add" stops being a rule to remember,
 * because a node carrying `-8 dB` cannot be read as an override of `20` — it is
 * not the same kind of quantity. The panel prints the arithmetic (`sensitivity
 * 12 = global 20, focus -8`) so the sum is visible rather than trusted.
 *
 * ── Why a node biases ONLY the threshold ────────────────────────────────────
 *
 * Reduction is proportional to excess over threshold, so lowering the threshold
 * in a band does both jobs at once: it catches resonances that were being
 * missed AND deepens the cut on ones already caught. One number per node covers
 * "work harder here" completely, monotonically. A node with five fields is a
 * zone with extra steps.
 *
 * ⚠ WHAT THAT GIVES UP, stated rather than hidden: a per-band CEILING. A bias
 * cannot express "at most 6 dB here" — 12 dB in the low mids is fine and the
 * same 12 dB on sibilance is a lisp. `maxCut` is global in this model. If that
 * turns out to be missed in listening, it is a second optional node field, not
 * a reason to go back to absolute values.
 *
 * ── Why sharpness stays global ──────────────────────────────────────────────
 *
 * Two reasons that happen to agree.
 *
 * CONCEPTUAL: sharpness says WHAT SHAPE COUNTS as a resonance — it sets the
 * scale of the reference envelope, a property of the detector. A node's span
 * says WHERE YOU ARE PAYING ATTENTION — a property of the map. They are on
 * different axes, and the confusion the panel has to avoid ("what is node Q
 * versus sharpness?") only arises if they are the same kind of thing. The test
 * that separates them: sharpness changes what gets found at a fixed frequency;
 * span changes where you look at a fixed sharpness.
 *
 * MECHANICAL: the kernel pays one extra inverse transform per DISTINCT
 * sharpness per frame. With one value there is exactly one envelope group, so
 * the kernel's `uniform` fast path is always taken — it assigns rather than
 * blends, and the bit-identical guarantee that zones only hold on an untouched
 * panel holds here permanently. See buildResonanceZoneCurves' note on why that
 * flag is a guarantee and not an optimisation.
 */

/**
 * Span is stated as FULL WIDTH AT HALF AMPLITUDE, in octaves.
 *
 * The alternative is to expose sigma, which is what the maths wants and what
 * nobody can read off a plot. FWHM is the number that matches what a user sees:
 * a node whose span reads 1.0 covers about an octave of visible shading, and
 * the amount printed on it is what is delivered at its centre.
 *
 * ⚠ It is NOT Q, is not labelled Q, and must not be drawn as a bell with a gain
 * handle over the spectrum. That reading is what makes people expect a notch
 * filter — the failure already on record from the discarded Gaussian nodes, and
 * the reason this curve lives on its own rail rather than over the trace.
 */
export const FOCUS_FWHM_TO_SIGMA = 1 / (2 * Math.sqrt(2 * Math.LN2))

/**
 * Parameter ranges.
 *
 * `biasDb` is +/-18 because that is exactly what it takes to reach either end
 * of the selectivity range from the stock setting of 20 — +18 lands on 2, which
 * clamps to the floor of 3 (working as hard as the detector can), and -18 lands
 * on 38, which clamps to the ceiling of 36 (measured to remove nothing). A
 * wider range would be travel that cannot change the sound; a narrower one
 * would mean a node could not fully exclude a band, and "leave this completely
 * alone" is the one thing a targeting control has to be able to say.
 *
 * `spanOct` floors at a sixth of an octave — the same figure as the zone
 * crossfade, chosen there because no single partial spans it, which is the
 * right floor here for the same reason. It tops out at 4 octaves, which is a
 * broad tilt across most of the voice against a display spanning about ten.
 */
/**
 * A node's SHAPE — how its amount is spread over frequency.
 *
 * `bell` is the original and the default: a Gaussian in log frequency, for
 * "work harder around here". The two shelves say "work harder on everything
 * below/above here", which a bell cannot express at any width — a wide bell
 * still falls away on both sides, so aiming one at "all the air" also lifts the
 * midrange on its way past.
 *
 * ⚠ THE SHELF IS A WEIGHT, NOT A SECOND MECHANISM. Every shape returns a number
 * in [0, 1] that the amount is multiplied by, so everything downstream — the
 * sum, the clamp, the curve, the solo window — is unchanged and shape-blind.
 */
export const FOCUS_SHAPES = ['bell', 'low', 'high']

/**
 * Steepness of a shelf's transition, in the same `spanOct` units the bell uses.
 *
 * Chosen so the shelf reaches 95% of its amount half a span below the corner
 * and 5% half a span above it — so `spanOct` means the same kind of thing on
 * both shapes ("about this wide a transition"), and a shelf at the default
 * 1 octave moves from doing nothing to doing everything across one octave.
 */
const SHELF_K = 2 * Math.log(19)

export const RESONANCE_FOCUS_RANGES = {
  biasDb: { min: -18, max: 18 },
  spanOct: { min: 1 / 6, max: 4 },
  hz: { min: 20, max: 20000 },
  depth: { min: 0, max: 1 },
  sharpness: { min: 0, max: 1 },
  selectivity: { min: 3, max: 36 },
  maxCut: { min: 3, max: 48 },
  protectCeilHz: { min: 200, max: 20000 },
}

/** Bounded so the rail stays legible and the per-bin sum stays cheap. */
export const RESONANCE_FOCUS_MAX_NODES = 8

/**
 * The global detector, carrying the values zones ship with.
 *
 * ⚠ SAME PROVENANCE, SAME CAVEAT. These are ZONE_STOCK — selectivity and depth
 * are the peak reference's previous real-audio calibration, sharpness and
 * maxCut have never been re-derived against the peak envelope at all. They are
 * carried over unchanged so that an A/B against zones is an A/B of the
 * TARGETING MODEL and not of two different tunings.
 */
export const RESONANCE_FOCUS_GLOBAL = {
  depth: 1,
  sharpness: 0.8,
  selectivity: 20,
  maxCut: 36,
  /**
   * Harmonic protection: GLOBAL, with a ceiling, replacing the per-zone flag.
   *
   * The per-zone toggle existed for one measured reason — the mask blocks
   * 67-88% of every octave from 60 Hz to 20 kHz, which is real protection down
   * where the partials are widely spaced and a blanket veto up where sibilance
   * lives, so "protect the fundamental region, work freely above 5 kHz" was the
   * setting the effect most wanted and could not express.
   *
   * That is a statement about a FREQUENCY, not about a partition. One switch
   * and one ceiling say it directly, and say it the same way on every file,
   * where a per-zone flag says it only if the zones happen to be placed
   * somewhere sensible.
   *
   * Off by default, matching zones: under the shipping peak reference the
   * envelope is drawn THROUGH the harmonic peaks, so nothing protrudes at a
   * harmonic and there is nothing for the mask to protect against.
   */
  protect: false,
  protectCeilHz: 5000,
}

/**
 * The shipped starting point: the global detector and NO NODES.
 *
 * The empty array is the design. A flat bias is exactly the stock zone patch —
 * verified in the tests, curve for curve — so switching targeting models on a
 * file nobody has touched changes nothing at all, and the first thing a user
 * sees is a panel with nothing on it demanding to be set up.
 */
export const DEFAULT_RESONANCE_FOCUS = {
  global: { ...RESONANCE_FOCUS_GLOBAL },
  nodes: [],
}

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** One node, normalised and clamped. Absent fields take the stock values. */
export function focusNode(node) {
  const R = RESONANCE_FOCUS_RANGES
  return {
    id: node?.id ?? 'n',
    // An unrecognised shape falls back to the default rather than passing
    // through: a typo must not produce a fourth behaviour, and a node whose
    // shape is `undefined` should draw the same curve it always did.
    shape: FOCUS_SHAPES.includes(node?.shape) ? node.shape : 'bell',
    hz: clampNum(node?.hz ?? 1000, R.hz.min, R.hz.max),
    spanOct: clampNum(node?.spanOct ?? 1, R.spanOct.min, R.spanOct.max),
    // A disabled node is amount zero, not a special case downstream — the same
    // rule zones follow for a disabled zone's depth. It reaches the sum as "no
    // opinion here", which is what bypass means for an offset and needs no
    // second mechanism anywhere.
    biasDb: node?.enabled === false
      ? 0
      : clampNum(node?.biasDb ?? 0, R.biasDb.min, R.biasDb.max),
    enabled: node?.enabled !== false,
  }
}

/** The global settings, normalised and clamped. */
export function focusGlobal(g) {
  const R = RESONANCE_FOCUS_RANGES
  const S = RESONANCE_FOCUS_GLOBAL
  return {
    depth: clampNum(g?.depth ?? S.depth, R.depth.min, R.depth.max),
    sharpness: clampNum(g?.sharpness ?? S.sharpness, R.sharpness.min, R.sharpness.max),
    selectivity: clampNum(g?.selectivity ?? S.selectivity, R.selectivity.min, R.selectivity.max),
    maxCut: clampNum(g?.maxCut ?? S.maxCut, R.maxCut.min, R.maxCut.max),
    protect: (g?.protect ?? S.protect) !== false,
    protectCeilHz: clampNum(
      g?.protectCeilHz ?? S.protectCeilHz, R.protectCeilHz.min, R.protectCeilHz.max),
  }
}

/**
 * A node's own influence at one frequency, in [0, 1], independent of its amount.
 *
 * The shape and nothing else. Two callers need it separately from the bias: the
 * sum below multiplies it by the amount, and the SOLO window uses it to decide
 * where a node's region is — which has to work for a node whose amount is zero,
 * where the bias carries no shape at all.
 *
 * Gaussian in LOG frequency, and the shelves likewise, which is what makes a
 * node's width mean the same thing at 200 Hz and at 8 kHz. Uniform-in-Hz would
 * give a node at the top of the spectrum a hundredth of the reach of one at the
 * bottom — the same mistake the cepstral reference's uniform resolution makes,
 * and this codebase has already measured what that costs.
 */
export function focusNodeWeightAt(node, freqHz) {
  if (!(freqHz > 0) || !(node.hz > 0)) return 0
  const oct = Math.log2(freqHz / node.hz)
  if (node.shape === 'low') return 1 / (1 + Math.exp((SHELF_K * oct) / node.spanOct))
  if (node.shape === 'high') return 1 / (1 + Math.exp((-SHELF_K * oct) / node.spanOct))
  const d = oct / (node.spanOct * FOCUS_FWHM_TO_SIGMA)
  // Beyond about four sigma the term is under 0.03% and cannot move a threshold
  // quantised to a tenth of a dB. Skipped so a narrow bell costs nothing across
  // the rest of the spectrum. ⚠ Shelves have no such cutoff — a shelf that
  // stopped being full amount far from its corner would not be a shelf.
  if (d > 4 || d < -4) return 0
  return Math.exp(-0.5 * d * d)
}

/**
 * Total bias at one frequency, in dB. Positive means "work harder here".
 *
 * A sum of Gaussians in LOG frequency, which is what makes a node's span mean
 * the same thing at 200 Hz and at 8 kHz. Uniform-in-Hz would give a node at the
 * top of the spectrum a hundredth of the reach of one at the bottom, which is
 * the same mistake the cepstral reference's uniform-in-Hz resolution makes and
 * that this codebase has already measured the cost of.
 *
 * NOT clamped here. The clamp belongs on the finished threshold, once, so that
 * two overlapping nodes behave like two overlapping nodes rather than like the
 * larger of the two.
 */
export function focusBiasAt(nodes, freqHz) {
  if (!nodes || nodes.length === 0 || !(freqHz > 0)) return 0
  let sum = 0
  for (const raw of nodes) {
    const n = focusNode(raw)
    if (!n.biasDb) continue
    sum += n.biasDb * focusNodeWeightAt(n, freqHz)
  }
  return sum
}

/**
 * The threshold in force at one frequency, and the arithmetic behind it.
 *
 * Returned as its three parts rather than only the total because the PANEL
 * PRINTS ALL THREE. That is the answer to "do nodes override or add?" — not a
 * rule in a tooltip, but the sum on screen where the question gets asked.
 * `effective` is what the kernel uses; `clamped` says the sum ran past the end
 * of the parameter, which is otherwise invisible and reads as a dead knob.
 */
export function focusSelectivityAt(focus, freqHz) {
  const g = focusGlobal(focus?.global)
  const R = RESONANCE_FOCUS_RANGES.selectivity
  const bias = focusBiasAt(focus?.nodes, freqHz)
  const raw = g.selectivity - bias
  const effective = clampNum(raw, R.min, R.max)
  return { global: g.selectivity, bias, effective, clamped: raw !== effective }
}

/**
 * The effective threshold as a function of frequency, normalised once.
 *
 * ⚠ FOR THE DISPLAY, AND THE "ONCE" IS THE POINT. The plot needs the threshold
 * at every one of its 192 display bins on every animation frame, and
 * `focusSelectivityAt` normalises the globals and every node on each call — at
 * 60 fps with a full rail that is tens of thousands of throwaway objects a
 * second, spent redrawing a curve that only changes when a knob moves. This
 * hoists the normalisation out, so the per-bin call is the Gaussian sum and
 * nothing else. Build it in a `computed` and it is rebuilt per edit rather than
 * per frame.
 *
 * The plot adding the threshold itself — rather than reading one the kernel
 * sends — is what lets the line track the knob on the frame it is turned,
 * instead of on the next frame out of the worklet. Same reason the zone path
 * does its own `zoneSettingsAt` lookup.
 */
export function focusThresholdFn(focus) {
  const g = focusGlobal(focus?.global)
  const all = (focus?.nodes ?? []).map(focusNode)
  const nodes = all.filter(n => n.biasDb !== 0)
  const R = RESONANCE_FOCUS_RANGES.selectivity
  // ⚠ SOLO IS IN HERE TOO, or the dotted threshold on the plot would describe a
  // patch the ear is not hearing — which is the whole failure the frozen
  // threshold already cost once.
  const solo = Number.isInteger(focus?.solo) && all[focus.solo] ? all[focus.solo] : null
  return (hz) => {
    const effective = clampNum(g.selectivity - focusBiasAt(nodes, hz), R.min, R.max)
    if (!solo) return effective
    const w = focusNodeWeightAt(solo, hz)
    return effective * w + R.max * (1 - w)
  }
}

/**
 * Weight of the harmonic mask at one frequency: 1 below the ceiling, 0 above.
 *
 * Crossfaded over the same sixth of an octave a zone boundary uses, for the
 * identical reason: a hard step means the bin just below the ceiling and the
 * bin just above it are judged by different rules, so a partial sitting across
 * the line is half masked and slides between the two regimes as the pitch
 * moves. That per-bin gain movement is what the whole effect exists to avoid.
 */
export const FOCUS_PROTECT_EDGE_OCTAVES = 1 / 6

export function focusProtectAt(g, freqHz) {
  if (!g.protect) return 0
  if (!(freqHz > 0)) return 1
  const half = FOCUS_PROTECT_EDGE_OCTAVES / 2
  const oct = Math.log2(freqHz / g.protectCeilHz)
  if (oct <= -half) return 1
  if (oct >= half) return 0
  return clampNum(0.5 - oct / FOCUS_PROTECT_EDGE_OCTAVES, 0, 1)
}

/**
 * Expand a focus patch onto an FFT bin grid.
 *
 * Returns exactly the shape buildResonanceZoneCurves returns, because the
 * kernel consumes per-bin curves and does not know which authoring model drew
 * them. That is what makes this prototype a panel change rather than a DSP
 * change: one dispatch line in the processor, and everything downstream — the
 * detector loop, the envelope groups, the mask, the ceiling — is untouched.
 *
 * `uniform` is ALWAYS true and `groups` always has one member, because
 * sharpness is global here. See the note at the top of this file: that is the
 * fast path, and on the kernel side it is the difference between assigning the
 * reference envelope and blending it against itself.
 */
export function buildResonanceFocusCurves(focus, binCount, binWidth) {
  const g = focusGlobal(focus?.global)
  const all = (focus?.nodes ?? []).map(focusNode)
  const nodes = all.filter(n => n.biasDb !== 0)
  const R = RESONANCE_FOCUS_RANGES.selectivity

  /**
   * SOLO — hear what ONE node's region is removing, and nothing else.
   *
   * ⚠ MONITORING STATE. It is never in what Apply renders; `useResonance`
   * applies it on the way to the LIVE kernel only, exactly as a zone's delta
   * was applied. See the note there, and test/ui/resonanceFocusSolo.test.js.
   *
   * The zone version isolated a BAND — every other zone switched off — and a
   * node is not a band, so the transform cannot be copied literally. What
   * carries over is the intent: a zone delta answered "what is being taken out
   * HERE", and a node has a "here" of its own, namely its own influence.
   *
   * So the threshold is crossfaded between what the patch really does and OFF,
   * by the soloed node's own weight:
   *
   *     selectivity = effective·w + max·(1 - w)
   *
   * Where the node has full influence you hear exactly what the full patch does
   * there; where it has none, nothing is touched. It needs no special case for
   * shape — a shelf solos its whole shelf, a bell its own bell — and none for a
   * node at amount zero, because the WEIGHT carries the region where the bias
   * would not. That last case is deliberately audible rather than silent: a
   * node set to "no opinion" still sits over a region the global detector is
   * working, and hearing that is the point of asking.
   */
  const solo = Number.isInteger(focus?.solo) && all[focus.solo] ? all[focus.solo] : null

  const depth = new Float64Array(binCount).fill(g.depth)
  const sharpness = new Float64Array(binCount).fill(g.sharpness)
  const maxCut = new Float64Array(binCount).fill(g.maxCut)
  const selectivity = new Float64Array(binCount)
  const protect = new Float64Array(binCount)

  for (let k = 0; k < binCount; k++) {
    const hz = k * binWidth
    const effective = clampNum(g.selectivity - focusBiasAt(nodes, hz), R.min, R.max)
    if (solo) {
      const w = focusNodeWeightAt(solo, hz)
      selectivity[k] = effective * w + R.max * (1 - w)
    } else {
      selectivity[k] = effective
    }
    protect[k] = focusProtectAt(g, hz)
  }
  // Bin 0 is DC; log2(0) is -Infinity, so it copies its neighbour. Same guard
  // the zone builder needs, same reason.
  if (binCount > 1) {
    selectivity[0] = selectivity[1]
    protect[0] = protect[1]
  }

  return {
    depth,
    sharpness,
    selectivity,
    maxCut,
    protect,
    groups: [{ sharpness: g.sharpness, weight: new Float64Array(binCount).fill(1) }],
    uniform: true,
    anyProtect: g.protect,
  }
}

/**
 * Copy a focus patch field by field.
 *
 * ⚠ NOT DEFENSIVE TIDINESS. This object crosses a structured clone twice —
 * `postMessage` on every knob move and `processorOptions` on the offline render
 * — and the panel holds it in a Vue ref, which hands out a reactive Proxy that
 * `structuredClone` refuses outright. Zones shipped without this once: the
 * throw landed on the first param push, so `pushAllParams` never finished, the
 * meter loop never started, and the symptom was the spectrum plot and DELTA
 * both dead with nothing on screen about it.
 */
export function copyFocus(focus) {
  if (!focus) return null
  const g = focus.global ?? {}
  return {
    // ⚠ COPIED, BUT ONLY EVER SET ON THE LIVE PATH. `solo` crosses to the
    // kernel like any other field — it has to, or the monitor could not work —
    // and it is `useResonance` that keeps it out of what Apply renders.
    solo: Number.isInteger(focus.solo) ? focus.solo : undefined,
    global: {
      depth: g.depth,
      sharpness: g.sharpness,
      selectivity: g.selectivity,
      maxCut: g.maxCut,
      protect: g.protect,
      protectCeilHz: g.protectCeilHz,
    },
    nodes: (focus.nodes ?? []).map(n => ({
      id: n.id,
      hz: n.hz,
      spanOct: n.spanOct,
      biasDb: n.biasDb,
      shape: n.shape,
      enabled: n.enabled,
    })),
  }
}
