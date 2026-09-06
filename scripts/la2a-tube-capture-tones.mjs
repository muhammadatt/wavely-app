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

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readWav } from '../test/voicerx/wav.js'
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

/**
 * ── ONE-BOUNCE CONCATENATION, AND WHY IT IS MUTE-SCHEDULED ─────────────────
 *
 * Every tone here is 3 s, and a Waves demo's first mute lands at 20.01 s, so a
 * tone bounced on its own can never be hit. The trap is the workflow anyone
 * would actually use: dropping all sixteen on one timeline and bouncing once.
 * Then the mutes fall wherever they fall, and — as the ballistics captures
 * showed — a muted tone does not look like an error, it looks like a plugin
 * that went silent.
 *
 * So the concatenated stimulus places each tone inside a clean window. Measured
 * across nine ballistics captures, the mute is a TIMER: first at 20.01 s, then
 * every 20.00 s, lasting 0.99 s. With a 0.1 s guard that leaves 18.80 s of
 * clean audio per cycle, and a 3 s tone plus 1 s of silence fits four to a
 * window.
 *
 * ⚠ ONLY THE LEVEL AND FREQUENCY SWEEPS GO IN, BECAUSE THEY SHARE A SETTING
 * (Gain 0, Peak Reduction 0). The gain sweep is the same tone at DIFFERENT Gain
 * positions, so it cannot share a bounce with anything — and at 3 s each,
 * bounced one position at a time, it is inherently mute-free anyway.
 *
 * The noise-floor file rides along as the last slot, which is better than
 * capturing it separately: it then measures the noise of the same bounce.
 */
export const CONCAT_FILE = 'concat_gain0_pr0.wav'
export const CONCAT_MANIFEST = 'concat_manifest.json'
const MUTE_PERIOD_S = 20.0
const MUTE_LEN_S = 1.0
const MUTE_GUARD_S = 0.1
const SLOT_GAP_S = 1.0
const CONCAT_LEAD_S = 0.5

/** Earliest start >= t at which a `span`-second slot clears every mute. */
function slotClear(t, span) {
  const window = MUTE_PERIOD_S - MUTE_LEN_S - 2 * MUTE_GUARD_S
  if (span > window) {
    throw new Error(`a ${span}s slot cannot fit the ${window.toFixed(2)}s clean window between demo mutes`)
  }
  for (let k = 1; k * MUTE_PERIOD_S < t + span + MUTE_PERIOD_S; k++) {
    const from = k * MUTE_PERIOD_S - MUTE_GUARD_S
    const to = k * MUTE_PERIOD_S + MUTE_LEN_S + MUTE_GUARD_S
    if (from >= t + span) break
    if (to > t) t = to
  }
  return t
}

/** Which tones share the one-bounce file, and where each sits in it. */
export function concatPlan() {
  const entries = sweepEntries().filter(e => e.kind !== 'gain')
  const slots = []
  let t = CONCAT_LEAD_S
  for (const e of entries) {
    t = slotClear(t, TONE_SECONDS)
    slots.push({ ...e, startS: t })
    t += TONE_SECONDS + SLOT_GAP_S
  }
  t = slotClear(t, TONE_SECONDS)
  slots.push({ id: 'noise-floor', kind: 'noise', file: NOISE_FLOOR_FILE, startS: t, silent: true })
  t += TONE_SECONDS + SLOT_GAP_S
  return { slots, seconds: t + 0.5 }
}


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

/**
 * ── SPLITTING A ONE-BOUNCE CAPTURE BACK INTO PER-TONE CAPTURES ─────────────
 *
 * ⚠ THE CAPTURE'S HEAD IS NOT TRUSTED. A bounce can carry DAW pre-roll, plugin
 * latency, or dead air, and cutting at nominal offsets would then slice every
 * tone in the wrong place — quietly, since a mis-cut 1 kHz tone is still a
 * 1 kHz tone. The offset is measured instead, by matching the capture's
 * envelope against the stimulus's own, with dead samples excluded so a demo
 * mute cannot drag the fit (the ballistics alignment railed exactly that way
 * before it excluded them).
 */
