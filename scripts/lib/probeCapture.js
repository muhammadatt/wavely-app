/**
 * Reading a reference capture and checking the things a capture can get wrong
 * SILENTLY.
 *
 * Every one of these was a real failure on the LA-2A work, and every one of
 * them misdiagnoses itself — each looks like a compressor measurement rather
 * than an error, which is why they are checked up front rather than inferred
 * later from a thin table.
 *
 * ⚠ THIS DOES NOT REPLACE THE COPIES IN `la2a-ballistics.mjs`, DELIBERATELY.
 * Those are written against a module-level 44.1 kHz constant; these take the
 * rate as an argument, which the FET suite needs (96 or 192 kHz). Merging them
 * would be an unverifiable refactor: `data/corpus/la2a-ballistics/captures/` is
 * gitignored and empty in a fresh clone, so there is no way to prove the LA-2A
 * fitting path still behaves. The stimulus side WAS merged, because its output
 * is checkable byte-for-byte. Merge these when a capture set is on hand to
 * check against, and not before.
 */

import { readWav } from './wav.js'
import { MUTE_PERIOD_S, MUTE_LEN_S } from './demoMute.js'

const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))

/**
 * Read a capture and refuse the two mismatches nothing downstream can recover.
 *
 * @param {string} path
 * @param {number} expectSampleRate  the rate the stimulus was written at
 */
export function readCapture(path, expectSampleRate) {
  const { mono, sampleRate, seconds, bitDepth } = readWav(path)
  if (sampleRate !== expectSampleRate) {
    throw new Error(
      `${path}: captured at ${sampleRate} Hz but the stimulus is ${expectSampleRate} Hz. ` +
      'Re-bounce at the stimulus rate — resampling here would measure the resampler.')
  }
  return { y: mono, sampleRate, seconds, bitDepth }
}

/**
 * Is this capture just the stimulus back again?
 *
 * ⚠ THE FAILURE THIS CATCHES MISDIAGNOSES ITSELF. A bypassed insert, or a
 * bounce that exported the source instead of the processed track, produces a
 * file bit-identical to the stimulus — and every downstream reading then says
 * "no compression", which looks exactly like "the knob is too low". Measured
 * once: five ramps at knobs 30 through 90 all came back 100 % identical, and
 * the fitter reported five knobs that never reached 1 dB.
 *
 * Bit-identity is the right test rather than a small threshold: even at unity
 * gain and no reduction, a real plugin's output stage changes SOMETHING. Zero
 * difference across every sample means the audio never entered it.
 */
export function isUnprocessed(capture, stimulus) {
  const n = Math.min(capture.length, stimulus.length)
  for (let i = 0; i < n; i++) if (capture[i] !== stimulus[i]) return false
  return n > 0
}

/**
 * Stretches where the capture is silent but the stimulus is not.
 *
 * ⚠ DEMO PLUGINS MUTE ON A TIMER, and a muted second inside a measurement
 * window does not look like an error — it looks like a compressor that clamped
 * to nothing.
 */
export function findGaps(capture, env, sampleRate) {
  const win = Math.round(0.02 * sampleRate)
  const gaps = []
  let inGap = false, start = 0
  for (let i = 0; i + win < capture.length; i += win) {
    let cm = 0, sm = 0
    for (let j = 0; j < win; j++) {
      const a = Math.abs(capture[i + j]); if (a > cm) cm = a
      const r = env[Math.min(i + j, env.length - 1)]; if (r > sm) sm = r
    }
    const dead = cm < 1e-6 && sm > 1e-4
    if (dead && !inGap) { inGap = true; start = i / sampleRate }
    if (!dead && inGap) { inGap = false; gaps.push([start, i / sampleRate]) }
  }
  if (inGap) gaps.push([start, capture.length / sampleRate])
  return gaps
}

/** Does [a,b] touch any gap? */
export function hitsGap(gaps, a, b) {
  return gaps.some(([g0, g1]) => b >= g0 && a <= g1)
}

