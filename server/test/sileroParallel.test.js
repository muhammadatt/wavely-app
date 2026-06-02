/**
 * Tests for the parallel Silero VAD path (sileroParallel.js).
 *
 * The model itself is replaced by a deterministic, frame-local energy stub:
 * each 25 ms frame is labelled silence/voiced purely from its own RMS against a
 * fixed threshold. Because that labelling is context-independent, the parallel
 * carve → per-chunk dispatch → rebase → reassemble pipeline MUST reproduce a
 * whole-file run exactly (the warm-up overlap and seam placement only matter
 * for the real GRU's state; they cannot change a frame-local label). Any
 * off-by-one in global-frame rebasing or core-region keeping shows up as a
 * mismatch here.
 *
 * Real FFmpeg is used for the sub-chunk carves (extractAudioRange), matching
 * the rest of the suite. No Python / torch is involved.
 *
 * Run with:  cd server && npm test
 */

import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'

import { tempPath, removeTmp }            from '../lib/ffmpeg.js'
import { runFfmpeg }                      from '../lib/exec-ffmpeg.js'
import { readWavSamples }                 from '../pipeline/wavReader.js'
import { classifySileroVadParallel }      from '../pipeline/sileroParallel.js'

const TEMP_FILES = []
const SR             = 16000
const FRAME_SAMPLES  = Math.round(0.025 * SR)  // 400 — must match frame_config.json
const STUB_THRESH_DB = -50                     // fixed silence threshold for the stub VAD

/**
 * Build a 16 kHz mono WAV: alternating sine tones and 1 s digital-silence pads,
 * long enough (and with enough qualifying silences) to force a multi-chunk plan
 * once the planner minimum is overridden down.
 */
async function makeSplittableWav(durationSec) {
  const outPath = tempPath('.wav')
  TEMP_FILES.push(outPath)
  const segSec = durationSec / 4 - 0.75
  const sil = `anullsrc=cl=mono:r=${SR}`
  await runFfmpeg([
    '-f', 'lavfi', '-i', `sine=frequency=300:sample_rate=${SR}:duration=${segSec}`,
    '-f', 'lavfi', '-i', sil,
    '-f', 'lavfi', '-i', `sine=frequency=400:sample_rate=${SR}:duration=${segSec}`,
    '-f', 'lavfi', '-i', sil,
    '-f', 'lavfi', '-i', `sine=frequency=500:sample_rate=${SR}:duration=${segSec}`,
    '-f', 'lavfi', '-i', sil,
    '-f', 'lavfi', '-i', `sine=frequency=600:sample_rate=${SR}:duration=${segSec}`,
    '-filter_complex',
      `[1:a]atrim=duration=1,asetpts=PTS-STARTPTS[s1];` +
      `[3:a]atrim=duration=1,asetpts=PTS-STARTPTS[s2];` +
      `[5:a]atrim=duration=1,asetpts=PTS-STARTPTS[s3];` +
      `[0:a][s1][2:a][s2][4:a][s3][6:a]concat=n=7:v=0:a=1[out]`,
    '-map', '[out]',
    '-c:a', 'pcm_f32le',
    '-ac', '1',
    outPath,
  ])
  return outPath
}

/** Per-frame RMS (linear) over 400-sample frames of a mono buffer. */
function frameRmsLinear(samples) {
  const n = Math.floor(samples.length / FRAME_SAMPLES)
  const rms = new Float64Array(n)
  for (let f = 0; f < n; f++) {
    let sumSq = 0
    const start = f * FRAME_SAMPLES
    for (let i = start; i < start + FRAME_SAMPLES; i++) sumSq += samples[i] * samples[i]
    rms[f] = Math.sqrt(sumSq / FRAME_SAMPLES)
  }
  return rms
}

/** Frame-local energy stub standing in for silero_vad.py. */
async function stubRunVad(inputPath, outputJsonPath) {
  const { samples } = await readWavSamples(inputPath)
  const rms = frameRmsLinear(samples)
  const threshLin = Math.pow(10, STUB_THRESH_DB / 20)
  const frames = []
  for (let f = 0; f < rms.length; f++) {
    frames.push({ index: f, isSilence: rms[f] < threshLin })
  }
  await writeFile(outputJsonPath, JSON.stringify({ frames }))
}

