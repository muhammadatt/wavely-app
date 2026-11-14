/**
 * Render the before / after audio for the effect marketing pages.
 *
 *   npm run marketing:render                       # every page's samples
 *   npm run marketing:render -- opto-smooth        # one page
 *
 * You record (or pick) the DRY clip; this renders the processed one with the
 * real DSP, so a page can never play audio the product would not make. For
 * every sample listed in `src/content/marketing/<id>.js` it reads
 *
 *   marketing/samples/<slug>/<sample>.<wav|flac|aif|aiff|mp3|m4a>   the dry source
 *
 * and writes
 *
 *   public/plugins/<slug>/audio/<sample>-off.mp3   the dry clip, as played
 *   public/plugins/<slug>/audio/<sample>-on.mp3    through the effect
 *   src/content/marketing/audio/<id>.json          what exists, durations, levels
 *
 * A file named PLACEHOLDER in the samples folder marks its clips as stand-ins:
 * the page then says so beside the player. Delete it with the real recordings.
 * A sample whose dry source is absent keeps its last render (the dry sources
 * need not be committed; the rendered pair is what the page serves).
 *
 * ── WHY BOTH FILES ARE ENCODED THE SAME WAY ─────────────────────────────────
 * The page plays the two in lock-step and switches between them, so they must
 * stay sample-aligned after decoding. Both are rendered at the same length and
 * encoded with identical settings, so any encoder delay a browser fails to trim
 * is the SAME delay on both and the pair stays aligned with each other.
 *
 * ── WHAT "THROUGH THE EFFECT" MEANS ─────────────────────────────────────────
 * Exactly what Apply does on a selection of the whole clip with the sample's
 * `settings` dialled in over the effect's defaults: the file's input alignment,
 * the measured makeup / ceilings, and the kernel render with its latency
 * trimmed. It mirrors `useLA2A` / `useVoxPressor`'s `prepareApply` and the
 * `apply*Region` render, using the same kernel classes the worklets run. If an
 * apply path changes how it measures, change it here too.
 *
 * Only effects listed in RENDERERS can be rendered; add one per page.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MARKETING, marketingSlug } from '../src/content/marketing/index.js'
import { inputAlignDbFor } from '../src/audio/dsp/inputAlign.js'
import { computeAutoMakeupPlan, processLA2ABuffer } from '../src/audio/la2aProcessor.js'
import { LA2A_DEFAULTS, toKernelParams as la2aKernelParams } from '../src/audio/effects/la2aParams.js'
import { processVoxPressorBuffer } from '../src/audio/voxPressorProcessor.js'
import { measureVoxPressor } from '../src/audio/voxPressorSolve.js'
import { VOX_DEFAULTS, VOX_MEASURED_KEYS, toKernelParams as voxKernelParams } from '../src/audio/effects/voxPressorParams.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SR = 44100
const SOURCE_EXT = ['wav', 'flac', 'aif', 'aiff', 'mp3', 'm4a']
/** Plenty for a voice A/B, and small: ~0.5 MB per 20 s clip. */
const MP3_ARGS = ['-codec:a', 'libmp3lame', '-b:a', '192k']

const args = process.argv.slice(2)
const only = args.filter(a => !a.startsWith('--'))
for (const id of only) if (!MARKETING[id]) { console.error(`no marketing page: ${id}`); process.exit(1) }
const ids = only.length ? only : Object.keys(MARKETING)

// ── Effects ─────────────────────────────────────────────────────────────────

const peakDb = (channels) => {
  let p = 0
  for (const c of channels) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]))
  return p > 0 ? 20 * Math.log10(p) : -Infinity
}

/** Render `channels` through `process`, padded by its latency and trimmed back to the input. */
function renderAligned(channels, latency, process) {
  const n = channels[0].length
  const padded = channels.map((c) => { const q = new Float32Array(n + latency); q.set(c); return q })
  return process(padded).map(c => c.slice(latency, latency + n))
}

const RENDERERS = {
  /** useLA2A.prepareApply (alignment, then the percentile makeup solve) → applyLA2ARegion. */
  'opto-smooth'(channels, settings) {
    const panel = { ...LA2A_DEFAULTS, ...settings }
    const inputAlignDb = inputAlignDbFor(channels, SR)
    const plan = computeAutoMakeupPlan(channels, SR, {
      mode: panel.mode, peakReduction: panel.peakReduction, gainDb: 0, r37: panel.r37,
      lookaheadMs: panel.lookahead, analog: panel.analog !== false, mix: panel.mix, inputAlignDb,
    }, { reference: 'percentile' })
    const kp = la2aKernelParams({
      ...panel,
      gain: Math.max(-24, Math.min(24, plan.makeupDb)),
      ceilingDb: peakDb(channels),
      ceilingKneeDb: plan.ceilingKneeDb,
      inputAlignDb,
    })
    const probe = processLA2ABuffer([new Float32Array(128)], SR, kp)
    const out = renderAligned(channels, probe.latencySamples, ch => processLA2ABuffer(ch, SR, kp).channelData)
    return { channels: out, note: `align ${inputAlignDb.toFixed(2)} dB, makeup ${plan.makeupDb.toFixed(2)} dB` }
  },

  /** useVoxPressor.prepareApply (alignment, measureVoxPressor) → applyVoxPressorRegion. */
  'vox-pressor'(channels, settings) {
    const alignDb = inputAlignDbFor(channels, SR)
    const panel = { ...VOX_DEFAULTS, ...settings, alignDb, listen: 'off' }
    const measured = measureVoxPressor(channels, SR, voxKernelParams(panel))
    const solved = { ...panel }
    for (const k of VOX_MEASURED_KEYS) solved[k] = measured[k] ?? null
    const kp = voxKernelParams(solved)
    const out = processVoxPressorBuffer(channels, SR, kp, { compensate: true }).channelData
    return { channels: out, note: `align ${alignDb.toFixed(2)} dB, peaks ${(measured.peaksDb ?? 0).toFixed(1)} dB, body ${(measured.bodyDb ?? 0).toFixed(1)} dB` }
  },
}

