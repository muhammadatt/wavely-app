/**
 * Resonance Suppressor — worklet kernel.
 *
 * A realtime port of the server's `resonanceSuppressor` stage
 * (server/scripts/resonance_suppressor.py). Soothe-style dynamic suppression:
 * per STFT frame, build a reference envelope that sits at the inter-harmonic
 * floor, treat whatever protrudes above it as a resonance, and duck it.
 *
 * This file is BOTH a normal ES module (exports ResonanceKernel and
 * processResonanceBuffer) AND an AudioWorklet module (registers
 * 'resonance-processor').
 *
 * THE ALGORITHM IS ALREADY CAUSAL. That is the whole reason this port is
 * possible without an analysis pass. Per frame:
 *
 *   1. magnitude in dB — of the channel mean on stereo, of the sole channel
 *      on mono
 *   2. cepstral lifter → reference envelope at the inter-harmonic floor, at a
 *      feature scale `sharpness` asks for and the measured F0 caps
 *   3. spike = magnitude − envelope, thresholded at `selectivity`, soft-kneed,
 *      scaled by the zone's `depth`, clipped to its `maxCut`
 *   4. harmonic-protected bins zeroed, Gaussian spread of constant width in
 *      OCTAVES, zeroed again, out-of-band zeroed
 *   5. per-bin attack/release IIR at the frame rate
 *   6. `mix` blends the resulting gain against unity and `trimDb` scales the
 *      wet side, both inside the per-bin gain rather than around the effect
 *   7. gain applied to every channel's complex spectrum, inverse FFT,
 *      overlap-add
 *
 * The 1394-line Python is mostly machinery this port does not need: multi-pass
 * chains, `sibilant_only` gating, band-summary reporting, and the pitch
 * transition detector (a ±5-frame lookahead that would cost another 58 ms of
 * latency and is outside the core parameter set).
 *
 * HARMONIC PROTECTION MATTERS WHEREVER THERE ARE HARMONICS. Cepstral liftering
 * puts the reference at the inter-harmonic floor, so the harmonics of a pitched
 * source protrude above it and read as resonances. Without the mask the
 * suppressor eats them — the server refuses to run the stage at all when
 * `preserve_harmonics` is on and no F0 is available. Here F0Tracker supplies a
 * per-frame pitch, which is what makes the mask possible live.
 *
 * THIS EFFECT IS NOT VOICE-ONLY. The server stage ran inside a voice mastering
 * chain and could assume speech; a realtime effect gets pointed at drums,
 * synths, guitars and room tone. Two consequences run through this file:
 *
 *   - Suppression is gated on signal presence, never on pitch. Unpitched
 *     material is exactly as valid an input as a narrator.
 *   - The pitch search range is a parameter (`pitchMinHz` / `pitchMaxHz`), not
 *     the server's hard-coded speech band. An out-of-range source does not fail
 *     quietly — the tracker returns an octave artefact with full confidence and
 *     the mask lands on bins that are not harmonics, which is worse than having
 *     no mask at all.
 *
 * THREE APPROXIMATIONS vs. the server, all consequences of streaming:
 *
 *   - Lifter cutoff comes from a rolling median pitch rather than the whole
 *     file's median.
 *   - Frame activity comes from an absolute energy floor in place of Silero
 *     labels. Silent frames get a zero target so the IIR decays through them.
 *   - The lifter cutoff is `min(sharpness target, 0.40 * sr / F0)` rather than
 *     the server's `0.40 * sr / F0` outright, and the spread kernel is a
 *     constant width in octaves rather than a constant count of bins. Both aim
 *     at the same defect: the server's constants make the detector's resolution
 *     a function of the speaker's pitch and of where on the frequency axis a
 *     defect happens to sit. `server/scripts/resonance_suppressor.py` still has
 *     the original geometry.
 *
 *     WHAT THAT ACTUALLY BOUGHT, RESTATED — the first version of this note
 *     claimed more than the measurement supports, because it was taken on a
 *     carrier whose harmonics stop at 6 kHz, so its top probe sat on the last
 *     harmonic rather than on the material. On a full-spectrum carrier, a broad
 *     +10 dB hump swept 500 Hz / 1.2 / 2.5 / 4 / 6.4 kHz:
 *
 *       old geometry   22.9  14.5   8.2   6.6   1.6   (spread 21.2 dB)
 *       this one       10.4  10.5   8.3   8.0   3.2   (spread  7.3 dB)
 *
 *     So: flat to within 2.5 dB across 500 Hz–4 kHz, which is the claim, and
 *     STILL FALLING ABOVE 4 kHz — 8.0 dB at 4 kHz against 3.2 at 6.4. The
 *     residue is the cepstral reference itself, whose own smoothing scale is
 *     uniform in Hz however the spread kernel is shaped, and which tracks the
 *     noise floor upward where the harmonics are weak. The spread kernel was
 *     the half of this that a spread kernel can fix.
 *
 *     THE PITCH COUPLING IS LIKEWISE ONLY HALF FIXED, and the half that
 *     remains is the larger one. Clamping the lifter removed the coupling
 *     through the cutoff; end to end, on one hump at 2.5 kHz with nothing
 *     changing but the carrier's pitch, removal still runs 0.10 dB at F0 90 to
 *     4.97 at F0 260 — a 50x spread, against 38x before the change. F0 90 and
 *     F0 150 now run an IDENTICAL cutoff and still differ 22x, so there is a
 *     second coupling, through how much protrudes above an inter-harmonic-floor
 *     reference as the comb thins. It is a property of where the reference
 *     sits, not of the cutoff, and no cutoff rule addresses it. See
 *     `test/dsp/resonancePitch.test.js`, which pins all of this.
 *   - `mix` and `trimDb` do not exist on the server, where the stage is one
 *     link in a chain that has its own gain staging. Here it is a plugin a
 *     person points at a selection, and suppression only ever removes energy.
 *   - The cepstral reference is computed over the full spectrum rather than the
 *     server's band-restricted variant. Band restriction exists for passes with
 *     a very small lifter cutoff (L≈3, the sibilant-only passes), where the
 *     kept coefficients collapse onto the band mean; at the cutoffs this
 *     parameter set produces (L≈150–300) it makes little difference, and the
 *     band-restricted transform length is not a power of two. Detection and
 *     reduction are still band-limited — only the reference differs, and only
 *     for frequency ranges much narrower than the default 40 Hz–20 kHz.
 */

import { StftProcessor } from './dsp/stft.js'
import { F0Tracker } from './dsp/f0.js'
import { getFFT } from './dsp/fft.js'
import {
  RESONANCE_DISPLAY_BINS,
  RESONANCE_DISPLAY_CURVES,
  DEFAULT_RESONANCE_ZONES,
  buildResonanceZoneCurves,
  resonanceDisplayRange,
} from './resonanceParams.js'
import { buildResonanceFocusCurves } from './resonanceFocus.js'

const FFT_SIZE = 2048
const HOP_SIZE = 512

/** Matches `eps` in resonance_suppressor.py's process(). */
const MAG_EPS = 1e-10

/**
 * Cepstral lifter cutoff used when no pitch has been measured, in quefrency
 * bins — the `else` branch of resonance_suppressor.py:346.
 *
 * This is a cutoff, NOT a pitch. An earlier version of this file seeded the
 * tracker with a 60 Hz *pitch* and ran it through `0.40 * sr / f0`, which
 * yields L = 294 rather than 60 — an envelope roughly five times finer than
 * intended. A fine envelope traces a resonance instead of passing under it, so
 * nothing protrudes and nothing is suppressed. On speech that only affected
 * warmup, because a real pitch arrives within a frame or two. On unpitched
 * material there is never a pitch, so the wrong cutoff was permanent and the
 * effect did essentially nothing (measured: 0.3 dB removed from a 13 dB
 * resonance in noise).
 */
const DEFAULT_LIFTER_CUTOFF = 60

/**
 * Envelope feature scale the lifter aims for, in Hz, at the two ends of the
 * Sharpness knob.
 *
 * THE LIFTER CUTOFF USED TO BE F0 AND NOTHING ELSE, and that made the
 * detector's spectral resolution a property of the speaker rather than of the
 * settings. `L = 0.40 * sr / F0` means the envelope can follow any feature
 * wider than `sr / L` Hz, so a 200 Hz voice got a 500 Hz envelope and a 100 Hz
 * voice a 250 Hz one — the deeper the voice, the finer the reference, the less
 * anything protrudes, the less the effect did. Measured on the same synthetic
 * resonance: nothing about the resonance changed, only the pitch of the carrier
 * under it, and the removal moved by several dB.
 *
 * Sharpness now sets an ABSOLUTE target scale and F0 only CLAMPS it. The clamp
 * is the part that is physics — an envelope finer than the harmonic spacing
 * starts tracing the comb instead of passing under it, which is the whole
 * reason the cutoff was tied to F0 in the first place — but there is no reason
 * the target has to sit exactly on that limit for every speaker.
 *
 * Calibrated so the default Sharpness of 0.8 lands on ~380 Hz, which is what
 * `0.40 * sr / F0` gave for a 150 Hz voice: the tuning pitch this parameter set
 * was chosen against is unmoved, deeper voices get the resolution they were
 * always supposed to have, and higher voices stay comb-limited as they must.
 */
const LIFTER_SCALE_COARSE_HZ = 2000
const LIFTER_SCALE_FINE_HZ = 250

