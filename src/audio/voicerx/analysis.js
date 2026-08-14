/**
 * VoiceRx analysis — client port of Stage 3a Corrective EQ.
 *
 * Direct port of server/scripts/corrective_eq.py. Same constants, same steps,
 * same order: mean cepstral envelope over voiced frames -> per-region
 * edge-anchored baseline -> deviation peak -> band parameters -> merge.
 *
 * WHY THIS AND NOT A REFERENCE CURVE. The corpus route (referenceEQ) compares a
 * recording against a stored curve, which drags the mastering preset into a spot
 * editing tool and only works for presets whose corpus has been built. Stage 3a
 * needs neither: the reference is the file's own spectrum, anchored just outside
 * each scan region and interpolated across it. A resonance is defined as an
 * excursion from its own neighbourhood, which is both what the ear hears and
 * what a display can show honestly.
 *
 * THE ONE REAL DIVERGENCE FROM THE SERVER: voiced-frame selection.
 *
 * Stage 3a receives a Silero VAD mask. There is no Silero in the browser, so
 * frames are selected here as *pitched and above the noise floor* using
 * F0Tracker. The docstring on dsp/f0.js warns — correctly, and from experience —
 * that "pitched" is not "speech": Silero labels fricatives and breaths as speech
 * and the autocorrelation tracker does not.
 *
 * That warning is about substituting one for the other where speech presence is
 * what matters. Here it is not. This analysis wants periodic frames
 * specifically: the whole method is to lifter away harmonic structure to expose
 * the formant envelope, the lifter cutoff is derived from F0, and an unvoiced
 * frame contributes no harmonics to remove and no formant peaks worth
 * averaging. The server calls this "the voiced-frame spectral envelope" for the
 * same reason. So the substitution narrows the frame set toward exactly the
 * frames this computation is about, and the energy gate keeps out the quiet
 * pitched noise the correlation ratio alone would let through.
 *
 * Dependency-free apart from ../dsp/. No Web Audio, no DOM — the caller hands in
 * a mono Float32Array, which keeps this unit-testable without an AudioContext.
 */

import { getFFT, rfftBinCount } from '../dsp/fft.js'
import { F0Tracker } from '../dsp/f0.js'
import {
  REGION_ORDER, REGION_SPAN_HZ, classifyVoice,
  SCAN_LOW, SCAN_HIGH, DIRECTION, THRESHOLD_DB, MAX_BOOST_DB, MAX_CUT_DB, SCALE,
} from './regions.js'
import {
  detectSpectralHoles, inAnyHole, holeCoverage, MAX_HOLE_COVERAGE,
} from './holes.js'
import { toLogGrid, robustTrend } from './trend.js'
import { roleForRegion } from '../eqBands.js'
import { peaking, lowShelf, highShelf, magnitudeResponseDb } from '../dsp/biquad.js'
import { eqDesignRate } from '../eqProcessor.js'

/**
 * BASELINE STRATEGY — `trend` ships; `chord` is kept for comparison only.
 *
 * `chord` is what shipped originally: the median of a context window either
 * side of a scan region, interpolated straight across in log-frequency. It has
 * one confirmed structural fault — it reads spectral CURVATURE as a hump, so a
 * notch or a steep roll-off anywhere near a region tips the anchors and invents
 * a correction on the far side of it. That is the failure that started this
 * whole investigation.
 *
 * `trend` replaces it with a robust local quadratic and changes NOTHING else:
 * the region tables, directions, thresholds, caps, SCALE, iteration and merge
 * are exactly as they were. One variable, which is what made the comparison
 * readable.
 *
 * WHY IT WON, and on which evidence. The synthetic corpus rates it WORSE
 * (detection 67%→63%, recovery 0.50→0.44) because v1's thresholds were
 * calibrated against chord deviations and the trend is a tighter reference. The
 * real corpus — 13 commercially mastered files, 31 windows, where the right
 * answer is very nearly "no correction" — reverses that comprehensively:
 *
 *   invented bands        89 → 48          invented gain   289.4 → 132.0 dB
 *   windows left alone     1 →  5 of 31    bands on F0         1 → 0
 *   convergence residual 0.11 → 0.00       risky boosts        0 → 0
 *
 * It costs 0.11 bands per file in repeatability (0.78 → 0.89 that fail to
 * recur across windows of one file), which is the one measure where the chord
 * is ahead. Convergence is the strongest single signal: applying the trend's
 * own corrections and re-analysing leaves it with NOTHING further to say, where
 * the chord still wants 11% of its original gain — a detector chasing structure
 * in its own reference never settles.
 *
 * Both readings rest on finished masters, so the claim is specifically "does
 * not damage good audio". Raw narrator recordings remain unvalidated.
 *
 *
 * THRESHOLD CALIBRATION — an open question, not yet a default.
 *
 * Every per-region detection threshold in regions.js was tuned against CHORD
 * deviations, and the chord systematically over-reads: a convex spectrum sits
 * above its own chord whether or not anything is wrong with it, so the number a
 * threshold was chosen to clear was always the real defect PLUS a curvature
 * bias. The trend removes the bias, which means the same thresholds are now too
 * high by roughly however much bias they were absorbing.
 *
 * That is measurable, and it lines up with what listening reported — the chord
 * catching real defects the trend walks past, while cutting harder than the
 * defect warranted. On the clip that started this investigation the trend
 * measures a genuine boxy resonance at 2.46 dB against a 2.5 dB threshold: a
 * miss by four hundredths of a decibel, on a defect a person can hear.
 *
 * Scaling every threshold by 0.80 on the 58-case corpus beats BOTH shipping
 * detectors on every axis at once:
 *
 *                        detection   recovery   invented bands   invented gain
 *   chord                     67%       0.50               24         79.4 dB
 *   trend, x1.00              63%       0.44                5         19.8 dB
 *   trend, x0.80              70%       0.58                7         27.1 dB
 *
 * Convergence stays at 0 and risky boosts stay at 0. Below 0.75 it collapses
 * (x0.60 gives 41 invented bands), so 0.80 is a knee rather than a slope.
 *
 * It is NOT the default, for one reason: that table is the synthetic corpus,
 * which has now been wrong about the real-audio ranking three times. Lowering a
 * detection threshold necessarily increases what gets offered on finished audio
 * that needs nothing, and the size of that increase has not been measured where
 * it matters. Run `npm run scorecard:real` against a corpus of finished masters
 * before promoting this. Until then it is reachable, so it can be heard.
 */

/**
 * Region table with every detection threshold scaled.
 *
 * Copies rather than mutating: the tables in regions.js are module-level
 * objects shared by the plot, the role clamps and both detectors, so scaling
 * them in place would silently change what every other caller sees.
 */
function scaleThresholds(regions, scale) {
  if (!(scale > 0) || scale === 1) return regions
  const out = {}
  for (const [name, row] of Object.entries(regions)) {
    const copy = [...row]
    copy[THRESHOLD_DB] = row[THRESHOLD_DB] * scale
    out[name] = copy
  }
  return out
}

// ── Constants, all from corrective_eq.py:41-53 ──────────────────────────────