// ── Audio I/O (FFmpeg) ──────────────────────────────────────────────────────

function ffmpeg(argv, input) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...argv], { input, maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString() || r.error}`)
  return r.stdout
}

function channelCount(path) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', path])
  const n = Number(String(r.stdout).trim())
  if (!(n >= 1)) throw new Error(`cannot read channels of ${path}`)
  return Math.min(n, 2)
}

/** Decode to float32 at 44.1 kHz, the app's internal format. */
function decode(path) {
  const nch = channelCount(path)
  const raw = ffmpeg(['-i', path, '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', String(nch), '-ar', String(SR), '-'])
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  const n = all.length / nch
  const channels = Array.from({ length: nch }, () => new Float32Array(n))
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) channels[c][i] = all[i * nch + c]
  return channels
}

function encodeMp3(channels, path) {
  const n = channels[0].length, nch = channels.length
  const inter = new Float32Array(n * nch)
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) inter[i * nch + c] = channels[c][i]
  ffmpeg(['-y', '-f', 'f32le', '-ar', String(SR), '-ac', String(nch), '-i', '-', ...MP3_ARGS, path], Buffer.from(inter.buffer))
}

/** Gated loudness proxy for the page's level-matched A/B: RMS of 50 ms blocks within 30 dB of the loudest. */
function gatedRmsDb(channels) {
  const block = Math.round(0.05 * SR), n = channels[0].length
  const rms = []
  for (let s = 0; s + block <= n; s += block) {
    let sum = 0
    for (const c of channels) for (let i = s; i < s + block; i++) sum += c[i] * c[i]
    rms.push(sum / (block * channels.length))
  }
  const top = Math.max(...rms)
  const kept = rms.filter(v => v > top * 1e-3)
  const mean = kept.reduce((a, b) => a + b, 0) / Math.max(1, kept.length)
  return mean > 0 ? 10 * Math.log10(mean) : -Infinity
}

const round2 = v => Number.isFinite(v) ? Math.round(v * 100) / 100 : null

// ── Main ────────────────────────────────────────────────────────────────────

let failures = 0
for (const id of ids) {
  const page = MARKETING[id]
  const slug = marketingSlug(id)
  const render = RENDERERS[id]
  if (!render) { console.log(`FAIL  ${id}: no renderer in scripts/marketing-render.mjs`); failures++; continue }
  const srcDir = join(ROOT, 'marketing/samples', slug)
  const outDir = join(ROOT, 'public/plugins', slug, 'audio')
  mkdirSync(outDir, { recursive: true })
  // A sample with no dry source keeps whatever was rendered for it before.
  const manifestPath = join(ROOT, 'src/content/marketing/audio', `${id}.json`)
  const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).samples ?? {} : {}
  const manifest = { samples: {} }
  // A PLACEHOLDER file marks the folder's clips as stand-ins; the page labels them so.
  const placeholder = existsSync(join(srcDir, 'PLACEHOLDER'))

  for (const sample of page.samples ?? []) {
    const src = SOURCE_EXT.map(e => join(srcDir, `${sample.id}.${e}`)).find(existsSync)
    if (!src) {
      if (previous[sample.id]) manifest.samples[sample.id] = previous[sample.id]
      console.log(`skip  ${id}/${sample.id}: no dry source in marketing/samples/${slug}/${previous[sample.id] ? ' (keeping the last render)' : ''}`)
      continue
    }
    const off = join(outDir, `${sample.id}-off.mp3`)
    const on = join(outDir, `${sample.id}-on.mp3`)
    try {
      const dry = decode(src)
      const t0 = Date.now()
      const wet = render(dry, sample.settings ?? {})
      encodeMp3(dry, off)
      encodeMp3(wet.channels, on)
      manifest.samples[sample.id] = {
        off: `/plugins/${slug}/audio/${sample.id}-off.mp3`,
        on: `/plugins/${slug}/audio/${sample.id}-on.mp3`,
        ...(placeholder ? { placeholder: true } : {}),
        seconds: round2(dry[0].length / SR),
        channels: dry.length,
        // For the page's optional level-matched A/B, so it needs no analysis of its own.
        levelDb: { off: round2(gatedRmsDb(dry)), on: round2(gatedRmsDb(wet.channels)) },
        peakDb: { off: round2(peakDb(dry)), on: round2(peakDb(wet.channels)) },
      }
      const m = manifest.samples[sample.id]
      console.log(`ok    ${id}/${sample.id}: ${m.seconds} s, level ${m.levelDb.off} → ${m.levelDb.on} dB, peak ${m.peakDb.off} → ${m.peakDb.on} dBFS (${wet.note}; ${Date.now() - t0} ms)`)
    } catch (err) {
      console.log(`FAIL  ${id}/${sample.id}: ${err.message}`); failures++
    }
  }
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}
process.exit(failures ? 1 : 0)

