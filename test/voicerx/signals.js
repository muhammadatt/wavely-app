/**
 * Synthetic voices with known defects — the ground truth the scorecard scores
 * against.
 *
 * WHY SYNTHESIS AND NOT RECORDINGS. The question a corrective EQ has to answer
 * is "what is wrong with this voice", and on a real recording nobody knows the
 * answer — which is exactly why VoiceRx's region tables were never validated.
 * Take a voice that is right, apply a defect you chose, and the correct output
 * is no longer a matter of opinion: it is the inverse of what you applied.
 *
 * WHAT THIS CANNOT SETTLE. Planting a biquad and asking a detector to invert a
 * biquad tests invertibility, not taste. A room that sounds boxy is not
 * literally a peaking filter, and no score here says whether a correction
 * sounds better. What it does catch, and catch cheaply, is the class of failure
 * that has actually bitten: corrections invented on clean input, defects missed
 * entirely, and recovery that varies with frequency for no reason. Those are
 * not matters of opinion either.
 *
 * ADDITIVE, NOT FILTERED. The voice is summed sinusoids whose amplitudes come
 * from evaluating the formant transfer function at each harmonic, rather than a
 * harmonic stack pushed through biquads. No filter state means no transients at
 * vowel boundaries, and no risk of the generator's own artefacts being scored as
 * detector findings. Defects ARE applied as real biquads, because a defect is
 * the thing being recovered and it should be exactly what it claims to be.
 *
 * Deterministic throughout. Same case name, same samples, every run.
 */

import { peaking, BiquadCascade } from '../../src/audio/dsp/biquad.js'

export const SR = 44100

/**
 * Formant frequencies and bandwidths for five vowels, male voice, in Hz.
 *
 * WHY VOWELS AND NOT ONE FIXED SHAPE. A single formant set gives a spectrum
 * with three fixed 15 dB peaks in it, and a resonance detector looking at the
 * mean envelope would be right to call those resonances — they are. Real speech
 * moves its formants constantly, so averaging over a passage smears them into
 * something far flatter, and it is that smeared average VoiceRx measures.
 *
 * Getting this wrong in either direction ruins the corpus. A flat synthetic
 * makes every detector look clean because there is nothing to mistake for a
 * defect; a static-formant synthetic makes every detector look broken because
 * the voice really does have a 15 dB peak at F1. Cycling vowels is what puts
 * the clean control where a real narrator sits.
 *
 * THE HIGHER SERIES IS NOT OPTIONAL PADDING. A vocal tract has poles all the
 * way up, spaced by roughly c/2L — about 1 kHz for an adult male — and
 * truncating the series after F5 makes the spectrum fall off a cliff above it:
 * five resonators' skirts together roll off as f^-10, which put the synthetic
 * voice 50 dB down by 4 kHz and left everything above that as pure noise floor.
 * A detector scored on that corpus would be graded almost entirely on how it
 * handles silence in the top three octaves. Continuing the series past the top
 * of the scanned range is what puts the long-term average spectrum where a real
 * one sits: falling steadily above 1 kHz, still live at 10 kHz.
 *
 * Bandwidths widen with frequency, as real formants do — higher poles are more
 * heavily damped, which is why the top of a voice reads as a smooth slope
 * rather than as a row of peaks.
 *
 * A HIGHER FORMANT THAT NEVER MOVES IS A DEFECT IN THE CORPUS. The first
 * version of this fixed F4 at 3500 Hz with a 150 Hz bandwidth for every vowel —
 * a Q of 23 that sits in the same place for the entire file. That is a textbook
 * resonance, the analysis found it in every single case and asked for a 9 dB
 * cut, and it was right to: the synthetic voice really did have a sharp fixed
 * peak at 3.5 kHz. Every detector scored on that corpus would have been marked
 * down for correctly finding a defect the generator planted by accident.
 *
 * So the higher poles are jittered per vowel and damped hard. Real ones move
 * with articulation like the low ones do, and are wide enough that the average
 * over a passage is a slope rather than a row of spikes.
 *
 * The series runs past 16 kHz on purpose. Where it stops, the summed skirts
 * roll off on their own at about 18 dB per octave, and that natural edge must
 * fall OUTSIDE the range VoiceRx scans — `air` reaches 16 kHz, so a series
 * ending at 12.5 kHz puts a synthetic cliff inside the top region and every
 * detector would be scored on a deficiency the generator invented.
 */