export const FRAME_SIZE = 2048
export const HOP_SIZE = 512
export const N_FFT = 4096
export const MIN_VOICED_FRAMES = 50
/**
 * Upper bound on frames fed to the cepstral mean. Beyond this the frames are
 * strided evenly across the selection rather than every window being analysed,
 * so a long selection does not drive tens of thousands of transforms on the
 * main thread.
 */
export const MAX_ANALYSIS_FRAMES = 2000
export const CONTEXT_OCTAVES = 0.4
export const MERGE_OCTAVES = 0.33

/**
 * How many measure-correct-measure rounds one analysis runs.
 *
 * Three settles everything the per-region caps allow: an uncapped region is
 * within 0.3^2 = 9% of its deviation after two, and a capped one reaches its
 * cap in three from any starting deviation. A fourth would only ever re-confirm
 * a total that is already pinned.
 */
export const MAX_CORRECTION_PASSES = 3

/**
 * How far a region's total correction may exceed what one pass may spend.
 *
 * There are two caps and they answer different questions. `MAX_CUT_DB` /
 * `MAX_BOOST_DB` bound a single decision — how much one measurement is trusted
 * to move the file — and iterating must not turn that into three times the
 * licence. But holding the TOTAL to the per-pass figure would make iterating
 * pointless: a 12 dB hump in mud spends its whole 6 dB budget on pass one and
 * still leaves 6 dB standing, so the total has to be allowed past 6 or nothing
 * has changed.
 *
 * Two is not a taste call. It is where repeated manual analysis already lands:
 * re-running the analysis on corrected audio hands each round a fresh budget,
 * and a 12 dB hump settles at 6.0 + 4.2 = 10.2 dB over two rounds. This factor
 * lets one analysis reach the same place the user was reaching by hand, and no
 * further. Deviations past about 14 dB stop short of resolved and stay flagged,
 * which is the right answer: at that size the measurement is as likely to be
 * wrong as the voice is to be that broken, and a 15 dB surgical cut taken on
 * trust is the worse mistake.
 */
export const MAX_TOTAL_CAP_FACTOR = 2
const NATS_TO_DB = 10.0 / Math.LN10

/**
 * Frame energy above the noise floor required to consider a frame voiced.
 *
 * Not in the Python — it stands in for the part of Silero's judgement that the
 * correlation ratio does not cover. A quiet pitched artefact (a hum tail, a
 * chair creak with a periodic component) passes MIN_CORR_RATIO happily; the
 * floor is what keeps it out of the envelope average.
 */
const VOICED_ENERGY_MARGIN_DB = 8.0

/** Same 10th-percentile floor estimate the corpus path in referenceEQ uses. */
const NOISE_FLOOR_PERCENTILE = 10

/**
 * How far below the envelope's peak a region may sit before it is treated as
 * having no content at all.
 *
 * NOT IN THE PYTHON, and it fixes a real failure the server shares. A file that
 * has been brick-walled — anything that has been through a low-bitrate MP3, or
 * recorded on a device that rolls off at 10 kHz — has literally nothing above
 * the cutoff. The cepstral envelope up there is built from the log of numerical
 * noise, and a dip detector reads that as an enormous deficiency and asks for a
 * boost. Boosting a dead band raises hiss and nothing else, which is the exact
 * opposite of what the user asked for.
 *
 * 60 dB is chosen from measurement, not taste. On a source whose harmonics stop
 * at 9 kHz, the highest region with real content sits about 42 dB below the
 * envelope peak while the dead region above it sits about 92 dB below. Anything
 * in that gap separates them; 60 dB is far enough above the real content to
 * never suppress a legitimate air correction, and far enough below the dead
 * band to always catch it.
 */
const DEAD_REGION_DB = 60

/**
 * Steepest local slope, in dB per octave, into which a correction may be made.
 *
 * A dip detector cannot tell "this band is deficient" from "this file's
 * bandwidth ends here", and the second is common: any lowpass, any codec, any
 * modest microphone. `air` is a fixed 9-16 kHz band scanned for dips with a
 * boost cap, so on a file whose content stops at 11 kHz it finds the roll-off,
 * calls it a deficiency, and lifts it — which is bandwidth extension performed
 * by accident, and all it raises is hiss. On the real corpus this was six
 * boosts of +6.0 dB at 14.8-16 kHz, every one pinned at twice its cap.
 *
 * The guard is a slope test because the separation is enormous. Measured on the
 * reproduced cases:
 *
 *   bandwidth edge at 14 kHz, false boost     -56 dB/octave
 *   bandwidth edge at 11 kHz, false boost     -59
 *   bandwidth edge at  9 kHz, false boost     -62
 *   planted -6 dB deficiency at 9 kHz, real    -6
 *   planted -6 dB deficiency at 5 kHz, real    -5
 *   clean voice, no defect                     -9
 *
 * Nothing sits between -9 and -56, so the threshold's exact value inside that
 * gap does not matter. 25 dB/octave is chosen as comfortably beyond anything a
 * vocal tract produces: a spectrum falling that fast over half an octave is a
 * filter, not a voice.
 *
 * Tested on the MAGNITUDE of the slope, so the same rule catches the mirror
 * case at the bottom — boosting into a high-pass roll-off, which every ACX
 * master carries — without a second constant.
 *
 * CUTS ARE GUARDED TOO, which was not the first instinct. The reasoning for
 * exempting them — attenuating something already attenuated is pointless but
 * harmless — is wrong twice over. A cut on the shoulder of a roll-off removes
 * the last of a file's real top end, and more fundamentally the test is about
 * whether the DETECTION is valid: a feature sitting on a filter slope is a
 * filter artefact whichever direction the correction would point. Measured,
 * extending it to cuts takes the bandwidth family to zero invented bands with
 * detection rate unchanged, so it costs nothing.
 */
const MAX_CORRECTION_SLOPE_DB_PER_OCT = 25

/** Span over which that slope is measured, in octaves. */
const CORRECTION_SLOPE_SPAN_OCTAVES = 0.5

/**
 * Local slope of the envelope at `hz`, in dB per octave.
 *
 * Measured across a span rather than between adjacent bins: a two-bin
 * difference on a cepstrally smoothed curve is dominated by the smoothing, and
 * what this needs to know is the gross direction of travel.
 */
function envelopeSlopeDbPerOctave(freqsHz, envelopeDb, hz, sampleRate) {
  const half = Math.pow(2, CORRECTION_SLOPE_SPAN_OCTAVES / 2)
  const lo = hz / half
  const hi = Math.min(hz * half, sampleRate / 2 - 100)
  if (!(hi > lo)) return 0

  const step = freqsHz[1] - freqsHz[0]
  const at = (f) => {
    const k = Math.min(envelopeDb.length - 1, Math.max(0, Math.round(f / step)))
    return envelopeDb[k]
  }
  return (at(hi) - at(lo)) / Math.log2(hi / lo)
}

/**
 * Fraction of frames that must be pitched before the material counts as speech
 * at all.
 *
 * This separates the two failure messages, which send the user to do different
 * things: "too short, select more" versus "this isn't speech, use General mode".
 * Testing for *zero* pitched frames looks like the obvious way to tell them
 * apart and is wrong — the correlation gate will find a periodic component in a
 * handful of noise frames by chance, and one lucky frame in two seconds of
 * traffic rumble would tell the user to select a longer stretch of it.
 *
 * Real speech with pauses runs 40-60% pitched; noise and room tone sit near
 * zero. A tenth is nowhere near either.
 */
