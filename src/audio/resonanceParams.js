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
 * Pitch search ranges for harmonic protection.
 *
 * The server's stage only ever ran on speech, so its range was a constant. This
 * effect is a general tool, and an out-of-range source does not degrade
 * gracefully: the tracker returns the best lag *within* the range, which for an
 * out-of-range pitch is an octave artefact reported with full confidence, and
 * the protection mask then lands on bins that are not harmonics.
 *
 * `wide` asks for 40 Hz, below what a 2048-sample frame can autocorrelate; the
 * kernel clamps it, and `effectivePitchRange` is how the UI finds out to what.
 */
export const PITCH_RANGES = {
  voice: { minHz: 70, maxHz: 400, label: 'VOICE', title: 'Speech and vocals (70–400 Hz)' },
  wide: { minHz: 40, maxHz: 1200, label: 'WIDE', title: 'Instruments and full-range material (40–1200 Hz)' },
}

/**
 * The pitch range actually used, after the kernel's clamp.
 *
 * The kernel clamps the requested range to what its frame can autocorrelate and
 * records the result on `kernel.pitchRange` — but that lives inside a worklet
 * and there is no channel back out for a value needed to render a label. So the
 * clamp is mirrored here, and a test pins the two together.
 */
export function effectivePitchRange(sampleRate, rangeKey) {
  const range = PITCH_RANGES[rangeKey] ?? PITCH_RANGES.voice
  const floor = pitchFloorHz(sampleRate, RESONANCE_FRAME_SIZE)
  return { minHz: Math.max(floor, range.minHz), maxHz: range.maxHz }
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
    selectivity: 20,
    depth: 1,
    // Slow, because the two mechanisms are complementary and measurably
    // superadditive: the stable envelope removes the frequency-domain source of
    // gain movement and these remove the time-domain residue. Alone they are
    // worth 21% and 11%; together, 62%.
    attack: 100,
    release: 500,
    // The whole point: this reference does not make harmonics look like
    // resonances, so it does not need the mask that answers that.
    preserveHarmonics: false,
  },
}

export function resolveRefMode() {
  const requested = readOverride('resoRef')
  return REF_MODES.has(requested) ? requested : DEFAULT_REF_MODE
}

/** Shipping defaults, with the selected reference mode's calibration applied. */
export function withRefModeDefaults(defaults) {
  return { ...defaults, ...RESONANCE_REF_MODE_DEFAULTS[resolveRefMode()] }
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
 * Sensitivity weighting curve — EQ-style nodes that are NOT filters.
 *
 * A node does not boost or cut the audio. It offsets `selectivity` — the
 * threshold a bin must protrude above its reference to count as a resonance —
 * over a region of the spectrum. Positive gain LOWERS the threshold there, so
 * the effect is more willing to act; negative gain raises it. Soothe2 describes
 * the same idea as "an inverse EQ or a sidechain EQ": boosting a band makes it
 * more processed, not louder.
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
 * Gaussian in LOG frequency, summed across nodes, for the same reason the
 * spread kernel is: a region of the spectrum is a span in octaves, not in Hz.
 *
 * Kept here rather than in the kernel so the panel can draw exactly the curve
 * the detector uses, the way the display grid is shared.
 */
export const RESONANCE_WEIGHT_MAX_NODES = 4
/** Range of a single node, in dB of threshold offset. */
export const RESONANCE_WEIGHT_MAX_DB = 12
/**
 * Ceiling on the SUM.
 *
 * Nodes add, because two overlapping nodes both meaning "be more sensitive
 * here" should be more sensitive than either alone — anything else is
 * surprising to move. But an unbounded sum of four nodes could drive the
 * effective threshold far negative, and a negative threshold does not mean
 * "very sensitive", it means "treat everything including what sits BELOW the
 * reference", which is not a resonance by any definition. Bounded here, and
 * the effective threshold is floored at zero in the kernel as well.
 */
export const RESONANCE_WEIGHT_SUM_LIMIT_DB = 24
export const RESONANCE_WEIGHT_MIN_OCTAVES = 0.15
export const RESONANCE_WEIGHT_MAX_OCTAVES = 3
/**
 * NARROW BY DEFAULT, and that is measured rather than a taste.
 *
 * On a narrator clip with an audible low-mid honk, treating it with one wide
 * node (1.0 octave at 450 Hz) against two narrow ones (0.3 octave at 356 and
 * 534, where the source spectrum actually peaks), both at +9 dB:
 *
 *                        mean cut   jitter      honk treated   per unit cut
 *     drive selectivity    -5.52   1.23/1.58        3.90          0.71
 *     one wide node        -4.83   1.13/1.49        4.17          0.86
 *     two narrow nodes     -3.93   1.01/1.36        4.64          1.18
 *
 * The two narrow nodes beat lowering selectivity globally on EVERY axis at
 * once - more treatment where it was wanted, less cutting overall, less gain
 * jitter - where the wide node only improved two of the three. A wide node is
 * most of the way back to being a second selectivity knob.
 */
export const RESONANCE_WEIGHT_DEFAULT_OCTAVES = 0.3

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** Threshold offset the node set applies at one frequency, in dB. */
export function resonanceWeightDbAt(nodes, freqHz) {
  if (!nodes || nodes.length === 0 || !(freqHz > 0)) return 0
  let acc = 0
  for (const node of nodes) {
    if (!node || !(node.freqHz > 0) || !node.gainDb) continue
    if (node.enabled === false) continue
    const octaves = clampNum(
      node.octaves ?? RESONANCE_WEIGHT_DEFAULT_OCTAVES,
      RESONANCE_WEIGHT_MIN_OCTAVES,
      RESONANCE_WEIGHT_MAX_OCTAVES,
    )
    const x = Math.log2(freqHz / node.freqHz) / octaves
    acc += clampNum(node.gainDb, -RESONANCE_WEIGHT_MAX_DB, RESONANCE_WEIGHT_MAX_DB)
      * Math.exp(-0.5 * x * x)
  }
  return clampNum(acc, -RESONANCE_WEIGHT_SUM_LIMIT_DB, RESONANCE_WEIGHT_SUM_LIMIT_DB)
}

/**
 * Expand a node set onto an FFT bin grid, or null when it would be flat.
 *
 * Null rather than a zero-filled array so the detector can skip the lookup
 * entirely on the overwhelmingly common empty case, and so a file processed
 * with no nodes is bit-identical to one processed before this existed.
 */
export function buildResonanceWeightCurve(nodes, binCount, binWidth) {
  if (!nodes || nodes.length === 0) return null
  const live = nodes.filter(n => n && n.enabled !== false && n.gainDb && n.freqHz > 0)
  if (live.length === 0) return null
  const curve = new Float64Array(binCount)
  // Bin 0 is DC; evaluating log2(0) there would be -Infinity. It carries no
  // audible content and the detector's band limits exclude it in practice.
  for (let k = 1; k < binCount; k++) curve[k] = resonanceWeightDbAt(live, k * binWidth)
  curve[0] = curve[1]
  return curve
}
