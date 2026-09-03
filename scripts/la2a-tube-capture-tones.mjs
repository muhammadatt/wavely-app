#!/usr/bin/env node
/**
 * Generate the probe tones for the LAEA tube-stage capture.
 *
 *   npm run la2a:tube:tones
 *
 * See docs/la2a_tube_capture_protocol.md for the full protocol — what to do
 * with these files, how to bounce them, and what the capture answers and does
 * not. This script only builds the stimulus.
 *
 * ⚠ THIS FILE IS THE SWEEP'S SINGLE SOURCE OF TRUTH. `la2a-tube-fit.mjs`
 * imports the entry lists below rather than reading a manifest, so tones and
 * analysis cannot drift apart — there is no JSON to go stale. Change a sweep
 * here and the fit script sees the same change on its next run.
 *
 * WHY THESE THREE SWEEPS AND NOT ONE GRID.
 *
 *   LEVEL SWEEP (1 kHz, 8 levels, Gain 0, Peak Reduction 0) is the one that
 *   calibrates TUBE_DRIVE_LIN and TUBE_BIAS. It needs no assumption about the
 *   plugin's Gain knob at all — the only thing driving the tube is the input
 *   level, which this script sets exactly. 1 kHz because that is the
 *   frequency hardware THD specs are conventionally quoted at, including the
 *   LA-2A's own — so a plugin datasheet or a bench figure is comparable
 *   without a correction.
 *
 *   FREQ SWEEP (7 frequencies, one fixed level) is a HOLD-OUT check, not fit
 *   data. Our shaper is memoryless, so it predicts IDENTICAL harmonic ratios
 *   at every frequency for a given input level — that is a testable claim,
 *   not an assumption baked into the model. If a real LA-2A's output
 *   transformer saturates low frequencies harder than high ones, no amount of
 *   retuning TUBE_DRIVE_LIN or TUBE_BIAS can reproduce that; it would mean the
 *   memoryless curve is the wrong shape for the stage, not that its constants
 *   are wrong. Keeping this out of the fit is what lets it answer that
 *   question instead of assuming the answer.
 *
 *   GAIN SWEEP (one tone, several knob positions) is QUALITATIVE. It exists to
 *   confirm the makeup-drives-the-tube claim through the plugin's own control
 *   rather than only through a level we set ourselves — but the knob's
 *   printed number is not trusted as a dB value unless the operator confirms
 *   it against the level sweep (see the protocol doc's calibration check).
 *   `la2a-tube-fit.mjs` reports this sweep but does not fit against it.
 *
 * WHY DBC RATHER THAN ABSOLUTE LEVEL. Harmonic content expressed relative to
 * the fundamental (dBc) is immune to any linear output trim the plugin
 * applies — insertion gain, a "make-up" pad, whatever. That is the opposite of
 * the R37 taper fit, whose target (dB of gain reduction) is NOT immune to a
 * trim and needed the reference's +1.34 dB insertion gain measured and
 * removed first. Nothing here needs that: no bypass reference capture, no
 * insertion-gain correction. What still has to be exact is the INPUT level,
 * and that is exact by construction — these are generated tones, not a
 * recording of something else.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const OUT_DIR = join(ROOT, 'data/corpus/la2a/tube_capture')
export const TONES_DIR = join(OUT_DIR, 'tones')
export const CAPTURES_DIR = join(OUT_DIR, 'captures')

/**
 * Sample rate for the generated tones, and the rate this protocol asks the
 * capture session to run at. Harmonics are measured through H8 (see
 * la2a-tube-fit.mjs), and the freq sweep goes up to 5 kHz — H8 of that is
 * 40 kHz, which needs a Nyquist above it. 96 kHz clears every probe frequency
 * with margin; 44.1/48 kHz would alias the freq sweep's top end back into the
 * harmonics being measured.
 */
export const CAPTURE_SR = 96000

export const TONE_SECONDS = 3.0
export const FADE_MS = 20