before(() => {
  // Parallelism is gated on a multi-worker pool; the planner minimum is lowered
  // so the short fixture splits.
  process.env.PYTHON_WORKER_POOL_SIZE     = '4'
  process.env.SILERO_PARALLEL             = '1'
  process.env.SILERO_PARALLEL_MIN_CHUNK_S = '5'
  process.env.SILERO_PARALLEL_MAX_CHUNK_S = '600'
  process.env.SILERO_PARALLEL_WARMUP_S    = '1'
})

after(async () => {
  for (const f of TEMP_FILES) await removeTmp(f)
})

test('parallel Silero reassembles frame labels identically to a whole-file run', async () => {
  const input = await makeSplittableWav(60)  // 60 s → target ≈ 15 s/chunk → multi-chunk

  const { samples } = await readWavSamples(input)
  const energyFrameRms = frameRmsLinear(samples)
  const numFrames      = energyFrameRms.length

  // Whole-file reference: run the same stub once over the entire input.
  const wholeJson = tempPath('.json')
  TEMP_FILES.push(wholeJson)
  await stubRunVad(input, wholeJson)
  const wholeFrames = JSON.parse(await readFile(wholeJson, 'utf8')).frames
  const wholeLabel  = new Map(wholeFrames.map(f => [f.index, f.isSilence]))

  // Parallel run — count dispatches to confirm the multi-chunk path was taken.
  let dispatches = 0
  const countingStub = (inp, out) => { dispatches++; return stubRunVad(inp, out) }

  const result = await classifySileroVadParallel(input, {
    energyFrameRms,
    silenceThresholdDbfs: STUB_THRESH_DB,
    numFrames,
    runVad: countingStub,
  })

  assert.ok(result, 'expected a parallel result (not the single-call fallback)')
  assert.ok(dispatches >= 2, `expected ≥2 chunk dispatches, got ${dispatches}`)

  const nPlan = Math.min(numFrames, Math.floor(samples.length / FRAME_SAMPLES))

  // Cores must tile [0, nPlan) with no gaps, no duplicates, ascending.
  const indices = result.frames.map(f => f.index)
  assert.equal(indices.length, nPlan, 'reassembled frame count should cover the planned range')
  for (let f = 0; f < nPlan; f++) {
    assert.equal(indices[f], f, `frame index gap/disorder at position ${f}`)
  }

  // Every reassembled label must equal the whole-file label exactly.
  for (const { index, isSilence } of result.frames) {
    assert.equal(isSilence, wholeLabel.get(index),
      `label mismatch at frame ${index}: parallel=${isSilence} whole=${wholeLabel.get(index)}`)
  }
})

test('SILERO_PARALLEL=0 forces the single-call fallback (returns null)', async () => {
  const input = await makeSplittableWav(60)
  const { samples } = await readWavSamples(input)
  const energyFrameRms = frameRmsLinear(samples)

  process.env.SILERO_PARALLEL = '0'
  try {
    const result = await classifySileroVadParallel(input, {
      energyFrameRms,
      silenceThresholdDbfs: STUB_THRESH_DB,
      numFrames: energyFrameRms.length,
      runVad: () => { throw new Error('runVad should not be called when disabled') },
    })
    assert.equal(result, null, 'expected null (caller falls back to single call)')
  } finally {
    process.env.SILERO_PARALLEL = '1'
  }
})

test('single-worker pool disables parallelism (returns null)', async () => {
  const input = await makeSplittableWav(60)
  const { samples } = await readWavSamples(input)
  const energyFrameRms = frameRmsLinear(samples)

  const prev = process.env.PYTHON_WORKER_POOL_SIZE
  process.env.PYTHON_WORKER_POOL_SIZE = '1'
  try {
    const result = await classifySileroVadParallel(input, {
      energyFrameRms,
      silenceThresholdDbfs: STUB_THRESH_DB,
      numFrames: energyFrameRms.length,
      runVad: () => { throw new Error('runVad should not be called with a single worker') },
    })
    assert.equal(result, null, 'expected null with a single-worker pool')
  } finally {
    process.env.PYTHON_WORKER_POOL_SIZE = prev
  }
})
