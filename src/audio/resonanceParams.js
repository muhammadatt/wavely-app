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
import { copyFocus } from './resonanceFocus.js'

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
 * Curves in one display frame: magnitude, reference, detect, reduction.
 *
 * ⚠ IT WAS 5 TWICE, AND BOTH TIMES THE FIFTH HAD OUTLIVED ITS READER. First
 * `output`, kept after the two lanes merged and drawn by nothing; it was reused
 * for `detect` rather than removed. Then `reductionHeld` — the maximum since the
 * previous read, which existed solely so the trace's peak-hold outline could
 * catch a peak landing on a frame the reader never saw. The hold is gone and so
 * is the curve.
 *
 * Worth stating because the count is DECLARED rather than derived: it sizes the
 * buffer, slices the view and crosses a postMessage every 23 ms, so a curve
 * nothing reads is paid for on every frame and nothing complains. If a third one
 * ever goes the same way, derive this from the view's own key list instead.
 */
export const RESONANCE_DISPLAY_CURVES = 4
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
 *   ?resoRef=cepstral                              one page load
 *   localStorage.setItem('resoRef', 'cepstral')    until cleared
 *
 * ⚠ THE ROLES SWAPPED AND THIS NOTE HAD THEM THE OLD WAY ROUND, examples
 * included. The PEAK ENVELOPE ships; cepstral is the override. The swap was made
 * on the measurement in RESONANCE_REF_MODE_DEFAULTS below: the cepstral
 * reference works in roughly 150-900 Hz and is blind either side of it — below
 * the fundamental where rumble and room modes live, and above about 1 kHz where
 * sibilance and ring do, which is most of what this effect is asked to remove.
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
export const DEFAULT_REF_MODE = 'peak'

/**
 * Per-mode calibration.
 *
 * THE PEAK-ENVELOPE REFERENCE SHIPS. The cepstral one is the override, and the
 * swap was made on measurement rather than taste.
 *
 * WHAT THE CEPSTRAL REFERENCE COULD NOT SEE. A +12 dB Q=8 resonance planted on
 * 46 s of real narration (median F0 195 Hz), dB removed at that frequency:
 *
 *          60 Hz   80    110    150    250    400    900   2.5k    6k
 *   cep    -0.01  0.00   0.06   4.63   7.56   6.22   1.86   0.01   0.00
 *   peak    1.74  2.76   0.34   4.00   4.66   6.52   0.86   0.76   4.39
 *
 * It works in a band roughly 150–900 Hz and nowhere else — blind below the
 * fundamental, where rumble and room modes live, and blind above about 1 kHz,
 * where sibilance and ring live. That is most of what a resonance suppressor
 * is asked to remove.
 *
 * THE FIRST EXPLANATION OFFERED FOR THE HIGH END WAS WRONG and the measurement
 * that killed it is worth keeping: the cepstral envelope's resolution is
 * uniform in Hz, so the obvious theory was that it tracks (and therefore hides)
 * resonances that are wide in Hz. Swept at 6 kHz by bandwidth, cepstral removes
 * 0.03 / 0.00 / 0.01 / 0.01 dB at Q 40 / 20 / 8 / 3 against peak's 6.08 / 6.33
 * / 6.05 / 4.96. Bandwidth is irrelevant; it does not see anything up there at
 * any width. The remaining explanation — unproven — is that cepstral compares a
 * RAW bin against a smooth envelope, and at high frequencies the raw spectrum's
 * own bin-to-bin scatter is comparable to the threshold, where the peak path
 * compares a max-filtered value against a wide octave-scale average.
 *
 * THE HISTORICAL OBJECTION TO PEAK NO LONGER REPRODUCES. It was rejected once
 * for worse pitch-movement artefacts; matched at 3.0 dB of cut on the same
 * clip with stock ballistics, gain jitter is 2.59/3.52 cepstral against
 * 2.51/3.73 peak — a wash. That finding predates the F0 tracker's bounded
 * interpolation and the slow-ballistics work, both of which moved it.
 *
 * ⚠ THE ONE THING MEASURED AGAINST THE SWAP, and it is unresolved: peak spreads
 * its work far more widely on material with nothing planted in it. Matched at
 * 3.0 dB, mean reduction per band on untouched narration —
 *
 *            60    120    250    500     1k   2.5k     6k
 *   cep    -0.01  -6.66  -2.67  -1.66  -0.52  -0.07  -0.00
 *   peak   -4.24  -5.52  -5.70  -2.20  -0.25  -0.70  -0.58
 *
 * −4.24 dB at 60 Hz on a file with nothing deliberately wrong there. On this
 * clip that is very likely room rumble and welcome, but a number cannot say so,
 * and it is the axis on which peak may turn out to be less surgical rather than
 * more capable. One narrator, one clip.
 *
 * THE KNOBS ARE NOT COMPARABLE BETWEEN THE TWO MODES. `selectivity` thresholds
 * how far a bin protrudes above the reference, and the two disagree about that
 * quantity by an order of magnitude — on a clean voice with no defect at all
 * the cepstral reference reads 21–24 dB of protrusion, because from the
 * inter-harmonic floor the comb itself protrudes, while the peak reference
 * reads 2.5–4.2 dB, which is what "nothing is wrong here" ought to measure.
 * This is soothe2's note about its own two algorithms, for the same reason:
 * "choosing the mode changes everything, as all other controls are relative to
 * the mode."
 */
