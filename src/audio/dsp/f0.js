/**
 * Per-frame F0 estimation via FFT autocorrelation.
 *
 * Dependency-free — imported by AudioWorklet kernels.
 *
 * Direct port of server/scripts/estimate_f0_contour.py (`_autocorr_f0_batch`):
 * zero-mean the frame, autocorrelate via |rfft|² → irfft at 2× length, take the
 * peak within the lag range implied by the search bounds, gate on
 * MIN_CORR_RATIO, then parabolically interpolate the peak.
 *
 * The Python hard-codes a speech range; here it is settable per consumer via
 * `setRange`, because these effects run on whatever the user loaded rather than
 * on a narrator. F0_MIN_HZ / F0_MAX_HZ remain the speech defaults.
 *
 * The Python runs this over a whole file at once; the algorithm itself is
 * strictly per-frame and causal, which is what makes realtime harmonic
 * protection possible in the resonance suppressor without an analyze pass.
 *
 * One thing the whole-file version has that a streaming tracker cannot: a
 * whole-file median, used to set the cepstral lifter cutoff. Substituted by a
 * rolling median over recent pitched frames, matching the deque pattern
 * sibilance_detector.py already uses for its band tracking.
 *
 * WHAT THIS IS NOT: a voice activity detector. The server pairs this estimator
 * with Silero VAD, and the two answer different questions — Silero says "is
 * someone speaking", this says "is there a periodic component in range". Every
 * fricative is the first without being the second. Substituting one for the
 * other silently narrows behaviour, which is a mistake this file has already
 * caused once (see the note on `pitched` in `estimate`).
 */

import { getFFT } from './fft.js'

export const F0_MIN_HZ = 70.0
export const F0_MAX_HZ = 400.0
/**
 * Correlation ratio a frame must clear to count as pitched.
 *
 * KEPT AT THE SERVER'S VALUE AS THE DEFAULT, and it is far too permissive for
 * anything that acts on the pitch it returns. Measured on 46 s of narration
 * against an independent check of whether the harmonic comb is even
 * measurable: of the frames landing in ratio 0.1-0.2, TWO PERCENT have a comb
 * clear enough to verify, against 71% of frames above 0.7. Everything in
 * between is the tracker reporting a confident pitch for a frame that does not
 * have one, and the estimate there is close to arbitrary.
 *
 * Not lowered globally because three other consumers are calibrated against
 * this number (voicerx/analysis.js, which already works around the same
 * permissiveness with its own energy margin, voicerx/v2/envelope.js, and
 * humDetect.js). Callers that act on the pitch pass their own `minRatio`.
 */
export const MIN_CORR_RATIO = 0.1

/** Rolling-median window, matching sibilance_detector.py's F0_ROLLING_WINDOW_SIZE. */
export const DEFAULT_MEDIAN_WINDOW = 10

/**
 * Longest lag worth searching, as a fraction of the frame.
 *
 * Autocorrelation at lag L only has frameSize − L samples of overlap to work
 * with, so the estimate degrades as L approaches the frame length. Half the
 * frame is the conventional stopping point; past it the peak is being formed by
 * a handful of samples and the tracker starts inventing pitches. At 2048
 * samples / 44.1 kHz this puts the hard floor at 43.07 Hz.
 */
const MAX_LAG_FRACTION = 0.5

/** Lowest pitch this frame size can estimate at all. */
export function pitchFloorHz(sampleRate, frameSize) {
  return sampleRate / Math.floor(frameSize * MAX_LAG_FRACTION)
}

export class F0Tracker {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate
   * @param {number} [opts.frameSize=2048] must match the consumer's STFT n_fft
   * @param {number} [opts.medianWindow=10]
   * @param {number} [opts.defaultF0=null] seed used before the first pitched frame
   * @param {number} [opts.minHz=70] low end of the pitch search
   * @param {number} [opts.maxHz=400] high end of the pitch search
   * @param {number} [opts.minRatio=0.1] correlation ratio required to be pitched
   * @param {number} [opts.holdFrames=0] frames to carry the last confident pitch
   */
  constructor({
    sampleRate,
    frameSize = 2048,
    medianWindow = DEFAULT_MEDIAN_WINDOW,
    defaultF0 = null,
    minHz = F0_MIN_HZ,
    maxHz = F0_MAX_HZ,
    minRatio = MIN_CORR_RATIO,
    holdFrames = 0,
  }) {
    this.sampleRate = sampleRate
    this.frameSize = frameSize
    this.medianWindow = medianWindow
    this.defaultF0 = defaultF0

    // Autocorrelation runs at 2× the frame length, as in the Python.
    this.corrSize = 2 * frameSize
    this.fft = getFFT(this.corrSize)

    this.setRange(minHz, maxHz)

    const bins = (this.corrSize >>> 1) + 1
    this._re = new Float64Array(bins)
    this._im = new Float64Array(bins)
    this._centred = new Float64Array(frameSize)
    this._corr = new Float64Array(this.corrSize)

    this.minRatio = minRatio
    this.holdFrames = holdFrames

    this._history = []
    this._sorted = []
    this.lastF0 = null
    this._heldF0 = 0
    this._sinceConfident = Infinity
  }

