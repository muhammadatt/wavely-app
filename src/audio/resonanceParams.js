/**
 * Resonance Suppressor parameters shared between the UI and the kernel.
 *
 * Separate from effects/resonance.js because that module imports the worklet
 * loader, whose `?worker&url` specifier only resolves under Vite — so anything
 * it touches is unreachable from `node --test`. The pitch-range clamp mirrored
 * here has to be testable against the kernel's own clamp, which is the whole
 * reason it exists.
 */

import { pitchFloorHz } from './dsp/f0.js'

/**
 * Matches FFT_SIZE in resonanceProcessor.js. Duplicated rather than imported so
 * the app bundle does not pull in the whole kernel — it is loaded as a worklet,
 * not as a module.
 */
export const RESONANCE_FRAME_SIZE = 2048

/**
 * The pitch range the harmonic-protection mask searches for, in Hz.
 *
 * FIXED, AND THE SWITCH THAT USED TO SET IT IS GONE. It offered VOICE
 * (70–400) and WIDE (40–1200) on the argument that nothing else about this
 * effect assumes speech and this should not either. Measured, that was the
 * wrong conclusion from a true premise: the EFFECT is general-purpose, but the
 * MASK is not — it exists to keep a suppressor off the harmonics of a voice,
 * and its whole mechanism is a comb built from one tracked F0.
 *
 * WIDE is measurably harmful on the material this feature is for. On 46 s of
 * real narration the two settings disagree on 18.6% of frames and WIDE's p90
 * lands at 849 Hz against a real median of 191 — a comb at the wrong spacing
 * protects the wrong bins and leaves the actual harmonics exposed. WIDE earns
 * its place only above 400 Hz, where VOICE cannot track at all (500/800/1000 Hz
 * sources read as 250/400/333), and a pitched source up there is not something
 * the harmonic mask was built for.
 *
 * Its advertised 40 Hz floor was fiction besides: nothing below about 70 Hz
 * resolves in a 2048-sample frame, and 45/55/65 Hz sources report no pitch
 * under either setting.
 *
 * So: harmonic protection is a voice feature, switched off per zone when the
 * material is not one. Everything else in the effect stays general-purpose.
 */
export const HARMONIC_PITCH_RANGE = { minHz: 70, maxHz: 400 }

/**
 * The range actually used, after the kernel's clamp.
 *
 * The kernel clamps to what its frame can autocorrelate and records the result
 * on `kernel.pitchRange` — but that lives inside a worklet with no channel back
 * to the panel, so the same arithmetic is repeated here for the caption. At
 * 44.1 kHz the floor is 43 Hz, so the fixed range passes through untouched; it
 * only bites at low sample rates.
 */
export function effectivePitchRange(sampleRate) {
  const floor = pitchFloorHz(sampleRate, RESONANCE_FRAME_SIZE)
  return {
    minHz: Math.max(floor, HARMONIC_PITCH_RANGE.minHz),
    maxHz: HARMONIC_PITCH_RANGE.maxHz,
  }
}

/**
 * Slowest ballistic setting that is indistinguishable from instantaneous.
 *
 * The per-bin attack/release IIR steps once per STFT hop — 11.6 ms at 44.1 kHz,
 * 10.7 at 48. A time constant at or below that leaves a coefficient near zero,
 * so every setting under it produces the same jump-to-target and the bottom of
 * each knob was travel that did nothing. The minima below start where the
 * coefficient becomes something a listener can hear: ~0.3 for attack, ~0.6 for
 * release, which is where the notch takes visibly more than one frame to open
 * or close.
 */
export const RESONANCE_ATTACK_MIN_MS = 12
export const RESONANCE_RELEASE_MIN_MS = 25

