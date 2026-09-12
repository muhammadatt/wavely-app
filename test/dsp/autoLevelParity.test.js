/**
 * Auto Leveler — client/server parity.
 *
 * The client port exists to produce the SAME curve as the pipeline stage from
 * the same inputs, so the test is not a set of assertions about plausible
 * behaviour: it runs the real server stage and the real client solver over one
 * synthetic file and compares the gain curves sample for sample.
 *
 * That makes every constant, every rounding rule and every boundary case in the
 * port testable at once, including the ones no hand-written assertion would
 * think to cover — where a crossfade window lands, which clips merged, how a
 * sub-phrase split fell out. If the two ever disagree by more than float noise,
 * this fails with the sample index that first diverged.
 *
 * THE VAD MASK IS SUPPLIED, NOT COMPUTED, on both sides. That is the real
 * architecture: Silero runs on the server and its labels are the shared input.
 * Handing both implementations the same mask tests exactly the half that was
 * ported, and nothing else.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { writeWavChannels } from '../../server/pipeline/wavWriter.js'
import { analyzeAutoLeveler } from '../../server/pipeline/autoLeveler.js'
import {
  prepareAutoLevel, solveAutoLevel, expandGainSegments, AUTOLEVEL_DEFAULTS,
} from '../../src/audio/dsp/autoLevel.js'

const SAMPLE_RATE = 44100
const FRAME_DURATION_S = 0.025

/**
 * A file of speech-like phrases at deliberately uneven levels, separated by
 * room tone.
 *
 * Not noise shaped to look like speech — a sum of a fundamental and four
 * harmonics with a per-phrase envelope. The leveler only ever measures
 * K-weighted energy over spans of hundreds of milliseconds, so what matters is
 * that the phrases differ in level by more than the deadband and that the gaps
 * are quiet enough to be gaps. Two phrases are placed 7 dB apart specifically
 * to exercise the merge path.
 */
function synthesizeSpeech(phrases, sampleRate) {
  const totalS = phrases[phrases.length - 1].endS + 1.5
  const n = Math.round(totalS * sampleRate)
  const audio = new Float32Array(n)

  // Room tone everywhere, so the gaps are not digital silence — the crossfade
  // placement searches for the lowest-energy window and needs energy to rank.
  let seed = 12345
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff) * 2 - 1
  }
  // ~-75 dBFS. Low enough that the noise-floor headroom cap leaves the full
  // +10 dB of lift available: at -62 against the default -60 target the cap
  // computes to zero headroom and forbids every boost, which silently turns the
  // fixture into a cuts-only file and takes the merge path with it.
  for (let i = 0; i < n; i++) audio[i] = rand() * 0.0002

  for (const { startS, endS, amp, f0 } of phrases) {
    const start = Math.round(startS * sampleRate)
    const end   = Math.min(n, Math.round(endS * sampleRate))
    const len   = end - start
    for (let i = 0; i < len; i++) {
      const t = (start + i) / sampleRate
      // Syllable-rate amplitude modulation, so the phrase has internal
      // dynamics for the short-term curve to see.
      const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.5 * t)
      // Cosine edges, so phrase onsets are not steps.
      const edge = Math.min(1, Math.min(i, len - i) / (0.02 * sampleRate))
      let s = 0
      for (let h = 1; h <= 5; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h
      audio[start + i] += amp * edge * syllable * s * 0.4
    }
  }
  return audio
}

/** Frames voiced exactly where a phrase is, which is the mask both sides get. */
function buildFrameAnalysis(phrases, numSamples, sampleRate, noiseFloorDbfs) {
  const frameSamples = Math.round(FRAME_DURATION_S * sampleRate)
  const numFrames = Math.floor(numSamples / frameSamples)
  const frames = []
  for (let f = 0; f < numFrames; f++) {
    const tStart = (f * frameSamples) / sampleRate
    const tEnd   = ((f + 1) * frameSamples) / sampleRate
    const voiced = phrases.some(p => tEnd > p.startS && tStart < p.endS)
    frames.push({
      index: f,
      offsetSamples: f * frameSamples,
      lengthSamples: frameSamples,
      rmsDbfs: voiced ? -22 : noiseFloorDbfs,
      isSilence: !voiced,
    })
  }
  return { frames, noiseFloorDbfs, silenceThresholdDbfs: noiseFloorDbfs + 6 }
}

function frameVoicedMask(frameAnalysis) {
  const mask = new Uint8Array(frameAnalysis.frames.length)
  for (let f = 0; f < mask.length; f++) mask[f] = frameAnalysis.frames[f].isSilence ? 0 : 1
  return mask
}

