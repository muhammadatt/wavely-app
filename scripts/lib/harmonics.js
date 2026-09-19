/**
 * Harmonic analysis of a steady tone, for the distortion side of the reference
 * captures.
 *
 * The method is a DFT at exact multiples of the probe over an integer number of
 * cycles — no window function, because the window boundary sits on a full cycle
 * and there is nothing to leak. Same approach as `la2a-dcblock-real.mjs` and
 * `test/dsp/la2aTube.test.js`.
 *
 * ⚠ REPORTED IN dBc, RELATIVE TO THE FUNDAMENTAL, AND THAT IS WHAT MAKES IT
 * USABLE HERE. Harmonic content expressed against the fundamental is immune to
 * any linear output trim the plugin applies — insertion gain, a make-up pad,
 * the Output knob, whatever. The LA-2A taper fit had the opposite property: its
 * target was dB of gain reduction, which is NOT immune, and it needed a bypass
 * reference capture and an insertion-gain correction measured and removed first.
 * Nothing here needs that.
 *
 * ⚠ THE FLOOR THAT ACTUALLY APPLIES IS THE STIMULUS TONE'S OWN HARMONIC
 * CONTENT, NOT A FIXED dBc THRESHOLD. A float32 sine is not spectrally pure,
 * and its impurity is per-harmonic and level-dependent: measured on our own
 * tones, H2 sits at −311 dBc and H4 at −291 at every level — clean — but H3
 * wanders between −157 and −186. At −40 dBFS the LALA's H3 was −148.4 dBc, only
 * 8.5 dB above what the stimulus already carried. `compareToFloor` takes the
 * stimulus's own harmonics as the reference, harmonic by harmonic.
 *
 * ⚠ AND A FIXED THRESHOLD DOES NOT CATCH AN UNRENDERED FILE. A capture whose
 * harmonics ALL sit at the stimulus's own never went through the plugin — but
 * H2 of a clean tone is at −311 dBc while H3 is at −157, so one threshold
 * cannot flag both. The per-harmonic comparison can.
 */

const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))

/** Margin above the stimulus's own harmonic at which a reading stops meaning anything. */
export const STIMULUS_MARGIN_DB = 6
/** Every harmonic within this of the stimulus's own means the file never entered the plugin. */
export const UNRENDERED_MARGIN_DB = 3

/**
 * DFT magnitude at `k * freqHz` over an integer number of cycles closest to the
 * requested window.
 */
export function dftMag(y, offset, length, sampleRate, freqHz, k) {
  const cycleSamples = sampleRate / (k * freqHz)
  const cycles = Math.max(1, Math.round(length / cycleSamples))
  const n = Math.min(y.length - offset, Math.round(cycles * cycleSamples))
  let re = 0, im = 0
  for (let i = 0; i < n; i++) {
    const p = 2 * Math.PI * k * freqHz * i / sampleRate
    re += y[offset + i] * Math.cos(p)
    im += y[offset + i] * Math.sin(p)
  }
  return 2 * Math.hypot(re, im) / n
}

/**
 * Harmonics of `freqHz` over [start, start+length) of `y`.
 *
 * @returns {{ fundamentalDbfs, dBc: number[], thdPct, driftWarning }}
 *   `dBc` is [H2, H3, … Hn] relative to H1.
 */
export function harmonicsAt(y, start, length, sampleRate, freqHz, n = 5) {
  const h = []
  for (let k = 1; k <= n; k++) h.push(dftMag(y, start, length, sampleRate, freqHz, k))

  let sq = 0
  for (let k = 1; k < n; k++) sq += h[k] * h[k]
  const thdPct = h[0] > 0 ? 100 * Math.sqrt(sq) / h[0] : NaN

  // ⚠ A SINE'S RMS IS PEAK/sqrt(2). If the exact-frequency DFT disagrees with
  // the broadband RMS by more than a rounding error, the file is probably not
  // at freqHz any more — a sample-rate mismatch on export, or something
  // pitch-shifting in the chain. That failure otherwise reads as enormous
  // distortion.
  let rms = 0
  const end = Math.min(y.length, start + length)
  for (let i = start; i < end; i++) rms += y[i] * y[i]
  rms = Math.sqrt(rms / Math.max(1, end - start))
  const impliedPeak = rms * Math.SQRT2
  const driftWarning = Math.abs(db(h[0]) - db(impliedPeak)) > 1.5
    ? `fundamental DFT reads ${db(h[0]).toFixed(1)} dBFS but broadband RMS implies ` +
      `${db(impliedPeak).toFixed(1)} — check sample rate / pitch`
    : null

  return { fundamentalDbfs: db(h[0]), dBc: h.slice(1).map(v => db(v / h[0])), thdPct, driftWarning }
}