/**
 * Align a capture to the stimulus by ENVELOPE, not waveform — a periodic probe
 * correlates ambiguously at its own period, which is the same order as the
 * quantities being measured.
 *
 * ⚠ DEAD REGIONS ARE EXCLUDED FROM THE COST OR THE FIT RAILS. Seconds of
 * silence the stimulus does not have dominate a log-envelope distance and the
 * search pins itself to the end of its range — measured, it came back at −4394
 * against a ±4410 limit, and every table downstream was nonsense: 22 dB of
 * reduction half a millisecond after a step, negative reduction during a
 * release.
 */
export function alignByEnvelope(refEnv, capture, sampleRate, maxLagSec = 0.5) {
  const maxLag = Math.round(maxLagSec * sampleRate)
  const a = Math.exp(-1 / (sampleRate * 0.005))

  /**
   * ⚠ THE SAME SMOOTHER RUNS ON BOTH SIDES, AND LEAVING IT OFF THE REFERENCE
   * BIASED EVERY ALIGNMENT BY THE SMOOTHER'S OWN DELAY.
   *
   * The capture has to be rectified and smoothed to get an envelope out of it.
   * The reference does not — `buildProbe` hands back the exact instantaneous
   * amplitude. Comparing a smoothed thing to an unsmoothed one asks the search
   * to absorb the one-pole's group delay as if it were capture latency:
   * measured on a capture with NO offset at all, it reported **332 samples,
   * 3.5 ms at 96 kHz**, and injecting known offsets of 0 / 137 / 4096 returned
   * 332 / 469 / 4428 — the right spacing on a wrong origin.
   *
   * Harmless for a THD window 0.8 s inside a 3 s tone. Fatal for a ballistics
   * fit, where 3.5 ms is longer than every attack time this unit has.
   *
   * ⚠ WITH BOTH SIDES SMOOTHED THE RESIDUAL IS ABOUT 12 SAMPLES (0.125 ms at
   * 96 kHz), AND THAT IS STILL NOT ENOUGH FOR A BALLISTICS FIT. It is not a
   * constant to subtract: what is left is the compressor's own attack pulling
   * the capture's envelope down just after each onset, which is material- and
   * setting-dependent. At a 4 kHz probe and 96 kHz there are 24 samples per
   * period, so ±12 samples sits exactly at the edge of period ambiguity — a
   * waveform cross-correlation refined from here could lock onto the wrong
   * cycle.
   *
   * THE FIX, WHEN THE BALLISTICS FITTER NEEDS IT: refine against a STEP EDGE
   * rather than the tone. The edges in `bursts.wav` are broadband transients
   * placed on zero crossings, so correlating the raw waveform across one is
   * unambiguous where correlating a periodic tone is not. Not built yet — the
   * null test does not need it, and building it against a real capture beats
   * guessing at what the residual looks like on one.
   */
  const smooth = (src, abs) => {
    const out = new Float64Array(src.length)
    let e = 0
    for (let i = 0; i < src.length; i++) {
      const v = abs ? Math.abs(src[i]) : src[i] * 0.6366   // mean |sin|, so the scales match
      e = a * e + (1 - a) * v
      out[i] = e
    }
    return out
  }
  const rect = smooth(capture, true)
  const ref = smooth(refEnv, false)

  const dead = new Uint8Array(capture.length)
  {
    const win = Math.round(0.02 * sampleRate)
    for (let i = 0; i + win < capture.length; i += win) {
      let cm = 0
      for (let j = 0; j < win; j++) { const v = Math.abs(capture[i + j]); if (v > cm) cm = v }
      if (cm < 1e-6) for (let j = 0; j < win; j++) dead[i + j] = 1
    }
  }

  const cost = (lag, stride) => {
    let err = 0, c = 0
    for (let i = Math.max(0, -lag); i + lag < rect.length && i < ref.length; i += stride) {
      if (dead[i + lag]) continue
      err += (Math.log(Math.max(rect[i + lag], 1e-9)) - Math.log(Math.max(ref[i], 1e-9))) ** 2
      c++
    }
    return c > 1000 ? err / c : Infinity
  }

  /**
   * MULTI-RESOLUTION, and it is the difference between usable and not: the
   * single-pass version searched every 8th lag across the whole range at a
   * 128-sample stride — about 240 M operations, **6 seconds per capture**, and
   * with ten captures in a null-test run that was the entire cost of the
   * report. Narrowing by powers of four costs about 3.6 M for the same answer.
   *
   * ⚠ THE COARSE STEP IS SAFE BECAUSE THE COST SURFACE IS SMOOTH ON THAT SCALE,
   * not because coarse is good enough. The envelope is smoothed with a 5 ms
   * time constant, so a 256-sample step at 96 kHz (2.7 ms) cannot jump over the
   * basin. Sharpen that smoother and this step has to come down with it.
   */
  const passes = [
    [maxLag, 256, 512],
    [512, 32, 128],
    [64, 4, 64],
    [8, 1, 32],
  ]
  let best = 0
  for (const [span, step, stride] of passes) {
    let bestErr = Infinity, found = best
    const from = Math.max(-maxLag, best - span), to = Math.min(maxLag, best + span)
    for (let lag = from; lag <= to; lag += step) {
      const e2 = cost(lag, stride)
      if (e2 < bestErr) { bestErr = e2; found = lag }
    }
    best = found
  }
  return best
}

