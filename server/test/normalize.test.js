/**
 * Tests for the ACX RMS normalize stage.
 *
 * Validates that the `normalize` pipeline stage, when run with the `acx`
 * output profile, drives the output audio to ungated full-file RMS of
 * -20 dBFS regardless of the input level. This is the contract the ACX
 * certification check (full-file RMS within [-23, -18]) relies on.
 *
 * Run with:  cd server && node --test test/normalize.test.js
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { tempPath, removeTmp } from '../lib/ffmpeg.js'
import { runFfmpeg }            from '../lib/exec-ffmpeg.js'
import { normalize }            from '../pipeline/stages.js'
import { measureRmsDbfs }       from '../pipeline/measure.js'
import { OUTPUT_PROFILES }      from '../presets.js'

const TARGET_DBFS    = -20  // ACX RMS target
const TARGET_TOL_DB  = 0.1  // tolerance on output RMS — well below the ACX [-23, -18] window
const TEMP_FILES     = []

/**
 * Generate a synthetic mono WAV containing a 440 Hz sine wave.
 *
 * @param {number} durationSec
 * @param {number} amplitudeDb  - per-sample amplitude in dBFS (sine peak; RMS is amplitudeDb - 3.01)
 * @returns {Promise<string>} path to the generated WAV
 */
async function makeSineWav(durationSec, amplitudeDb) {
  const outPath = tempPath('.wav')
  TEMP_FILES.push(outPath)
  await runFfmpeg([
    '-f', 'lavfi',
    '-i', `sine=frequency=440:sample_rate=44100:duration=${durationSec}`,
    '-af', `volume=${amplitudeDb}dB`,
    '-c:a', 'pcm_f32le',
    '-ac', '1',
    outPath,
  ])
  return outPath
}

/**
 * Generate a synthetic mono WAV containing sine, prefixed and suffixed with
 * digital silence. Emulates the shape of a real audiobook file where the
 * voiced material is interrupted by leading/trailing room silence — used to
 * confirm full-file RMS normalization is invariant to the silence ratio.
 *
 * @param {number} sineSec         duration of the sine segment in seconds
 * @param {number} silenceSec      duration of silence at head AND tail
 * @param {number} amplitudeDb     sine peak amplitude in dBFS
 */
async function makeSinePlusSilenceWav(sineSec, silenceSec, amplitudeDb) {
  const outPath = tempPath('.wav')
  TEMP_FILES.push(outPath)
  await runFfmpeg([
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${sineSec}`,
    '-f', 'lavfi', '-i', `anullsrc=cl=mono:r=44100`,
    '-filter_complex',
      // [1] is the silence source; trim each end-piece to the requested duration,
      // then concat: silence + sine + silence
      `[1:a]atrim=duration=${silenceSec},asetpts=PTS-STARTPTS[head];` +
      `[1:a]atrim=duration=${silenceSec},asetpts=PTS-STARTPTS[tail];` +
      `[0:a]volume=${amplitudeDb}dB[voiced];` +
      `[head][voiced][tail]concat=n=3:v=0:a=1[out]`,
    '-map', '[out]',
    '-c:a', 'pcm_f32le',
    '-ac', '1',
    outPath,
  ])
  return outPath
}

/**
 * Build a minimal ctx for invoking a pipeline stage in isolation.
 */
function makeCtx(inputPath, outputProfile) {
  const localTmpFiles = []
  return {
    currentPath: inputPath,
    outputProfile,
    tmp(ext) {
      const p = tempPath(ext)
      localTmpFiles.push(p)
      TEMP_FILES.push(p)
      return p
    },
    tmpFiles: localTmpFiles,
    log: () => {},  // silence stage logging during tests
    results: {},
  }
}

after(async () => {
  for (const f of TEMP_FILES) await removeTmp(f)
})

test('normalize (ACX/RMS): quiet sine lands within tolerance of -20 dBFS', async () => {
  // -30 dBFS sine peak => -33 dBFS full-file RMS. Requires +13 dB of gain.
  const input  = await makeSineWav(2, -30)
  const inRms  = await measureRmsDbfs(input)
  assert.ok(Number.isFinite(inRms), `expected finite input RMS, got ${inRms}`)

  const ctx = makeCtx(input, OUTPUT_PROFILES.acx)
  await normalize(ctx)

  const outRms = await measureRmsDbfs(ctx.currentPath)
  assert.ok(
    Math.abs(outRms - TARGET_DBFS) < TARGET_TOL_DB,
    `output full-file RMS ${outRms} dBFS not within ±${TARGET_TOL_DB} of ${TARGET_DBFS} (input was ${inRms})`
  )
  assert.equal(ctx.results.normalize, undefined,
    'normalize() does not populate ctx.results.normalize — log-only reporting via logLevel'
  )
})

test('normalize (ACX/RMS): loud sine lands within tolerance of -20 dBFS', async () => {
  // -6 dBFS sine peak => -9 dBFS full-file RMS. Requires -11 dB of gain (attenuation).
  const input  = await makeSineWav(2, -6)
  const inRms  = await measureRmsDbfs(input)
  assert.ok(Number.isFinite(inRms), `expected finite input RMS, got ${inRms}`)

  const ctx = makeCtx(input, OUTPUT_PROFILES.acx)
  await normalize(ctx)

  const outRms = await measureRmsDbfs(ctx.currentPath)
  assert.ok(
    Math.abs(outRms - TARGET_DBFS) < TARGET_TOL_DB,
    `output full-file RMS ${outRms} dBFS not within ±${TARGET_TOL_DB} of ${TARGET_DBFS} (input was ${inRms})`
  )
})

test('normalize (ACX/RMS): sine + silence padding still lands at -20 dBFS', async () => {
  // Audiobook-shaped input: 2 s of sine flanked by 1 s of silence on each
  // side (50 % silence ratio). Pre-fix behavior would lift voiced RMS to
  // -20 and leave full-file RMS undershooting by the silence drag (~3 dB).
  // The fix targets ungated full-file RMS directly, so this lands at -20
  // regardless of how much silence is in the file.
  const input  = await makeSinePlusSilenceWav(2, 1, -20)
  const inRms  = await measureRmsDbfs(input)
  assert.ok(Number.isFinite(inRms), `expected finite input RMS, got ${inRms}`)

  const ctx = makeCtx(input, OUTPUT_PROFILES.acx)
  await normalize(ctx)

  const outRms = await measureRmsDbfs(ctx.currentPath)
  assert.ok(
    Math.abs(outRms - TARGET_DBFS) < TARGET_TOL_DB,
    `output full-file RMS ${outRms} dBFS not within ±${TARGET_TOL_DB} of ${TARGET_DBFS} ` +
    `for sine+silence input (input was ${inRms}). Voiced-only normalization would ` +
    `undershoot here — this test guards against that regression.`
  )
})
