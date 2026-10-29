/**
 * VOICE DETECTOR — what VoxPressor's compressors listen to.
 *
 * A linear filter on the mono detector signal, never on the audio. The two
 * compressors it feeds take it through their `sidechain` argument
 * (`LA2AKernel.process`, `FET1176Kernel.process`), so it changes WHAT trips
 * them and nothing about how they sound once tripped.
 *
 *   x ─ HP @ voice corner ─ [plosive low shelf] ─ sibilance high shelf ─ sc
 *
 * 1. HIGH-PASS AT THE SPEAKER'S RUMBLE CORNER, second-order Butterworth. The
 *    corner is `measureVoiceProfile().cornerHz` — the same number VoiceRx and
 *    Reso Soothe aim at, 40–100 Hz — so "where this voice stops" has one
 *    definition in the app. `DEFAULT_CORNER_HZ` when the profile cannot be
 *    measured.
 *
 * 2. PLOSIVE LOW SHELF, −10 dB below 150 Hz. A "p" or "b" that passes the
 *    high-pass is still mostly energy under ~150 Hz, and to an opto cell with a
 *    seconds-long release it reads as the loudest thing in the phrase. The
 *    shelf leaves vowels — whose energy sits above it — in charge.
 *    ⚠ OPTIONAL PER TAP, and the Peaks (1176) tap turns it OFF: a plosive is
 *    often the loudest peak in a narration take, and the FET lets go in tens of
 *    ms, so catching one costs a few ms of gain. Peaks the FET cannot see are
 *    peaks the Peaks knob cannot trim.
 *
 * 3. SIBILANCE HIGH SHELF, −9 dB above 5 kHz. The compressors should ride the
 *    vowels; "s" is the de-esser's job, and both cutting on one "s" lisps it.
 *
 * ⚠ EVERY DEPTH AND CORNER HERE IS REASONED, not measured or auditioned. They
 * are module constants so the bench can move them; nothing saves them.
 */
import { BiquadCascade, highpass, lowShelf, highShelf } from './biquad.js'

export const DEFAULT_CORNER_HZ = 80
export const CORNER_MIN_HZ = 40
export const CORNER_MAX_HZ = 100

export const PLOSIVE_SHELF_HZ = 150
export const PLOSIVE_SHELF_DB = -10
export const SIBILANCE_SHELF_HZ = 5000
export const SIBILANCE_SHELF_DB = -9
const SHELF_Q = Math.SQRT1_2

/**
 * The detector's biquad sections for a tap, in order. Exported so the panel can
 * draw the response with the exact coefficients the kernel runs.
 */
export function voiceDetectorSections(sampleRate, { cornerHz = DEFAULT_CORNER_HZ, plosive = true, sibilance = true } = {}) {
  const corner = Number.isFinite(cornerHz)
    ? Math.min(CORNER_MAX_HZ, Math.max(CORNER_MIN_HZ, cornerHz))
    : DEFAULT_CORNER_HZ
  const sections = [highpass(sampleRate, corner, Math.SQRT1_2)]
  if (plosive) sections.push(lowShelf(sampleRate, PLOSIVE_SHELF_HZ, SHELF_Q, PLOSIVE_SHELF_DB))
  // The shelf frequency is clamped below Nyquist for low sample rates.
  if (sibilance) sections.push(highShelf(sampleRate, Math.min(SIBILANCE_SHELF_HZ, sampleRate * 0.4), SHELF_Q, SIBILANCE_SHELF_DB))
  return sections
}

/**
 * One tap of the detector: mono mix in, filtered detector signal out.
 *
 * Changing the corner swaps coefficients without resetting state — the corner
 * is measured once per file and moves rarely, and a reset would put a
 * transient into the detector at the moment it does.
 */
export class VoiceDetector {
  constructor(sampleRate, { plosive = true, sibilance = true } = {}) {
    this.sampleRate = sampleRate
    this.plosive = plosive
    this.sibilance = sibilance
    this.cornerHz = DEFAULT_CORNER_HZ
    this.cascade = new BiquadCascade(1 + (plosive ? 1 : 0) + (sibilance ? 1 : 0), 1)
    this.cascade.setSections(voiceDetectorSections(sampleRate, { cornerHz: this.cornerHz, plosive, sibilance }))
    this.mono = new Float32Array(0)
    this.out = new Float32Array(0)
  }

  setCornerHz(hz) {
    const next = Number.isFinite(hz) ? hz : DEFAULT_CORNER_HZ
    if (next === this.cornerHz) return
    this.cornerHz = next
    this.cascade.setSections(voiceDetectorSections(this.sampleRate, { cornerHz: next, plosive: this.plosive, sibilance: this.sibilance }))
  }

  reset() {
    this.cascade.reset()
  }

  /**
   * @param {Float32Array[]} channels  audio, any channel count
   * @param {number} n
   * @returns {Float32Array} the detector signal for this block (kernel scratch:
   *   valid until the next call)
   */
  process(channels, n) {
    if (this.mono.length < n) {
      this.mono = new Float32Array(n)
      this.out = new Float32Array(n)
    }
    const nIn = channels.length
    const mono = this.mono
    if (nIn === 1) {
      mono.set(channels[0].subarray(0, n))
    } else {
      // Same mono tap the kernels take on their own: the mean of the channels.
      const scale = 1 / nIn
      for (let i = 0; i < n; i++) {
        let x = channels[0][i]
        for (let ch = 1; ch < nIn; ch++) x += channels[ch][i]
        mono[i] = x * scale
      }
    }
    this.cascade.process(mono, this.out, n, 0)
    return this.out.subarray(0, n)
  }
}
