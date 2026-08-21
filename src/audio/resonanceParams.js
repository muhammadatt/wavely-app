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
/** Range of a zone's threshold offset, in dB. */
export const RESONANCE_ZONE_SENS_MAX_DB = 12
/** Closest two boundaries may sit, so a zone always has room to be read. */
export const RESONANCE_ZONE_MIN_OCTAVES = 0.25
/**
 * Width of the crossfade at a boundary, in octaves, centred on the split.
 *
 * NOT COSMETIC. A hard step in the threshold means the bin just below a split
 * and the bin just above it are judged by different rules, so a resonance
 * sitting across the line is half treated — and as the pitch moves it slides
 * between the two regimes, which is the same per-bin gain movement the whole
 * effect is built to avoid. A sixth of an octave is about two semitones: wide
 * enough that no single partial spans it, narrow enough that a zone edge still
 * lands where the user put it.
 */
export const RESONANCE_ZONE_EDGE_OCTAVES = 1 / 6

/**
 * The starting zone set: four spans over the speech spectrum.
 *
 * Every zone is neutral — no offset, full depth, enabled — so a panel that has
 * never touched this behaves exactly as a panel with no zones at all, and
 * buildResonanceZoneCurves returns null for it. The boundaries are placed where
 * the voice changes character rather than on round numbers: 180 Hz is above
 * most narrators' fundamentals, 1.1 kHz is the bottom of the presence range,
 * and 5 kHz is where sibilance starts to dominate.
 */
export const DEFAULT_RESONANCE_ZONES = [
  { id: 'z1', hiHz: 180, sensitivityDb: 0, depth: 1, enabled: true },
  { id: 'z2', hiHz: 1100, sensitivityDb: 0, depth: 1, enabled: true },
  { id: 'z3', hiHz: 5000, sensitivityDb: 0, depth: 1, enabled: true },
  { id: 'z4', hiHz: 20000, sensitivityDb: 0, depth: 1, enabled: true },
]

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** A zone's settings, normalised and clamped. */
export function zoneSettings(zone) {
  if (!zone) return { sensitivityDb: 0, depth: 1, enabled: true }
  const enabled = zone.enabled !== false
  return {
    enabled,
    sensitivityDb: enabled
      ? clampNum(zone.sensitivityDb ?? 0, -RESONANCE_ZONE_SENS_MAX_DB, RESONANCE_ZONE_SENS_MAX_DB)
      : 0,
    // A disabled zone is depth zero, not a special case downstream. It reaches
    // the kernel as "remove none of what you find here", which is what bypass
    // means for a suppressor and needs no second mechanism.
    depth: enabled ? clampNum(zone.depth ?? 1, 0, 1) : 0,
  }
}

/**
 * The span each zone covers, given the processed band.
 *
 * The band limits are their own parameters and move independently, so a zone's
 * edges are only meaningful clamped to them — a split dragged to 8 kHz while
 * the ceiling sits at 6 kHz describes a zone with no width.
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
 * Settings in force at one frequency, blended across boundaries.
 *
 * Linear in log frequency across RESONANCE_ZONE_EDGE_OCTAVES, which is enough:
 * the quantity being blended is a threshold in dB, and a kink in it is not
 * something any downstream stage differentiates.
 */