/**
 * Geometry of the per-frequency display the panel draws.
 *
 * Lives here rather than in the kernel for the same reason the pitch clamp
 * does: the kernel is loaded as a worklet, and the UI needs these numbers on
 * the main thread to lay out an axis. The kernel imports them from here, so the
 * grid the worklet fills and the axis the panel draws are the same grid.
 *
 * 192 points over 20 Hz–20 kHz is ~0.05 octave each — finer than the ear
 * resolves and finer than the 2048-point FFT can actually distinguish above a
 * few kHz, which is the right way round: the display never has to invent a
 * feature the analysis did not see. Below ~400 Hz the reverse holds and several
 * display points share one FFT bin; the kernel interpolates there rather than
 * drawing a staircase, and the result is smooth but genuinely no more resolved
 * than 21.5 Hz.
 */
export const RESONANCE_DISPLAY_BINS = 192
/**
 * Curves the kernel posts per frame, in order: magnitude, reference, output,
 * reduction, held reduction.
 *
 * The output curve is sent rather than derived on the far side as
 * `magnitude - reduction`. Those two are summarised from different FFT bins —
 * magnitude takes the loudest bin in a display cell, reduction the most
 * suppressed one, and on real speech they are different bins in 65% of the
 * cells that carry any cut. Subtracting one from the other draws a notch up to
 * 2 dB deeper than the one that happened.
 *
 * Reduction is sent twice for a related reason. The live curve is this frame's,
 * so it agrees with the spectrum beside it; the held curve is the maximum since
 * the last read, which is what the peak-hold outline needs and what nothing
 * else should be drawn from.
 */
export const RESONANCE_DISPLAY_CURVES = 5
export const RESONANCE_DISPLAY_MIN_HZ = 20
export const RESONANCE_DISPLAY_MAX_HZ = 20000

/**
 * The span actually displayed at a given sample rate.
 *
 * Clamped to just under Nyquist: the top display point maps to an FFT bin, and
 * asking for one at exactly Nyquist lands on the last bin of the rfft, whose
 * magnitude is real-only and reads low. A hair below keeps the axis honest.
 */
export function resonanceDisplayRange(sampleRate) {
  return {
    minHz: RESONANCE_DISPLAY_MIN_HZ,
    maxHz: Math.min(RESONANCE_DISPLAY_MAX_HZ, sampleRate * 0.5 * 0.98),
  }
}

/**
 * Reference mode override, for hearing the two detectors back to back.
 *
 *   ?resoRef=peak                              one page load
 *   localStorage.setItem('resoRef', 'peak')    until cleared
 *
 * The cepstral reference ships. The peak-envelope one is the alternative — see
 * the note on PEAK_REF_FLOOR_FACTOR in resonanceProcessor.js — and it needs a
 * way to be listened to on real material before anything is decided, because
 * every number behind it so far is synthetic.
 *
 * Read at module load rather than per-analysis, unlike VoiceRx's equivalent:
 * these values seed the panel's knobs, and a knob that silently changes value
 * between two runs of the same session is worse than one that needs a reload.
 *
 * An unrecognised value falls back to the shipping mode rather than passing
 * through, for the reason the VoiceRx override gives: a typo must not quietly
 * run the other detector while the person at the keyboard believes otherwise.
 */
const REF_MODES = new Set(['cepstral', 'peak'])
export const DEFAULT_REF_MODE = 'cepstral'