const HIGH_FORMANTS = {
  f: [3500, 4500, 5600, 6700, 7800, 8900, 10000, 11200, 12500, 13800, 15200, 16800],
  b: [280, 320, 380, 440, 500, 560, 640, 720, 800, 880, 960, 1050],
}

/**
 * Extra tilt applied per formant by its centre frequency, dB per octave.
 *
 * With equal-amplitude parallel formants the spectrum follows the source alone,
 * which came out at -6 dB/octave and stayed too bright: the model sat only
 * 20 dB below peak at 8 kHz where a real long-term average is 35-45 dB down.
 * Parallel synthesisers carry a per-formant amplitude for exactly this reason
 * (Klatt's A1..An), and a -4 dB/octave trend across the series lands the whole
 * spectrum near -10 dB/octave, inside the measured range for speech.
 */
const FORMANT_TILT_DB_PER_OCT = -4

/**
 * Bandwidths are conversational, not citation-form. A vowel read carefully in a
 * phonetics lab has a 60 Hz F1; the same vowel inside running speech is wider
 * and shorter, which is what a narrator actually produces and what makes a
 * long-term average smooth.
 *
 * F3 IS THE SAME TRAP AS F4, ONE FORMANT DOWN. Textbook F3 values for these
 * vowels sit between 2240 and 2600 Hz — six of seven inside a fifth of an
 * octave — and averaged over a passage that is a persistent 3.3 dB peak at
 * 2.42 kHz. The v1 detector never noticed, so the corpus looked clean; the v2
 * detector found it immediately, with high confidence and near-perfect
 * split-half stability, because it is really there. A corpus is only as clean
 * as the most sensitive detector that has looked at it, and grading a better
 * detector on this one would have marked it down for being right.
 *
 * So F3 is spread across the range male F3 actually occupies, 2200-3100 Hz, and
 * damped a little harder. The vowels stay recognisable; the long-term average
 * stops having a formant baked into it.
 */
const VOWELS = [
  { f: [730, 1090, 2300], b: [90, 110, 170] }, // "ah"
  { f: [530, 1840, 2750], b: [90, 110, 170] }, // "eh"
  { f: [270, 2290, 3080], b: [90, 110, 170] }, // "ee"
  { f: [570, 840, 2480], b: [90, 110, 170] },  // "oh"
  { f: [300, 870, 2210], b: [90, 110, 170] },  // "oo"
  { f: [620, 1300, 2920], b: [90, 110, 170] }, // "uh" — fills the F2 gap
  { f: [400, 1600, 2620], b: [90, 110, 170] }, // "ih" — fills the F2 gap
].map((v, i) => ({
  // Deterministic per-vowel jitter, so the higher series smears in the mean
  // instead of stacking into a fixed peak.
  f: [...v.f, ...HIGH_FORMANTS.f.map((f, j) => f * (1 + 0.09 * Math.sin(i * 2.4 + j * 1.7)))],
  b: [...v.b, ...HIGH_FORMANTS.b],
}))

/** Deterministic noise (mulberry32), matching the generator in the dsp tests. */
function noise(n, seed) {
  const out = new Float64Array(n)
  let s = seed | 0
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    out[i] = ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1)
  }
  return out
}

/** White noise shaped to roughly -3 dB/octave (Paul Kellet's economy filter). */
function pinkNoise(n, seed) {
  const white = noise(n, seed)
  const out = new Float64Array(n)
  let b0 = 0, b1 = 0, b2 = 0
  for (let i = 0; i < n; i++) {
    const w = white[i]
    b0 = 0.99765 * b0 + w * 0.0990460
    b1 = 0.96300 * b1 + w * 0.2965164
    b2 = 0.57000 * b2 + w * 1.0526913
    out[i] = b0 + b1 + b2 + w * 0.1848
  }
  return out
}

/**
 * Magnitude of one two-pole resonator at `hz`.
 *
 * The standard second-order form, where Q is the formant's centre frequency
 * over its bandwidth — so a 730 Hz formant 60 Hz wide peaks about 22 dB above
 * the skirt, which is what a vowel actually does.
 */
function resonatorMag(hz, centreHz, bandwidthHz) {
  const r = hz / centreHz
  const q = centreHz / bandwidthHz
  const real = 1 - r * r
  const imag = r / q
  return 1 / Math.sqrt(real * real + imag * imag)
}