export function zoneSettingsAt(zones, freqHz, floorHz = 20, ceilHz = 20000) {
  if (!zones || zones.length === 0) return { sensitivityDb: 0, depth: 1 }
  const bounds = zoneBounds(zones, floorHz, ceilHz)
  const half = RESONANCE_ZONE_EDGE_OCTAVES / 2
  let index = bounds.length - 1
  for (let i = 0; i < bounds.length; i++) {
    if (freqHz <= bounds[i].hiHz) { index = i; break }
  }
  const here = zoneSettings(zones[index])
  if (freqHz <= 0) return here

  // Which boundary, if any, this frequency is inside the crossfade of.
  const edgeBelow = index > 0 ? bounds[index - 1].hiHz : null
  const edgeAbove = index < bounds.length - 1 ? bounds[index].hiHz : null
  let other = null
  let t = 1
  if (edgeBelow && Math.abs(Math.log2(freqHz / edgeBelow)) < half) {
    other = zoneSettings(zones[index - 1])
    t = 0.5 + Math.log2(freqHz / edgeBelow) / RESONANCE_ZONE_EDGE_OCTAVES
  } else if (edgeAbove && Math.abs(Math.log2(freqHz / edgeAbove)) < half) {
    other = zoneSettings(zones[index + 1])
    t = 0.5 - Math.log2(freqHz / edgeAbove) / RESONANCE_ZONE_EDGE_OCTAVES
  }
  if (!other) return here
  const mix = clampNum(t, 0, 1)
  return {
    sensitivityDb: here.sensitivityDb * mix + other.sensitivityDb * (1 - mix),
    depth: here.depth * mix + other.depth * (1 - mix),
  }
}

/**
 * Expand a zone set onto an FFT bin grid, or null when it would change nothing.
 *
 * Null rather than neutral arrays so the detector can skip two lookups per bin
 * on the overwhelmingly common untouched case, and so a file processed on the
 * default zones is bit-identical to one processed before zones existed.
 */
export function buildResonanceZoneCurves(zones, binCount, binWidth, floorHz, ceilHz) {
  if (!zones || zones.length === 0) return null
  const neutral = zones.every((z) => {
    const s = zoneSettings(z)
    return s.sensitivityDb === 0 && s.depth === 1
  })
  if (neutral) return null
  const weightDb = new Float64Array(binCount)
  const depthScale = new Float64Array(binCount)
  // Bin 0 is DC; log2(0) is -Infinity. It carries no audible content and the
  // detector's band limits exclude it in practice.
  for (let k = 1; k < binCount; k++) {
    const at = zoneSettingsAt(zones, k * binWidth, floorHz, ceilHz)
    weightDb[k] = at.sensitivityDb
    depthScale[k] = at.depth
  }
  weightDb[0] = weightDb[1]
  depthScale[0] = depthScale[1]
  return { weightDb, depthScale }
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
    sensitivityDb: z.sensitivityDb,
    depth: z.depth,
    enabled: z.enabled,
  }))
}

// Defaults are the acx_audiobook preset's resonanceSuppressor block
// (src/audio/presets.js), which is the tuning these were chosen against.
export const RESONANCE_DEFAULTS = {
  depth: 0.67,
  sharpness: 0.8,
  selectivity: 8,
  attack: 15, // ms
  release: 80, // ms
  maxReduction: 36, // dB
  freqFloor: 40, // Hz
  freqCeil: 20000, // Hz
  mode: 'soft', // 'soft' | 'hard'
  preserveHarmonics: true,
  pitchRange: 'voice', // key of PITCH_RANGES
  // 'cepstral' | 'peak' — see RESONANCE_REF_MODE_DEFAULTS above.
  refMode: 'cepstral',
  // Sensitivity zones — see DEFAULT_RESONANCE_ZONES above. Not filters.
  zones: DEFAULT_RESONANCE_ZONES,
  mix: 1, // 0 = dry, 1 = fully suppressed
  trim: 0, // dB, wet path only
}

/** Map UI param names to kernel param names. */
export function toKernelParams(params) {
  const range = PITCH_RANGES[params.pitchRange] ?? PITCH_RANGES.voice
  return {
    depth: params.depth,
    sharpness: params.sharpness,
    selectivity: params.selectivity,
    attackMs: params.attack,
    releaseMs: params.release,
    maxReductionDb: params.maxReduction,
    freqFloorHz: params.freqFloor,
    freqCeilHz: params.freqCeil,
    mode: params.mode,
    preserveHarmonics: params.preserveHarmonics,
    pitchMinHz: range.minHz,
    pitchMaxHz: range.maxHz,
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