/**
 * Analysis window, in seconds counted back from the END of the capture, not
 * the start. A capture's head can carry an unknown amount of DAW pre-roll,
 * plugin latency, or dead air before the tone actually begins — counting from
 * the end is robust to all of that as long as the file is at least this long
 * (TONE_SECONDS plus a little tail comfortably clears it). Mirrors the
 * "skip past settling" convention `la2a-dcblock-real.mjs` uses, generalised to
 * not need a known head offset at all.
 */
export const ANALYSIS_WINDOW_END_OFFSET_S = 0.5
export const ANALYSIS_WINDOW_LENGTH_S = 1.5

// ── Level sweep — the one that calibrates the curve ────────────────────────
export const LEVEL_SWEEP_FREQ_HZ = 1000
export const LEVEL_SWEEP_DBFS = [-40, -30, -24, -18, -12, -6, -3, -1]

// ── Frequency sweep — hold-out, not fit against ─────────────────────────────
export const FREQ_SWEEP_DBFS = -6 // mid-travel: clearly above any plugin noise floor, well short of the extreme end
export const FREQ_SWEEP_HZ = [50, 100, 200, 500, 1000, 2000, 5000]

// ── Gain-knob sweep — qualitative corroboration only ────────────────────────
export const GAIN_SWEEP_FREQ_HZ = 1000
export const GAIN_SWEEP_DBFS = -18 // NOMINAL_DBFS in la2aProcessor.js — 0 VU

/** `-18 -> "-018"`, `-1 -> "-001"`, `0 -> "+000"`. Always signed, always 3 digits. */
function formatDb(v) {
  const r = Math.round(v)
  return (r < 0 ? '-' : '+') + String(Math.abs(r)).padStart(3, '0')
}

export function toneFilename(kind, freqHz, levelDbfs) {
  return `${kind}_${String(freqHz).padStart(5, '0')}hz_${formatDb(levelDbfs)}dbfs.wav`
}

/**
 * Every entry the sweep needs a tone for. `id` is stable and human-readable;
 * `file` is the exact filename `la2a-tube-fit.mjs` will look for under
 * `captures/` with no path munging, so the naming is the whole contract
 * between "make this in your DAW" and "the script found it".
 */
export function sweepEntries() {
  const entries = []
  for (const dbfs of LEVEL_SWEEP_DBFS) {
    entries.push({ id: `level@${dbfs}dBFS`, kind: 'level', freqHz: LEVEL_SWEEP_FREQ_HZ, levelDbfs: dbfs, file: toneFilename('level', LEVEL_SWEEP_FREQ_HZ, dbfs) })
  }
  for (const hz of FREQ_SWEEP_HZ) {
    entries.push({ id: `freq@${hz}Hz`, kind: 'freq', freqHz: hz, levelDbfs: FREQ_SWEEP_DBFS, file: toneFilename('freq', hz, FREQ_SWEEP_DBFS) })
  }
  entries.push({ id: 'gain-sweep-tone', kind: 'gain', freqHz: GAIN_SWEEP_FREQ_HZ, levelDbfs: GAIN_SWEEP_DBFS, file: toneFilename('gain', GAIN_SWEEP_FREQ_HZ, GAIN_SWEEP_DBFS) })
  return entries
}

export const NOISE_FLOOR_FILE = 'noise_silence.wav'

// ── WAV writer — 32-bit float, mono, no quantization of the stimulus ────────