/**
 * Phrase layout. Levels are chosen to hit every branch that has one:
 *   - a spread wide enough that inClipStd clears the deadband
 *   - one 7 dB neighbour step, above MERGE_MAX_DELTA_DB, to force a merge
 *   - one 6 s phrase with a sustained quiet middle, to force a sub-phrase split
 *   - gaps both longer and shorter than the 300 ms VAD bridge
 */
const PHRASES = [
  { startS: 0.8,  endS: 3.2,  amp: 0.30, f0: 120 },
  { startS: 3.9,  endS: 6.1,  amp: 0.13, f0: 130 },
  { startS: 6.4,  endS: 8.2,  amp: 0.34, f0: 110 },
  { startS: 9.0,  endS: 12.4, amp: 0.075, f0: 125 },  // ~7 dB below its neighbour
  { startS: 13.0, endS: 15.1, amp: 0.28, f0: 118 },
  { startS: 15.9, endS: 21.9, amp: 0.22, f0: 122 },   // long — split candidate
  { startS: 22.6, endS: 25.0, amp: 0.10, f0: 128 },
  { startS: 25.9, endS: 28.4, amp: 0.26, f0: 115 },
]

/**
 * The quiet middle of the long phrase, which is what the splitter looks for.
 *
 * DEPTH AND LENGTH BOTH HAVE TO CLEAR THEIR THRESHOLD WITH ROOM. The split test
 * runs on the 400 ms short-term LUFS curve, so a dip only reads at full depth
 * where the whole window fits inside it: a 900 ms dip presents as roughly 500 ms
 * of qualifying hops, which lands exactly on SUBPHRASE_SPLIT_MIN_DURATION_MS and
 * makes the fixture depend on rounding. 1.6 s at -12 dB clears both thresholds
 * by a comfortable margin and is still an ordinary thing for a narrator to do.
 */
function carveSubphraseDip(audio, sampleRate) {
  const from = Math.round(18.2 * sampleRate)
  const to   = Math.round(19.8 * sampleRate)
  for (let i = from; i < to; i++) audio[i] *= 0.25
}