export const RESONANCE_REF_MODE_DEFAULTS = {
  // The shipping reference. Its calibration lives in RESONANCE_ZONE_STOCK
  // rather than here, because that is now what a fresh panel starts from.
  peak: {},
  cepstral: {
    refMode: 'cepstral',
    // What the zones carried while the cepstral reference shipped, restored so
    // the override is the old panel rather than the new numbers on the old
    // detector. See RESONANCE_ZONE_STOCK for why 8 and 20 are not comparable.
    zoneOverrides: { selectivity: 8, depth: 0.67 },
    attack: 15,
    release: 80,
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

/**
 * Per-zone parameter ranges. Absolute values, not offsets from anything.
 *
 * SELECTIVITY'S TOP WAS 24, WHICH DID NOT REACH ZERO — the knob's gentlest
 * setting still removed audible material. Selectivity is a threshold, so it
 * runs backwards: higher means less gets through it and less is cut. Measured
 * on 46 s of real narration under the shipping peak reference, with protection
 * off and depth 1, mean / p90 cut in 100–400 Hz:
 *
 *     sel      3      8     12     16     20     24     28     34     40
 *     mean  17.92  13.11   9.34   5.76   3.05   1.30   0.39   0.05   0.00
 *     p90   26.30  21.40  17.30  13.30   8.60   3.60   1.10   0.10   0.00
 *
 * So the old maximum sat at 1.3 dB mean and 3.6 dB p90 — winding the control
 * fully "off" left several dB of cut in place on the peaks, and the only way to
 * stop a band being treated was to switch the zone off entirely. That is the
 * one thing a threshold's top end has to be able to say.
 *
 * The range was set for the CEPSTRAL reference, whose stock selectivity was 8 —
 * mid-travel there. Peak's stock is 20, so the same window put the default at
 * 71% of the travel with 1.3 dB of authority left above it.
 *
 * 36 rather than 34. The effect is already inaudible by 30 (0.18 dB) and
 * measures 0.03 at 34 on THIS file, which is one recording: material with more
 * low-frequency energy needs a higher threshold to null, and a knob whose top
 * fails to reach zero on some inputs is a worse error than a few degrees of
 * dead travel at the end on others. Stock 20 lands at 52% of the new range.
 *
 * The MINIMUM stays at 3, which is not a lack of nerve. Below it the curve
 * saturates — 0.5 removes 20.30 dB against 3's 17.92, a 2.4 dB spread across
 * five sixths of the remaining travel — and every setting down there is well
 * past destroying the material. Lowering it would spend real estate on
 * differences nobody can use, and would clamp nothing that exists today.
 */
export const RESONANCE_ZONE_RANGES = {
  depth: { min: 0, max: 1 },
  sharpness: { min: 0, max: 1 },
  selectivity: { min: 3, max: 36 },
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
/**
 * ⚠ CALIBRATED FOR THE CEPSTRAL REFERENCE AND CARRIED OVER TO THE PEAK ONE.
 *
 * `selectivity` and `depth` here are the peak reference's previous calibration
 * (20 / 1), which was derived on real narration as "where a 46 s narrator clip
 * lands on ~3 dB of mean cut in the fundamental region" — with harmonic
 * protection OFF and against the old F0 tracker. A fresh solve on the same clip
 * with the current build puts the 3 dB point nearer 16.3. Neither number has
 * been listened to as a shipping default.
 *
 * `sharpness` and `maxCut` are unchanged from the cepstral era and have not
 * been re-derived against the peak envelope at all. Sharpness in particular
 * means something different there: it sets the geometric window of the peak
 * reference rather than a cepstral lifter cutoff.
 *
 * These are a starting point for listening, not a result.
 */
const ZONE_STOCK = {
  depth: 1,
  sharpness: 0.8,
  selectivity: 20,
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
  /**
   * ⚠ OFF UNDER THE SHIPPING REFERENCE, and that is a behavioural default
   * rather than a number to be re-tuned.
   *
   * The mask exists because the CEPSTRAL reference sits at the inter-harmonic
   * floor, so every harmonic protrudes and reads as a resonance. The peak
   * envelope is drawn THROUGH the harmonic peaks, so nothing protrudes at a
   * harmonic and there is nothing for the mask to protect against. Switched on
   * there it does something else entirely — it holds the partials and
   * attenuates the floor between them, pinned in resonancePitch.test.js — and
   * measured on real narration that does not improve the harmonic-to-noise
   * ratio: quieter, not cleaner.
   */
  protect: false,
  enabled: true,
}
/**
 * THREE ZONES, NOT FOUR. The 5 kHz boundary is the one that went.
 *
 * 180 Hz and 1.1 kHz are the two splits the panel's own reasoning rests on —
 * below the first is where rumble and the fundamental live and where the
 * harmonic mask earns its place, and above the second is where sibilance and
 * ring do — so a three-way keeps both of those and folds the old upper-mid and
 * air zones into one. Splitting 1.1 kHz upward again is one double-click for
 * anyone who wants it back, and a split inherits its parent's settings.
 */
export const DEFAULT_RESONANCE_ZONES = [
  { id: 'z1', hiHz: 180, ...ZONE_STOCK },
  { id: 'z2', hiHz: 1100, ...ZONE_STOCK },
  { id: 'z3', hiHz: 20000, ...ZONE_STOCK },
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
  // BALLISTICS SLOW ENOUGH TO LEVEL A PHRASE RATHER THAN A SYLLABLE, which is
  // the regime the sweep found: at matched cut, a longer release is better per
  // dB removed (0.416 -> 0.299 out to 4 s) and p90 depth falls 8.5 -> 5.2 dB,
  // the same average spread evenly instead of concentrated in momentary deep
  // notches. 15/80 was inherited from the server stage, where the suppressor
  // runs inside a chain rather than as something set by ear.
  //
  // 200/500 IS WHERE THAT SWEEP SATURATES, which is why it is the default rather
  // than the slowest setting the sweep liked. Matched at 3.0 dB of cut, gain
  // jitter runs 0.96/1.29 at 12/80 ms, reaches 0.80/1.02 by 200/500, and is then
  // FLAT out to 200/4000 — so everything past this pair buys nothing measurable
  // while making the effect slower to respond. It was 300/1500, which is inside
  // that flat region and therefore not wrong, only unnecessarily sluggish.
  //
  // ⚠ THE KNOB TOPS STAY AT 400/2000. What keeps improving past the knee is p90
  // depth rather than jitter, and a narrator with an unusually resonant room is
  // the case that wants it — the sweep is the argument for the range, this pair
  // is the argument for where to start.
  attack: 200, // ms
  release: 500, // ms
  mode: 'soft', // 'soft' | 'hard'
  // 'cepstral' | 'peak' — see RESONANCE_REF_MODE_DEFAULTS above.
  refMode: 'peak',
  // Sensitivity zones — see DEFAULT_RESONANCE_ZONES above. Not filters.
  zones: DEFAULT_RESONANCE_ZONES,
  /**
   * Focus patch, or null for the zone model. See resonanceFocus.js.
   *
   * ⚠ PRESENT AND NULL, NOT ABSENT, and that is load-bearing twice over. The
   * effect wrapper's `setParam` guards with `name in params`, so a key missing
   * from this object is not rejected — it is SILENTLY DROPPED, which is exactly
   * how the soft clipper's drive ratios shipped as a control that did nothing
   * for a whole listening session. And `toKernelParams` forwards every key, so
   * null has to be a value the kernel understands rather than a hole.
   */
  focus: null,
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
    // Copied field by field for the same reason zones are: a Vue reactive proxy
    // does not survive `structuredClone`, and the throw lands on the first param
    // push — taking the meter loop, the display and the DELTA monitor with it.
    focus: copyFocus(params.focus),
    mix: params.mix,
    trimDb: params.trim,
  }
}