/**
 * Per-mode calibration.
 *
 * THE KNOBS ARE NOT COMPARABLE BETWEEN THE TWO MODES, and pretending they are
 * would make the comparison meaningless. `selectivity` is a threshold on how
 * far a bin protrudes above the reference, and the two references disagree
 * about that quantity by an order of magnitude — measured on a clean voice with
 * no defect present at all, the cepstral reference reads 21-24 dB of
 * protrusion, because from the inter-harmonic floor the comb itself protrudes;
 * the peak-envelope reference reads 2.5-4.2 dB, which is what "nothing is
 * wrong here" ought to measure. Put a +10 dB broad defect in and the cepstral
 * reading does not move at all (23.40 to 23.40 at 800 Hz) while the peak
 * reading goes 2.48 to 7.40.
 *
 * So the peak reference measures the defect's actual prominence against a near
 * zero floor, and its threshold belongs just above that floor: selectivity 4
 * with depth at unity, since protrusion is now roughly the true size of the
 * thing being removed rather than a number inflated by the comb. Measured at
 * that point it removes 2.2 / 7.2 / 10.5 dB of a +10 dB broad hump at
 * 0.8 / 1.6 / 3.2 kHz, at a third the clean-voice damage of the unmasked
 * cepstral path, with harmonic protection off and pitch transparency intact.
 * Selectivity 3 removes a little more and starts to lose the transparency.
 *
 * This is soothe2's note about its own two algorithms, for the same reason:
 * "choosing the mode changes everything, as all other controls are relative to
 * the mode."
 *
 * CALIBRATED ON SYNTHETIC MATERIAL. That is the one thing this project has
 * learned repeatedly not to trust, so these are a starting point for listening,
 * not a result.
 */
export const RESONANCE_REF_MODE_DEFAULTS = {
  cepstral: {},
  peak: {
    refMode: 'peak',
    // RE-CALIBRATED ON REAL NARRATION. This was 4, from a synthetic clean voice
    // whose protrusion floor measured 2.5-4.2 dB. Real speech measures p75 at
    // 8.9 dB and p90 at 17.2 in the same band, so 4 treated over a quarter of
    // every time-frequency cell and removed 12 dB on average. 20 is where a
    // 46 s narrator clip lands on ~3 dB of mean cut in the fundamental region.
    // Applied to every zone by withRefModeDefaults. Not a zone array here:
    // DEFAULT_RESONANCE_ZONES is declared further down this file, and a
    // reference to it at module-evaluation time is a temporal-dead-zone throw.
    zoneOverrides: { selectivity: 20, depth: 1, protect: false },
    // Slow, because the two mechanisms are complementary and measurably
    // superadditive: the stable envelope removes the frequency-domain source of
    // gain movement and these remove the time-domain residue. Alone they are
    // worth 21% and 11%; together, 62%.
    attack: 100,
    release: 500,
  },
}

export function resolveRefMode() {
  const requested = readOverride('resoRef')
  return REF_MODES.has(requested) ? requested : DEFAULT_REF_MODE
}

/** Shipping defaults, with the selected reference mode's calibration applied. */
export function withRefModeDefaults(defaults) {
  const { zoneOverrides, ...rest } = RESONANCE_REF_MODE_DEFAULTS[resolveRefMode()]
  const merged = { ...defaults, ...rest }
  if (zoneOverrides) {
    merged.zones = (merged.zones ?? []).map(z => ({ ...z, ...zoneOverrides }))
  }
  return merged
}

/** Query string, then stored preference. Null when neither has an opinion. */
function readOverride(key) {
  try {
    return new URLSearchParams(window.location.search).get(key)
      ?? window.localStorage.getItem(key)
  } catch {
    // No window under test, or a browser that throws on localStorage in
    // private mode. Neither is a reason to fail.
    return null
  }
}

