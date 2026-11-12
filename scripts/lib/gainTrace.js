/**
 * Recovering the gain a compressor applied, from a capture and the stimulus
 * that produced it.
 *
 * ⚠ THIS IS A DIFFERENT METHOD FROM THE ONE THE LA-2A WORK USES, AND THE
 * DIFFERENCE IS FORCED BY THE 1176'S ATTACK.
 *
 * `la2a-ballistics.mjs` recovers an envelope by COHERENT DETECTION — multiply by
 * cos and sin, low-pass at `min(500, f/2.5)`, take the magnitude. Two poles at
 * 500 Hz rise in about 0.8 ms, which resolves the LA-2A's 1-10 ms attack
 * comfortably. It cannot resolve this unit at all: FET Punch's attack dial runs
 * to 20 microseconds, and a demodulator fast enough to see that needs a cutoff
 * around 19 kHz, which needs a probe above 47 kHz. There is no audio-band probe
 * that makes coherent detection work here. Running it anyway would report every
 * dial position from about 5 upward as the same number — the detector's own
 * rise time — and that number would look like a measurement.
 *
 * WHAT WORKS INSTEAD: DIVIDE. We wrote the stimulus, so the dry signal is known
 * exactly at every sample rather than estimated. The applied gain is then
 * `wet[i] / dry[i]` directly, with no filter anywhere in the path and therefore
 * no rise time of its own. Resolution is the capture's sample period, not a
 * detector's bandwidth.
 *
 * ⚠ THE COST IS THE ZERO CROSSINGS, and it is small but it is not nothing.
 * Division is ill-conditioned where the probe passes through zero, so those
 * samples are dropped. The blind window is `asin(floor)/(pi*f)` seconds, twice
 * per cycle — at a 4 kHz probe and floor 0.1 that is 8.0 us, which is BELOW the
 * 20 us fastest attack and above the 10.4 us sample period at 96 kHz. At a
 * 1 kHz probe the same floor blinds 31.9 us, which is WIDER than the fastest
 * attack. `blindWindowUs` reports it so a probe is never read as a resolution
 * it does not support, and it is why the fast plans use a high probe.
 *
 * ⚠ AND THE SATURATOR RIDES ON THE RESULT. The capture is
 * `fet(dry * inputLin * g) * outGain`, not `dry * g`, so a recovered trace
 * carries the output stage's instantaneous compression of the waveform as a
 * RIPPLE AT TWICE THE PROBE FREQUENCY — deepest at the waveform peaks, zero at
 * the crossings. That is not an error to suppress: it is the static
 * nonlinearity, observed separately from the compression, which is the same
 * quantity `la2a-pair-compare.mjs` isolates as "peak rounding" and gets at a
 * harder way. `rippleDb` measures it. What it does mean is that a BALLISTICS
 * fit must read the ripple's mean and not its extremes, which is what
 * `smoothRipple` is for.
 */

const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))

/**
 * Seconds per cycle during which |probe| sits below `floor` of its amplitude,
 * summed over the two crossings — i.e. how long the trace is blind for, twice
 * per cycle. Report it next to any attack number taken from the trace.
 */
export function blindWindowUs(freqHz, floor) {
  return 1e6 * Math.asin(Math.min(1, floor)) / (Math.PI * freqHz)
}

/**
 * Per-sample applied gain, linear, NaN where the probe was too near zero.
 *
 * @param {Float32Array} capture
 * @param {Float64Array} env     - the stimulus's exact instantaneous amplitude
 * @param {Float32Array} dry     - the stimulus waveform
 * @param {object} [opts]
 * @param {number} [opts.lag=0]  - capture sample index = stimulus index + lag
 * @param {number} [opts.floor=0.1] - drop samples below this fraction of `env`
 */
export function traceGain(capture, env, dry, { lag = 0, floor = 0.1 } = {}) {
  const n = Math.min(dry.length, env.length)
  const g = new Float64Array(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    const j = i + lag
    if (j < 0 || j >= capture.length) continue
    const d = dry[i]
    const a = d < 0 ? -d : d
    if (!(a >= floor * env[i]) || a === 0) continue
    g[i] = capture[j] / d
  }
  return g
}