/**
 * Combined formant magnitude for one vowel, in dB — PARALLEL, not cascade.
 *
 * Multiplying the resonators together is the textbook picture of a vocal tract
 * and it is wrong to use here. Each normalised resonator falls as (Fc/f)^2 above
 * its centre, so with twelve of them the skirts compound: the synthetic voice
 * rolled off at 10-14 dB per octave above 1 kHz where a real long-term average
 * falls 6-9, and by 8 kHz it was 14 dB too quiet. Klatt-style synthesisers fix
 * this with an explicit higher-pole correction; summing the resonators instead
 * gets there directly, because then the overall tilt is whatever the source
 * imposes and each formant contributes a peak rather than a permanent tax on
 * everything above it.
 *
 * Summing magnitudes rather than complex responses ignores inter-formant phase.
 * That is deliberate: the target is a realistic magnitude SPECTRUM, which is the
 * only thing a cepstral envelope measures, and phase-correct summation would
 * introduce nulls between formants that a real tract does not have.
 */
function vowelMagDb(hz, vowel) {
  let mag = 0
  for (let i = 0; i < vowel.f.length; i++) {
    const tilt = Math.pow(10, (FORMANT_TILT_DB_PER_OCT * Math.log2(vowel.f[i] / vowel.f[0])) / 20)
    mag += tilt * resonatorMag(hz, vowel.f[i], vowel.b[i])
  }
  return 20 * Math.log10(mag + 1e-12)
}

/**
 * Glottal source plus lip radiation, in dB.
 *
 * Flat below the glottal corner and -6 dB/octave above it, which is the
 * standard approximation: a -12 dB/octave source through a +6 dB/octave
 * radiation load. With parallel formants carrying no net tilt of their own,
 * this is what sets the spectrum's slope.
 */
function sourceDb(hz) {
  const corner = 300
  return hz <= corner ? 0 : -6 * Math.log2(hz / corner)
}

/**
 * Amplitude taper at the top of the file's bandwidth.
 *
 * A hard cutoff is a brick wall and no real chain produces one; a codec or an
 * anti-alias filter rolls off over a fraction of an octave. The taper width is
 * a parameter because how sharply the band ends is exactly what the
 * bandwidth-edge cases are probing.
 */
function bandwidthTaperDb(hz, edgeHz, taperOctaves) {
  if (hz <= edgeHz) return 0
  const octavesPast = Math.log2(hz / edgeHz)
  // 90 dB over the taper width, then flat — steep enough to read as an edge,
  // smooth enough not to be a discontinuity.
  return -Math.min(90, (octavesPast / taperOctaves) * 90)
}

/**
 * A clean voice: cycling vowels over a drifting fundamental, with pauses.
 *
 * @param {object} opts
 * @param {number} opts.f0Hz median fundamental
 * @param {number} opts.seconds duration
 * @param {number} opts.bandwidthHz where the spectrum starts to roll off
 * @param {number} opts.taperOctaves how sharply it rolls off there
 * @param {number} opts.snrDb broadband speech-to-noise, or Infinity for none
 * @param {number} opts.seed noise seed
 * @returns {Float32Array}
 */