/**
 * SENSITIVITY ZONES — contiguous spans of the spectrum, each with its own
 * settings. Not filters, and not bands in the EQ sense.
 *
 * A zone does not boost or cut. It changes how the DETECTOR behaves over a span
 * of the spectrum: `sensitivityDb` offsets `selectivity` — the threshold a bin
 * must protrude above its reference before it counts as a resonance — and
 * `depth` scales how much of that protrusion is removed once it does. Positive
 * sensitivity LOWERS the threshold, so the effect is more willing to act there;
 * `enabled: false` takes the zone out of the effect entirely. Soothe2 describes
 * the same idea as "an inverse EQ": making a band more processed, not louder.
 *
 * WHY A SCALAR SELECTIVITY IS STRUCTURALLY WRONG, measured rather than
 * asserted. The quantity it thresholds does not have a frequency-independent
 * distribution. Mean protrusion on real narration, by band:
 *
 *                60-120   120-180   190-270   300-500   600-1000
 *     cepstral      3.4      12.5      15.3      13.7       13.9
 *     peak         17.1      17.5      18.1      18.6       13.1
 *
 * A 12 dB spread across the low end for the cepstral reference. One number
 * cannot be the right threshold at 100 Hz and at 250 Hz at once, and the
 * consequence is measurable: on a narration clip the suppressor was inert on a
 * word with an audible low-mid honk, and reaching it by lowering selectivity
 * globally took gain jitter from 0.85/1.14 to 1.23/1.58 — worse than a
 * configuration already rejected by ear. The headroom was real and only
 * reachable per-band.
 *
 * ZONES RATHER THAN THE GAUSSIAN NODES THIS REPLACES. The nodes were bumps at a
 * centre frequency with a width in octaves, drawn as a dip in the threshold
 * line. Two things were wrong with that in use. The handle rode the threshold
 * curve, which moves with the audio, so a control the user was trying to aim
 * bounced several times a second. And a Gaussian has no edges, so "which part
 * of the spectrum is this setting for" had no answer you could read off the
 * screen. A zone has a left edge, a right edge, and one value inside it — the
 * boundary is a vertical line that does not move unless it is dragged, and the
 * value is a horizontal segment on a fixed scale.
 *
 * Zones are ORDERED and CONTIGUOUS: `hiHz` is each zone's upper boundary, the
 * next zone starts where this one ends, and the last zone's `hiHz` is ignored
 * because it runs to the top of the processed band. There are therefore no gaps
 * and no overlaps to reason about, which is the other half of what the nodes
 * made hard — two overlapping Gaussians summed to something neither of them
 * showed.
 */
export const RESONANCE_ZONE_MIN = 1
export const RESONANCE_ZONE_MAX = 6
/** Closest two boundaries may sit, so a zone always has room to be read. */
export const RESONANCE_ZONE_MIN_OCTAVES = 0.25
/**
 * Width of the crossfade at a boundary, in octaves, centred on the split.
 *
 * NOT COSMETIC. A hard step means the bin just below a split and the bin just
 * above it are judged by different rules, so a resonance sitting across the
 * line is half treated — and as the pitch moves it slides between the two
 * regimes, which is the same per-bin gain movement the whole effect is built to
 * avoid. A sixth of an octave is about two semitones: wide enough that no
 * single partial spans it, narrow enough that a zone edge still lands where the
 * user put it.
 */
export const RESONANCE_ZONE_EDGE_OCTAVES = 1 / 6

/** Per-zone parameter ranges. Absolute values, not offsets from anything. */
export const RESONANCE_ZONE_RANGES = {
  depth: { min: 0, max: 1 },
  sharpness: { min: 0, max: 1 },
  selectivity: { min: 3, max: 24 },
  maxCut: { min: 3, max: 48 },
}

/**
 * The starting zone set: four spans over the speech spectrum.
 *
 * Every zone carries the values that used to be the single global setting, so
 * an untouched panel behaves exactly as the panel did before zones existed —
 * and buildResonanceZoneCurves takes its uniform fast path, which keeps that
 * bit-identical rather than merely close. The boundaries are placed where the
 * voice changes character rather than on round numbers: 180 Hz is above most
 * narrators' fundamentals, 1.1 kHz is the bottom of the presence range, and
 * 5 kHz is where sibilance starts to dominate.
 */