const MIN_VOICED_RATIO = 0.1

/**
 * Energy gate for voiced-frame selection.
 *
 * The naive form — `p10 + margin` — is what the whole-file paths use, and it is
 * right there because a whole file always contains pauses, so its 10th
 * percentile really is room tone. A *selection* need not: the user can hand us
 * four seconds of unbroken speech, where p10 is simply the quietest speech and
 * a gate 8 dB above it throws away most of the material it was meant to keep.
 *
 * So the gate is also held below the top decile. Read as one sentence: gate 8 dB
 * above the floor, but never so high that it eats into the loudest tenth of the
 * material. When there are pauses the first term wins and this behaves exactly
 * like the whole-file version; as the dynamic range narrows the second term
 * takes over continuously, and on perfectly uniform material the gate ends up
 * below every frame and disables itself. No discontinuity, no threshold to tune.
 */
function voicedGateDb(energiesDb) {
  const floor = percentile(energiesDb, NOISE_FLOOR_PERCENTILE)
  const loud = percentile(energiesDb, 90)
  return Math.min(floor + VOICED_ENERGY_MARGIN_DB, loud - VOICED_ENERGY_MARGIN_DB)
}

// ── Small numeric helpers ───────────────────────────────────────────────────

/** Linear-interpolated percentile, matching NumPy and correctiveEQ.js:79. */
export function percentile(values, p) {
  if (!values || values.length === 0) return 0
  const sorted = Float64Array.from(values).sort()
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function median(values) {
  return percentile(values, 50)
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Symmetric Hann, matching `np.hanning`.
 *
 * NOT dsp/stft.js's `hannPeriodic`, which is scipy's `fftbins=True` variant with
 * a different denominator. The difference is one sample of period and it does
 * not matter much for a magnitude average — but the lifter below is built by
 * slicing a Hann in half, where an off-by-one in the taper shape would quietly
 * shift the envelope's smoothness, so both use the same definition the Python
 * does.
 */
/**
 * Floor for the log-power spectrum, as a fraction of the frame's loudest bin.
 *
 * This used to be an absolute `+ 1e-10`, which made the entire analysis depend
 * on how loud the file happened to be. Bins below the constant get flattened up
 * to it and bins above keep their value, so which side of it a bin falls on
 * moves when you apply gain — and the same recording, 6 dB louder, produces a
 * different envelope. The invariance check found it rather than reasoning did:
 * v2 dropped a 12.1 kHz band on a gated file when the input was lifted 6 dB.
 *
 * Measured on a gated synthetic, doubling the input moved envelope bins by
 * anywhere from 6.02 to 10.3 dB where every bin should have moved by exactly
 * 6.02. The error peaks in a narrow band of levels — those where the quietest
 * bins straddle the constant — which is why attenuating a case by 20, 40 and 60
 * dB failed to reproduce it, and why it survived this long.
 *
 * 120 dB below the frame's own peak scales with the signal, so the pipeline
 * becomes exactly scale-invariant, and it sits far enough down to leave any
 * well-conditioned frame's spectrum untouched.
 */
const LOG_POWER_FLOOR_RATIO = 1e-12

/**
 * Log power spectrum with a relative floor. Writes `bins` values into `out`.
 *
 * Shared by both detectors deliberately: they had separate copies of the same
 * absolute epsilon, and a scale-dependence bug fixed in one copy is a bug still
 * shipping in the other.
 */
export function logPowerSpectrum(re, im, out, bins) {
  let maxPower = 0
  for (let k = 0; k < bins; k++) {
    const p = re[k] * re[k] + im[k] * im[k]
    out[k] = p
    if (p > maxPower) maxPower = p
  }
  // Digital silence has no scale of its own, so there is no relative floor to
  // apply. A flat spectrum is the only scale-invariant answer available.
  if (maxPower === 0) {
    out.fill(0, 0, bins)
    return
  }
  const floor = maxPower * LOG_POWER_FLOOR_RATIO
  for (let k = 0; k < bins; k++) out[k] = Math.log(out[k] + floor)
}

export function hannSymmetric(size) {
  const w = new Float64Array(size)
  if (size === 1) {
    w[0] = 1
    return w
  }
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
  }
  return w
}

// ── Step 0 — voiced frame collection ────────────────────────────────────────

/**
 * Collect FRAME_SIZE windows at HOP_SIZE that are pitched and above the floor.
 *
 * Returns the frames plus the per-frame F0 estimates, which the caller needs
 * for voice classification and the lifter cutoff.
 *
 * @param {Float32Array} audio mono
 * @param {number} sampleRate
 */
export function collectVoicedFrames(audio, sampleRate) {
  const starts = []
  for (let s = 0; s + FRAME_SIZE <= audio.length; s += HOP_SIZE) starts.push(s)
  if (starts.length === 0) {
    return { frames: [], f0Values: [], noiseFloorDb: -Infinity, totalFrames: 0 }
  }

  // Frame energies first: the floor is a property of the whole selection, so it
  // has to exist before any frame can be judged against it.
  const energiesDb = new Float64Array(starts.length)
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]
    let sumSq = 0
    for (let j = 0; j < FRAME_SIZE; j++) {
      const x = audio[s + j]
      sumSq += x * x
    }
    energiesDb[i] = 20 * Math.log10(Math.sqrt(sumSq / FRAME_SIZE) + 1e-10)
  }
  const noiseFloorDb = percentile(energiesDb, NOISE_FLOOR_PERCENTILE)
  const gateDb = voicedGateDb(energiesDb)

  const tracker = new F0Tracker({ sampleRate, frameSize: FRAME_SIZE })
  const voicedStarts = []
  const f0Values = []
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]
    const frame = audio.subarray(s, s + FRAME_SIZE)
    const { f0, pitched } = tracker.estimate(frame, energiesDb[i] > gateDb)
    if (pitched && f0 > 0) {
      voicedStarts.push(s)
      f0Values.push(f0)
    }
  }

  // Stride evenly rather than truncating, so the mean envelope still samples
  // the whole selection instead of only its opening.
  let selected = voicedStarts
  let selectedF0 = f0Values
  if (voicedStarts.length > MAX_ANALYSIS_FRAMES) {
    selected = []
    selectedF0 = []
    for (let k = 0; k < MAX_ANALYSIS_FRAMES; k++) {
      const i = Math.round((k * (voicedStarts.length - 1)) / (MAX_ANALYSIS_FRAMES - 1))
      selected.push(voicedStarts[i])
      selectedF0.push(f0Values[i])
    }
  }

  return {
    frames: selected.map(s => audio.subarray(s, s + FRAME_SIZE)),
    // F0 percentiles are taken over every voiced frame, not the strided subset:
    // they are cheap to keep and more stable for it.
    f0Values,
    strideF0Values: selectedF0,
    noiseFloorDb,
    totalFrames: starts.length,
  }
}

// ── Step 1 — cepstral spectral envelope ─────────────────────────────────────