/**
 * The two things a bounce gets wrong silently, reported up front.
 *
 * ⚠ (1) THAT THE RENDER STARTED AT SAMPLE 0. Events are POSITIONED around the
 * demo-mute grid, which is absolute (20.01 s, then every 20.00), so a bounce
 * that starts late slides every one of them into the mutes they were placed to
 * avoid — and the only symptom is events going missing. The mutes' offset in
 * the capture measures the render offset directly.
 *
 * ⚠ (2) THAT THE BOUNCE RAN TO THE END. A tail cut short loses the last event,
 * and the last event is the longest one in most plans.
 *
 * @returns {{ gaps, offsetWarning, shortBy, lines }} `lines` is human-readable.
 */
export function preflight(label, capture, plan, env, sampleRate) {
  const lines = []
  const got = capture.length / sampleRate
  const shortBy = plan.seconds - got
  if (shortBy > 0.5) {
    lines.push(`⚠ ${label}: ${got.toFixed(1)}s against the stimulus's ${plan.seconds.toFixed(1)}s — ` +
      `the bounce is ${shortBy.toFixed(1)}s short and the last event(s) are missing.`)
  }

  const gaps = findGaps(capture, env, sampleRate)
  let offsetWarning = null
  if (gaps.length) {
    const offsets = gaps
      .map(([a]) => a - MUTE_PERIOD_S * Math.round(a / MUTE_PERIOD_S))
      .sort((x, y) => x - y)
    // ⚠ RESOLUTION IS THE GAP DETECTOR'S 20 ms WINDOW, so this LOCATES a bad
    // render rather than measuring it: a 400 ms shift reads as about 370. That
    // is the right precision for the job — the answer is "re-render", not a trim.
    const median = offsets[Math.floor(offsets.length / 2)] - 0.01
    lines.push(`   ${gaps.length} silent stretch(es) — demo mute grid at ` +
      `${gaps.slice(0, 4).map(([a]) => a.toFixed(2)).join(', ')}${gaps.length > 4 ? ' …' : ''}`)
    if (Math.abs(median) > 0.15) {
      offsetWarning = median
      lines.push(`⚠ ${label}: THE DEMO MUTES ARE ABOUT ${(median * 1000).toFixed(0)} ms OFF THE GRID (±20 ms).`)
      lines.push("   They should open at 20.01s and every 20.00s after. The bounce did not start at")
      lines.push('   the file\'s first sample, so events are no longer in the clean windows they were')
      lines.push('   scheduled into. Re-render from sample 0 — nothing downstream can recover this.')
    }
  }
  return { gaps, offsetWarning, shortBy, lines }
}