const ZONE_STOCK = {
  depth: 0.67,
  sharpness: 0.8,
  selectivity: 8,
  maxCut: 36,
  /**
   * Harmonic protection, PER ZONE, and the measurement is why.
   *
   * The mask zeroes reduction at every bin near a harmonic of the measured F0,
   * and its coverage does not fall off with frequency: measured at F0 90 / 140
   * it blocks 67–77% of every octave from 60 Hz to 20 kHz, and at F0 220 it
   * blocks 88% above 10 kHz. Down where the partials are widely spaced and
   * dominant that is real protection — thinning the comb there is exactly the
   * damage it exists to prevent. Up where sibilance and hiss live it is a
   * blanket veto over the band, and the "harmonics" being protected are a comb
   * so dense that nothing about it is separable by ear.
   *
   * So "protect the fundamental region, work freely above 5 kHz" is the setting
   * this effect most wants and could not express while the mask was global.
   *
   * The PITCH RANGE stays global, and that is not an oversight: it tells one
   * tracker which F0 to look for, and there is one signal and one pitch.
   */
  protect: true,
  enabled: true,
}
export const DEFAULT_RESONANCE_ZONES = [
  { id: 'z1', hiHz: 180, ...ZONE_STOCK },
  { id: 'z2', hiHz: 1100, ...ZONE_STOCK },
  { id: 'z3', hiHz: 5000, ...ZONE_STOCK },
  { id: 'z4', hiHz: 20000, ...ZONE_STOCK },
]
export const RESONANCE_ZONE_STOCK = ZONE_STOCK

/**
 * One zone spanning everything, carrying the settings given.
 *
 * The shape a caller wants when it has no opinion about frequency — a preset
 * block, a test, or any code that predates zones and thinks in one depth and
 * one selectivity. It is a real zone set, not a compatibility mode: the kernel
 * has one path, and this is what "the same everywhere" looks like in it.
 */
export function uniformZones(settings = {}) {
  return [{ id: 'z1', hiHz: 20000, ...ZONE_STOCK, ...settings }]
}

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** A zone's settings, normalised and clamped. */
export function zoneSettings(zone) {
  const enabled = zone ? zone.enabled !== false : true
  const R = RESONANCE_ZONE_RANGES
  return {
    enabled,
    // A disabled zone is depth zero, not a special case downstream. It reaches
    // the kernel as "remove none of what you find here", which is what bypass
    // means for a suppressor and needs no second mechanism.
    depth: enabled ? clampNum(zone?.depth ?? ZONE_STOCK.depth, R.depth.min, R.depth.max) : 0,
    maxCut: clampNum(zone?.maxCut ?? ZONE_STOCK.maxCut, R.maxCut.min, R.maxCut.max),
    protect: (zone?.protect ?? ZONE_STOCK.protect) !== false,
    sharpness: clampNum(zone?.sharpness ?? ZONE_STOCK.sharpness, R.sharpness.min, R.sharpness.max),
    selectivity: clampNum(
      zone?.selectivity ?? ZONE_STOCK.selectivity, R.selectivity.min, R.selectivity.max),
  }
}

/**
 * The span each zone covers.
 *
 * `hiHz` is each zone's upper boundary, the next starts where this one ends,
 * and the last zone's `hiHz` is ignored because it runs to the top. There are
 * therefore no gaps and no overlaps to reason about.
 */
export function zoneBounds(zones, floorHz = 20, ceilHz = 20000) {
  const out = []
  let lo = floorHz
  for (let i = 0; i < zones.length; i++) {
    const last = i === zones.length - 1
    const hi = last ? ceilHz : clampNum(zones[i].hiHz, floorHz, ceilHz)
    out.push({ loHz: lo, hiHz: Math.max(lo, hi) })
    lo = Math.max(lo, hi)
  }
  return out
}

/**
 * Per-zone weights at one frequency: 1 inside a zone, crossfading at the edges.
 *
 * Always sums to 1, which is what lets the caller blend anything per bin —
 * a threshold, a depth, or a whole reference envelope — by the same weights.
 */
