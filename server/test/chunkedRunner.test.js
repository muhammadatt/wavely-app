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
import { planChunkBoundaries }  from '../pipeline/chunking.js'
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
  const timings = await runChunkedBlock(
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

  // Timings shape — verify the public contract the orchestrator logs against
  assert.ok(timings, 'expected runChunkedBlock to return a timings object')
  assert.equal(timings.overall.plannedChunks, innerInvocations,
    'plannedChunks should match the number of inner invocations for a 1-stage block')
  assert.equal(timings.overall.overlapMs, 100)
  assert.ok(timings.overall.stitchMs > 0,
    `stitchMs should be >0 for multi-chunk plan, got ${timings.overall.stitchMs}`)
  assert.equal(timings.overall.planReason, null,
    'planReason should be null when planner returned multiple chunks')
  assert.equal(timings.perChunk.length, innerInvocations)
  for (let i = 0; i < timings.perChunk.length; i++) {
    const c = timings.perChunk[i]
    assert.equal(c.index, i + 1)
    assert.equal(c.stages.length, 1)
    assert.equal(c.stages[0].name, 'hpf')
    assert.ok(c.stages[0].durationMs >= 0)
    assert.ok(c.carveMs >= 0)
  }
  assert.equal(timings.perStage.hpf.count, innerInvocations)
  assert.equal(
    timings.perStage.hpf.totalMs,
    timings.perChunk.reduce((s, c) => s + c.stages[0].durationMs, 0),
    'perStage.hpf.totalMs should equal sum of per-chunk hpf durations',
  )

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

test('planChunkBoundaries: bails to single-chunk plan when a search window has no silence', async () => {
  // Construct a 30 min file with silence only in the first 10 min. The
  // planner should place splits in the silence-rich region until its next
  // search window (anchored to the last emitted split) falls in the silent-
  // free tail, then bail entirely rather than emit a final chunk that spans
  // the rest of the file and violates maxChunkDurationS.
  const sampleRate    = 44100
  const totalSamples  = 30 * 60 * sampleRate
  const frameSamples  = Math.round(0.025 * sampleRate)
  const numFrames     = Math.floor(totalSamples / frameSamples)
  const silenceCutoff = 10 * 60 * sampleRate

  const frames = []
  for (let i = 0; i < numFrames; i++) {
    const start = i * frameSamples
    // Silence only in first 10 min, at minutes 3 and 6 (≥500 ms each).
    const inSilence1 = start >= 3 * 60 * sampleRate && start < 3 * 60 * sampleRate + sampleRate
    const inSilence2 = start >= 6 * 60 * sampleRate && start < 6 * 60 * sampleRate + sampleRate
    const isSilence  = start < silenceCutoff && (inSilence1 || inSilence2)
    frames.push({ offsetSamples: start, lengthSamples: frameSamples, isSilence })
  }

  const plan = planChunkBoundaries({
    frames, sampleRate, totalSamples,
    options: { targetChunkDurationS: 180, minChunkDurationS: 60, maxChunkDurationS: 300 },
  })

  // The bug case: previously the planner advanced its cursor past the
  // silent-free tail without emitting splits, then emitted a final chunk
  // anchored to the last successful split — that chunk could span the rest
  // of the file (oversize). The fix bails to a single-chunk plan instead,
  // letting the runner fall back to running inner stages whole-file.
  assert.equal(plan.chunks.length, 1, `expected single-chunk bail, got ${plan.chunks.length} chunks`)
  assert.equal(plan.reason, 'no_silence_in_split_window')
  // Sanity: the chunk spans the whole file.
  assert.equal(plan.chunks[0].startSample, 0)
  assert.equal(plan.chunks[0].endSample, totalSamples)
})

test('planChunkBoundaries: when every search window has silence, no chunk exceeds max', async () => {
  // Counterpart to the bail test: ensure the happy path still respects max
  // when splits can be placed throughout the file. Synthesise silence every
  // 4 min across a 30 min file; with max=300 s the planner must keep
  // emitting splits so the worst chunk stays ≤ 5 min.
  const sampleRate   = 44100
  const totalSamples = 30 * 60 * sampleRate
  const frameSamples = Math.round(0.025 * sampleRate)
  const numFrames    = Math.floor(totalSamples / frameSamples)

  const frames = []
  for (let i = 0; i < numFrames; i++) {
    const start = i * frameSamples
    // 1 s silence at minutes 4, 8, 12, 16, 20, 24, 28
    const minute   = Math.floor(start / sampleRate / 60)
    const insideMin = (start / sampleRate) % 60
    const isSilence = minute > 0 && minute % 4 === 0 && insideMin < 1
    frames.push({ offsetSamples: start, lengthSamples: frameSamples, isSilence })
  }

  const plan = planChunkBoundaries({
    frames, sampleRate, totalSamples,
    options: { targetChunkDurationS: 240, minChunkDurationS: 60, maxChunkDurationS: 300 },
  })

  assert.ok(plan.chunks.length > 1, `expected multi-chunk plan, got ${plan.chunks.length}`)
  const maxChunkSamples = 300 * sampleRate
  for (const c of plan.chunks) {
    assert.ok(
      c.endSample - c.startSample <= maxChunkSamples,
      `chunk [${c.startSample}, ${c.endSample}) length ${c.endSample - c.startSample} ` +
      `exceeds max ${maxChunkSamples}`,
    )
  }
})

test('chunked block: timings distinguish inner stages by model and aggregate per-stage', async () => {
  // Verifies the display-name resolver and per-stage aggregation: two
  // inner-stage entries with the same configKey but different `model`
  // settings should appear as separate per-stage rollup keys.
  const input = await makeChunkableWav(120)
  const ctx   = await makeCtx(input, 44100)

  // Synthetic no-op stages that mimic the dispatch contract — we only
  // care about the runner's timing scaffolding, not the actual processing.
  const noop = async () => {}
  const timings = await runChunkedBlock(
    ctx,
    [{ noiseReduce: { model: 'df3' } }, { noiseReduce: { model: 'rnnoise' } }],
    noop,
    { targetChunkDurationS: 30, minChunkDurationS: 10, maxChunkDurationS: 60 },
  )

  assert.ok(timings.perStage['noiseReduce(df3)'],     'expected noiseReduce(df3) in perStage')
  assert.ok(timings.perStage['noiseReduce(rnnoise)'], 'expected noiseReduce(rnnoise) in perStage')
  assert.equal(timings.perStage['noiseReduce(df3)'].count, timings.overall.plannedChunks)
  assert.equal(timings.perStage['noiseReduce(rnnoise)'].count, timings.overall.plannedChunks)
})

test('chunked block: single-chunk plan still produces a timings report', async () => {
  const input = await makeChunkableWav(30)
  const ctx   = await makeCtx(input, 44100)

  const timings = await runChunkedBlock(ctx, ['hpf'], async (subCtx) => {
    await hpf(subCtx)
  })

  assert.equal(timings.overall.plannedChunks, 1)
  assert.equal(timings.overall.stitchMs, 0,
    'single-chunk plan should report stitchMs=0 (no stitching done)')
  assert.ok(typeof timings.overall.planReason === 'string',
    'single-chunk plan should surface a planReason')
  assert.equal(timings.perChunk.length, 1)
  assert.equal(timings.perChunk[0].carveMs, 0)
  assert.equal(timings.perStage.hpf.count, 1)
})

test('chunked block: concurrency runs chunks in parallel and preserves order', async () => {
  // Inner-stage callback sleeps SLEEP_MS per call. With sequential dispatch
  // wallClockMs ≥ chunks × SLEEP_MS; with concurrency=N, wall clock should
  // drop near (chunks/N) × SLEEP_MS. We also track in-flight count to assert
  // the cap is actually applied.
  const SLEEP_MS = 200
  const input    = await makeChunkableWav(120)
  const ctx      = await makeCtx(input, 44100)

  let inFlight    = 0
  let peakInFlight = 0
  const completionOrder = []
  const innerStage = async (subCtx) => {
    inFlight++
    if (inFlight > peakInFlight) peakInFlight = inFlight
    await new Promise(r => setTimeout(r, SLEEP_MS))
    inFlight--
    // Track completion order by carved sample-range start (subCtx.currentPath
    // is a temp file, but the chunkInPath suffix differs per chunk — easier
    // to capture the call order via a shared counter).
    completionOrder.push(completionOrder.length + 1)
  }

  const timings = await runChunkedBlock(
    ctx,
    ['hpf'],
    innerStage,
    { targetChunkDurationS: 30, minChunkDurationS: 10, maxChunkDurationS: 60 },
    /* concurrency */ 3,
  )

  assert.ok(timings.overall.plannedChunks >= 2,
    `expected ≥2 chunks for multi-chunk concurrency test, got ${timings.overall.plannedChunks}`)
  assert.equal(timings.overall.concurrency, Math.min(3, timings.overall.plannedChunks),
    'effective concurrency should equal min(requested, plannedChunks)')
  assert.ok(peakInFlight >= 2,
    `peak in-flight should be ≥2 when concurrency>1, got ${peakInFlight}`)
  assert.ok(peakInFlight <= timings.overall.concurrency,
    `peak in-flight ${peakInFlight} exceeded concurrency cap ${timings.overall.concurrency}`)

  // wallClock should be meaningfully less than serial (innerTotalMs) at
  // peak parallelism. Allow generous slack for setTimeout scheduling jitter
  // and per-chunk carve overhead — the key check is "not serial".
  const serialFloor = timings.overall.plannedChunks * SLEEP_MS
  assert.ok(
    timings.overall.wallClockMs < serialFloor,
    `expected wallClockMs (${timings.overall.wallClockMs}) < serial floor (${serialFloor})`,
  )

  // perChunk[] must be in plan order regardless of completion order
  for (let i = 0; i < timings.perChunk.length; i++) {
    assert.equal(timings.perChunk[i].index, i + 1)
  }
})

test('chunked block: concurrency=1 produces serial wall-clock (baseline)', async () => {
  const SLEEP_MS = 100
  const input    = await makeChunkableWav(120)
  const ctx      = await makeCtx(input, 44100)

  let peakInFlight = 0
  let inFlight     = 0
  const innerStage = async () => {
    inFlight++
    if (inFlight > peakInFlight) peakInFlight = inFlight
    await new Promise(r => setTimeout(r, SLEEP_MS))
    inFlight--
  }

  const timings = await runChunkedBlock(
    ctx,
    ['hpf'],
    innerStage,
    { targetChunkDurationS: 30, minChunkDurationS: 10, maxChunkDurationS: 60 },
    /* concurrency */ 1,
  )

  assert.equal(timings.overall.concurrency, 1)
  assert.equal(peakInFlight, 1, 'concurrency=1 must never run more than one chunk at a time')
  // Serial: wallClock ≈ chunks × (SLEEP_MS + carveMs). Floor at chunks × SLEEP_MS.
  const serialFloor = timings.overall.plannedChunks * SLEEP_MS
  assert.ok(
    timings.overall.wallClockMs >= serialFloor,
    `expected wallClockMs (${timings.overall.wallClockMs}) >= serial floor (${serialFloor})`,
  )
})

test('chunked block: propagates notch60Hz from chunks and refreshes metrics post-stitch', async () => {
  // Inner stages writing to subCtx.results should NOT be silently dropped on
  // the way back to the parent. This was the bug: hpf sets notch60Hz, and
  // noiseReduce refreshes whole-file metric scalars; both were lost before
  // the merge/refresh fix.
  const input = await makeChunkableWav(120)
  const ctx   = await makeCtx(input, 44100)

  // Seed the parent's metrics with sentinel values so we can prove the
  // post-block refresh ran (the stitched output is real audio, so the
  // refreshed value will be far from -77 / -33).
  ctx.results.metrics.noiseFloorDbfs       = -77.0
  ctx.results.metrics.voicedRmsDbfs        = -33.0
  ctx.results.metrics.averageVoicedRmsDbfs = -33.0
  ctx.results.metrics.silenceThresholdDbfs = -71.0

  // Synthetic inner stage that mimics what real hpf + noiseReduce do:
  // write notch60Hz, write a noiseReduction report, and update metrics on
  // the sub-ctx. Stays as a no-op for the audio so the stitcher can still
  // produce a valid output.
  const innerStage = async (subCtx) => {
    subCtx.results.notch60Hz = true
    subCtx.results.noiseReduction = {
      applied: true,
      model: 'DF3-sim',
      pre_noise_floor_dbfs:  -77.0,
      post_noise_floor_dbfs: -88.0,
      makeupGainDb: 1.2,
    }
    // Sub-ctx writes here go to the sub-ctx clone, not the parent.
    subCtx.results.metrics.noiseFloorDbfs = -88.0
  }

  await runChunkedBlock(
    ctx,
    ['hpf'],   // entry name doesn't matter — innerStage above runs
    innerStage,
    { targetChunkDurationS: 30, minChunkDurationS: 10, maxChunkDurationS: 60 },
  )

  // notch60Hz propagated from chunk 0
  assert.equal(ctx.results.notch60Hz, true,
    'expected notch60Hz from chunk 0 to propagate to parent ctx.results')

  // noiseReduction report present and structurally intact
  assert.ok(ctx.results.noiseReduction, 'expected noiseReduction report on parent ctx')
  assert.equal(ctx.results.noiseReduction.model, 'DF3-sim')
  assert.equal(ctx.results.noiseReduction.applied, true)

  // Metrics refreshed from stitched audio — sentinel values must be gone
  assert.notEqual(ctx.results.metrics.noiseFloorDbfs, -77.0,
    `noiseFloorDbfs (${ctx.results.metrics.noiseFloorDbfs}) is still the sentinel; ` +
    `expected post-stitch refresh from remeasureFrames`)
  assert.notEqual(ctx.results.metrics.voicedRmsDbfs, -33.0,
    `voicedRmsDbfs (${ctx.results.metrics.voicedRmsDbfs}) is still the sentinel`)

  // noiseReduction.post_noise_floor_dbfs synced to the refreshed metrics
  assert.equal(
    ctx.results.noiseReduction.post_noise_floor_dbfs,
    ctx.results.metrics.noiseFloorDbfs,
    'noiseReduction.post_noise_floor_dbfs should equal refreshed metrics.noiseFloorDbfs',
  )
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