/**
 * Mean level, in dBFS, of a window — used for insertion gain, where a DFT at
 * one frequency would miss a broadband change.
 */
export function windowRmsDb(y, from, to) {
  let s = 0, n = 0
  for (let i = Math.max(0, from); i < Math.min(y.length, to); i++) { s += y[i] * y[i]; n++ }
  return n ? db(Math.sqrt(s / n)) : NaN
}

/**
 * Refine a coarse lag against a STEP EDGE, to the sample.
 *
 * ⚠ ENVELOPE ALIGNMENT IS NOT ENOUGH FOR BALLISTICS AND THIS IS THE FIX THAT
 * WAS DEFERRED. `alignByEnvelope` lands within about 12 samples once both sides
 * are smoothed — 0.125 ms at 96 kHz, which is fine for a THD window sitting
 * 0.8 s inside a 3 s tone and useless against a 20 us attack.
 *
 * ⚠ AND A PERIODIC TONE CANNOT BE CORRELATED UNAMBIGUOUSLY. At a 4 kHz probe
 * and 96 kHz there are 24 samples per period, so a ±12 sample uncertainty spans
 * a whole period and a waveform correlation can lock onto the wrong cycle. The
 * STEP EDGE is what breaks the tie: it is a broadband amplitude discontinuity
 * placed on a zero crossing, so the correlation peaks once at the true lag and
 * the one-period-away peaks are lower — the jump does not line up there even
 * though the waveform does.
 *
 * Normalised, so the compressor having pulled the post-edge amplitude down (the
 * whole point of the capture) cannot bias it. A pure gain leaves zero crossings
 * where they were.
 *
 * @param {number} edgeSec   where the stimulus steps
 * @param {number} coarseLag from `alignByEnvelope`
 * @param {number} searchSamples  half-width of the search, ± around coarseLag
 */
export function refineLagAtEdge(capture, stimulus, edgeSec, sampleRate, coarseLag, {
  searchSamples = 64, windowSec = 0.004,
} = {}) {
  const half = Math.round(windowSec * sampleRate)
  const centre = Math.round(edgeSec * sampleRate)
  const from = centre - half
  const to = centre + half
  if (from < 0 || to >= stimulus.length) return { lag: coarseLag, score: NaN, margin: NaN }

  const scores = []
  for (let d = -searchSamples; d <= searchSamples; d++) {
    const lag = coarseLag + d
    let num = 0, sa = 0, sb = 0
    for (let i = from; i < to; i++) {
      const j = i + lag
      if (j < 0 || j >= capture.length) { num = NaN; break }
      const a = stimulus[i], b = capture[j]
      num += a * b; sa += a * a; sb += b * b
    }
    if (!Number.isFinite(num) || sa <= 0 || sb <= 0) continue
    scores.push([lag, num / Math.sqrt(sa * sb)])
  }
  if (!scores.length) return { lag: coarseLag, score: NaN, margin: NaN }
  scores.sort((p, q) => q[1] - p[1])
  const [lag, score] = scores[0]
  /**
   * ⚠ THE MARGIN IS THE THING TO CHECK, NOT THE SCORE. A capture that locked
   * onto the wrong cycle still correlates beautifully — the runner-up being
   * almost as good is what says the edge did not disambiguate. Report it so a
   * fitter can refuse rather than quietly measure the wrong sample.
   */
  const rival = scores.find(([l]) => Math.abs(l - lag) > sampleRate / 8000) // ≥ half a period at 4 kHz
  return { lag, score, margin: rival ? score - rival[1] : NaN }
}