  /**
   * Set the pitch search range, clamped to what this frame size can resolve.
   *
   * The server only ever tracked speech, so the range was a constant. A
   * realtime effect is pointed at whatever the user loaded, and a source
   * outside the search range does not fail quietly — the peak picker returns
   * the best lag *within* the range, which for an out-of-range pitch is an
   * octave artefact reported with full confidence. Widening the range is the
   * only way to avoid that, and it is nearly free: the FFT is sized from the
   * frame, not the range, so this only moves the bounds of a linear scan.
   *
   * @returns {{ minHz: number, maxHz: number }} the clamped range actually used
   */
  setRange(minHz, maxHz) {
    const floor = pitchFloorHz(this.sampleRate, this.frameSize)
    const ceil = this.sampleRate / 2
    let lo = Math.max(floor, Math.min(minHz, ceil))
    let hi = Math.max(lo, Math.min(maxHz, ceil))
    // One lag apart at minimum, or the scan below has nothing to look at.
    if (Math.floor(this.sampleRate / lo) <= Math.floor(this.sampleRate / hi)) {
      hi = this.sampleRate / Math.max(1, Math.floor(this.sampleRate / lo) - 1)
    }
    this.minHz = lo
    this.maxHz = hi
    this.lagMin = Math.floor(this.sampleRate / hi)
    this.lagMax = Math.floor(this.sampleRate / lo)
    return { minHz: lo, maxHz: hi }
  }

  reset() {
    this._history.length = 0
    this.lastF0 = null
    this._heldF0 = 0
    this._sinceConfident = Infinity
  }