export function zoneWeightsAt(zones, freqHz) {
  const w = new Array(zones.length).fill(0)
  if (zones.length === 0) return w
  const half = RESONANCE_ZONE_EDGE_OCTAVES / 2
  let index = zones.length - 1
  for (let i = 0; i < zones.length - 1; i++) {
    if (freqHz <= zones[i].hiHz) { index = i; break }
  }
  w[index] = 1
  if (!(freqHz > 0)) return w

  const edgeBelow = index > 0 ? zones[index - 1].hiHz : null
  const edgeAbove = index < zones.length - 1 ? zones[index].hiHz : null
  if (edgeBelow > 0 && Math.abs(Math.log2(freqHz / edgeBelow)) < half) {
    const t = clampNum(0.5 + Math.log2(freqHz / edgeBelow) / RESONANCE_ZONE_EDGE_OCTAVES, 0, 1)
    w[index] = t
    w[index - 1] = 1 - t
  } else if (edgeAbove > 0 && Math.abs(Math.log2(freqHz / edgeAbove)) < half) {
    const t = clampNum(0.5 - Math.log2(freqHz / edgeAbove) / RESONANCE_ZONE_EDGE_OCTAVES, 0, 1)
    w[index] = t
    w[index + 1] = 1 - t
  }
  return w
}

/** Settings in force at one frequency, blended across boundaries. */
export function zoneSettingsAt(zones, freqHz) {
  if (!zones || zones.length === 0) return { ...ZONE_STOCK, depth: ZONE_STOCK.depth }
  const w = zoneWeightsAt(zones, freqHz)
  const out = { depth: 0, sharpness: 0, selectivity: 0, maxCut: 0 }
  for (let i = 0; i < zones.length; i++) {
    if (!w[i]) continue
    const s = zoneSettings(zones[i])
    out.depth += w[i] * s.depth
    out.sharpness += w[i] * s.sharpness
    out.selectivity += w[i] * s.selectivity
    out.maxCut += w[i] * s.maxCut
  }
  return out
}

/**
 * Expand a zone set onto an FFT bin grid.
 *
 * Returns per-bin curves for the three settings, plus what the kernel needs to
 * build a reference envelope per distinct sharpness: `groups` lists the
 * DISTINCT sharpness values with the bins each covers, and `uniform` says the
 * whole spectrum shares one setting.
 *
 * THE UNIFORM FLAG IS NOT AN OPTIMISATION, IT IS A GUARANTEE. Blending N
 * identical envelopes by weights that sum to 1 is not exactly the envelope —
 * `0.3·e + 0.7·e` differs from `e` in the last bits — so a panel whose zones
 * all still carry the stock settings would drift from the build before zones
 * existed by an amount that is inaudible and impossible to prove absent. With
 * one group the kernel assigns rather than blends, and the default patch stays
 * bit-identical.
 */
export function buildResonanceZoneCurves(zones, binCount, binWidth) {
  if (!zones || zones.length === 0) return null
  const depth = new Float64Array(binCount)
  const sharpness = new Float64Array(binCount)
  const selectivity = new Float64Array(binCount)
  const maxCut = new Float64Array(binCount)
  // 1 where the harmonic mask applies, 0 where it does not, crossfaded between.
  // A fraction rather than a flag so a boundary between a protected zone and an
  // unprotected one is the same soft edge every other zone setting has — a hard
  // step here would put a partial half in and half out of the mask.
  const protect = new Float64Array(binCount)

  // Distinct sharpness values, to a resolution finer than the knob's step. Each
  // becomes one reference envelope; the kernel pays one inverse transform per
  // group per frame, so this is the number worth keeping small.
  const groups = []
  const keyOf = v => Math.round(v * 1000)
  const zoneGroup = zones.map((z) => {
    const key = keyOf(zoneSettings(z).sharpness)
    let g = groups.find(x => x.key === key)
    if (!g) {
      g = { key, sharpness: zoneSettings(z).sharpness, weight: new Float64Array(binCount) }
      groups.push(g)
    }
    return g
  })

  const settings = zones.map(zoneSettings)
  for (let k = 0; k < binCount; k++) {
    const hz = k * binWidth
    const w = zoneWeightsAt(zones, hz)
    for (let i = 0; i < zones.length; i++) {
      if (!w[i]) continue
      depth[k] += w[i] * settings[i].depth
      sharpness[k] += w[i] * settings[i].sharpness
      selectivity[k] += w[i] * settings[i].selectivity
      maxCut[k] += w[i] * settings[i].maxCut
      protect[k] += w[i] * (settings[i].protect ? 1 : 0)
      zoneGroup[i].weight[k] += w[i]
    }
  }
  // Bin 0 is DC; log2(0) is -Infinity, so it copies its neighbour.
  if (binCount > 1) {
    depth[0] = depth[1]
    sharpness[0] = sharpness[1]
    selectivity[0] = selectivity[1]
    maxCut[0] = maxCut[1]
    protect[0] = protect[1]
    for (const g of groups) g.weight[0] = g.weight[1]
  }
  return {
    depth,
    sharpness,
    selectivity,
    maxCut,
    protect,
    groups,
    uniform: groups.length === 1,
    // Whether the mask is worth building at all this frame. It depends only on
    // F0, so one zone wanting it is enough to pay for it.
    anyProtect: zones.some(z => zoneSettings(z).protect),
  }
}