/**
 * Build the tapered lifter.
 *
 * Keeps the LOW quefrencies — the smooth formant envelope — and fades to zero
 * approaching the cutoff, which is where harmonic structure lives. The Python
 * carries a note that the spec's reference snippet applies this taper in the
 * inverted direction; this follows the Python, which follows the stated intent.
 */
function buildLifter(lifterCutoff) {
  const tl = Math.max(1, Math.min(lifterCutoff, N_FFT >>> 1))
  const full = hannSymmetric(2 * tl)
  const half = full.subarray(tl) // falling half, length tl
  let peak = 0
  for (let i = 0; i < half.length; i++) if (half[i] > peak) peak = half[i]
  const norm = peak > 0 ? 1 / peak : 1

  const lifter = new Float64Array(N_FFT)
  for (let i = 0; i < tl; i++) {
    const v = half[i] * norm
    lifter[i] = v                    // positive quefrencies 0..tl
    lifter[N_FFT - tl + i] = half[tl - 1 - i] * norm // mirrored negatives
  }
  return { lifter, tl }
}

/**
 * Mean cepstral spectral envelope in dB across voiced frames.
 *
 * @returns {{ freqsHz: Float64Array, envelopeDb: Float64Array, lifterCutoff: number }}
 */
export function computeCepstralEnvelope(frames, sampleRate, f0P5Hz) {
  const lifterCutoff = Math.trunc((0.85 / f0P5Hz) * sampleRate)
  const { lifter } = buildLifter(lifterCutoff)

  const bins = rfftBinCount(N_FFT)
  const fft = getFFT(N_FFT)
  const window = hannSymmetric(FRAME_SIZE)

  const padded = new Float64Array(N_FFT)
  const specRe = new Float64Array(bins)
  const specIm = new Float64Array(bins)
  const logPower = new Float64Array(bins)
  const cepstrum = new Float64Array(N_FFT)
  const envRe = new Float64Array(bins)
  const envIm = new Float64Array(bins)
  const envelopeSum = new Float64Array(bins)

  for (const frame of frames) {
    padded.fill(0)
    const n = Math.min(frame.length, FRAME_SIZE)
    for (let i = 0; i < n; i++) padded[i] = frame[i] * window[i]

    fft.rfft(padded, specRe, specIm)
    logPowerSpectrum(specRe, specIm, logPower, bins)

    // Real half-spectrum -> real symmetric cepstrum. irfft's null imaginary
    // argument is exactly this case; see the note in dsp/fft.js.
    fft.irfft(logPower, null, cepstrum)
    for (let i = 0; i < N_FFT; i++) cepstrum[i] *= lifter[i]

    fft.rfft(cepstrum, envRe, envIm)
    for (let k = 0; k < bins; k++) envelopeSum[k] += envRe[k]
  }

  const envelopeDb = new Float64Array(bins)
  const scale = NATS_TO_DB / frames.length
  for (let k = 0; k < bins; k++) envelopeDb[k] = envelopeSum[k] * scale

  const freqsHz = new Float64Array(bins)
  for (let k = 0; k < bins; k++) freqsHz[k] = (k * sampleRate) / N_FFT

  return { freqsHz, envelopeDb, lifterCutoff }
}

// ── Step 2 — baseline estimation (edge anchoring) ───────────────────────────

/**
 * How far a context window may be widened while hunting for clean bins.
 *
 * A notch sitting in a context window is repaired by looking further out for
 * spectrum that is not in the notch, and the limit is how far "further out" can
 * go before the anchor stops describing the region's neighbourhood at all. At
 * 1.2 octaves the search can step clear of a hole of the width the detector is
 * built to find (WINDOW_OCTAVES either side of its floor) while still landing
 * within about an octave of the scan edge.
 *
 * Past that the anchor would be reporting a different part of the voice — the
 * point of edge anchoring is locality, and an anchor two octaves away has none.
 * When the search runs out, the region falls back to the flat-baseline path,
 * which is the same answer the dead-anchor case already gets and for the same
 * reason: only one side can be seen, so read against a level reference rather
 * than inventing a slope.
 */
export const MAX_CONTEXT_OCTAVES = 1.2

/** Widening step. Fine enough to stop just past a hole's edge rather than well past it. */
const CONTEXT_STEP_OCTAVES = 0.1

/**
 * Bins a WIDENED context window must find before it is worth stopping at.
 *
 * Only ever consulted while repairing. A window that lost bins is being
 * re-cast somewhere it was not designed for, so it has to justify where it
 * stopped; one bin of clean spectrum just past the edge of a notch is a
 * coincidence, not a level.
 */
const MIN_REPAIRED_CONTEXT_BINS = 3

/**
 * One anchor: the median level of usable spectrum on one side of the region.
 *
 * WIDENING IS A REPAIR AND ONLY A REPAIR. When every bin in the ordinary
 * CONTEXT_OCTAVES window is usable, that window IS the anchor, however few bins
 * it holds — which keeps this identical to the previous behaviour on any file
 * with no hole and no dead band. That is not a courtesy to the old code. At
 * 48 kHz with N_FFT of 4096 the bins are 11.7 Hz apart, so sub_bass's low
 * context (45.5-60 Hz) contains exactly two of them, and a rule that widened
 * whenever a window held fewer than three would reach down into DC rumble on
 * every file ever analysed, to fix a problem none of them have.
 *
 * Only once exclusions have actually removed something does the window widen,
 * stepping outward until it finds MIN_REPAIRED_CONTEXT_BINS of clean spectrum.
 * Returns null when even the widest window cannot — the honest answer when that
 * whole side of the region is notch or silence.
 */
function anchorLevel(freqsHz, envelopeDb, edgeHz, below, floorDb, holes) {
  for (let ext = CONTEXT_OCTAVES; ext <= MAX_CONTEXT_OCTAVES + 1e-9; ext += CONTEXT_STEP_OCTAVES) {
    const lo = below ? edgeHz / Math.pow(2, ext) : edgeHz
    const hi = below ? edgeHz : edgeHz * Math.pow(2, ext)
    const vals = []
    let excluded = 0
    for (let k = 0; k < freqsHz.length; k++) {
      const f = freqsHz[k]
      if (below ? !(f >= lo && f < hi) : !(f > lo && f <= hi)) continue
      if (envelopeDb[k] < floorDb || inAnyHole(holes, f)) {
        excluded++
        continue
      }
      vals.push(envelopeDb[k])
    }
    // Intact on the first look: this is the window the region was designed
    // around, and there is nothing to repair.
    if (ext === CONTEXT_OCTAVES && excluded === 0) {
      return vals.length > 0 ? median(vals) : null
    }
    if (vals.length >= MIN_REPAIRED_CONTEXT_BINS) return median(vals)
  }
  return null
}