/**
 * Which of `measured.dBc` are meaningfully above the same harmonic of the
 * stimulus, and whether the file looks unrendered.
 *
 * @param {{dBc:number[]}} measured  from the capture
 * @param {{dBc:number[]}} stimulus  the same analysis on the generated tone
 */
export function compareToFloor(measured, stimulus) {
  const usable = measured.dBc.map((v, i) =>
    stimulus ? v > stimulus.dBc[i] + STIMULUS_MARGIN_DB : true)
  const unrendered = stimulus !== null && stimulus !== undefined
    && measured.dBc.every((v, i) => v < stimulus.dBc[i] + UNRENDERED_MARGIN_DB)
  return { usable, unrendered }
}

/** Format a harmonic row, marking readings the stimulus's own floor swallows. */
export function formatDbc(measured, usable) {
  return measured.dBc
    .map((v, i) => (usable[i] ? v.toFixed(1).padStart(7) : '  (flr)'))
    .join(' ')
}

/**
 * Even-order against odd-order content — the discriminator that separates a
 * SATURATOR from a compressor's own detector ripple.
 *
 * ⚠ THIS IS THE CHECK THAT STOPS `fetDrive` BEING FITTED TO THE WRONG
 * MECHANISM, and it is not hypothetical: a compressor with an unsmoothed
 * full-wave detector modulates its gain at 2f on a steady tone, and multiplying
 * a tone by a 2f modulation puts sidebands at f and 3f. So it produces
 * ODD-ORDER ONLY distortion, with H2 and H4 at the numerical floor, while
 * distorting nothing — the waveshaper is not involved at all.
 *
 * It has been measured twice in this repo. LAEA with Peak Reduction engaged
 * showed "~0.06 % of odd-order only content (H2/H4/H6/H8 at the numerical
 * floor) — the cell's detector ripple modulating the gain, not a saturator".
 * And our own FET kernel at `fetDrive: 0` — no saturator in the path by
 * construction — reads 0.020 % THD at 10.9 dB of reduction, H3 at −74 dBc with
 * H2 and H4 at floor.
 *
 * A THD number alone cannot tell those from a real output stage. The even/odd
 * balance can, and it is the difference between fitting a saturator and fitting
 * a ripple.
 */
export function harmonicBalance(measured, usable) {
  // dBc array is [H2, H3, H4, H5, …]; index 0 is H2 (even), 1 is H3 (odd), …
  const even = [], odd = []
  measured.dBc.forEach((v, i) => {
    const order = i + 2
    if (!usable[i]) return                     // at the stimulus's own floor
    ;(order % 2 === 0 ? even : odd).push(v)
  })
  const top = a => (a.length ? Math.max(...a) : null)
  const evenDbc = top(even), oddDbc = top(odd)
  /**
   * ⚠ DOMINANCE, NOT PRESENCE, IS THE TEST — and using presence got it wrong.
   * The stimulus's own H2 sits near −311 dBc, so a capture's H2 at −158 counts
   * as "above the stimulus floor" while being 84 dB under its H3 and carrying
   * no energy worth the name. Our own kernel at `fetDrive: 0` reads exactly
   * that, and a presence test called it a saturator.
   *
   * `SYMMETRY_MARGIN_DB` is the gap at which the weaker parity stops mattering.
   * 10 dB is conservative: the ripple case measures 84 dB, and the real
   * asymmetric shaper measures 3.7 dB the other way.
   */
  const SYMMETRY_MARGIN_DB = 10
  const oddOnly = oddDbc !== null && evenDbc === null
  return {
    evenDbc,
    oddDbc,
    oddOnly,
    /** Odd dominates by enough that a symmetric mechanism is the better reading. */
    oddDominant: oddDbc !== null && (oddOnly || oddDbc - evenDbc > SYMMETRY_MARGIN_DB),
    marginDb: oddDbc !== null && evenDbc !== null ? oddDbc - evenDbc : null,
  }
}