/**
 * Peak-envelope reference — geometry.
 *
 * AN ALTERNATIVE TO THE CEPSTRAL REFERENCE, NOT A TUNING OF IT, and the reason
 * it exists is that three separate shortcomings and the harmonic mask all trace
 * back to one decision: cepstral liftering puts the reference at the
 * INTER-HARMONIC FLOOR. From down there every harmonic of a pitched source
 * protrudes and reads as a resonance, which is why the mask has to exist; the
 * reference's resolution is then tied to the comb, which is why detection
 * depends on the speaker's pitch; and its smoothing is uniform in Hz, which is
 * why detection falls away at the top of the spectrum.
 *
 * This reference is drawn THROUGH the harmonic peaks instead of under them:
 *
 *   1. a running MAXIMUM over one harmonic spacing — the envelope traced
 *      through the peaks. A harmonic sliding across bins does not move it, and
 *      the inter-harmonic floor never enters it.
 *   2. a wide log-frequency mean of that — the reference proper.
 *
 * Protrusion is then a comparison of two quantities that BOTH live on the
 * harmonic peaks, so the comb cancels out of it and a harmonic is not a
 * resonance by construction. Measured against the cepstral reference, with no
 * harmonic mask at all: it matches the mask's transparency to pitch movement on
 * both a vibrato and a phoneme-boundary step to three decimal places, cuts real
 * resonances on voiced material where the masked cepstral path cuts nothing,
 * does roughly a tenth the damage to a clean voice that the unmasked cepstral
 * path does, and does not regress unpitched material.
 *
 * NOT THE DEFAULT, AND THE FIRST REAL FILE SAYS IT SHOULD NOT BECOME ONE.
 * Every number above is synthetic. On 46 s of real narration (`npm run
 * reso:real`), with both configurations solved to the SAME 3 dB mean cut in
 * 100-400 Hz — which is the only fair comparison, since a config that cuts less
 * has fewer artefacts for free — the gain jitter goes the other way:
 *
 *                                slow pitch   fast pitch
 *     cepstral, protection off      0.90         1.25
 *     peak-envelope, no mask        1.23         1.77
 *
 * So on real speech this reference is 37% WORSE at the thing it was built to
 * fix, and its fast/slow ratio (1.44 against 1.39) says it chases pitch just as
 * much. The transparency it showed on synthetics — matching the mask to three
 * decimal places — does not survive contact with a voice. Eighth time a clean
 * corpus has been too clean to answer the question asked of it, and the first
 * time one has reversed a result outright rather than merely flattering it.
 *
 * TWO HYPOTHESES FOR THE GAP, BOTH TESTED, BOTH WRONG. It is not the pitch
 * estimate feeding the max filter: per-frame F0, rolling median, and a fixed
 * 300 or 500 Hz window all land within 1.19-1.30 dB of jitter. It is not the
 * calibration either — the numbers above are already solved to matched cut. The
 * remaining candidate is that real voiced speech simply is not a clean comb:
 * jitter, shimmer, breath and formant transitions mean the "harmonic peaks" the
 * max filter traces are themselves moving, so an envelope drawn through them is
 * not the stable thing a synthetic stack made it look like.
 *
 * The calibration was also 4-5x too hot. Selectivity 4 came from a synthetic
 * clean voice whose protrusion floor was 2.5-4.2 dB; real narration measures
 * p75 at 8.9 dB and p90 at 17.2 in the same band, so that threshold treated
 * well over a quarter of every time-frequency cell and removed 12 dB on
 * average. Reaching 3 dB needs selectivity ~17.
 *
 * `SPACING_CAP_BINS` bounds the max filter's cost; it binds only at
 * implausibly high pitches. `REF_FLOOR_FACTOR` is the one constant with a
 * derivation rather than a fit: the second-stage mean has to be much wider than
 * the max filter that feeds it, or it follows the resonance instead of passing
 * under it. Eight harmonic spacings clears that; at F0 150 it is the 1200 Hz
 * the prototype was measured at.
 */
const PEAK_SPACING_CAP_BINS = 64
/** Err wide on the max filter's window — see the note at its call site. */
const PEAK_SPACING_MARGIN = 1.25
const PEAK_REF_FLOOR_FACTOR = 8
/** Reference width in octaves at Sharpness 0 and 1 — the detection scale. */
const PEAK_REF_OCT_COARSE = 3.0
const PEAK_REF_OCT_FINE = 1.2
/**
 * Spacing assumed when no pitch has been measured.
 *
 * On unpitched material there is no comb for the max filter to step over, so
 * the stage degenerates to a mild local maximum and the reference is close to a
 * plain log-frequency smoothing. 150 Hz is what the prototype was measured with
 * and it did not regress noise; a cepstral fallback on unpitched frames is the
 * obvious alternative and is untested.
 */
const PEAK_FALLBACK_F0_HZ = 150

/**
 * KNOWN DEFECT: THIS REFERENCE OVER-CUTS BELOW THE FUNDAMENTAL. Measured, not
 * yet fixed.
 *
 * The max filter's window is `spacing * PEAK_SPACING_MARGIN` — about +-244 Hz
 * on a narrator at F0 195. Applied to a bin at 60-120 Hz that window reaches UP
 * ACROSS THE F0 STEP and imports the fundamental region's far higher level,
 * while the wide reference smoothing does not rise as fast. Bins below F0
 * therefore inherit a peak value they do not have, read as protruding, and get
 * cut. Measured on 46 s of narration, at the selectivity each reference needs
 * for the same 3 dB of mean cut:
 *
 *                    cepstral            peak
 *     60-120 Hz      3.4 dB / 3.5%     17.1 dB / 26.6%
 *    190-270 Hz     15.3 dB / 41.6%    18.1 dB / 32.0%
 *
 * (mean protrusion, and how often it clears its own threshold). Five times the
 * protrusion below F0 and it acts seven times as often, which comes out as a
 * broad 1.6-2.2 dB cut across 60-135 Hz that the cepstral reference does not
 * make at all. Reported by ear as "it removed more resonances", and it is not
 * removing resonances — it is thinning the low end.
 *
 * THE CEPSTRAL REFERENCE GETS THIS RIGHT FOR FREE: its envelope is a smooth
 * low-order fit that simply follows the falling spectrum below F0, so nothing
 * down there protrudes and it leaves the region alone without being told to.
 *
 * A fixed `freqFloorHz` of 160 removes the broad cut entirely and leaves the
 * 190-270 Hz resonance trench bit-identical (-2.61 / -3.09 / -4.01 either way),
 * but that is declining to process, not a repair, and 160 Hz is one narrator's
 * number. The principled fix is to stop the max window crossing the F0 step —
 * floor detection at the measured per-frame F0 — which tracks a speaker instead
 * of assuming one. Not done here because which reference ships is undecided.
 *
 * TWO WRONG READINGS ON THE WAY, and the second is the reusable one. I first
 * proposed this mechanism from theory and reached for the floor before testing
 * it. Then I checked peak's 60-120 Hz protrusion against PEAK'S OWN 190-270 Hz,
 * saw 17.1 against 18.1, and withdrew the hypothesis as unsupported. Both
 * numbers were right; the comparison was meaningless. The question was never
 * "is this band unusual for this reference" — it was "do the two references
 * disagree here", and against the other reference at the same frequencies the
 * gap is enormous. A within-condition comparison cannot answer a
 * between-condition question, and the fix appearing to work nearly let the
 * wrong explanation stand.
 */

/**
 * What the shipping configuration does to real narration, for the record.
 *
 * The same 46 s file, cepstral reference with the mask on, at its own default
 * selectivity of 8: it removes 0.09 dB in 100-400 Hz and 0.14 dB in 2-6 kHz.
 * The synthetic finding — that harmonic protection makes the effect inert on
 * pitched material — reproduces on a voice, on the material this product is
 * built for.
 *
 * Two further facts from that file worth having written down. Reaching 3 dB of
 * cut in the fundamental region with protection off needs selectivity 19, more
 * than twice the shipping default, so the default is not merely masked into
 * inertness — it is set below where it would do useful work either way. And the
 * pitch tracker reports 5% octave jumps and 14% jumps over a tritone between
 * consecutive voiced frames, which is the estimate BOTH the harmonic mask and
 * this reference are built on. Widening the search range does not help: p95
 * simply tracks whatever ceiling it is given (397 Hz at a 400 limit, 1189 at
 * 1200), which is the tracker returning the rail rather than a high voice, and
 * the wild-jump rate rises from 14% to 18%.
 */

/**
 * Spread half-width in OCTAVES at Sharpness 0, and the bin cap that bounds its
 * cost.
 *
 * The spread kernel used to be `30 * (1 - sharpness)` FFT BINS wide, which is a
 * constant width in Hz — ±129 bins-worth at the default, everywhere. That is
 * ±1.9 octaves at 60 Hz and ±0.02 octaves at 8 kHz: the same knob produced a
 * cut two orders of magnitude different in Q depending only on where on the
 * axis it landed. Every other tool in this category specifies this control as a
 * Q, and the ear hears it as one.
 *
 * 0.3 octaves is chosen so the default Sharpness of 0.8 gives ±6 bins at
 * 3 kHz — exactly what the linear kernel gave there. The mid band is unmoved;
 * the ends are what change, and they change toward being the same width in
 * octaves as the middle.
 *
 * The cap exists only so the widest setting cannot make the top of the spectrum
 * quadratically expensive. It binds above ~10 kHz at Sharpness 0 and nowhere at
 * the default.
 */
