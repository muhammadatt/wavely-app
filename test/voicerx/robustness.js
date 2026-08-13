/**
 * Three checks that need no ground truth at all.
 *
 * The synthetic corpus knows the right answer because it planted the defect.
 * The real corpus knows roughly what a finished master should report. Neither
 * is available for a raw narrator recording, which is what the product actually
 * receives — and all three of these work there, today, on any audio.
 *
 * They test properties a correct detector must have regardless of taste:
 *
 *   INVARIANCE   the same recording, trivially transformed, must produce the
 *                same diagnosis
 *   CONVERGENCE  applying a detector's own corrections must leave it with
 *                little left to say
 *   DIRECTION    boosts and cuts are not symmetric in risk, and where a
 *                detector chooses to boost is a fault line
 *
 * None of them can tell you a detector is GOOD. Each can tell you one is
 * broken, and none of them needs anyone to listen to anything.
 */

import { peaking, BiquadCascade } from '../../src/audio/dsp/biquad.js'

/** How close two bands must sit to count as the same finding. */
const SAME_BAND_OCTAVES = 0.33

/** And how close in gain, before they are the same finding said differently. */
const SAME_GAIN_DB = 1.5

/**
 * Above this, a boost is the riskiest thing a corrective EQ can do.
 *
 * Sibilance, hiss and codec artefacts all live up here, and every one of them
 * is made worse by a lift. Below it a boost adds body, which is recoverable by
 * ear; above it a boost adds the exact defects users come to the tool to
 * remove. The real corpus caught v2 offering +3 to +5 dB across 4-6 kHz on
 * files whose owner describes them as audibly sibilant — a correction pointing
 * the wrong way on a problem you can hear.
 */
const RISKY_BOOST_ABOVE_HZ = 3000

function agreement(a, b) {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0

  let matched = 0
  for (const band of a) {
    const hit = b.some(other => Math.abs(Math.log2(other.freqHz / band.freqHz)) < SAME_BAND_OCTAVES
      && Math.abs(other.gainDb - band.gainDb) < SAME_GAIN_DB)
    if (hit) matched++
  }
  // Symmetric: a detector that emits ten bands where the other emits one has
  // not "agreed" just because the one is among the ten.
  return (2 * matched) / (a.length + b.length)
}

/** Uniform gain. The envelope shifts bodily, so every deviation is unchanged. */
function withGain(audio, db) {
  const g = Math.pow(10, db / 20)
  const out = new Float32Array(audio.length)
  for (let i = 0; i < audio.length; i++) out[i] = audio[i] * g
  return out
}

/** Polarity inversion. A magnitude spectrum cannot see it. */
function inverted(audio) {
  const out = new Float32Array(audio.length)
  for (let i = 0; i < audio.length; i++) out[i] = -audio[i]
  return out
}

/** Shift the analysis window by part of a hop, so framing lands differently. */
function shifted(audio, samples) {
  return audio.subarray(samples, audio.length)
}

/**
 * Does the diagnosis survive a transformation that changes nothing?
 *
 * Gain and polarity should be EXACTLY invariant — the cepstral envelope of a
 * scaled signal is the same curve moved bodily up or down, and every deviation
 * from a reference derived from that same curve is unchanged. Anything less
 * than perfect agreement there is a bug, not a tolerance.
 *
 * The frame shift is the interesting one. It is not exactly invariant — a
 * different set of windows lands on different phonemes — so some disagreement
 * is honest. But a detector reading the voice rather than the framing should
 * still mostly agree with itself, and this puts a number on "mostly".
 */
export function invariance(detector, audio, sampleRate) {
  const base = detector(audio, sampleRate)
  if (!base.ok) return null

  const cases = {
    'gain +6 dB': withGain(audio, 6),
    'gain -6 dB': withGain(audio, -6),
    'polarity flip': inverted(audio),
    'shift 1/2 hop': shifted(audio, 256),
    'shift 3 hops': shifted(audio, 1536),
  }

  const out = { bands: base.bands.length, scores: {} }
  for (const [name, variant] of Object.entries(cases)) {
    const got = detector(variant, sampleRate)
    out.scores[name] = got.ok ? agreement(base.bands, got.bands) : 0
  }
  // Gain and polarity are the ones that must be exact; the shifts are reported
  // but held to a lower standard, so they are summarised apart.
  out.exact = Math.min(
    out.scores['gain +6 dB'], out.scores['gain -6 dB'], out.scores['polarity flip'],
  )
  out.framing = Math.min(out.scores['shift 1/2 hop'], out.scores['shift 3 hops'])
  return out
}

/**
 * Apply a set of corrections. Peaking filters throughout — an approximation,
 * since v1 uses shelves at the extremes, and an acceptable one: the question
 * this serves is whether a detector settles, and a shelf-versus-bell difference
 * at the ends of the range cannot turn convergence into divergence.
 */
function applyBands(audio, bands, sampleRate) {
  if (!bands.length) return audio
  const out = Float32Array.from(audio)
  for (const b of bands) {
    const c = new BiquadCascade(1, 1)
    c.setSection(0, peaking(sampleRate, b.freqHz, b.q || 3, b.gainDb, 'q'))
    c.process(out, out, out.length, 0)
  }
  return out
}

/**
 * Apply what the detector asked for, then ask it again.
 *
 * A detector that measures the voice should have little left to say once its
 * own corrections are in place — the thing it objected to is gone. One that is
 * chasing structure in its own reference will find a fresh set of problems
 * forever, and the second pass is where that shows.
 *
 * This is a DIAGNOSTIC, not a proposal. Production deliberately analyses only
 * the dry signal, because re-analysing corrected audio inside the product would
 * be a feedback loop (see the note in suggestions.js). Running that loop once,
 * on purpose, outside the product, is exactly how you find out whether it would
 * have converged.
 */
export function convergence(detector, audio, sampleRate) {
  const first = detector(audio, sampleRate)
  if (!first.ok) return null

  const firstGain = first.bands.reduce((s, b) => s + Math.abs(b.gainDb), 0)
  const second = detector(applyBands(audio, first.bands, sampleRate), sampleRate)
  const secondGain = second.ok ? second.bands.reduce((s, b) => s + Math.abs(b.gainDb), 0) : 0

  return {
    firstBands: first.bands.length,
    firstGainDb: round(firstGain),
    secondBands: second.ok ? second.bands.length : 0,
    secondGainDb: round(secondGain),
    // 0 means it settled completely; 1 means the second pass wants as much as
    // the first; above 1 means applying its own advice made things worse by its
    // own measure.
    residualFraction: firstGain > 0 ? round(secondGain / firstGain) : (secondGain > 0 ? Infinity : 0),
  }
}

/** Where a detector chooses to boost, which is not symmetric with cutting. */
export function directionStats(bands) {
  const boosts = bands.filter(b => b.gainDb > 0)
  const risky = boosts.filter(b => b.freqHz >= RISKY_BOOST_ABOVE_HZ)
  return {
    bands: bands.length,
    boosts: boosts.length,
    riskyBoosts: risky.length,
    riskyBoostGainDb: round(risky.reduce((s, b) => s + b.gainDb, 0)),
  }
}

function round(v) {
  return Math.round(v * 100) / 100
}