function splitCapture(capturePath) {
  const plan = concatPlan()
  const wav = readWav(capturePath)
  if (wav.sampleRate !== CAPTURE_SR) {
    console.log(`⚠ ${capturePath}: ${wav.sampleRate} Hz; this protocol captures at ${CAPTURE_SR}.`)
    return
  }
  const cap = wav.mono
  const W = Math.round(0.01 * CAPTURE_SR)              // 10 ms envelope
  const envOf = (a, n) => {
    const e = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      let m = 0
      for (let i = k * W; i < Math.min((k + 1) * W, a.length); i++) { const v = Math.abs(a[i]); if (v > m) m = v }
      e[k] = m
    }
    return e
  }
  const nRef = Math.floor(Math.round(plan.seconds * CAPTURE_SR) / W)
  const ref = new Float64Array(nRef)
  for (const slot of plan.slots) {
    if (slot.silent) continue
    const amp = Math.pow(10, slot.levelDbfs / 20)
    const a = Math.round(slot.startS * CAPTURE_SR / W), b = a + Math.round(TONE_SECONDS * CAPTURE_SR / W)
    for (let k = a; k < b && k < nRef; k++) ref[k] = amp
  }
  const capEnv = envOf(cap, Math.floor(cap.length / W))
  const maxLag = Math.floor(5 * CAPTURE_SR / W)        // +/- 5 s of head slop
  let best = 0, bestErr = Infinity
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let err = 0, n = 0
    for (let k = 0; k < nRef; k++) {
      const j = k + lag
      if (j < 0 || j >= capEnv.length) continue
      if (capEnv[j] < 1e-6 && ref[k] > 1e-4) continue   // a demo mute: not evidence
      err += (Math.log(Math.max(capEnv[j], 1e-9)) - Math.log(Math.max(ref[k], 1e-9))) ** 2
      n++
    }
    if (n > nRef / 3) { const e = err / n; if (e < bestErr) { bestErr = e; best = lag } }
  }
  const lagS = best * W / CAPTURE_SR
  console.log(`Aligned at ${lagS >= 0 ? '+' : ''}${lagS.toFixed(3)} s (rms ${Math.sqrt(bestErr).toFixed(2)} in log-envelope)`)
  mkdirSync(CAPTURES_DIR, { recursive: true })
  const len = Math.round(TONE_SECONDS * CAPTURE_SR)
  let written = 0, short = 0
  for (const slot of plan.slots) {
    const from = Math.round(slot.startS * CAPTURE_SR) + best * W
    const seg = new Float32Array(len)
    if (from < 0 || from + len > cap.length) { short++; console.log(`⚠ ${slot.id}: falls outside the capture; skipped`); continue }
    seg.set(cap.subarray(from, from + len))
    // A slot that came back silent when it should not have is a mute that the
    // scheduling was supposed to prevent — say so rather than write a dead file.
    if (!slot.silent) {
      let peak = 0
      for (let i = 0; i < len; i++) { const v = Math.abs(seg[i]); if (v > peak) peak = v }
      if (peak < 1e-6) { console.log(`⚠ ${slot.id}: SILENT in the capture — a demo mute landed on it`); continue }
      // ⚠ AND CHECK THE ANALYSIS WINDOW, NOT JUST THE SEGMENT. The scheduling
      // places tones against the mute grid measured from the RENDER's start; if
      // the bounce carries head slop, the grid slides relative to the tones and
      // a mute can eat part of a tone while leaving the rest loud. Found by
      // testing exactly that: 1.37 s of slop put a mute across the tail of the
      // 16.5 s tone, and a whole-segment peak test saw nothing wrong.
      const wFrom = Math.round((TONE_SECONDS - ANALYSIS_WINDOW_END_OFFSET_S - ANALYSIS_WINDOW_LENGTH_S) * CAPTURE_SR)
      const wTo = Math.round((TONE_SECONDS - ANALYSIS_WINDOW_END_OFFSET_S) * CAPTURE_SR)
      let dead = 0, run = 0
      for (let i = wFrom; i < wTo; i++) {
        if (Math.abs(seg[i]) < 1e-6) { run++; if (run > dead) dead = run } else run = 0
      }
      if (dead > CAPTURE_SR * 0.005) {
        console.log(`⚠ ${slot.id}: ${(1000 * dead / CAPTURE_SR).toFixed(0)} ms of silence INSIDE its analysis window — a demo mute clipped it.`)
        console.log('   The tones are scheduled against a mute grid measured from the RENDER start,')
        console.log(`   so a bounce with head slop (this one had ${lagS.toFixed(2)} s) slides them into it.`)
        console.log('   Re-bounce starting at the first sample, with no pre-roll.')
        continue
      }
    }
    writeFloatWav(join(CAPTURES_DIR, slot.file), seg, CAPTURE_SR)
    written++
  }
  console.log(`Wrote ${written} per-tone captures to ${CAPTURES_DIR}${short ? ` (${short} outside the file)` : ''}`)
  console.log('\nStill needed by hand: the GAIN sweep, one bounce per Gain position.')
  console.log('Then:  npm run la2a:tube:fit')
}