/**
 * Expected level across a scan region, anchored to the spectrum just outside it
 * on both sides and interpolated in log-frequency.
 *
 * This is the "reference" — derived from the file, a fifth of an octave of
 * context on either side. An anomaly is a departure from its own neighbourhood.
 *
 * `floorDb` guards the anchors themselves. A region can have perfectly good
 * content while the context window above it falls off the end of the file's
 * bandwidth — brilliance (5-9 kHz) on a source that stops at 9 kHz is exactly
 * that case. The upper anchor then lands in numerical noise, the baseline
 * plunges across the region, and the deviation soars at the top of the scan
 * range: a large, confident, entirely fictitious detection. When one anchor is
 * dead the other is used for both ends, which reads the region against a flat
 * reference — the honest reading when only one side can be seen.
 *
 * `holes` guards the anchors against the same failure by a different cause. A
 * notch does not make a context window dead, it makes it LOW, which the floor
 * test cannot see and which tips the chord exactly as far as the notch is deep.
 * Hole bins are therefore excluded from the anchor medians and the window
 * widens outward past them; see anchorLevel and holes.js. A hole in the
 * context window is far more common than a dead one — it is what any previously
 * applied surgical EQ cut leaves behind.
 *
 * `usable` marks the scan bins that may be searched for an anomaly. The arrays
 * stay complete so that a caller plotting them draws the region as measured,
 * with no gap where the mask bites; only the search honours it.
 *
 * @returns {{ scanFreqs, scanEnv, baseline, usable, flatBaseline }|null}
 */
export function estimateBaseline(
  freqsHz, envelopeDb, scanLowHz, scanHighHz, floorDb = -Infinity, holes = [], trendAt = null,
) {
  if (trendAt) return trendBaseline(freqsHz, envelopeDb, scanLowHz, scanHighHz, floorDb, holes, trendAt)

  const ctxLoLow = scanLowHz / Math.pow(2, CONTEXT_OCTAVES)
  const ctxHiHigh = scanHighHz * Math.pow(2, CONTEXT_OCTAVES)

  let lowBins = 0
  let highBins = 0
  const scanIdx = []
  for (let k = 0; k < freqsHz.length; k++) {
    const f = freqsHz[k]
    if (f >= ctxLoLow && f < scanLowHz) lowBins++
    else if (f > scanHighHz && f <= ctxHiHigh) highBins++
    if (f >= scanLowHz && f <= scanHighHz) scanIdx.push(k)
  }
  // A context window with no bins AT ALL is off the end of the spectrum, and
  // that is a different failure from one whose bins are unusable. The flat
  // baseline below is a reading of a region against the one side that CAN be
  // seen; where a side is not merely obscured but absent — the file's Nyquist
  // sits inside the context window — there is no spectrum there to have an
  // opinion about, and the region is not assessable at all.
  if (lowBins === 0 || highBins === 0 || scanIdx.length < 2) return null

  let anchorLow = anchorLevel(freqsHz, envelopeDb, scanLowHz, true, floorDb, holes)
  let anchorHigh = anchorLevel(freqsHz, envelopeDb, scanHighHz, false, floorDb, holes)

  const lowDead = anchorLow === null
  const highDead = anchorHigh === null
  if (lowDead && highDead) return null
  if (lowDead) anchorLow = anchorHigh
  if (highDead) anchorHigh = anchorLow

  const logLo = Math.log2(scanLowHz)
  const logHi = Math.log2(scanHighHz)
  const span = logHi - logLo

  const scanFreqs = new Float64Array(scanIdx.length)
  const scanEnv = new Float64Array(scanIdx.length)
  const baseline = new Float64Array(scanIdx.length)
  const usable = new Uint8Array(scanIdx.length)
  for (let i = 0; i < scanIdx.length; i++) {
    const k = scanIdx[i]
    scanFreqs[i] = freqsHz[k]
    scanEnv[i] = envelopeDb[k]
    // np.interp clamps outside the two anchor points; inside, it is linear.
    const t = span > 0 ? clamp((Math.log2(freqsHz[k] + 1e-10) - logLo) / span, 0, 1) : 0
    baseline[i] = anchorLow + (anchorHigh - anchorLow) * t
    usable[i] = envelopeDb[k] >= floorDb && !inAnyHole(holes, freqsHz[k]) ? 1 : 0
  }
  return { scanFreqs, scanEnv, baseline, usable, flatBaseline: lowDead || highDead }
}

/**
 * The same region measurement, referenced to a trend instead of a chord.
 *
 * There are no anchors here and therefore none of the anchor machinery — no
 * context windows to be empty, no widening, no flat-baseline fallback. A local
 * fit is defined wherever there is spectrum around the point, which is the
 * whole reason it cannot be tipped by a notch sitting in one window.
 *
 * `usable` and the hole exclusion are kept identical to the chord path so the
 * comparison isolates the baseline and nothing else.
 */
function trendBaseline(freqsHz, envelopeDb, scanLowHz, scanHighHz, floorDb, holes, trendAt) {
  const scanIdx = []
  for (let k = 0; k < freqsHz.length; k++) {
    const f = freqsHz[k]
    if (f >= scanLowHz && f <= scanHighHz) scanIdx.push(k)
  }
  if (scanIdx.length < 2) return null

  const scanFreqs = new Float64Array(scanIdx.length)
  const scanEnv = new Float64Array(scanIdx.length)
  const baseline = new Float64Array(scanIdx.length)
  const usable = new Uint8Array(scanIdx.length)
  for (let i = 0; i < scanIdx.length; i++) {
    const k = scanIdx[i]
    scanFreqs[i] = freqsHz[k]
    scanEnv[i] = envelopeDb[k]
    baseline[i] = trendAt(freqsHz[k])
    usable[i] = envelopeDb[k] >= floorDb && !inAnyHole(holes, freqsHz[k]) ? 1 : 0
  }
  return { scanFreqs, scanEnv, baseline, usable, flatBaseline: false }
}

/**
 * Build a trend lookup over the whole envelope.
 *
 * Masked by v1's own dead-region rule rather than by v2's measured-SNR mask.
 * The real corpus showed that mask reading 100% live on 31/31 windows — inert —
 * so bringing it along would import a component that does nothing while
 * pretending the experiment tested it.
 */
export function makeTrendLookup(freqsHz, envelopeDb, floorDb, sampleRate) {
  const loHz = Math.max(20, freqsHz[1])
  const hiHz = Math.min(sampleRate / 2 - 1, freqsHz[freqsHz.length - 1])
  const grid = toLogGrid(freqsHz, envelopeDb, loHz, hiHz)

  const mask = new Uint8Array(grid.n)
  for (let i = 0; i < grid.n; i++) mask[i] = grid.db[i] >= floorDb ? 1 : 0

  const { trend } = robustTrend(grid.db, mask, grid.n)
  const logLo = Math.log2(loHz)
  const perOctave = 1 / (Math.log2(grid.hz[1] / grid.hz[0]))

  return (hz) => {
    const x = (Math.log2(Math.max(hz, loHz)) - logLo) * perOctave
    const i = Math.min(grid.n - 2, Math.max(0, Math.floor(x)))
    const t = Math.min(1, Math.max(0, x - i))
    return trend[i] * (1 - t) + trend[i + 1] * t
  }
}

// ── Step 3 — deviation detection ────────────────────────────────────────────

/**
 * Detect a hump or a dip. `peakDeviationDb` is always populated, detected or
 * not — the display uses it to show how close a region came to the threshold.
 *
 * `usable` optionally masks bins out of the search. Bins inside a spectral hole
 * are not the voice, and both halves of this function have to honour that, not
 * just the peak search: a width measured across a notch would hand the band a Q
 * derived from the shape of an old EQ cut rather than the shape of the
 * resonance being corrected.
 */