/**
 * The one fixed band limit left, in Hz.
 *
 * An ANALYSIS limit, not a taste. The adjustable low/high pair is gone — a band
 * you want left alone is a zone switched off — but below this a 2048-point
 * frame has under two bins to work with, so the envelope there is not a
 * measurement of anything. It replaces a default floor of 40 Hz that was doing
 * the same job under a name that implied it was a preference.
 */
const ANALYSIS_FLOOR_HZ = 20

const SPREAD_MAX_OCTAVES = 0.3
const SPREAD_MAX_HALF_BINS = 96

/** exp(-x²/2) sampled over 0..SPREAD_LUT_MAX sigma, so the hot loop has no exp. */
const SPREAD_LUT_MAX = 3.5
const SPREAD_LUT_SIZE = 512
const SPREAD_LUT = (() => {
  const lut = new Float64Array(SPREAD_LUT_SIZE + 1)
  for (let i = 0; i <= SPREAD_LUT_SIZE; i++) {
    const x = (i / SPREAD_LUT_SIZE) * SPREAD_LUT_MAX
    lut[i] = Math.exp(-0.5 * x * x)
  }
  return lut
})()

// Harmonic protection geometry — DEFAULT_PARAMS in resonance_suppressor.py.
const HARMONIC_WIDTH_BINS = 2
const HARMONIC_WIDTH_PCT = 0.01

/**
 * Safety bound on the harmonic walk.
 *
 * The server caps at a fixed 100 harmonics, which makes the protected band slide
 * with pitch — at 40 Hz it stops at 4 kHz and leaves everything above exposed,
 * at 220 Hz it runs past Nyquist. The walk now ends at `freqCeilHz` instead, so
 * the protected band is the band the user asked to process. This is only a guard
 * against a pathological pitch making the loop long.
 */
const MAX_HARMONIC = 4096

/**
 * Minimum open bins between neighbouring harmonic masks, and the harmonic
 * spacing below which the comb stops being representable at all.
 *
 * A protection mask is only useful if the inter-harmonic floor stays exposed
 * for the suppressor to work on. Once neighbouring masks touch, "protect the
 * harmonics" becomes "protect everything" and the effect goes inert. At
 * 2048/44.1 kHz the spacing limit puts the pitch floor for protection at
 * ~64.6 Hz — which is, not coincidentally, right where the server's 70 Hz
 * speech floor sits.
 */
const MIN_HARMONIC_GAP_BINS = 1
const MIN_HARMONIC_SPACING_BINS = 3

/** Bound the per-pitch mask cache so a long session cannot grow it forever. */
const MASK_CACHE_LIMIT = 256

/**
 * Absolute energy floor below which a frame is treated as silence, in dB of
 * frame mean-square.
 *
 * Deliberately absolute rather than relative to a measured noise floor: a floor
 * tracker rises toward the signal, so on continuous material with no silence in
 * it the floor converges on the signal level and the gate never opens at all.
 */
const SILENCE_FLOOR_DB = -60

/**
 * Default pitch search range for harmonic protection.
 *
 * The server hard-coded the speech range because the stage only ever ran inside
 * a voice mastering chain. A realtime effect gets pointed at drums, synths and
 * instruments, so the range is a parameter — see `pitchMinHz` / `pitchMaxHz`.
 */
const DEFAULT_PITCH_MIN_HZ = 70
const DEFAULT_PITCH_MAX_HZ = 400

/**
 * Voicing gate and hold for the pitch this effect acts on.
 *
 * EVERYTHING PITCH-DEPENDENT HERE IS ONLY AS GOOD AS THIS ESTIMATE — the
 * harmonic protection mask lands on bins chosen by it, and the peak-envelope
 * reference sizes its max filter from it — and at the tracker's default gate of
 * 0.1 the estimate is frequently not an estimate at all. Measured on 46 s of
 * narration against an independent check of whether the harmonic comb is even
 * measurable: 14.0% of consecutive voiced frames jumped by more than a tritone,
 * and of the frames scraping in just above the default gate, 2% had a comb
 * clear enough to verify.
 *
 * 0.7 with a 16-frame hold takes those jumps to 0.8% while still giving 90% of
 * active frames a pitch to work with — against 99% before, and against 69% for
 * the same gate with no hold. THE HOLD IS THE HALF THAT MATTERS: a higher gate
 * on its own converts a bad pitch into no pitch, and no pitch means no mask,
 * which is a worse failure than a slightly stale one. 16 frames is 186 ms at
 * 44.1 kHz — long enough to carry across a consonant inside a word, short
 * enough that it cannot survive a pause.
 *
 * ONE FILE, ONE NARRATOR. The direction is well evidenced and the exact numbers
 * are not; a second voice is the thing to check before treating them as settled.
 */
const PITCH_MIN_RATIO = 0.7
const PITCH_HOLD_FRAMES = 16

/**
 * Level that reads as 0 on the displayed spectrum, in dB of raw bin magnitude.
 *
 * The FFT is unnormalised and the analysis window is a periodic Hann, so a
 * full-scale sine sitting on a bin centre produces |X| = A·N/4 — the N/2 of an
 * unnormalised transform times the window's 0.5 coherent gain. Subtracting that
 * puts the display in dBFS, which is the only scale a number on a spectrum plot
 * can be read against. It is a display convention only: nothing in the
 * suppression path sees it, because every decision the kernel makes is a
 * difference between two magnitudes and a constant cancels out of all of them.
 */
const SPECTRUM_REF_DB = 20 * Math.log10(FFT_SIZE / 4)