function main() {
  const splitArg = process.argv.indexOf('--split')
  if (splitArg !== -1) {
    const path = process.argv[splitArg + 1]
    if (!path) { console.log('usage: --split <captured concat file>'); return }
    splitCapture(path)
    return
  }
  mkdirSync(TONES_DIR, { recursive: true })
  mkdirSync(CAPTURES_DIR, { recursive: true }) // created empty so the DAW has somewhere obvious to export into

  const entries = sweepEntries()
  for (const e of entries) {
    writeFloatWav(join(TONES_DIR, e.file), buildTone(e.freqHz, e.levelDbfs, CAPTURE_SR), CAPTURE_SR)
  }
  writeFloatWav(join(TONES_DIR, NOISE_FLOOR_FILE), new Float32Array(Math.round(TONE_SECONDS * CAPTURE_SR)), CAPTURE_SR)

  // The one-bounce file, mute-scheduled. See CONCAT_FILE.
  const plan = concatPlan()
  const cat = new Float32Array(Math.round(plan.seconds * CAPTURE_SR))
  for (const slot of plan.slots) {
    if (slot.silent) continue
    const tone = buildTone(slot.freqHz, slot.levelDbfs, CAPTURE_SR)
    cat.set(tone, Math.round(slot.startS * CAPTURE_SR))
  }
  writeFloatWav(join(TONES_DIR, CONCAT_FILE), cat, CAPTURE_SR)
  writeFileSync(join(TONES_DIR, CONCAT_MANIFEST),
    JSON.stringify({ sampleRate: CAPTURE_SR, toneSeconds: TONE_SECONDS, slots: plan.slots }, null, 2))

  console.log(`Wrote ${entries.length + 1} tones to ${TONES_DIR}`)
  console.log(`\nONE-BOUNCE OPTION — ${CONCAT_FILE} (${plan.seconds.toFixed(1)}s, ${plan.slots.length} tones)`)
  console.log('  Bounce that ONE file at Gain 0 / Peak Reduction 0, then:')
  console.log(`    npm run la2a:tube:split -- <your-capture.wav>`)
  console.log('  which cuts it into the per-tone captures the fitter expects.')
  console.log('  Its tones are placed to dodge a Waves demo mute (20.01s, then every 20.00s).')
  console.log('  ⚠ The GAIN sweep is NOT in it — that tone is bounced once per Gain position,')
  console.log('    and at 3s each those are mute-free on their own.')
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