export function detectAnomaly(scanFreqs, scanEnv, baseline, thresholdDb, direction, usable = null) {
  const ok = i => !usable || usable[i]
  const sign = direction === 'dip' ? -1 : 1
  let peak = -Infinity
  let peakIdx = -1
  for (let i = 0; i < scanFreqs.length; i++) {
    if (!ok(i)) continue
    const d = sign * (scanEnv[i] - baseline[i])
    if (d > peak) {
      peak = d
      peakIdx = i
    }
  }

  const result = { peakDeviationDb: peak, detected: false }
  if (peakIdx === -1 || peak < thresholdDb) return result

  // Half-power width of the excursion, in octaves — the measurement that gives
  // the band its Q instead of a hand-picked constant.
  let first = -1
  let last = -1
  let count = 0
  for (let i = 0; i < scanFreqs.length; i++) {
    if (!ok(i)) continue
    if (sign * (scanEnv[i] - baseline[i]) >= peak / 2) {
      if (first === -1) first = i
      last = i
      count++
    }
  }
  const widthOctaves = count >= 2 ? Math.log2(scanFreqs[last] / scanFreqs[first]) : 0.33

  return {
    peakDeviationDb: peak,
    detected: true,
    centerHz: scanFreqs[peakIdx],
    deviationDb: sign * peak,
    widthOctaves,
  }
}

// ── Step 4 — band parameters ────────────────────────────────────────────────

/** Q from the half-power bandwidth of a peaking filter. */
export function qFromWidth(widthOctaves) {
  if (widthOctaves > 0) {
    const q = 1 / (2 * Math.sinh((Math.LN2 / 2) * widthOctaves))
    return clamp(q, 0.8, 8.0)
  }
  return 3.0
}

/** Gain opposes the deviation, scaled back and capped by the region's limits. */
export function computeBandParams(
  centerHz, deviationDb, widthOctaves, scalingFactor, maxBoostDb, maxCutDb,
) {
  const gainDb = clamp(-deviationDb * scalingFactor, -maxCutDb, maxBoostDb)
  return {
    freqHz: round(centerHz, 1),
    gainDb: round(gainDb, 2),
    q: round(qFromWidth(widthOctaves), 2),
  }
}

function round(v, places) {
  const f = Math.pow(10, places)
  return Math.round(v * f) / f
}

// ── Step 5 — band merging ───────────────────────────────────────────────────

function bandEdges(centerHz, widthOctaves) {
  const half = widthOctaves / 2
  return [centerHz / Math.pow(2, half), centerHz * Math.pow(2, half)]
}

function combine(b1, b2) {
  const center = Math.sqrt(b1.centerHz * b2.centerHz)

  // A region constrains only the direction it corrects and stores 0 for the
  // other. Ignore those zeros when combining, or merging a boost-only band with
  // a cut-only band would clamp the net correction to zero. The all-zero
  // direction can never be the net direction, so the fallback cannot wrongly
  // clamp a real correction.
  const cuts = [b1.cutLimit, b2.cutLimit].filter(v => v > 0)
  const boosts = [b1.boostLimit, b2.boostLimit].filter(v => v > 0)
  const cutLim = cuts.length ? Math.min(...cuts) : 0
  const boostLim = boosts.length ? Math.min(...boosts) : 0

  const [lo1, hi1] = bandEdges(b1.centerHz, b1.widthOctaves)
  const [lo2, hi2] = bandEdges(b2.centerHz, b2.widthOctaves)
  const width = Math.log2(Math.max(hi1, hi2) / Math.min(lo1, lo2))

  return {
    region: `${b1.region}+${b2.region}`,
    centerHz: center,
    gainDb: round(clamp(b1.gainDb + b2.gainDb, -cutLim, boostLim), 2),
    q: round(qFromWidth(width), 2),
    widthOctaves: width,
    cutLimit: cutLim,
    boostLimit: boostLim,
  }
}

/**
 * Merge bands whose centres are within 1/3 octave, iterating to a fixed point.
 * Two adjacent regions catching the same physical resonance would otherwise
 * correct it twice.
 */
export function mergeBands(input) {
  let bands = input
  let mergeCount = 0
  let changed = true
  while (changed && bands.length > 1) {
    changed = false
    outer:
    for (let i = 0; i < bands.length; i++) {
      for (let j = i + 1; j < bands.length; j++) {
        const d = Math.abs(Math.log2(bands[i].centerHz) - Math.log2(bands[j].centerHz))
        if (d < MERGE_OCTAVES) {
          const merged = combine(bands[i], bands[j])
          bands = bands.filter((_, k) => k !== i && k !== j).concat([merged])
          mergeCount++
          changed = true
          break outer
        }
      }
    }
  }
  return { bands, mergeCount }
}

// ── Correction passes ───────────────────────────────────────────────────────

/**
 * One measurement sweep over all nine regions.
 *
 * Split out of analyzeVoiceRx so it can be run more than once, against
 * successively corrected envelopes — see iterateCorrections for why once is
 * not enough.
 *
 * `envelopePeakDb` is a parameter rather than recomputed here on purpose: the
 * dead-region test asks whether the SOURCE has content in a region, which is a
 * property of the recording and must not drift as corrections are applied.
 */