async function runBothSides(config) {
  const audio = synthesizeSpeech(PHRASES, SAMPLE_RATE)
  carveSubphraseDip(audio, SAMPLE_RATE)

  const noiseFloorDbfs = -75
  const frameAnalysis = buildFrameAnalysis(PHRASES, audio.length, SAMPLE_RATE, noiseFloorDbfs)

  const dir = await mkdtemp(path.join(tmpdir(), 'autolevel-parity-'))
  const wavPath = path.join(dir, 'in.wav')
  try {
    await writeWavChannels([audio], SAMPLE_RATE, wavPath)

    const server = await analyzeAutoLeveler(wavPath, { autoLeveler: config }, frameAnalysis)

    const prepared = prepareAutoLevel({
      audio,
      sampleRate: SAMPLE_RATE,
      frameVoiced: frameVoicedMask(frameAnalysis),
      frameDurationS: FRAME_DURATION_S,
      noiseFloorDbfs,
    })
    const client = solveAutoLevel(prepared, config)

    return { server, client, prepared, numSamples: audio.length }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('client port reproduces the server gain curve sample for sample', async () => {
  const { server, client, numSamples } = await runBothSides(AUTOLEVEL_DEFAULTS)

  assert.equal(server.applied, true, `server skipped: ${server.skipped_reason}`)
  assert.equal(client.applied, true, `client skipped: ${client.reason}`)

  const clientGain = expandGainSegments(client.segments, numSamples)
  assert.equal(clientGain.length, server.gainSr.length)

  let worst = 0
  let worstAt = -1
  for (let i = 0; i < numSamples; i++) {
    const d = Math.abs(clientGain[i] - server.gainSr[i])
    if (d > worst) { worst = d; worstAt = i }
  }

  // Float32 storage on both sides, and the two biquad implementations differ in
  // form (the server is direct form I, BiquadCascade is transposed direct form
  // II), so the LUFS feeding each clip's gain can differ in the last bits.
  assert.ok(
    worst < 1e-4,
    `gain curves diverge by ${worst.toFixed(6)} dB at sample ${worstAt} ` +
    `(${(worstAt / SAMPLE_RATE).toFixed(3)}s)`,
  )
})

test('client port reproduces the server clip segmentation and gains', async () => {
  const { server, client } = await runBothSides(AUTOLEVEL_DEFAULTS)

  assert.deepEqual(
    client.clips.map(c => [c.sampleStart, c.sampleEnd]),
    server.mergedClips.map(c => [c.sampleStart, c.sampleEnd]),
    'merged clip boundaries differ',
  )

  assert.equal(client.measurements.clip_count_initial, server.clipCountInitial)
  assert.equal(client.measurements.merges_count, server.mergesCount)
  assert.equal(client.measurements.subphrase_splits_count, server.subphraseSplits)

  for (let k = 0; k < client.gains.length; k++) {
    assert.ok(
      Math.abs(client.gains[k] - server.mergedGains[k]) < 1e-6,
      `clip ${k} gain differs: ${client.gains[k]} vs ${server.mergedGains[k]}`,
    )
  }
})

test('the fixture actually exercises splits and merges', async () => {
  const { server } = await runBothSides(AUTOLEVEL_DEFAULTS)

  // Guards against the parity tests passing vacuously if the fixture ever stops
  // producing the structure it was built to produce.
  //
  // Counted from the split and merge tallies rather than inferred from the clip
  // count, which cannot see either: the 300 ms gap between phrases 2 and 3 is
  // exactly the VAD bridge, so those two arrive as one clip and the base count
  // is already below the phrase count before a split adds one back.
  assert.ok(server.subphraseSplits > 0,
    'expected at least one sub-phrase split from the carved dip')
  assert.ok(server.mergesCount > 0,
    'expected at least one merge from the 7 dB neighbour step')
  assert.ok(server.mergedClips.length < server.clipCountInitial,
    'merging should reduce the clip count')
})

test('running_median target mode matches too', async () => {
  const config = { ...AUTOLEVEL_DEFAULTS, target_mode: 'running_median', target_window_s: 12 }
  const { server, client, numSamples } = await runBothSides(config)

  assert.equal(server.applied, true)
  assert.equal(client.applied, true)

  const clientGain = expandGainSegments(client.segments, numSamples)
  let worst = 0
  for (let i = 0; i < numSamples; i++) {
    const d = Math.abs(clientGain[i] - server.gainSr[i])
    if (d > worst) worst = d
  }
  assert.ok(worst < 1e-4, `running_median curves diverge by ${worst.toFixed(6)} dB`)
})

test('the noise-floor cap binds on both sides identically', async () => {
  // A floor at -40 leaves (−50 − −40) − 3 = 0 dB of headroom by the server's
  // formula, so no clip may be lifted at all while cuts stay available.
  const config = { ...AUTOLEVEL_DEFAULTS, noise_floor_target_dbfs: -50 }
  const audio = synthesizeSpeech(PHRASES, SAMPLE_RATE)
  carveSubphraseDip(audio, SAMPLE_RATE)
  const frameAnalysis = buildFrameAnalysis(PHRASES, audio.length, SAMPLE_RATE, -40)

  const dir = await mkdtemp(path.join(tmpdir(), 'autolevel-nf-'))
  const wavPath = path.join(dir, 'in.wav')
  try {
    await writeWavChannels([audio], SAMPLE_RATE, wavPath)
    const server = await analyzeAutoLeveler(wavPath, { autoLeveler: config }, frameAnalysis)
    const prepared = prepareAutoLevel({
      audio,
      sampleRate: SAMPLE_RATE,
      frameVoiced: frameVoicedMask(frameAnalysis),
      frameDurationS: FRAME_DURATION_S,
      noiseFloorDbfs: -40,
    })
    const client = solveAutoLevel(prepared, config)

    assert.equal(client.measurements.noise_floor_cap_active, true)
    assert.equal(server.nfCapActive, true)
    for (const g of client.gains) {
      assert.ok(g <= 1e-9, `cap should forbid any lift, saw +${g.toFixed(3)} dB`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('skip conditions agree with the server', async () => {
  // Too short: 4 s of file against the 10 s minimum.
  const shortPhrases = [{ startS: 0.5, endS: 2.5, amp: 0.3, f0: 120 }]
  const audio = synthesizeSpeech(shortPhrases, SAMPLE_RATE)
  const frameAnalysis = buildFrameAnalysis(shortPhrases, audio.length, SAMPLE_RATE, -75)

  const dir = await mkdtemp(path.join(tmpdir(), 'autolevel-short-'))
  const wavPath = path.join(dir, 'in.wav')
  try {
    await writeWavChannels([audio], SAMPLE_RATE, wavPath)
    const server = await analyzeAutoLeveler(
      wavPath, { autoLeveler: AUTOLEVEL_DEFAULTS }, frameAnalysis,
    )
    const prepared = prepareAutoLevel({
      audio,
      sampleRate: SAMPLE_RATE,
      frameVoiced: frameVoicedMask(frameAnalysis),
      frameDurationS: FRAME_DURATION_S,
      noiseFloorDbfs: -75,
    })

    assert.equal(server.applied, false)
    assert.equal(prepared.applicable, false)
    assert.equal(prepared.reason, server.skipped_reason)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
