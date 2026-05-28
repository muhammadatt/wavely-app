/**
 * Tests for the chunked block runner.
 *
 * Validates that running a deterministic inner stage (`hpf`) chunk-by-chunk
 * and stitching the per-chunk outputs back together produces a result that
 * matches a whole-file run of the same stage to within the equal-power
 * crossfade tolerance at each seam.
 *
 * Run with:  cd server && npm test
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tempPath, removeTmp, applyHighPass } from '../lib/ffmpeg.js'
import { runFfmpeg }            from '../lib/exec-ffmpeg.js'
import { readWavAllChannels }   from '../pipeline/wavReader.js'
import { runChunkedBlock }      from '../pipeline/chunkedRunner.js'
import { hpf }                  from '../pipeline/stages.js'

const TEMP_FILES = []

/**
 * Generate a long synthetic mono WAV: alternating sine tones and silence
 * regions. The silence regions are long enough that planChunkBoundaries
 * can split there (≥500 ms minimum).
 */
async function makeChunkableWav(durationSec) {
  const outPath = tempPath('.wav')
  TEMP_FILES.push(outPath)
  // 4 × ~30 s sine segments separated by 1 s silence — gives the planner
  // three splittable silences spread across the file.
  const segSec = durationSec / 4 - 0.75
  // Use lavfi `sine` for tones and `anullsrc`+atrim for silence — one input
  // per concat slot since a labelled output can only feed one consumer.
  // sine for tones, anullsrc + atrim for silence (older ffmpeg doesn't
  // accept anullsrc=d=…). One input per concat slot since each labelled
  // output can only feed one consumer.
  const sil = 'anullsrc=cl=mono:r=44100'
  await runFfmpeg([
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${segSec}`,
    '-f', 'lavfi', '-i', sil,
    '-f', 'lavfi', '-i', `sine=frequency=523:sample_rate=44100:duration=${segSec}`,
    '-f', 'lavfi', '-i', sil,
    '-f', 'lavfi', '-i', `sine=frequency=659:sample_rate=44100:duration=${segSec}`,
    '-f', 'lavfi', '-i', sil,
    '-f', 'lavfi', '-i', `sine=frequency=784:sample_rate=44100:duration=${segSec}`,
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

/**
 * Build a minimal pipeline ctx that mimics what the orchestrator hands to
 * stage functions. results.metrics.frames is supplied directly here (instead
 * of running analyzeFramesRaw) so the test stays fast and deterministic.
 */
async function makeCtx(inputPath, sampleRate) {
  const { channels } = await readWavAllChannels(inputPath)
  const totalSamples = channels[0].length
  const frameSamples = Math.round(0.025 * sampleRate)  // 25 ms — matches frameAnalysis.js
  const numFrames    = Math.floor(totalSamples / frameSamples)

  // Build synthetic frames marking the 1 s silence pads as isSilence.
  // The test signal is 4 sines × ~Xs separated by 1 s silence.
  const segSec  = (totalSamples / sampleRate) / 4 - 0.75
  const frames  = []
  for (let i = 0; i < numFrames; i++) {
    const t = i * frameSamples / sampleRate
    // Compute time within the repeating (segSec + 1s) cycle
    const cyclePos = t % (segSec + 1)
    const isSilence = cyclePos >= segSec  // silence is the trailing 1 s of each cycle
    frames.push({
      index:         i,
      offsetSamples: i * frameSamples,
      lengthSamples: frameSamples,
      isSilence,
      rmsDbfs:       isSilence ? -90 : -10,
    })
  }

  return {
    currentPath:    inputPath,
    preset:         {},
    outputProfile:  {},
    tmp(ext) {
      const p = tempPath(ext)
      TEMP_FILES.push(p)
      return p
    },
    tmpFiles: TEMP_FILES,
    log:      () => {},
    results:  { metrics: { frames, noiseFloorDbfs: -90 } },
    globalParams: {},
  }
}

after(async () => {
  for (const f of TEMP_FILES) await removeTmp(f)
})

test('chunked block: hpf via chunks matches whole-file hpf within crossfade tolerance', async () => {
  const input = await makeChunkableWav(120)  // 2 minutes — long enough to force multi-chunk plan
  const sampleRate = 44100

  // Whole-file reference run
  const wholePath = tempPath('.wav')
  TEMP_FILES.push(wholePath)
  await applyHighPass(input, wholePath)
  const whole = (await readWavAllChannels(wholePath)).channels[0]

  // Chunked run via the runner. Force a multi-chunk plan by overriding the
  // planner defaults (production uses 5/10 min targets which would yield a
  // single-chunk plan for this 2-min fixture).
  const ctx = await makeCtx(input, sampleRate)
  let innerInvocations = 0
  await runChunkedBlock(
    ctx,
    ['hpf'],
    async (subCtx, entry) => {
      innerInvocations++
      if (entry !== 'hpf') throw new Error('test dispatch: unexpected inner entry')
      await hpf(subCtx)
    },
    { targetChunkDurationS: 30, minChunkDurationS: 10, maxChunkDurationS: 60 },
  )
  assert.ok(innerInvocations >= 2,
    `expected ≥2 inner invocations (multi-chunk path), got ${innerInvocations}`)
  const chunked = (await readWavAllChannels(ctx.currentPath)).channels[0]

  // Lengths must match exactly — chunking must not change sample count
  assert.equal(chunked.length, whole.length,
    `chunked length ${chunked.length} != whole length ${whole.length}`)

  // Most samples should match the whole-file output to high precision.
  // Allow looser tolerance inside the crossfade regions: a 4th-order
  // Butterworth's transient state differs slightly when restarted on a
  // chunk boundary, so the seam will show a small deviation before the
  // crossfade weights bring the two runs back together.
  const TIGHT_TOL = 1e-3   // bulk of the file
  const LOOSE_TOL = 0.05   // within crossfade windows
  let mismatchedTight = 0
  let maxAbsDiff      = 0
  for (let i = 0; i < whole.length; i++) {
    const diff = Math.abs(chunked[i] - whole[i])
    if (diff > maxAbsDiff) maxAbsDiff = diff
    if (diff > TIGHT_TOL)  mismatchedTight++
  }
  // Total crossfade region budget: at most ~3 seams × 200 ms = 600 ms = ~26k samples
  // Allow a generous cap that catches catastrophic regressions but tolerates
  // expected filter-warmup differences at seams.
  const maxAllowedMismatched = Math.round(0.05 * whole.length)
  assert.ok(mismatchedTight <= maxAllowedMismatched,
    `${mismatchedTight} samples exceed tight tolerance ${TIGHT_TOL} (max abs diff ${maxAbsDiff.toExponential(2)})`)
  assert.ok(maxAbsDiff <= LOOSE_TOL,
    `max abs diff ${maxAbsDiff} exceeds loose tolerance ${LOOSE_TOL}`)
})

test('chunked block: single-chunk plan bypasses carve/stitch', async () => {
  // Short file (< 2 min) — planner returns a single chunk; runner should
  // invoke the inner stage exactly once against the parent ctx.
  const input = await makeChunkableWav(30)
  const ctx   = await makeCtx(input, 44100)

  let invocations = 0
  await runChunkedBlock(ctx, ['hpf'], async (subCtx, entry) => {
    invocations++
    assert.equal(subCtx, ctx, 'single-chunk path should pass parent ctx, not a sub-ctx')
    assert.equal(entry, 'hpf')
    await hpf(subCtx)
  })

  assert.equal(invocations, 1, `expected exactly 1 inner invocation, got ${invocations}`)
})