export function scanRegions(
  freqsHz, envelopeDb, regions, envelopePeakDb, holes = [], trendAt = null, sampleRate = 44100,
) {
  const regionResults = []
  const detected = []

  for (const name of REGION_ORDER) {
    const region = regions[name]
    const role = roleForRegion(name)
    const entry = {
      name,
      roleId: role?.id ?? null,
      scanLowHz: region[SCAN_LOW],
      scanHighHz: region[SCAN_HIGH],
      direction: region[DIRECTION],
      thresholdDb: region[THRESHOLD_DB],
      detected: false,
    }

    // A region mostly inside a notch is unassessable, and saying so is the
    // whole point. Repairing anchors rescues a region that NEIGHBOURS a hole;
    // a region that largely IS the hole has neither clean content to measure
    // nor a clean neighbourhood to measure it against, and any number produced
    // here would describe an old EQ move rather than this voice.
    const coverage = holeCoverage(holes, region[SCAN_LOW], region[SCAN_HIGH])
    if (coverage > MAX_HOLE_COVERAGE) {
      entry.skipReason = 'spectral_hole'
      entry.holeCoverage = round(coverage, 3)
      regionResults.push(entry)
      continue
    }
    if (coverage > 0) entry.holeCoverage = round(coverage, 3)

    const base = estimateBaseline(
      freqsHz, envelopeDb, region[SCAN_LOW], region[SCAN_HIGH],
      envelopePeakDb - DEAD_REGION_DB, holes, trendAt,
    )
    if (!base) {
      entry.skipReason = 'context window unavailable'
      regionResults.push(entry)
      continue
    }
    entry.flatBaseline = base.flatBaseline

    // A region with no content cannot be assessed, and must not be drawn — a
    // deviation curve computed from numerical noise is not a measurement.
    const regionLevelDb = median(base.scanEnv)
    if (regionLevelDb < envelopePeakDb - DEAD_REGION_DB) {
      entry.skipReason = 'no_energy'
      entry.regionLevelDb = round(regionLevelDb, 2)
      regionResults.push(entry)
      continue
    }

    // Every bin masked out, without the coverage test having caught it — a
    // region can sit under the coverage limit and still have nothing left to
    // search once dead bins are excluded as well as hole bins. Detection on an
    // empty set has no peak to return, so it is stopped here rather than
    // allowed to report a deviation of -Infinity.
    let usableBins = 0
    for (let i = 0; i < base.usable.length; i++) usableBins += base.usable[i]
    if (usableBins === 0) {
      entry.skipReason = coverage > 0 ? 'spectral_hole' : 'no_energy'
      regionResults.push(entry)
      continue
    }

    entry.scanFreqs = base.scanFreqs
    entry.scanEnv = base.scanEnv
    entry.baseline = base.baseline

    const det = detectAnomaly(
      base.scanFreqs, base.scanEnv, base.baseline,
      region[THRESHOLD_DB], region[DIRECTION], base.usable,
    )
    entry.peakDeviationDb = round(det.peakDeviationDb, 2)
    if (!det.detected) {
      regionResults.push(entry)
      continue
    }

    const params = computeBandParams(
      det.centerHz, det.deviationDb, det.widthOctaves,
      region[SCALE], region[MAX_BOOST_DB], region[MAX_CUT_DB],
    )

    // A correction sitting on a filter slope is describing the filter, not the
    // voice. See MAX_CORRECTION_SLOPE_DB_PER_OCT.
    if (params.gainDb !== 0) {
      const slope = envelopeSlopeDbPerOctave(freqsHz, envelopeDb, params.freqHz, sampleRate)
      if (Math.abs(slope) > MAX_CORRECTION_SLOPE_DB_PER_OCT) {
        entry.skipReason = 'bandwidth_edge'
        entry.slopeDbPerOctave = round(slope, 1)
        regionResults.push(entry)
        continue
      }
    }

    Object.assign(entry, {
      detected: true,
      centerHz: params.freqHz,
      deviationDb: round(det.deviationDb, 2),
      gainDb: params.gainDb,
      q: params.q,
      widthOctaves: round(det.widthOctaves, 2),
    })
    regionResults.push(entry)

    // A gain clipped below the perception floor is treated as no correction.
    if (Math.abs(params.gainDb) < 0.1) continue

    detected.push({
      region: name,
      centerHz: params.freqHz,
      gainDb: params.gainDb,
      q: params.q,
      widthOctaves: det.widthOctaves,
      cutLimit: region[MAX_CUT_DB],
      boostLimit: region[MAX_BOOST_DB],
    })
  }

  return { regionResults, detected }
}

/**
 * The filter VoiceRx will actually build for a region.
 *
 * Shelves at the ends, bells everywhere else — the client's own shapes, not the
 * server's all-peaking set (see the ROLES table). Predicting the correction
 * with the wrong shape would mispredict exactly the two regions whose reach is
 * unbounded on one side.
 */
function sectionForRegion(sampleRate, region, centerHz, q, gainDb) {
  switch (roleForRegion(region)?.type) {
    case 'lowshelf': return lowShelf(sampleRate, centerHz, q, gainDb)
    case 'highshelf': return highShelf(sampleRate, centerHz, q, gainDb)
    default: return peaking(sampleRate, centerHz, q, gainDb)
  }
}

/**
 * The envelope as it will read once these corrections are applied.
 *
 * Analytic, not re-measured: the corrections are biquads whose magnitude
 * response is known exactly, so predicting their effect is one add per bin. No
 * audio is re-rendered and no second FFT runs, which is what makes iterating
 * affordable at all.
 */
export function correctedEnvelope(sampleRate, freqsHz, envelopeDb, corrections) {
  if (corrections.length === 0) return envelopeDb
  // Design and evaluate at the rate the EQ cascade actually runs at. These
  // sections are a prediction of a filter the VoiceRx cascade will apply, and
  // that cascade is oversampled — modelling it at the file's rate would predict
  // a cramped response while an uncramped one ran. The gap is worst in `air`
  // (9-16 kHz), which is precisely where the correction loop needs to know
  // whether it has done enough.
  const designRate = eqDesignRate(sampleRate)
  const sections = corrections.map(c =>
    sectionForRegion(designRate, c.region, c.centerHz, c.q, c.gainDb))
  const responseDb = magnitudeResponseDb(sections, freqsHz, designRate)

  const out = new Float64Array(envelopeDb.length)
  for (let k = 0; k < out.length; k++) out[k] = envelopeDb[k] + responseDb[k]
  return out
}

/**
 * Measure, correct, and measure again — up to MAX_CORRECTION_PASSES.
 *
 * WHY ONE PASS IS NOT ENOUGH. Two things stop a single sweep from settling the
 * file, and both are deliberate features of the detector rather than faults:
 *
 *  1. `SCALE` applies 0.70 of the measured deviation (0.60 for upper_presence),
 *     so 30% is left standing by construction. Whenever the original deviation
 *     was more than about 3.3x a region's threshold, that remainder is itself
 *     over threshold and the region reports again the moment anyone looks.
 *  2. Baselines are anchored in the neighbours. CONTEXT_OCTAVES is 0.4 and the
 *     scan ranges abut, so Boxiness's lower anchor (288-380 Hz for a male
 *     voice) lies inside Mud's scan range, and Mud's upper anchor lies inside
 *     Boxiness's. Correcting one region moves its neighbour's reference, which
 *     can raise a deviation that was under threshold before. The target moves;
 *     this is not something a bigger single correction could have anticipated.
 *
 * On the server neither shows, because correctiveEQ runs exactly once in a
 * preset chain and nothing ever re-measures. VoiceRx is the first place a human
 * can analyse twice, which is how the residue became visible.
 *
 * WHAT BOUNDS IT. Each pass's increment is clamped to the region's per-pass cap
 * and the running total to MAX_TOTAL_CAP_FACTOR times that, so three passes
 * cannot spend 3x6 dB on Mud. The total cap is also what stops the neighbour
 * coupling above from ratcheting two adjacent regions against each other, and
 * it is why the loop is safe without a convergence proof. Where and how wide
 * come from the pass that first detected a region; later passes only revise how
 * much, so a correction never wanders off the anomaly it was measured from.
 */
