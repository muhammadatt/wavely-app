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
 *      scaled by `depth`, clipped to `maxReductionDb`
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
 *     constant width in octaves rather than a constant count of bins. Both are
 *     the same correction: the server's constants make the detector's
 *     resolution a function of the speaker's pitch and of where on the
 *     frequency axis a defect happens to sit. Measured on a broad +10 dB hump
 *     swept 500 Hz → 6 kHz, the server's geometry removes 25.2 / 15.4 / 10.2 /
 *     6.3 dB; this one removes 11.3 / 12.3 / 10.2 / 9.6. `server/scripts/
 *     resonance_suppressor.py` still has the original geometry.
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
  resonanceDisplayRange,
} from './resonanceParams.js'

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
  depth: 0.67,
  sharpness: 0.8,
  selectivity: 8,
  attackMs: 15,
  releaseMs: 80,
  maxReductionDb: 36,
  freqFloorHz: 40,
  freqCeilHz: 20000,
  pitchMinHz: DEFAULT_PITCH_MIN_HZ,
  pitchMaxHz: DEFAULT_PITCH_MAX_HZ,
  mode: 'soft', // 'soft' | 'hard'
  preserveHarmonics: true,
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
    this.displayOut = new Float32Array(this.displayBins)
    this.displayGrNow = new Float32Array(this.displayBins)
    this.displayGrHeld = new Float32Array(this.displayBins)
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
        for (let k = 0; k < bins; k++) {
          const d = 1 - g[k]
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
    const prevCeilHz = this.freqCeilHz
    const p = { ...this.params, ...partial }
    this.params = p

    this.depth = clamp(p.depth, 0, 1)
    this.selectivity = Math.max(0, p.selectivity)
    this.maxReductionDb = Math.max(0, p.maxReductionDb)
    this.softKnee = p.mode !== 'hard'
    this.kneeWidth = Math.max(this.selectivity * 0.5, 1e-6)
    this.preserveHarmonics = !!p.preserveHarmonics

    const nyquist = this.sampleRate / 2
    this.freqFloorHz = clamp(p.freqFloorHz, 0, nyquist)
    this.freqCeilHz = clamp(p.freqCeilHz, this.freqFloorHz, nyquist)
    for (let k = 0; k < this.binCount; k++) {
      const f = k * this.binWidth
      this.activeBins[k] = f >= this.freqFloorHz && f <= this.freqCeilHz ? 1 : 0
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

    // Gaussian spread, width set by sharpness — in OCTAVES, not bins.
    // Per-bin geometry, since a constant width in octaves is a width in bins
    // that grows with frequency. See SPREAD_MAX_OCTAVES.
    const sharpness = clamp(p.sharpness, 0, 1)
    const spreadOct = SPREAD_MAX_OCTAVES * (1 - sharpness)
    this.spreadEnabled = spreadOct > 1e-3
    if (this.spreadEnabled) {
      if (!this.spreadHalfBins) {
        this.spreadHalfBins = new Int32Array(this.binCount)
        this.spreadInvSigma = new Float64Array(this.binCount)
      }
      // Half-width and sigma as a FRACTION of the bin index: a span of
      // ±`oct` octaves around bin k covers k·(2^oct − 2^-oct)/2 bins either
      // side, to first order symmetric about k.
      const halfFrac = (Math.pow(2, spreadOct) - Math.pow(2, -spreadOct)) / 2
      const sigmaOct = spreadOct / 3
      const sigmaFrac = (Math.pow(2, sigmaOct) - Math.pow(2, -sigmaOct)) / 2
      for (let k = 0; k < this.binCount; k++) {
        const half = Math.min(Math.round(k * halfFrac), SPREAD_MAX_HALF_BINS)
        this.spreadHalfBins[k] = half
        const sigma = k * sigmaFrac
        this.spreadInvSigma[k] = sigma > 1e-9 ? 1 / sigma : 0
      }
    }

    // Cepstral lifter target. Sharpness picks an absolute envelope feature
    // scale; the per-frame F0 clamps it. See LIFTER_SCALE_COARSE_HZ.
    const targetHz = LIFTER_SCALE_COARSE_HZ
      * Math.pow(LIFTER_SCALE_FINE_HZ / LIFTER_SCALE_COARSE_HZ, sharpness)
    this.lifterTarget = Math.max(20, Math.round(this.sampleRate / targetHz))

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

    // The harmonic walk now ends at freqCeilHz, so that is the only param the
    // cached masks depend on. Compare values rather than key presence: the
    // effect wrapper posts the full param object on every knob move, so an
    // `in partial` test is true on every twist and never lets the cache survive.
    if (this.freqCeilHz !== prevCeilHz) this.maskCache.clear()
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
    this.displayGrHeld.fill(0)
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
   * Everything here is this frame's except the held reduction, which is the
   * maximum since the last read. The display is read at half the frame rate, so
   * a peak landing on the unread frame would otherwise be lost — but only the
   * peak-hold outline wants that value. Anything drawn against the spectrum
   * uses the live curve, so the two agree about the same instant.
   *
   * The reference goes out without `selectivity` added — the panel adds it when
   * drawing, so turning the knob moves the threshold line immediately rather
   * than on the next frame out of the worklet.
   */
  _snapshotDisplay() {
    const {
      magDb, envDb,
      displayMag, displayEnv, displayOut, displayGrNow, displayGrHeld,
    } = this
    // Post-blend reductions — the notch the listener actually gets. Aliases
    // prevGr whenever mix and trim are at their neutral settings.
    const prevGr = this.grDisplay ?? this.prevGr
    const last = this.binCount - 1

    for (let d = 0; d < this.displayBins; d++) {
      const lo = this.dLo[d]
      const hi = this.dHi[d]
      let mag
      let env
      let out
      let gr
      if (hi >= lo) {
        mag = -Infinity
        env = 0
        out = -Infinity
        gr = 0
        for (let k = lo; k <= hi; k++) {
          if (magDb[k] > mag) mag = magDb[k]
          env += envDb[k]
          // The output is summarised from the same bin as its own magnitude,
          // not assembled afterwards from the loudest bin and the most
          // suppressed one — those are different bins most of the time, and
          // the difference between them is a notch that never happened.
          const o = magDb[k] - prevGr[k]
          if (o > out) out = o
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
        const o0 = magDb[k0] - prevGr[k0]
        out = o0 + (magDb[k1] - prevGr[k1] - o0) * t
        gr = prevGr[k0] > prevGr[k1] ? prevGr[k0] : prevGr[k1]
      }
      displayMag[d] = mag - SPECTRUM_REF_DB
      displayEnv[d] = env - SPECTRUM_REF_DB
      displayOut[d] = out - SPECTRUM_REF_DB
      displayGrNow[d] = gr
      if (gr > displayGrHeld[d]) displayGrHeld[d] = gr
    }
    this.hasDisplayFrame = true
  }

  /** Floats one display read needs. */
  get displayLength() {
    return RESONANCE_DISPLAY_CURVES * this.displayBins
  }

  /**
   * Copy the display grid into `out` as
   * [magnitude, reference, output, reduction, held reduction] and clear the
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
    out.set(this.displayOut, 2 * D)
    out.set(this.displayGrNow, 3 * D)
    out.set(this.displayGrHeld, 4 * D)
    this.displayGrHeld.fill(0)
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
      if (freq > this.freqCeilHz || freq >= nyquist) break
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
  _analyzeFrame(specRe, specIm, stft) {
    const {
      magDb, envDb, reduction, spread, prevGr, gain, activeBins, binCount,
      selectivity, depth, maxReductionDb, softKnee, kneeWidth,
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
    const lifterCutoff = Math.min(this.lifterTarget, lifterCeiling)

    this._cepstralEnvelope(lifterCutoff)

    const mask = this.preserveHarmonics && pitched ? this._harmonicMask(f0) : null

    // Spike detection → soft knee → depth → clip.
    for (let k = 0; k < binCount; k++) {
      if (!activeBins[k]) {
        reduction[k] = 0
        continue
      }
      const above = magDb[k] - envDb[k] - selectivity
      if (above <= 0) {
        reduction[k] = 0
        continue
      }
      const curve = softKnee && above < kneeWidth
        ? (above * above) / (2 * kneeWidth)
        : above
      const r = curve * depth
      reduction[k] = r > maxReductionDb ? maxReductionDb : r
    }

    // Harmonic protection, pre-spread: zero these before the kernel runs so a
    // harmonic's own prominence is never smeared into the gaps beside it.
    if (mask) {
      for (let k = 0; k < binCount; k++) if (mask[k]) reduction[k] = 0
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
          const v = reduction[k]
          spread[k] = v > maxReductionDb ? maxReductionDb : v
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
        spread[k] = acc > maxReductionDb ? maxReductionDb : acc
      }
      // Post-spread: re-protect harmonics that neighbouring spikes bled into,
      // and hard-limit the reduction to the active band. Without a spread
      // kernel neither is needed — the pre-spread pass already zeroed the mask,
      // and the detection loop never wrote outside the active band.
      for (let k = 0; k < binCount; k++) {
        reduction[k] = (mask && mask[k]) || !activeBins[k] ? 0 : spread[k]
      }
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