  /**
   * Estimate F0 for one frame.
   *
   * @param {ArrayLike<number>} frame length === frameSize, unwindowed
   * @param {boolean} [energyGate=true] caller's activity gate (e.g. above a noise floor)
   * @returns {{ f0: number|null, pitched: boolean, ratio: number }}
   *
   * `pitched` means a periodic component was found in range — NOT that the
   * frame contains speech. The distinction matters: Silero, which this stands
   * in for on the server, labels fricatives and breaths as speech while this
   * returns false for them. Callers that gate audible behaviour on speech
   * presence must not use this flag for it.
   *
   * `held` marks a frame whose pitch was CARRIED FROM AN EARLIER FRAME rather
   * than measured on this one — see `holdFrames`. The hold exists because
   * raising `minRatio` on its own is a bad trade for anything that acts on the
   * pitch: it converts a badly-estimated pitch into no pitch, and for the
   * resonance suppressor that means harmonic protection switching off in the
   * middle of a word, which is worse than a slightly stale mask. Measured on
   * narration, a gate of 0.7 alone takes the share of active frames carrying
   * any pitch from 99% to 69%; the same gate with a 16-frame hold puts it back
   * to 90% while frame-to-frame jumps over a tritone fall from 14.0% to 0.8%.
   *
   * A held frame is not a measurement and does not enter the rolling median.
   */
  estimate(frame, energyGate = true) {
    const n = this.frameSize
    if (n < 64 || this.lagMax >= n || this.lagMin >= this.lagMax) {
      return { f0: null, pitched: false, ratio: 0 }
    }

    // Zero-mean, matching `f64 - f64.mean(axis=1)`.
    let mean = 0
    for (let i = 0; i < n; i++) mean += frame[i]
    mean /= n
    const centred = this._centred
    for (let i = 0; i < n; i++) centred[i] = frame[i] - mean

    // Autocorrelation via the Wiener-Khinchin route: irfft(|rfft(x)|²).
    this.fft.rfft(centred, this._re, this._im)
    const bins = (this.corrSize >>> 1) + 1
    for (let k = 0; k < bins; k++) {
      const re = this._re[k]
      const im = this._im[k]
      this._re[k] = re * re + im * im
      this._im[k] = 0
    }
    this.fft.irfft(this._re, null, this._corr)

    const corr = this._corr
    const corr0 = corr[0]

    let peak = -Infinity
    let peakLag = -1
    for (let lag = this.lagMin; lag < this.lagMax; lag++) {
      if (corr[lag] > peak) {
        peak = corr[lag]
        peakLag = lag
      }
    }

    const ratio = corr0 > 0 ? peak / corr0 : 0
    /**
     * A PEAK PINNED AT THE EDGE OF THE SEARCH WINDOW IS NOT A MEASUREMENT.
     *
     * The search runs over [lagMin, lagMax), so a peak sitting on either
     * boundary is the largest value in the window rather than a maximum of the
     * correlation — the real peak is very likely outside the range that was
     * asked for. Reporting it anyway is how a periodic source outside the range
     * gets a confident, stable, wrong pitch.
     *
     * Found through humDetect: pure 60 Hz hum has a period of 735 samples,
     * outside the voice range's lag window entirely, and the tracker pinned
     * every frame at the short-lag end and reported a rock-steady 402.7 Hz.
     * That defeated humDetect's concentration veto, whose whole job is to
     * distinguish an autocorrelation lock on mains hum from a real voice. It
     * had been passing only because the unbounded parabolic interpolation
     * scattered those pinned frames into incoherence — a check passing for the
     * wrong reason, which stops passing the moment the reason is fixed.
     *
     * A BOUNDARY PEAK IS TRUSTED IFF IT IS A GENUINE LOCAL MAXIMUM. Rejecting
     * every edge peak was tried first and is wrong in the obvious way: a source
     * sitting exactly at the top of the range — a 400 Hz saw in a 70–400 search
     * — also pins at the edge, and a tracker that cannot report its own limit
     * is broken. The correlation is computed at every lag and only the SEARCH
     * is bounded, so the neighbours either side are available whether or not
     * they are in range: a real peak has both of them lower, and a peak that is
     * merely the largest value in a truncated window does not.
     */
    const edge = peakLag === this.lagMin || peakLag === this.lagMax - 1
    const localMax = peakLag > 0 && peakLag < this.corrSize - 1
      && corr[peakLag - 1] < peak && corr[peakLag + 1] < peak
    const confident = peakLag > 0 && (!edge || localMax)
      && peak > this.minRatio * corr0 && energyGate
    if (!confident) {
      this._sinceConfident++
      if (
        this.holdFrames > 0
        && this._heldF0 > 0
        && this._sinceConfident <= this.holdFrames
        && energyGate
      ) {
        return { f0: this._heldF0, pitched: true, ratio, held: true }
      }
      return { f0: null, pitched: false, ratio, held: false }
    }

    // Parabolic interpolation around the peak.
    //
    // THE OFFSET IS CLAMPED TO HALF A SAMPLE, and leaving it unbounded — as the
    // Python this was ported from does — is a defect with visible consequences.
    // The parabola through three samples only locates a peak that lies between
    // them; when the correlation is flat or slightly concave the denominator
    // approaches zero and the offset runs away, so `peakLag + delta` can land
    // near zero or go negative. Measured on 46 s of narration at the shipping
    // VOICE range: 4.3% of pitched frames reported an F0 OUTSIDE the range they
    // had been asked to search, the highest at 5664 Hz and two of them
    // negative; on the WIDE range, 6.8%, with 60 negatives and a peak of
    // 23881 Hz. Those estimates set the harmonic mask's comb spacing and the
    // cepstral lifter's ceiling, so a frame with a nonsense F0 puts the mask on
    // the wrong bins entirely.
    //
    // AND NOTHING MORE. Clamping the RESULT into the range as well was tried
    // and is actively harmful: it turns a nonsense estimate into a plausible
    // one sitting exactly on the limit, so a run of garbage reads as a tight,
    // coherent contour. humDetect's concentration veto — which exists to stop
    // an autocorrelation lock onto mains hum being mistaken for a voice —
    // stopped firing, because every frame agreed on 399 Hz. Bounding the offset
    // is the fix; bounding the answer only hides what is left.
    let f0 = this.sampleRate / peakLag
    if (peakLag > 0 && peakLag < n - 1) {
      const y0 = corr[peakLag - 1]
      const y1 = corr[peakLag]
      const y2 = corr[peakLag + 1]
      const denom = y0 - 2 * y1 + y2
      if (denom !== 0) {
        const raw = (0.5 * (y0 - y2)) / denom
        const delta = raw > 0.5 ? 0.5 : raw < -0.5 ? -0.5 : raw
        f0 = this.sampleRate / (peakLag + delta)
      }
    }

    this.lastF0 = f0
    this._heldF0 = f0
    this._sinceConfident = 0
    this._history.push(f0)
    if (this._history.length > this.medianWindow) this._history.shift()

    return { f0, pitched: true, ratio, held: false }
  }

  /**
   * Rolling median of recent pitched estimates, or the seed default before any
   * pitched frame has been seen. Drives the cepstral lifter cutoff.
   */
  get median() {
    const h = this._history
    if (h.length === 0) return this.defaultF0
    const s = this._sorted
    s.length = h.length
    for (let i = 0; i < h.length; i++) s[i] = h[i]
    s.sort((a, b) => a - b)
    const mid = s.length >> 1
    return s.length % 2 ? s[mid] : 0.5 * (s[mid - 1] + s[mid])
  }
}