export const RESONANCE_KERNEL_DEFAULTS = {
  attackMs: 15,
  releaseMs: 80,
  pitchMinHz: DEFAULT_PITCH_MIN_HZ,
  pitchMaxHz: DEFAULT_PITCH_MAX_HZ,
  mode: 'soft', // 'soft' | 'hard'
  // 'peak' ships — see RESONANCE_REF_MODE_DEFAULTS for the measurement that
  // moved it there. 'cepstral' is the alternative, reachable by override.
  // Deliberately independent of the zones' protection setting so all four
  // combinations can be measured.
  refMode: 'peak',
  /**
   * Contiguous frequency zones, each carrying its own depth, sharpness and
   * selectivity — ABSOLUTE values, not offsets from a global setting, because
   * there is no longer a global setting for any of the three. See
   * DEFAULT_RESONANCE_ZONES. Also the only thing that decides which part of the
   * spectrum is processed: a zone switched off is a band left alone, which is
   * what the separate low/high limit pair used to do.
   */
  zones: DEFAULT_RESONANCE_ZONES,
  /**
   * Focus patch — `{ global, nodes }` — or null to use `zones`.
   *
   * Null rather than absent: this object is merged over the kernel's defaults,
   * so a key present-but-undefined would overwrite a default rather than fall
   * back to it. Null is a value that means something ("the other model"), which
   * is what the dispatch in _deriveParams reads.
   */
  focus: null,
  // Wet/dry blend and wet-path makeup. Both live inside the kernel's per-bin
  // gain rather than as nodes around it — see _mixGain.
  mix: 1,
  trimDb: 0,
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

export class ResonanceKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.binCount = (FFT_SIZE >>> 1) + 1
    this.binWidth = sampleRate / FFT_SIZE
    this.frameRateMs = (HOP_SIZE / sampleRate) * 1000

    this.fft = getFFT(FFT_SIZE)
    this.f0 = new F0Tracker({
      sampleRate,
      frameSize: FFT_SIZE,
      defaultF0: null,
      minHz: DEFAULT_PITCH_MIN_HZ,
      maxHz: DEFAULT_PITCH_MAX_HZ,
      minRatio: PITCH_MIN_RATIO,
      holdFrames: PITCH_HOLD_FRAMES,
    })

    // One STFT per channel, plus — on anything wider than mono — one more fed
    // the channel mean, which is what detection reads.
    //
    // A cut computed per channel independently would move the stereo image
    // around on correlated material, so one shared gain is right. THE SHARED
    // GAIN USED TO COME FROM CHANNEL 0 ALONE, which is not "linked" detection
    // but left-channel detection: a resonance present only in the right channel
    // was invisible, and on a two-host podcast recorded to separate channels
    // that is half the material. The mean, not the sum, so correlated content
    // does not arrive 6 dB hot and shift what clears `selectivity`.
    //
    // Mono keeps the old path exactly — the single channel's own frame both
    // decides and receives the gain, and no second transform is run.
    this.stfts = []
    this.detStft = null
    this.detMix = null

    const bins = this.binCount
    this.magDb = new Float64Array(bins)
    this.envDb = new Float64Array(bins)
    this.cepstrum = new Float64Array(FFT_SIZE)
    this.envRe = new Float64Array(bins)
    this.envIm = new Float64Array(bins)
    this.reduction = new Float64Array(bins)
    // Peak-envelope scratch: the max-filtered spectrum and its prefix sum.
    // Allocated lazily — nothing pays for them on the shipping path.
    this.peakMax = null
    this.peakPrefix = null
    // Post-blend reductions for the display; aliases prevGr at mix 1/trim 0.
    this.grDisplay = null
    this.grMixed = null
    this.spread = new Float64Array(bins)
    this.prevGr = new Float64Array(bins)
    this.gain = new Float64Array(bins)
    this.activeBins = new Uint8Array(bins)

    this.maskCache = new Map()
    this.currentMask = null

    this.frameIndex = 0

    // Metering — peak reduction seen since the last read.
    this.maxReductionSeen = 0

    // Monitoring mode. Never a member of `params`, and deliberately so — see
    // setMonitor.
    this.monitorDelta = false

    // Per-frequency display. The panel draws what the kernel measured rather
    // than running its own analyser over the output: a second FFT would show
    // the result of the cut but not the reference it was decided against, and
    // the threshold line is the one curve that explains what Selectivity does.
    this.displayBins = RESONANCE_DISPLAY_BINS
    this.displayMag = new Float32Array(this.displayBins)
    this.displayEnv = new Float32Array(this.displayBins)
    this.displayDetect = new Float32Array(this.displayBins)
    this.displayGrNow = new Float32Array(this.displayBins)
    this.hasDisplayFrame = false
    this._buildDisplayGrid()

    // Bound once so the hot path passes a stable reference rather than
    // allocating a closure per block.
    this._analyzeAndApply = (re, im, bins, self) => {
      this._analyzeFrame(re, im, self)
      this._applyGain(re, im, bins)
    }
    this._analyzeOnly = (re, im, bins, self) => {
      this._analyzeFrame(re, im, self)
    }
    this._applyGain = (re, im, bins) => {
      const g = this.gain
      if (this.monitorDelta) {
        // The complement of the gain is exactly the part being removed. The
        // STFT and its overlap-add are linear and reconstruct exactly, so
        // ISTFT(X·(1−G)) is ISTFT(X) − ISTFT(X·G) sample for sample — the
        // difference between the input and the output, with no delay to line
        // up and no second signal path to drift.
        //
        // ⚠ THE COMPLEMENT IS TAKEN AGAINST THE TRIM, NOT AGAINST UNITY, and
        // `1 - g[k]` was a real bug rather than a nicety. `gain` carries the
        // output trim (see the blend in setParams: gain = trim·((1−mix) +
        // mix·g)), so on a patch that is removing NOTHING — every zone
        // bypassed, depth at zero — the complement of unity is `1 − trim`,
        // which is not zero unless the trim is. Reported from use as "DELTA
        // keeps playing the file with everything switched off", and it does:
        // at +6 dB of trim `1 − trim` is −1, so DELTA plays the whole file back
        // at full level with its polarity flipped. Measured on a 180 Hz tone at
        // 0.2: delta peak 0.199 at +6 dB of trim, 0.058 at −3 dB, 0.000 at 0.
        //
        // `trimLin − g[k]` is the same arithmetic with the trim factored out of
        // the complement and left on the result: trim·(1 − blend). So the delta
        // is the removed signal, monitored through the same output trim the
        // processed signal is, and it is silent whenever nothing is removed
        // whatever the trim says. Mix needs no such treatment — it scales how
        // much is removed, so a delta that goes quiet as mix falls is correct.
        //
        // What that costs is the exact form of the identity: output + delta is
        // now the TRIMMED input rather than the input. At trim 0 dB — the
        // default, and every setting the old line was ever right for — this is
        // bit-identical to what it replaced.
        const trim = this.trimLin
        for (let k = 0; k < bins; k++) {
          const d = trim - g[k]
          re[k] *= d
          im[k] *= d
        }
        return
      }
      for (let k = 0; k < bins; k++) {
        re[k] *= g[k]
        im[k] *= g[k]
      }
    }

    this.params = { ...RESONANCE_KERNEL_DEFAULTS }
    this.setParams({})
  }

  /** Algorithmic latency, in samples. Reported to the offline apply path. */
  get latencySamples() {
    return FFT_SIZE
  }

  /** Merge a partial param update and recompute derived state. */
  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p

    this.softKnee = p.mode !== 'hard'
    this.refMode = p.refMode === 'peak' ? 'peak' : 'cepstral'

    /**
     * HARMONIC PROTECTION MEANS SOMETHING DIFFERENT UNDER EACH REFERENCE, and
     * it is honoured under both. It was briefly forced off under `peak`; that
     * was an over-reach and is reverted.
     *
     * The two references put their reduction in opposite places. The cepstral
     * one measures the bin's own magnitude, which peaks at harmonics, so its
     * reduction concentrates ON them and masking those bins removes most of it
     * — which is why the shipping default is inert on voiced material. The peak
     * reference measures a maximum over one harmonic spacing, which FLATTENS
     * the comb on purpose, so its reduction is smooth across frequency and
     * masking punches holes in it: the partials survive and the inter-harmonic
     * floor is attenuated instead.
     *
     * So under `cepstral` the control is protection, and under `peak` it is a
     * different process — attenuate between the partials, leave them alone —
     * which is a real technique and the reason this is not disabled.
     *
     * WHAT IT IS NOT, ON THE EVIDENCE SO FAR: harmonic-selective noise
     * reduction. If it were removing breath and room from the gaps it would
     * raise the harmonic-to-inter-harmonic ratio. Measured over the 3rd-12th
     * harmonic on confidently voiced frames of real narration, against a source
     * ratio of 14.11 dB:
     *
     *     peak, mask off,  sel 22    harmonics -0.51  gaps -0.10   ratio -0.40
     *     peak, mask ON,   sel 22    harmonics -0.36  gaps -0.39   ratio +0.03
     *     peak, mask ON,   sel 14    harmonics -1.28  gaps -0.84   ratio -0.45
     *     peak, mask ON,   sel 8     harmonics -3.04  gaps -2.62   ratio -0.42
     *
     * The ratio never improves, and driven harder the partials lose MORE than
     * the gaps. On this file it is quieter, not cleaner. One narrator, one
     * metric — enough to withhold the claim, not enough to remove the control.
     *
     * It also depends entirely on the F0 estimate: where the pitch is wrong the
     * gaps are misplaced and it cuts partials instead, and on unpitched frames
     * there is no comb so it reverts to full broadband suppression.
     */

    // Sensitivity zones. Rebuilt on any param change rather than diffed: it is
    // a few thousand lookups on a knob move, and never on the audio path.
    // Null when every zone is neutral, so the untouched case costs the detector
    // nothing and stays bit-identical to a build without zones.
    //
    // Built AFTER the band limits below would be the natural reading, but the
    // curves only need the limits to place their edges, and freqFloorHz /
    // freqCeilHz are computed a few lines down from the same `p`. Read from `p`
    // here for that reason rather than from `this`.
    // The zones ARE the settings. Depth, sharpness and selectivity have no
    // global value any more: each zone carries its own, and these curves are
    // how the per-bin detector reads them. Rebuilt on any param change rather
    // than diffed — a few thousand lookups on a knob move, never on the audio
    // path.
    //
    // ⚠ TWO AUTHORING MODELS, ONE KERNEL. `focus` is the prototype targeting
    // model (see resonanceFocus.js) and takes over when present; `zones` is
    // what ships. Nothing below this line knows which one drew the curves,
    // which is the point — the detector loop, the envelope groups, the mask and
    // the ceiling all read per-bin arrays either way, so an alternative model
    // is a panel change plus this dispatch rather than a DSP change.
    const zones = p.zones ?? DEFAULT_RESONANCE_ZONES
    const curves = p.focus
      ? buildResonanceFocusCurves(p.focus, this.binCount, this.binWidth)
      : buildResonanceZoneCurves(zones, this.binCount, this.binWidth)
    this.zoneDepth = curves.depth
    this.zoneSelectivity = curves.selectivity
    this.zoneSharpness = curves.sharpness
    this.zoneMaxCut = curves.maxCut
    this.zoneProtect = curves.protect
    this.anyProtect = curves.anyProtect

    // One reference envelope per DISTINCT sharpness, not per zone: sharpness
    // sets the scale of the envelope, which is a property of the whole
    // transform rather than of a bin, so a zone asking for a different one
    // needs its own envelope. The forward cepstrum is shared, so the cost is
    // one extra inverse transform per distinct value — at most five more per
    // frame, and exactly none on the overwhelmingly common uniform case.
    this.envGroups = curves.groups.map(g => ({
      weight: g.weight,
      // Cepstral lifter target. Sharpness picks an absolute envelope feature
      // scale; the per-frame F0 clamps it. See LIFTER_SCALE_COARSE_HZ.
      lifterTarget: Math.max(20, Math.round(this.sampleRate / (LIFTER_SCALE_COARSE_HZ
        * Math.pow(LIFTER_SCALE_FINE_HZ / LIFTER_SCALE_COARSE_HZ, g.sharpness)))),
      // Peak-envelope reference width, from the same knob: it is the same
      // quantity the lifter target is, an envelope feature scale, expressed in
      // octaves because this reference has no reason to be uniform in Hz.
      refOct: PEAK_REF_OCT_COARSE
        * Math.pow(PEAK_REF_OCT_FINE / PEAK_REF_OCT_COARSE, g.sharpness),
      buffer: null,
    }))
    this.envUniform = curves.uniform
    // A default for callers that reach _peakEnvelope directly rather than
    // through the blended wrapper — the blended one sets it per group.
    this.refOct = this.envGroups[0].refOct

    // The knee is half the threshold, and the threshold is now per bin. Held as
    // its own curve rather than recomputed in the detection loop so the loop
    // stays a read per bin.
    if (!this.kneeWidth || this.kneeWidth.length !== this.binCount) {
      this.kneeWidth = new Float64Array(this.binCount)
    }
    for (let k = 0; k < this.binCount; k++) {
      this.kneeWidth[k] = Math.max(this.zoneSelectivity[k] * 0.5, 1e-6)
    }

    // WHAT GETS PROCESSED IS NOW ONLY THE ZONES. The low/high limit pair is
    // gone: a band you want left alone is a zone switched off, which says the
    // same thing in the control that already exists. The floor is the one
    // remaining fixed bound, and it is an analysis limit rather than a taste —
    // below it a 2048-point frame has under two bins to work with.
    for (let k = 0; k < this.binCount; k++) {
      this.activeBins[k] = k * this.binWidth >= ANALYSIS_FLOOR_HZ ? 1 : 0
    }

    // Wet/dry blend and output trim, folded into the per-bin gain:
    // gain = trim * ((1 - mix) + mix * g).
    //
    // Inside the gain rather than as nodes around the effect, which is what
    // keeps the delta monitor exact: the output is ISTFT(X * gain) and the
    // delta is ISTFT(X * (1 - gain)), so the two still sum to the input at
    // every setting. A dry node running beside the effect would have to be
    // delayed by the STFT's latency to line up, and a trim node after the sum
    // would leave the delta describing a signal nobody hears.
    //
    // TRIM SITS AFTER THE BLEND, not on the wet path as soothe's does. Its job
    // here is to give back the level suppression took away — this is a plugin
    // pointed at a selection, not a link in a chain with its own gain staging
    // downstream — and a wet-path trim silently changes the wet/dry ratio, so
    // reaching for makeup would deepen the notches as a side effect.
    this.mix = clamp(p.mix ?? 1, 0, 1)
    this.trimLin = Math.pow(10, (p.trimDb ?? 0) / 20)
    this.mixDry = (1 - this.mix) * this.trimLin
    this.mixWet = this.mix * this.trimLin
    this.mixIsWetOnly = this.mix === 1

    // Gaussian spread, width set by sharpness — in OCTAVES, not bins, and now
    // per bin twice over: a constant width in octaves is already a width in
    // bins that grows with frequency, and sharpness itself now varies with
    // frequency. See SPREAD_MAX_OCTAVES.
    if (!this.spreadHalfBins) {
      this.spreadHalfBins = new Int32Array(this.binCount)
      this.spreadInvSigma = new Float64Array(this.binCount)
    }
    this.spreadEnabled = false
    for (let k = 0; k < this.binCount; k++) {
      const spreadOct = SPREAD_MAX_OCTAVES * (1 - this.zoneSharpness[k])
      if (spreadOct <= 1e-3) {
        this.spreadHalfBins[k] = 0
        this.spreadInvSigma[k] = 0
        continue
      }
      this.spreadEnabled = true
      // Half-width and sigma as a FRACTION of the bin index: a span of
      // ±`oct` octaves around bin k covers k·(2^oct − 2^-oct)/2 bins either
      // side, to first order symmetric about k.
      const halfFrac = (Math.pow(2, spreadOct) - Math.pow(2, -spreadOct)) / 2
      const sigmaOct = spreadOct / 3
      const sigmaFrac = (Math.pow(2, sigmaOct) - Math.pow(2, -sigmaOct)) / 2
      this.spreadHalfBins[k] = Math.min(Math.round(k * halfFrac), SPREAD_MAX_HALF_BINS)
      const sigma = k * sigmaFrac
      this.spreadInvSigma[k] = sigma > 1e-9 ? 1 / sigma : 0
    }

    // Attack/release at the frame rate: exp(-frame_period / tau).
    this.attackCoeff = p.attackMs > 0
      ? Math.exp(-this.frameRateMs / p.attackMs)
      : 0
    this.releaseCoeff = p.releaseMs > 0
      ? Math.exp(-this.frameRateMs / p.releaseMs)
      : 0

    // Pitch search range. The tracker clamps to what the frame can resolve and
    // returns the range it settled on; kept here so tests and any future
    // in-worklet reporting can read it. The UI mirrors the same clamp on the
    // main thread via effectivePitchRange() — there is no channel out of a
    // worklet for a value that is needed to render a label.
    this.pitchRange = this.f0.setRange(
      p.pitchMinHz ?? DEFAULT_PITCH_MIN_HZ,
      p.pitchMaxHz ?? DEFAULT_PITCH_MAX_HZ,
    )

    // The harmonic walk runs to Nyquist now that there is no adjustable band
    // ceiling, so the mask depends on F0 alone and the cache never needs
    // clearing on a param change.
  }

  /**
   * Monitor the difference instead of the result: what the suppressor is
   * taking out, alone.
   *
   * NOT A PARAMETER, and the separation is structural rather than tidiness.
   * `params` is what the offline apply path hands the kernel to render into
   * the timeline (applyResonanceRegion spreads it into toKernelParams), so a
   * monitoring mode living in there is one careless spread away from writing a
   * difference signal into someone's file. It travels on its own port message,
   * which the offline path never sends and processResonanceBuffer never calls.
   */
  setMonitor(delta) {
    this.monitorDelta = !!delta
  }

  /**
   * Depth of a notch as it survives the wet/dry blend, in dB.
   *
   * Measured against a bin the suppressor did not touch, so it is the depth of
   * the notch relative to the rest of the output rather than an absolute level
   * change: at mix 1 it is exactly `grDb`, at mix 0 it is exactly 0, and
   * `trimDb` — which moves every bin together — cancels out of it entirely.
   * That matches what the reduction curve is for. Monotone
   * in `grDb`, which is why the display can summarise raw reductions first and
   * map once per display point rather than once per FFT bin.
   */
  _mixDepth(grDb) {
    if (this.mixIsWetOnly || grDb <= 0) return grDb
    const g = (1 - this.mix) + this.mix * Math.pow(10, -grDb / 20)
    return -20 * Math.log10(g)
  }

  reset() {
    for (const s of this.stfts) s.reset()
    this.detStft?.reset()
    this.f0.reset()
    this.prevGr.fill(0)
    this.frameIndex = 0
    this.maskCache.clear()
    this.hasDisplayFrame = false
  }

  /**
   * Map the FFT bins onto the log-frequency display grid, once.
   *
   * Each display point owns a span of the axis, and which case it falls into
   * depends on where it sits: above ~400 Hz its span covers several FFT bins
   * and it takes the strongest of them, below that the span is narrower than a
   * bin and it interpolates between the two either side. Taking the maximum
   * rather than the mean is the important half — a resonance is a narrow peak,
   * and averaging it against the bins beside it is exactly the operation that
   * would hide the thing this display exists to show.
   */
  _buildDisplayGrid() {
    const D = this.displayBins
    const { minHz, maxHz } = resonanceDisplayRange(this.sampleRate)
    this.displayMinHz = minHz
    this.displayMaxHz = maxHz

    // Inclusive FFT bin span per display point; hi < lo means "interpolate at
    // dPos instead", which is the only signal the hot loop needs.
    this.dLo = new Int32Array(D)
    this.dHi = new Int32Array(D)
    this.dPos = new Float32Array(D)

    const octaves = Math.log2(maxHz / minHz)
    const halfStep = octaves / (D - 1) / 2
    const last = this.binCount - 1

    for (let d = 0; d < D; d++) {
      const fc = minHz * Math.pow(2, (d / (D - 1)) * octaves)
      this.dPos[d] = clamp(fc / this.binWidth, 0, last)

      const rawLo = Math.ceil((fc * Math.pow(2, -halfStep)) / this.binWidth)
      const rawHi = Math.floor((fc * Math.pow(2, halfStep)) / this.binWidth)
      if (rawHi >= rawLo && rawHi >= 0 && rawLo <= last) {
        this.dLo[d] = Math.max(rawLo, 0)
        this.dHi[d] = Math.min(rawHi, last)
      } else {
        this.dLo[d] = 1
        this.dHi[d] = 0
      }
    }
  }

  /**
   * Resample this frame's measurements onto the display grid.
   *
   * ALL FOUR CURVES DESCRIBE THIS FRAME, so anything drawn from them agrees
   * about one instant. There used to be a fifth carrying the maximum since the
   * last read, because the display is read at half the frame rate and a peak
   * landing on an unread frame was otherwise lost; it existed for the trace's
   * peak-hold outline alone, and went when that did.
   *
   * The reference goes out without `selectivity` added — the panel adds it when
   * drawing, so turning the knob moves the threshold line immediately rather
   * than on the next frame out of the worklet.
   *
   * `detect` is NOT `mag`: it is the curve the detector reads, which in the
   * shipping peak reference mode is a max-filtered magnitude. A margin computed
   * from `mag` reports no crossing on bins the kernel is cutting.
   */
  _snapshotDisplay() {
    const {
      magDb, envDb,
      displayMag, displayEnv, displayDetect, displayGrNow,
    } = this
    // Post-blend reductions — the notch the listener actually gets. Aliases
    // prevGr whenever mix and trim are at their neutral settings.
    const prevGr = this.grDisplay ?? this.prevGr
    const last = this.binCount - 1
    // ⚠ THE CURVE THE DETECTOR ACTUALLY READS, WHICH IS NOT `magDb`. In the
    // shipping `peak` reference mode this is `peakMax` — magnitude run through a
    // max filter — and the decision at line ~1287 is taken against it. Sending
    // only `magDb` meant the panel recomputed the margin from a curve the kernel
    // never consults, so a bin whose peak sits one bin over showed NO crossing
    // while the kernel cut several dB there. Reported exactly that way: 3-5 dB
    // in the trace and the meters, nothing in FOUND.
    const detect = (this.refMode === 'peak' ? this.peakMax : this.magDb) ?? this.magDb

    for (let d = 0; d < this.displayBins; d++) {
      const lo = this.dLo[d]
      const hi = this.dHi[d]
      let mag
      let env
      let det
      let gr
      if (hi >= lo) {
        mag = -Infinity
        env = 0
        det = -Infinity
        gr = 0
        for (let k = lo; k <= hi; k++) {
          if (magDb[k] > mag) mag = magDb[k]
          env += envDb[k]
          // MAX, like `mag` and `gr` and unlike `env`. The decision is taken per
          // FFT bin, so what a display cell has to report is the strongest
          // crossing anywhere in it — averaging would hide a one-bin resonance
          // among its quiet neighbours, which is the whole event.
          if (detect[k] > det) det = detect[k]
          if (prevGr[k] > gr) gr = prevGr[k]
        }
        env /= hi - lo + 1
      } else {
        const pos = this.dPos[d]
        const k0 = Math.min(Math.floor(pos), last)
        const k1 = Math.min(k0 + 1, last)
        const t = pos - k0
        mag = magDb[k0] + (magDb[k1] - magDb[k0]) * t
        env = envDb[k0] + (envDb[k1] - envDb[k0]) * t
        // ⚠ MAX RATHER THAN INTERPOLATED, unlike its neighbours here. Below
        // about 1 kHz a display cell is narrower than one FFT bin, so this
        // branch samples BETWEEN bins — and interpolating the detect curve there
        // lands off the peak the kernel decided on and under-reads the margin,
        // which is the failure this whole curve exists to fix.
        det = detect[k0] > detect[k1] ? detect[k0] : detect[k1]
        gr = prevGr[k0] > prevGr[k1] ? prevGr[k0] : prevGr[k1]
      }
      displayMag[d] = mag - SPECTRUM_REF_DB
      displayEnv[d] = env - SPECTRUM_REF_DB
      displayDetect[d] = det - SPECTRUM_REF_DB
      displayGrNow[d] = gr
    }
    this.hasDisplayFrame = true
  }

  /** Floats one display read needs. */
  get displayLength() {
    return RESONANCE_DISPLAY_CURVES * this.displayBins
  }

  /**
   * Copy the display grid into `out` as
   * [magnitude, reference, detect, reduction] and clear the
   * held accumulator. Returns false before the first frame.
   *
   * One flat array of sections rather than an array each, because this crosses
   * a postMessage boundary every 23 ms and one buffer clones once.
   */
  readDisplay(out) {
    if (!this.hasDisplayFrame) return false
    const D = this.displayBins
    out.set(this.displayMag, 0)
    out.set(this.displayEnv, D)
    out.set(this.displayDetect, 2 * D)
    out.set(this.displayGrNow, 3 * D)
    return true
  }

  /**
   * Boolean protection mask for one pitch: bins belonging to a harmonic of f0.
   * Cached per rounded pitch, as the Python does.
   *
   * Returns null when the comb cannot be represented at this bin width — see
   * MIN_HARMONIC_SPACING_BINS. A null mask means "no protection available",
   * which the caller must not confuse with "no protection needed".
   */
  _harmonicMask(f0) {
    if (!f0 || f0 <= 0) return null
    if (f0 / this.binWidth < MIN_HARMONIC_SPACING_BINS) return null
    const key = Math.round(f0)
    const cached = this.maskCache.get(key)
    if (cached) return cached

    if (this.maskCache.size >= MASK_CACHE_LIMIT) this.maskCache.clear()

    const mask = new Uint8Array(this.binCount)
    const nyquist = this.sampleRate / 2

    // Widest half-width that still leaves a gap between neighbouring harmonics.
    // Without this the comb merges into a solid block and the suppressor has
    // nothing left to work on — measured at 100% coverage for f0 <= 82 Hz, and
    // above ~5 kHz even at 150 Hz, because the 1% term outgrows the spacing.
    // The server gets away with it only because its fixed 100-harmonic cap
    // truncates the comb before the damage is visible.
    const spacingBins = f0 / this.binWidth
    const maxHalf = Math.max(
      0,
      Math.floor((spacingBins - 1 - MIN_HARMONIC_GAP_BINS) / 2),
    )

    for (let h = 1; h <= MAX_HARMONIC; h++) {
      const freq = h * f0
      if (freq >= nyquist) break
      const center = Math.round(freq / this.binWidth)
      const pctHalf = Math.round((freq * HARMONIC_WIDTH_PCT) / this.binWidth)
      const half = Math.min(Math.max(HARMONIC_WIDTH_BINS, pctHalf), maxHalf)
      const lo = Math.max(0, center - half)
      const hi = Math.min(this.binCount - 1, center + half)
      for (let k = lo; k <= hi; k++) mask[k] = 1
    }
    this.maskCache.set(key, mask)
    return mask
  }

  /**
   * Cepstral reference envelope: treat the log-magnitude spectrum as a signal,
   * invert it, zero the high-quefrency middle (where the pitch peak and every
   * overtone live), and transform back. What is left sits at the inter-harmonic
   * floor rather than riding the harmonic peaks, so a resonance is visible at
   * its true prominence even when it sits next to a harmonic.
   */
  /**
   * The reference envelope, one per DISTINCT zone sharpness, blended per bin.
   *
   * Sharpness sets the SCALE of the envelope — how much spectral detail it
   * follows — and that is a property of the whole transform, not of a bin. A
   * zone asking for a different sharpness therefore needs its own envelope, and
   * the per-bin answer is the weighted sum, using the same weights that
   * crossfade every other zone setting at a boundary.
   *
   * The forward cepstrum is computed once and shared, so each extra distinct
   * sharpness costs one inverse transform per frame — at most five more, and
   * exactly none in the uniform case, which is the one every untouched panel is
   * in. `envUniform` also takes the assignment path rather than the blend path:
   * summing N identical envelopes by weights that sum to 1 differs from the
   * envelope in the last bits, and the default patch is meant to be
   * bit-identical to the build before zones existed, not merely close.
   */
  _cepstralEnvelopeBlended(lifterCeiling) {
    const groups = this.envGroups
    if (this.envUniform) {
      this._cepstralEnvelope(Math.min(groups[0].lifterTarget, lifterCeiling))
      return
    }
    const { envDb, binCount } = this
    for (const g of groups) {
      if (!g.buffer || g.buffer.length !== binCount) g.buffer = new Float64Array(binCount)
      this._cepstralEnvelope(Math.min(g.lifterTarget, lifterCeiling))
      g.buffer.set(envDb.subarray(0, binCount))
    }
    envDb.fill(0, 0, binCount)
    for (const g of groups) {
      const { weight, buffer } = g
      for (let k = 0; k < binCount; k++) {
        if (weight[k]) envDb[k] += weight[k] * buffer[k]
      }
    }
  }

  /**
   * The same, for the peak-envelope reference.
   *
   * This one needs the max filter re-run per group as well as the geometric
   * mean, because both widths come from sharpness — and `peakMax` is what the
   * detector measures protrusion against in this mode, so it is blended too.
   */
  _peakEnvelopeBlended(f0) {
    const groups = this.envGroups
    if (this.envUniform) {
      this.refOct = groups[0].refOct
      this._peakEnvelope(f0)
      return
    }
    const { envDb, binCount } = this
    for (const g of groups) {
      if (!g.buffer || g.buffer.length !== binCount * 2) {
        g.buffer = new Float64Array(binCount * 2)
      }
      this.refOct = g.refOct
      this._peakEnvelope(f0)
      g.buffer.set(envDb.subarray(0, binCount), 0)
      g.buffer.set(this.peakMax.subarray(0, binCount), binCount)
    }
    envDb.fill(0, 0, binCount)
    this.peakMax.fill(0, 0, binCount)
    for (const g of groups) {
      const { weight, buffer } = g
      for (let k = 0; k < binCount; k++) {
        if (!weight[k]) continue
        envDb[k] += weight[k] * buffer[k]
        this.peakMax[k] += weight[k] * buffer[binCount + k]
      }
    }
  }

  _cepstralEnvelope(lifterCutoff) {
    const { fft, magDb, cepstrum, envRe, envIm, envDb, binCount } = this

    fft.irfft(magDb, null, cepstrum)

    // Zero indices [L, FFT_SIZE - L] inclusive, matching
    // `liftered[:, L : n_fft - L + 1] = 0`.
    const L = Math.max(1, Math.min(lifterCutoff, FFT_SIZE >>> 1))
    for (let i = L; i <= FFT_SIZE - L; i++) cepstrum[i] = 0

    fft.rfft(cepstrum, envRe, envIm)
    for (let k = 0; k < binCount; k++) envDb[k] = envRe[k]
  }

  /**
   * One analysis frame: measure, decide a per-bin gain, leave it in `gain`.
   *
   * `stft` is whichever instance produced this spectrum — the sole channel on
   * mono, the detection mix otherwise. Its unwindowed frame is what pitch is
   * measured from.
   */
  /**
   * Reference drawn through the harmonic peaks. See PEAK_REF_FLOOR_FACTOR.
   *
   * `f0` is the spacing to step over, not a pitch to be accurate about: the max
   * filter only needs a window at least one harmonic apart, so an overestimate
   * costs resolution and an underestimate lets the comb back into the envelope.
   * That asymmetry is why the fallback is a plausible speaking pitch rather
   * than something small.
   */
  _peakEnvelope(f0) {
    const { magDb, envDb, binCount, binWidth } = this
    if (!this.peakMax) {
      this.peakMax = new Float64Array(binCount)
      this.peakPrefix = new Float64Array(binCount + 1)
    }
    const peak = this.peakMax
    const prefix = this.peakPrefix

    const spacing = Math.min(
      Math.max(1, Math.ceil(f0 / binWidth)),
      PEAK_SPACING_CAP_BINS,
    )
    for (let k = 0; k < binCount; k++) {
      const lo = k - spacing < 0 ? 0 : k - spacing
      const hi = k + spacing >= binCount ? binCount - 1 : k + spacing
      let m = -Infinity
      for (let j = lo; j <= hi; j++) if (magDb[j] > m) m = magDb[j]
      peak[k] = m
    }

    // Running mean over a GEOMETRIC window — [k/2^oct, k*2^oct] — via a prefix
    // sum, so the width can vary per bin without the cost varying with it.
    //
    // The window has to be geometric, not a linear one whose half-width is
    // computed from an octave span. That mistake averages a bin at 2.5 kHz over
    // everything from DC to 6.8 kHz, so the reference is set by the bass, sits
    // far above the local level, and nothing protrudes: it took broad-defect
    // removal at 2.5 kHz to 0.1-0.6 dB whatever the width or the threshold,
    // which reads exactly like a detector that cannot see broad defects.
    //
    // The floor keeps the window wider than the max filter that feeds it. Below
    // a few hundred Hz the octave span alone is narrower than one harmonic
    // spacing, and a reference that narrow follows the resonance instead of
    // passing under it.
    prefix[0] = 0
    for (let k = 0; k < binCount; k++) prefix[k + 1] = prefix[k] + peak[k]
    const up = Math.pow(2, this.refOct)
    const floorBins = Math.round((PEAK_REF_FLOOR_FACTOR * f0) / binWidth)
    const last = binCount - 1
    for (let k = 0; k < binCount; k++) {
      let lo = Math.round(k / up)
      let hi = Math.round(k * up)
      if (k - lo < floorBins) lo = k - floorBins
      if (hi - k < floorBins) hi = k + floorBins
      if (lo < 0) lo = 0
      if (hi > last) hi = last
      envDb[k] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1)
    }
  }

  _analyzeFrame(specRe, specIm, stft) {
    const {
      magDb, envDb, reduction, spread, prevGr, gain, activeBins, binCount,
      softKnee, kneeWidth, zoneDepth, zoneSelectivity, zoneMaxCut,
    } = this

    for (let k = 0; k < binCount; k++) {
      const mag = Math.hypot(specRe[k], specIm[k])
      magDb[k] = 20 * Math.log10(mag + MAG_EPS)
    }

    // Pitch drives both the lifter cutoff and the protection mask, so it is
    // measured from the unwindowed frame the STFT kept for us.
    const raw = (stft ?? this.stfts[0]).rawFrame
    let sumSq = 0
    for (let i = 0; i < FFT_SIZE; i++) sumSq += raw[i] * raw[i]
    const frameDb = 10 * Math.log10(sumSq / FFT_SIZE + 1e-20)

    // TWO SEPARATE QUESTIONS, and conflating them is what made this effect
    // switch itself off on anything unpitched:
    //
    //   active  — is there enough signal here to act on at all? Drives whether
    //             suppression runs.
    //   pitched — did we find a periodic component? Drives ONLY whether the
    //             harmonic protection mask is available.
    //
    // A frame can be loud and unpitched — a fricative, a snare, a cymbal, a
    // noise sweep — and those frames still need suppressing. They just have no
    // harmonics to protect.
    const active = frameDb > SILENCE_FLOOR_DB
    const { f0, pitched } = this.f0.estimate(raw, active)
    // lifter_cutoff = max(20, int(0.40 * sr / f0)), or the flat default when
    // no pitch has been measured yet — the two branches of
    // resonance_suppressor.py:343-346.
    const medianF0 = this.f0.median
    // The comb limit: an envelope finer than this starts tracing the harmonics
    // instead of passing under them. Sharpness asks for a scale; this is the
    // most it can have.
    const lifterCeiling = medianF0 > 0
      ? Math.max(20, Math.trunc((0.4 * this.sampleRate) / medianF0))
      : DEFAULT_LIFTER_CUTOFF
    if (this.refMode === 'peak') {
      // THE CURRENT FRAME'S PITCH, NOT THE ROLLING MEDIAN, and the asymmetry
      // is the reason. The max filter's window has to span at least one
      // harmonic spacing: too wide only blunts the envelope, too narrow lets
      // the comb straight into it, which is the one thing this reference
      // exists to prevent. The median is safe for the cepstral lifter, where
      // both errors degrade gracefully, and unsafe here. On a narrator ranging
      // 87-397 Hz around a median of 195 the high-pitched frames were getting
      // half a spacing. Margin for the same reason: err wide.
      const spacingHz = (pitched && f0 > 0 ? f0 : medianF0) || PEAK_FALLBACK_F0_HZ
      this._peakEnvelopeBlended(spacingHz * PEAK_SPACING_MARGIN)
    } else {
      this._cepstralEnvelopeBlended(lifterCeiling)
    }

    // Built when ANY zone asks for it: the mask depends only on F0, so one
    // zone wanting it pays for the whole thing, and where it applies is decided
    // per bin below.
    // ⚠ THE MASK HOLDS THROUGH UNPITCHED FRAMES, AND GATING IT ON `pitched` WAS
    // THE BUG. Measured on 40 s of real narration at a median F0 of 112 Hz:
    // 2537 frames sit above the silence floor and only 1744 of them — 68.7% —
    // report a pitch. On the other 793 the mask was null and the harmonics were
    // cut with no protection at all.
    //
    // Those frames are not silence. They are voiced-to-unvoiced transitions,
    // quiet voiced frames and frames where the autocorrelation did not clear
    // its confidence bar — all of them still full of the voice's partials. So
    // the switch did not remove the artefact it exists for, it made it
    // INTERMITTENT: a partial held on one frame and cut on the next is gain
    // modulation on the fundamental, which is worse than a steady cut.
    //
    // The rolling median is already trusted for the cepstral lifter and already
    // computed. A voice's F0 does not change between frames, so a comb centred
    // on the last confident pitch is far closer to right than no comb at all —
    // and the failure mode is benign either way: a mask in slightly the wrong
    // place protects slightly the wrong bins, where no mask protects nothing.
    //
    // ⚠ IT HOLDS ONLY WHILE THE FRAME IS ACTIVE. Through real silence there is
    // nothing to protect, and holding there would mask the noise floor the
    // suppressor is meant to be free to work on.
    const maskF0 = pitched && f0 > 0 ? f0 : (active ? medianF0 : 0)
    const mask = this.anyProtect && maskF0 > 0 ? this._harmonicMask(maskF0) : null

    // Spike detection → soft knee → depth → clip.
    // WHAT PROTRUSION IS MEASURED FROM. Against the cepstral reference it is the
    // bin's own magnitude, as the server does. Against the peak envelope it is
    // the ENVELOPE's value at that bin, and the difference is the whole point:
    //
    // `magDb[k]` moves every time a harmonic slides across bin k, which IS
    // reason 1 — the detector reads the passing harmonic as a resonance
    // arriving and leaving, and the gain chases it. The peak envelope is a
    // maximum over one harmonic spacing, so a harmonic moving inside that span
    // does not change it. Detecting on it makes the gain a smooth, stable
    // function of frequency instead of a per-bin one.
    //
    // Fixing the reference and leaving the measurement on the raw magnitude was
    // half a fix, and measurably so: on real narration at matched treatment it
    // left gain jitter at 1.23/1.78 dB against the cepstral path's 0.94/1.25 —
    // WORSE than what it replaced. Moving detection onto the envelope takes it
    // to 0.97/1.34, and with slow ballistics to 0.36/0.77.
    // `?? magDb` is unreachable through _analyzeFrame, which always builds the
    // envelope first in peak mode. It is here so a future caller that reorders
    // those two gets the shipping behaviour rather than a null dereference on
    // the audio thread.
    const detect = (this.refMode === 'peak' ? this.peakMax : magDb) ?? magDb
    for (let k = 0; k < binCount; k++) {
      if (!activeBins[k]) {
        reduction[k] = 0
        continue
      }
      // Threshold and knee come from the zone this bin falls in. DEPTH DOES
      // NOT APPLY HERE — it is applied once, after the spread. See below.
      const above = detect[k] - envDb[k] - zoneSelectivity[k]
      if (above <= 0) {
        reduction[k] = 0
        continue
      }
      const knee = kneeWidth[k]
      reduction[k] = softKnee && above < knee ? (above * above) / (2 * knee) : above
    }

    // Harmonic protection, pre-spread: attenuate these before the spread kernel
    // runs so a harmonic's own prominence is never smeared into the gaps beside
    // it. Scaled by the zone's protection weight rather than zeroed outright —
    // the weight is 1 inside a protecting zone, 0 inside one that is not, and
    // crossfades between, so a partial sitting on a boundary is not half masked
    // by a step.
    const protect = this.zoneProtect
    if (mask) {
      for (let k = 0; k < binCount; k++) {
        if (mask[k] && protect[k] > 0) reduction[k] *= 1 - protect[k]
      }
    }

    // Gaussian spread along the log-frequency axis: a constant width in
    // octaves, so the Q of a cut is the same wherever it lands.
    if (this.spreadEnabled) {
      const halfBins = this.spreadHalfBins
      const invSigma = this.spreadInvSigma
      const lutScale = SPREAD_LUT_SIZE / SPREAD_LUT_MAX
      for (let k = 0; k < binCount; k++) {
        const half = halfBins[k]
        if (half < 1) {
          spread[k] = reduction[k]
          continue
        }
        const inv = invSigma[k]
        let acc = 0
        const lo = k - half >= 0 ? k - half : 0
        const hi = k + half < binCount ? k + half : binCount - 1
        for (let j = lo; j <= hi; j++) {
          const r = reduction[j]
          if (r === 0) continue
          const x = (j < k ? k - j : j - k) * inv
          if (x >= SPREAD_LUT_MAX) continue
          acc += r * SPREAD_LUT[(x * lutScale) | 0]
        }
        spread[k] = acc
      }
      // Post-spread: re-protect harmonics that neighbouring spikes bled into,
      // and hard-limit the reduction to the active band. Without a spread
      // kernel neither is needed — the pre-spread pass already attenuated the
      // mask, and the detection loop never wrote outside the active band.
      for (let k = 0; k < binCount; k++) {
        if (!activeBins[k]) {
          reduction[k] = 0
          continue
        }
        reduction[k] = mask && mask[k] ? spread[k] * (1 - protect[k]) : spread[k]
      }
    }

    // DEPTH AND THE CEILING, ONCE, AFTER THE SPREAD.
    //
    // After rather than in the detection loop, and it has to be after: the
    // spread kernel reaches up to 96 bins either side, so scaling first lets a
    // neighbouring zone's reduction smear straight through a boundary — a zone
    // switched off still lost 0.68 dB on a tone 1.6 octaves clear of the edge,
    // which is not what OFF can be allowed to mean.
    //
    // It costs nothing to move it. The spread is a linear operator, so scaling
    // before and scaling after are the same arithmetic wherever depth is
    // uniform, which is every patch that has not been zoned. The one real
    // change is that the ceiling clips the finished reduction rather than an
    // intermediate — it is a ceiling on what comes out, and that is where a
    // ceiling belongs.
    //
    // BOTH ARE PER ZONE. Max Cut is a bound on how much this effect will ever
    // take out of a band, and the honest answer differs by band: a low-mid
    // resonance can lose 12 dB before it is obviously gone, where the same
    // number spent on sibilance is a lisp.
    for (let k = 0; k < binCount; k++) {
      const r = reduction[k] * zoneDepth[k]
      const ceiling = zoneMaxCut[k]
      reduction[k] = r > ceiling ? ceiling : r
    }

    // Silent frames target zero, so the IIR decays through silence rather than
    // holding a cut across it. Note this keys off `active`, not `pitched` —
    // an unpitched frame is still processed.
    if (!active) reduction.fill(0)

    // Per-bin attack/release at the frame rate, then the mix/trim blend.
    const { attackCoeff, releaseCoeff, mixDry, mixWet } = this
    let frameMax = 0
    for (let k = 0; k < binCount; k++) {
      const target = reduction[k]
      const c = target >= prevGr[k] ? attackCoeff : releaseCoeff
      const v = c * prevGr[k] + (1 - c) * target
      prevGr[k] = v
      if (v > frameMax) frameMax = v
      gain[k] = mixDry + mixWet * Math.pow(10, -v / 20)
    }
    if (frameMax > this.maxReductionSeen) this.maxReductionSeen = frameMax

    // What the notches look like AFTER the blend, for the display and the
    // meter. Aliased to the raw reduction on the default path so nothing pays
    // for a mix that is not being used, and so the display stays bit-identical
    // at mix 1 / trim 0.
    if (this.mixIsWetOnly) {
      this.grDisplay = prevGr
    } else {
      if (!this.grMixed) this.grMixed = new Float64Array(binCount)
      for (let k = 0; k < binCount; k++) this.grMixed[k] = this._mixDepth(prevGr[k])
      this.grDisplay = this.grMixed
    }

    // Unconditional: at ~2000 operations per frame this costs less than one of
    // the three transforms above, and a display that only fills once someone is
    // watching has to define what "watching" means across a port boundary.
    this._snapshotDisplay()

    this.frameIndex++
  }

  _ensureChannels(n, detectFrom = n) {
    while (this.stfts.length < n) {
      this.stfts.push(new StftProcessor({ fftSize: FFT_SIZE, hopSize: HOP_SIZE }))
    }
    // Only worth a second transform when there is genuinely more than one
    // input to combine; a mono source fanned out to several outputs is still
    // decided by its own frame.
    if (detectFrom > 1 && !this.detStft) {
      this.detStft = new StftProcessor({ fftSize: FFT_SIZE, hopSize: HOP_SIZE })
      this.detMix = new Float64Array(HOP_SIZE)
    }
  }

  /**
   * Process one block.
   *
   * ⚠ THE COST OF THIS IS BURSTY AND THE AVERAGE HIDES IT. Hop is 512, so three
   * 128-sample quanta in four do nothing and the fourth does the whole frame:
   * measured at median 0.001 ms against max 1.617, which is 56% of the 2.90 ms
   * quantum deadline from one mono instance. Open, not fixed — the analysis
   * reads frame N and modifies its spectrum before the inverse transform in the
   * same quantum, so spreading it costs either latency or a stale control
   * signal. Routes, figures and the profile split are in CLAUDE.md.
   *
   * @param {Float32Array[]} inputChannels
   * @param {Float32Array[]} outputChannels
   * @param {number} n
   */
  process(inputChannels, outputChannels, n) {
    const nIn = inputChannels.length
    const nOut = outputChannels.length
    if (nIn === 0 || n === 0) {
      for (let ch = 0; ch < nOut; ch++) outputChannels[ch].fill(0, 0, n)
      return
    }

    this._ensureChannels(nOut, nIn)

    // Walk the block in pieces no longer than one hop, so at most one STFT
    // frame completes per piece. Channel 0 computes the gain for that frame and
    // the other channels reuse it; without the cap a block spanning two frames
    // would leave every channel but the first applying the LAST frame's gain to
    // both. Web Audio's 128-sample quantum never spans a frame, but the offline
    // path and any future caller are free to hand over larger blocks.
    let off = 0
    while (off < n) {
      const len = Math.min(HOP_SIZE, n - off)
      const whole = off === 0 && len === n

      // Detection first, so the gain a frame boundary inside this piece
      // produces is the one every channel then applies at that same boundary.
      if (this.detStft) {
        const mix = this.detMix
        const scale = 1 / nIn
        for (let i = 0; i < len; i++) {
          let acc = 0
          for (let ch = 0; ch < nIn; ch++) acc += inputChannels[ch][off + i]
          mix[i] = acc * scale
        }
        this.detStft.analyze(mix, len, this._analyzeOnly)
      }

      for (let ch = 0; ch < nOut; ch++) {
        const source = inputChannels[ch < nIn ? ch : nIn - 1]
        const target = outputChannels[ch]
        this.stfts[ch].process(
          whole ? source : source.subarray(off, off + len),
          whole ? target : target.subarray(off, off + len),
          len,
          ch === 0 && !this.detStft ? this._analyzeAndApply : this._applyGain,
        )
      }
      off += len
    }
  }

  /** Peak reduction since the last call, in dB, as the blend leaves it. */
  readMetering() {
    const v = this.maxReductionSeen
    this.maxReductionSeen = 0
    return this._mixDepth(v)
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 *
 * Note the output is delayed by `latencySamples` relative to the input, exactly
 * as the worklet's is — this returns the raw stream without trimming, so a
 * caller comparing against the worklet render sees the same thing.
 */
export function processResonanceBuffer(channelData, sampleRate, params = {}) {
  const kernel = new ResonanceKernel(sampleRate)
  kernel.setParams(params)

  const n = channelData[0].length
  const output = channelData.map(() => new Float32Array(n))
  const BLOCK = 128
  for (let off = 0; off < n; off += BLOCK) {
    const len = Math.min(BLOCK, n - off)
    kernel.process(
      channelData.map(c => c.subarray(off, off + len)),
      output.map(c => c.subarray(off, off + len)),
      len,
    )
  }
  return { channelData: output, latencySamples: kernel.latencySamples }
}

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

if (typeof registerProcessor === 'function') {
  // ~21 ms at 44.1 kHz — enough for a smooth meter without flooding the port.
  const METER_INTERVAL_SAMPLES = 1024

  class ResonanceWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new ResonanceKernel(sampleRate)
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params)
      }
      this.sinceMeter = 0
      this.display = new Float32Array(this.kernel.displayLength)
      this.port.onmessage = (e) => {
        if (e.data?.type === 'params') this.kernel.setParams(e.data.params)
        else if (e.data?.type === 'monitor') this.kernel.setMonitor(e.data.delta)
        else if (e.data?.type === 'reset') this.kernel.reset()
      }
    }

    process(inputs, outputs) {
      const input = inputs[0]
      const output = outputs[0]
      if (!output || output.length === 0) return true

      const n = output[0].length
      if (!input || input.length === 0) {
        for (const ch of output) ch.fill(0)
        return true
      }

      this.kernel.process(input, output, n)

      this.sinceMeter += n
      if (this.sinceMeter >= METER_INTERVAL_SAMPLES) {
        this.sinceMeter = 0
        // One scratch buffer, reused: postMessage clones synchronously, so the
        // main thread gets its own copy and the worklet allocates nothing on
        // the audio thread.
        const hasDisplay = this.kernel.readDisplay(this.display)
        this.port.postMessage({
          type: 'gr',
          grDb: this.kernel.readMetering(),
          display: hasDisplay ? this.display : null,
        })
      }
      return true
    }
  }

  registerProcessor('resonance-processor', ResonanceWorkletProcessor)
}