/**
 * Copy a zone set into plain objects.
 *
 * The panel holds these in a Vue ref, which hands out a reactive Proxy, and
 * this object crosses a structured clone on its way to the worklet. Passing the
 * proxy through throws DataCloneError, and that throw lands on the first param
 * push — so the meter loop never starts and the display and DELTA monitor both
 * stay dark, with nothing on screen about zones. Learned the hard way; see the
 * note on toKernelParams.
 */
export function copyZones(zones) {
  return (zones ?? []).map(z => ({
    id: z.id,
    hiHz: z.hiHz,
    depth: z.depth,
    sharpness: z.sharpness,
    selectivity: z.selectivity,
    maxCut: z.maxCut,
    protect: z.protect,
    enabled: z.enabled,
  }))
}

// Defaults are the acx_audiobook preset's resonanceSuppressor block
// (src/audio/presets.js), which is the tuning these were chosen against.
export const RESONANCE_DEFAULTS = {
  // Depth, sharpness and selectivity are NOT here. They are per-zone settings
  // now, with no global value to be an offset from — see DEFAULT_RESONANCE_ZONES.
  // Nor are the low/high band limits: a band you want left alone is a zone
  // switched off, which says the same thing in a control that already exists.
  attack: 15, // ms
  release: 80, // ms
  mode: 'soft', // 'soft' | 'hard'
  // 'cepstral' | 'peak' — see RESONANCE_REF_MODE_DEFAULTS above.
  refMode: 'cepstral',
  // Sensitivity zones — see DEFAULT_RESONANCE_ZONES above. Not filters.
  zones: DEFAULT_RESONANCE_ZONES,
  mix: 1, // 0 = dry, 1 = fully suppressed
  trim: 0, // dB, wet path only
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  return {
    attackMs: params.attack,
    releaseMs: params.release,
    mode: params.mode,
    // Fixed: harmonic protection is a voice feature — see HARMONIC_PITCH_RANGE.
    pitchMinHz: HARMONIC_PITCH_RANGE.minHz,
    pitchMaxHz: HARMONIC_PITCH_RANGE.maxHz,
    refMode: params.refMode,
    // Copied field by field, not passed through. Zones arrive as Vue reactive
    // proxies and this object crosses a structured clone — `postMessage` to the
    // worklet, and `processorOptions` on the offline render — which throws
    // DataCloneError on a proxy. It is not defensive tidiness: without it the
    // param push throws, so the meter loop never starts and the display and the
    // DELTA monitor both stay dark. Same reason manualEq copies its bands.
    zones: copyZones(params.zones),
    mix: params.mix,
    trimDb: params.trim,
  }
}