export function iterateCorrections(
  sampleRate, freqsHz, envelopeDb, regions, envelopePeakDb, holes = [], useTrend = false,
) {
  // The reference is rebuilt on each pass's corrected envelope, exactly as the
  // chord's anchors are re-measured — a baseline that stayed frozen while the
  // audio under it moved would stop describing the thing being scanned.
  const trendFor = env => (useTrend
    ? makeTrendLookup(freqsHz, env, envelopePeakDb - DEAD_REGION_DB, sampleRate)
    : null)

  const first = scanRegions(
    freqsHz, envelopeDb, regions, envelopePeakDb, holes, trendFor(envelopeDb), sampleRate,
  )
  const totals = new Map()
  let passes = 0

  for (let pass = 1; pass <= MAX_CORRECTION_PASSES; pass++) {
    let scan = first
    if (pass > 1) {
      const corrected = correctedEnvelope(
        sampleRate, freqsHz, envelopeDb, [...totals.values()],
      )
      scan = scanRegions(
        freqsHz,
        corrected,
        regions,
        envelopePeakDb,
        // Holes are a property of the SOURCE, like envelopePeakDb, and are
        // measured once from the dry envelope. Re-detecting them against a
        // corrected one would let a cut this loop just applied register as a
        // hole on the next pass and start masking out the very region it is
        // working on.
        holes,
        trendFor(corrected),
        sampleRate,
      )
    }
    if (scan.detected.length === 0) break

    let moved = false
    for (const d of scan.detected) {
      const prev = totals.get(d.region)
      if (!prev) {
        // The stored limits are the TOTAL ones from here on. Each pass's own
        // increment was already clamped to the per-pass cap inside
        // computeBandParams; what these bound is the sum, and they are what the
        // merge step will later clamp a combined band against.
        totals.set(d.region, {
          ...d,
          cutLimit: d.cutLimit * MAX_TOTAL_CAP_FACTOR,
          boostLimit: d.boostLimit * MAX_TOTAL_CAP_FACTOR,
          detectedOnPass: pass,
        })
        moved = true
        continue
      }
      const next = round(clamp(prev.gainDb + d.gainDb, -prev.cutLimit, prev.boostLimit), 2)
      if (Math.abs(next - prev.gainDb) >= 0.01) moved = true
      prev.gainDb = next
    }
    // Every region pinned at its total cap: further passes would re-measure the
    // same envelope and add nothing.
    if (!moved) break
    // Counted only where a pass changed the correction, so `passes` reads as
    // work done rather than loops entered — the round that finds nothing left
    // is how the loop ends, not a round that did something.
    passes = pass
  }

  // The curves on screen are drawn against the dry envelope, so the display
  // keeps the first pass's measurement — its scanEnv, baseline and deviation
  // are what the user's own recording reads, and a later pass's numbers would
  // describe a curve that is not the one plotted. Only the correction itself is
  // updated to the accumulated total, so the marker and the finding agree with
  // what is actually being applied.
  const regionResults = first.regionResults
  for (const entry of regionResults) {
    const total = totals.get(entry.name)
    if (!total) continue
    entry.detected = true
    entry.centerHz = total.centerHz
    entry.gainDb = total.gainDb
    entry.q = total.q
    entry.widthOctaves = round(total.widthOctaves, 2)
    entry.detectedOnPass = total.detectedOnPass
  }

  // Low frequency first. mergeBands compares every pair so it does not need the
  // order, but it names a merged band after its first contributor and the UI
  // reads that name as the primary one — which only holds while the list runs
  // upward. A region first detected on a later pass would otherwise land at the
  // end and rename any merge it took part in.
  const detected = [...totals.values()].sort((a, b) => a.centerHz - b.centerHz)

  return { regionResults, detected, passes }
}

// ── Main analysis ───────────────────────────────────────────────────────────

/**
 * Run the full VoiceRx analysis over a mono selection.
 *
 * Returns `{ ok: false, reason }` rather than a curve whenever the material
 * cannot support one. Never returns a partial result: a deviation curve drawn
 * from four voiced frames is noise wearing a diagnosis's clothes, and the
 * display has no way to say so once it is on screen.
 *
 * @param {Float32Array} audio mono, 32-bit float
 * @param {number} sampleRate
 * @param {{baseline?: 'chord'|'trend', thresholdScale?: number}} [options] see
 *   the BASELINE STRATEGY and THRESHOLD CALIBRATION notes at the top of this
 *   file. `trend` ships; `chord` is the superseded baseline, retained so the
 *   scorecards can still measure what changing it did.
 */
export function analyzeVoiceRx(
  audio, sampleRate, { baseline = 'trend', thresholdScale = 1 } = {},
) {
  const collected = collectVoicedFrames(audio, sampleRate)
  const { frames, f0Values, noiseFloorDb, totalFrames } = collected

  if (frames.length < MIN_VOICED_FRAMES) {
    const voicedRatio = totalFrames > 0 ? f0Values.length / totalFrames : 0
    return {
      ok: false,
      reason: voicedRatio < MIN_VOICED_RATIO ? 'no_voiced_frames' : 'insufficient_voiced',
      voicedFrames: frames.length,
      voicedRatio,
      requiredFrames: MIN_VOICED_FRAMES,
    }
  }

  const medianF0Hz = median(f0Values)
  const p5 = percentile(f0Values, 5)
  const f0P5Hz = p5 > 0 ? p5 : medianF0Hz

  const { voiceType, regions: nominalRegions } = classifyVoice(medianF0Hz)
  const regions = scaleThresholds(nominalRegions, thresholdScale)
  const { freqsHz, envelopeDb, lifterCutoff } = computeCepstralEnvelope(
    frames, sampleRate, f0P5Hz,
  )

  // Reference level for the dead-region test. Taken over the band where speech
  // actually lives, so a rumble-heavy file does not raise the bar for everything
  // above it.
  let envelopePeakDb = -Infinity
  for (let k = 0; k < freqsHz.length; k++) {
    if (freqsHz[k] >= 100 && freqsHz[k] <= 16000) {
      envelopePeakDb = Math.max(envelopePeakDb, envelopeDb[k])
    }
  }

  // Holes are found before any region is scanned, because a hole is a fact
  // about the file that several regions have to agree on. Detecting one
  // per-region would let the same notch be judged differently by the region
  // above it and the region below it, which is exactly the disagreement that
  // produced a matched pair of phantom cuts in the first place.
  const holes = detectSpectralHoles(
    freqsHz, envelopeDb, envelopePeakDb - DEAD_REGION_DB,
    REGION_SPAN_HZ[0], Math.min(REGION_SPAN_HZ[1], sampleRate / 2),
  )

  const { regionResults, detected, passes } = iterateCorrections(
    sampleRate, freqsHz, envelopeDb, regions, envelopePeakDb, holes, baseline === 'trend',
  )

  const { bands: merged, mergeCount } = mergeBands(detected)
  const bands = merged
    .filter(b => Math.abs(b.gainDb) >= 0.1)
    .sort((a, b) => a.centerHz - b.centerHz)
    .map(b => ({
      region: b.region,
      // A merged band spans two regions and belongs to neither; the role is the
      // first contributor's, which is the one the low-frequency-first ordering
      // makes the user read as primary.
      roleId: roleForRegion(b.region.split('+')[0])?.id ?? null,
      freqHz: round(b.centerHz, 1),
      gainDb: round(b.gainDb, 2),
      q: round(b.q, 2),
      widthOctaves: b.widthOctaves,
    }))

  return {
    ok: true,
    voiceType,
    regions,
    medianF0Hz: round(medianF0Hz, 2),
    f0P5Hz: round(f0P5Hz, 2),
    noiseFloorDb: round(noiseFloorDb, 2),
    voicedFrames: frames.length,
    lifterCutoffSamples: lifterCutoff,
    freqsHz,
    envelopeDb,
    regionResults,
    bands,
    /**
     * Notches in the source, low to high. Usually empty; a non-empty list is a
     * finding in its own right, and the reason any region carrying
     * `skipReason: 'spectral_hole'` went unread.
     */
    holes,
    baseline,
    thresholdScale,
    mergedBands: mergeCount,
    /** How many measure-correct rounds it took to settle. See iterateCorrections. */
    passes,
  }
}