function writeFloatWav(path, samples, sampleRate) {
  const n = samples.length
  const fmtSize = 18
  const factSize = 4
  const dataSize = n * 4
  const buf = Buffer.alloc(12 + (8 + fmtSize) + (8 + factSize) + (8 + dataSize))
  let o = 0
  buf.write('RIFF', o); o += 4
  buf.writeUInt32LE(buf.length - 8, o); o += 4
  buf.write('WAVE', o); o += 4

  buf.write('fmt ', o); o += 4
  buf.writeUInt32LE(fmtSize, o); o += 4
  buf.writeUInt16LE(3, o); o += 2 // WAVE_FORMAT_IEEE_FLOAT
  buf.writeUInt16LE(1, o); o += 2 // mono
  buf.writeUInt32LE(sampleRate, o); o += 4
  buf.writeUInt32LE(sampleRate * 4, o); o += 4 // byte rate
  buf.writeUInt16LE(4, o); o += 2 // block align
  buf.writeUInt16LE(32, o); o += 2 // bits per sample
  buf.writeUInt16LE(0, o); o += 2 // cbSize

  buf.write('fact', o); o += 4
  buf.writeUInt32LE(factSize, o); o += 4
  buf.writeUInt32LE(n, o); o += 4

  buf.write('data', o); o += 4
  buf.writeUInt32LE(dataSize, o); o += 4
  for (let i = 0; i < n; i++) { buf.writeFloatLE(samples[i], o); o += 4 }

  writeFileSync(path, buf)
}

/**
 * A raised-cosine fade in/out around an otherwise steady tone. The fade
 * exists so a DAW bounce doesn't click at the boundary; it sits entirely
 * outside the analysis window (see ANALYSIS_WINDOW_*), so it never touches a
 * measurement.
 */
function buildTone(freqHz, levelDbfs, sr) {
  const n = Math.round(TONE_SECONDS * sr)
  const amp = Math.pow(10, levelDbfs / 20)
  const fadeN = Math.round(FADE_MS / 1000 * sr)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let g = 1
    if (i < fadeN) g = 0.5 * (1 - Math.cos(Math.PI * i / fadeN))
    else if (i >= n - fadeN) g = 0.5 * (1 - Math.cos(Math.PI * (n - 1 - i) / fadeN))
    x[i] = amp * g * Math.sin(2 * Math.PI * freqHz * i / sr)
  }
  return x
}

function main() {
  mkdirSync(TONES_DIR, { recursive: true })
  mkdirSync(CAPTURES_DIR, { recursive: true }) // created empty so the DAW has somewhere obvious to export into

  const entries = sweepEntries()
  for (const e of entries) {
    writeFloatWav(join(TONES_DIR, e.file), buildTone(e.freqHz, e.levelDbfs, CAPTURE_SR), CAPTURE_SR)
  }
  writeFloatWav(join(TONES_DIR, NOISE_FLOOR_FILE), new Float32Array(Math.round(TONE_SECONDS * CAPTURE_SR)), CAPTURE_SR)

  console.log(`Wrote ${entries.length + 1} tones to ${TONES_DIR}`)
  console.log(`\nNext: docs/la2a_tube_capture_protocol.md — process each tone through LAEA`)
  console.log(`and save the result under the SAME filename in:\n  ${CAPTURES_DIR}`)
  console.log(`\nThe gain-sweep tone (${toneFilename('gain', GAIN_SWEEP_FREQ_HZ, GAIN_SWEEP_DBFS)}) is bounced`)
  console.log(`multiple times at different Gain settings — see the protocol for that file's naming.`)
  console.log(`\nWhen ready:  npm run la2a:tube:fit`)
}

// Only when run directly (`node la2a-tube-capture-tones.mjs`), not on import —
// `la2a-tube-fit.mjs` imports this module for its constants and must not
// silently regenerate every tone file as a side effect of that import.
//
// ⚠ A STRING-BUILT `file://${process.argv[1]}` COMPARISON FAILS ON WINDOWS,
// SILENTLY. `process.argv[1]` there is a native path with a drive letter and
// backslashes (`C:\...\script.mjs`); `import.meta.url` is always a proper
// URL (`file:///C:/.../script.mjs`, forward slashes, three slashes before the
// drive letter). The two never match, `main()` never runs, and — because
// nothing in `main()` had a chance to execute — there is no error and no
// output at all, which is exactly what "npm run ... does nothing" looks like.
// `resolve()` on both sides normalises through the platform's own `path`
// module (`path.win32` on Windows, automatically), which is what the actual
// bug report needed and a Linux dev box cannot reproduce to catch on its own.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main()