/**
 * Fill the zero-crossing gaps by linear interpolation between the nearest valid
 * samples on each side.
 *
 * ⚠ ONLY SHORT GAPS. A gap wider than `maxGapSamples` is left as NaN — that is
 * not a zero crossing, it is a demo mute or a dropout, and interpolating across
 * one draws a straight line through a second of silence and calls it a gain.
 */
export function fillShortGaps(g, maxGapSamples) {
  const out = Float64Array.from(g)
  let i = 0
  while (i < out.length) {
    if (Number.isFinite(out[i])) { i++; continue }
    let j = i
    while (j < out.length && !Number.isFinite(out[j])) j++
    const left = i > 0 ? out[i - 1] : NaN
    const right = j < out.length ? out[j] : NaN
    if (j - i <= maxGapSamples && Number.isFinite(left) && Number.isFinite(right)) {
      for (let k = i; k < j; k++) out[k] = left + (right - left) * (k - i + 1) / (j - i + 1)
    }
    i = j
  }
  return out
}

/**
 * Mean of the trace over one probe period, centred, so the saturator's 2f
 * ripple averages out and the ballistic trajectory is what is left.
 *
 * ⚠ A CENTRED WINDOW IS CORRECT HERE AND WRONG ON A LEVEL MEASUREMENT. It is
 * zero-phase, which on a GAIN STEP would smear the step backwards in time and
 * make a causal compressor look like it had lookahead — the one artefact that
 * would fake a fast attack. It is used only where the ripple must go and the
 * edge must not: read an attack time off the RAW trace and use this for the
 * settled regions. `la2a-pair-compare.mjs` refuses a zero-phase smoother
 * outright for exactly this reason; the difference is that it has no known dry
 * signal and therefore no way to separate the two.
 */
export function smoothRipple(g, samplesPerPeriod) {
  const h = Math.max(1, Math.round(samplesPerPeriod / 2))
  const out = new Float64Array(g.length).fill(NaN)
  for (let i = 0; i < g.length; i++) {
    let s = 0, c = 0
    for (let k = Math.max(0, i - h); k <= Math.min(g.length - 1, i + h); k++) {
      if (Number.isFinite(g[k])) { s += g[k]; c++ }
    }
    if (c > samplesPerPeriod / 2) out[i] = s / c
  }
  return out
}

/**
 * Depth of the 2f ripple over a settled span, in dB — the static nonlinearity,
 * separated from the compression. Zero for a pure time-varying gain.
 */
export function rippleDb(g, from, to) {
  let lo = Infinity, hi = -Infinity, c = 0
  for (let i = from; i < to && i < g.length; i++) {
    if (!Number.isFinite(g[i])) continue
    if (g[i] < lo) lo = g[i]
    if (g[i] > hi) hi = g[i]
    c++
  }
  return c > 8 ? db(hi) - db(lo) : NaN
}

/**
 * Per-block least-squares gain for PROGRAM material, where there is no known
 * probe to divide by: `g[k] = <wet,dry> / <dry,dry>` over each block.
 *
 * The program counterpart to `traceGain` — same quantity, much coarser in time,
 * and the only option when the dry signal is a recording rather than something
 * we generated. Lifted from `la2a-pair-compare.mjs` so the FET pair work and
 * the LA-2A pair work report the same statistic computed the same way.
 *
 * NOT a smoothed envelope ratio: a zero-phase smoother would smear a gain step
 * backwards in time and make a causal compressor look like it had lookahead.
 *
 * @returns {{ g: Float64Array, lvl: Float64Array }} gain per block (NaN below
 *   the gate) and the dry block RMS that produced it.
 */
export function blockGain(dry, wet, blockSize, gateDb = -45) {
  const n = Math.floor(dry.length / blockSize)
  const g = new Float64Array(n).fill(NaN)
  const lvl = new Float64Array(n)
  const gate = Math.pow(10, gateDb / 20)
  for (let k = 0; k < n; k++) {
    let num = 0, den = 0
    for (let i = k * blockSize; i < (k + 1) * blockSize; i++) { num += wet[i] * dry[i]; den += dry[i] * dry[i] }
    const r = Math.sqrt(den / blockSize)
    lvl[k] = r
    if (r > gate && den > 0) g[k] = num / den
  }
  return { g, lvl }
}