export function cleanVoice({
  f0Hz = 120,
  seconds = 4,
  bandwidthHz = 18000,
  taperOctaves = 0.25,
  snrDb = 45,
  seed = 0x51ed270b,
  /**
   * Scales every formant. A shorter vocal tract resonates higher, so a female
   * voice sits roughly 15-20% above a male one — raising f0 alone would produce
   * a male spectrum sung high, which is exactly the case VoiceRx's female region
   * table exists to handle and therefore the wrong thing to test it with.
   */
  formantScale = 1,
} = {}) {
  const n = Math.round(SR * seconds)
  const out = new Float32Array(n)

  // Harmonics up to Nyquist. Amplitudes are recomputed per block rather than
  // per sample: the vowel envelope moves far slower than the waveform, and a
  // 256-sample block is a small fraction of the shortest vowel here.
  const BLOCK = 256
  const VOWEL_SECONDS = 0.22
  const vowels = formantScale === 1
    ? VOWELS
    : VOWELS.map(v => ({ f: v.f.map(f => f * formantScale), b: v.b.map(b => b * formantScale) }))
  const maxHarmonic = Math.floor((SR / 2 - 100) / f0Hz)
  const phase = new Float64Array(maxHarmonic + 1)

  for (let start = 0; start < n; start += BLOCK) {
    const end = Math.min(n, start + BLOCK)
    const t = start / SR

    // Pauses: 0.15 s of silence every 0.75 s, so the frame-energy floor and the
    // voiced-frame gate both have something real to find.
    const speaking = (t % 0.75) <= 0.6

    // Vowels cross-fade rather than switch, and the fundamental drifts a little.
    // A dead-steady f0 makes the autocorrelation tracker look better than it is.
    const vowelPos = t / VOWEL_SECONDS
    const vi = Math.floor(vowelPos) % vowels.length
    const vj = (vi + 1) % vowels.length
    const blend = smoothstep(vowelPos - Math.floor(vowelPos))
    const f0 = f0Hz * (1 + 0.04 * Math.sin(2 * Math.PI * 0.37 * t))

    for (let k = 1; k <= maxHarmonic; k++) {
      const hz = k * f0
      if (hz >= SR / 2) break

      let db = sourceDb(hz)
      db += vowelMagDb(hz, vowels[vi]) * (1 - blend) + vowelMagDb(hz, vowels[vj]) * blend
      db += bandwidthTaperDb(hz, bandwidthHz, taperOctaves)
      const amp = speaking ? Math.pow(10, db / 20) : 0

      const step = (2 * Math.PI * hz) / SR
      let ph = phase[k]
      if (amp > 1e-6) {
        for (let i = start; i < end; i++) {
          out[i] += amp * Math.sin(ph)
          ph += step
        }
      } else {
        ph += step * (end - start)
      }
      phase[k] = ph % (2 * Math.PI)
    }
  }

  normalise(out, 0.32)

  if (Number.isFinite(snrDb)) {
    // PINK, not white. Room tone, preamp hiss and traffic rumble all fall with
    // frequency; white noise at a realistic broadband SNR puts more energy above
    // 5 kHz than the voice has up there, so the top two octaves of the corpus
    // become noise and every detector gets graded on how it handles hiss rather
    // than on how it handles a voice.
    const speechRms = rmsOfLoudPart(out)
    const nz = pinkNoise(n, seed)
    const noiseRms = speechRms * Math.pow(10, -snrDb / 20)
    let sq = 0
    for (let i = 0; i < n; i++) sq += nz[i] * nz[i]
    const g = noiseRms / Math.sqrt(sq / n)
    for (let i = 0; i < n; i++) out[i] += nz[i] * g
  }

  return out
}

function smoothstep(x) {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

function normalise(buf, target) {
  let peak = 0
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]))
  if (peak <= 0) return
  const g = target / peak
  for (let i = 0; i < buf.length; i++) buf[i] *= g
}

/** RMS of the speaking portion only — pauses would drag a whole-file RMS down. */
function rmsOfLoudPart(buf) {
  const frames = []
  const N = 1024
  for (let s = 0; s + N <= buf.length; s += N) {
    let sq = 0
    for (let i = 0; i < N; i++) sq += buf[s + i] ** 2
    frames.push(Math.sqrt(sq / N))
  }
  frames.sort((a, b) => b - a)
  const top = frames.slice(0, Math.max(1, Math.round(frames.length * 0.25)))
  return top.reduce((a, b) => a + b, 0) / top.length
}

/**
 * Apply a known defect. This is the ground truth: the correct response is a
 * band at `freqHz` with gain `-gainDb`.
 *
 * A real biquad, not an amplitude adjustment in the generator, so the defect
 * present in the file is exactly the one named and a detector that recovers it
 * has recovered something real.
 */
export function applyDefect(audio, { freqHz, gainDb, q = 3.0 }) {
  const out = Float32Array.from(audio)
  const c = new BiquadCascade(1, 1)
  c.setSection(0, peaking(SR, freqHz, q, gainDb, 'q'))
  c.process(out, out, out.length, 0)
  return out
}

/**
 * Build a case's audio.
 *
 * Two lists, because a case can contain something that was done to the audio
 * without there being a correct correction for it. `defects` are scored for
 * recovery — the right answer is a band at the inverse gain. `applied` is
 * applied identically but expects NO band: a 20 dB notch is a hole, and the
 * right response is to say so rather than to spend 20 dB of boost trying to
 * fill it. Keeping them in separate lists is what lets the scorer treat a band
 * near a notch as spurious while treating a band near a resonance as the point.
 */
export function renderCase(spec) {
  let audio = cleanVoice(spec.voice ?? {})
  for (const defect of [...(spec.defects ?? []), ...(spec.applied ?? [])]) {
    audio = applyDefect(audio, defect)
  }
  return audio
}
