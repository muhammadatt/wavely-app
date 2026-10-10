/**
 * PHAT*SS — the file's treble statistics, which the HF detents calibrate from.
 *
 * For each detector band the tape shelf can listen on (`TREBLE_DETECT_HZ`), the
 * distribution of 10 ms peaks of that band — `x − LP1(x)`, the exact one-pole
 * split the kernel's detector reads — over the file's ACTIVE windows, as
 * percentiles in dB RE THE VOICE LEVEL (the whole file's gated RMS, the number
 * the shelf already follows).
 *
 * ⚠ WHY NOT THE VOICE LEVEL ALONE. A threshold set from broadband RMS means
 * different things on different takes: on narration the treble's 10 ms peaks
 * sit ~8 dB lower re the RMS than on the music the FATSO law was fitted on, and
 * a dull take's loudest treble is its vowels. A Tame knob let the user correct
 * for that by ear; a detent cannot, so the detents place their threshold on
 * this distribution instead ("act on the top few % of treble events") — with a
 * floor re the voice level, so a dull file whose treble never comes near the
 * voice is left mostly alone rather than having its top events cut anyway.
 *
 * Bounded cost on any length: at most `maxBlocks` evenly spread blocks of
 * BLOCK_S, each read with WARMUP_S of lead-in so the one-pole has settled.
 * Channels are measured apart (peak = the loudest channel, activity = the mean
 * of their powers), as the kernel's linked detector does.
 */

import { onePoleLowpass } from './dsp/hfLimit.js'
import { indexSegments, readChannel } from './saturationBenchAnalysis.js'

/** The detector corners the detents can choose, Hz. */
export const TREBLE_DETECT_HZ = Object.freeze({ '2k': 2000, '4k': 4000 })

/** Percentiles reported, as fractions. */
export const TREBLE_PERCENTILES = Object.freeze({ p50: 0.5, p75: 0.75, p90: 0.9, p95: 0.95, p98: 0.98, p99: 0.99 })

/** Peak window, seconds — the dev log's 10 ms treble peaks. */
export const TREBLE_WINDOW_S = 0.01

/** Windows quieter than this re the voice level are pauses, not treble events. */
export const TREBLE_ACTIVE_BELOW_DB = 30

const BLOCK_S = 0.5
const WARMUP_S = 0.03

/**
 * @param {object[]} segments  the timeline
 * @param {number} end         seconds (the whole file: always from 0)
 * @param {number} sampleRate
 * @param {number} channels
 * @param {number} voiceLevelDb  the whole file's gated RMS, dBFS
 * @returns {{ bands: Record<string, Record<string, number>>, windows: number } | null}
 *   null when nothing in the file is active.
 */
export function measureTrebleStats(segments, end, sampleRate, channels, voiceLevelDb, { maxBlocks = 240 } = {}) {
  const sr = sampleRate
  const win = Math.max(1, Math.round(TREBLE_WINDOW_S * sr))
  const blockN = Math.max(win, Math.round(BLOCK_S / TREBLE_WINDOW_S) * win)
  const warm = Math.round(WARMUP_S * sr)
  const total = Math.floor(end * sr)
  const nBlocks = Math.max(1, Math.floor(total / blockN))
  const stride = Math.max(1, nBlocks / maxBlocks)
  const nCh = Math.max(1, channels)
  const index = indexSegments(segments)
  const buf = new Float64Array(warm + blockN)
  const gate = Math.pow(10, (voiceLevelDb - TREBLE_ACTIVE_BELOW_DB) / 10)
  const corners = Object.entries(TREBLE_DETECT_HZ)
  const filters = corners.map(([, hz]) => onePoleLowpass(sr, hz))
  const peaks = corners.map(() => [])

  const winsPerBlock = Math.floor(Math.min(blockN, total) / win)
  const ms = new Float64Array(winsPerBlock)
  const pk = corners.map(() => new Float64Array(winsPerBlock))

  for (let p = 0; p < nBlocks; p += stride) {
    const b = Math.floor(p)
    const s0 = b * blockN
    const lead = Math.min(warm, s0)
    const n = Math.min(blockN, total - s0)
    const nWin = Math.floor(n / win)
    if (nWin < 1) continue
    ms.fill(0)
    for (const a of pk) a.fill(0)
    for (let ch = 0; ch < nCh; ch++) {
      readChannel(index, ch, (s0 - lead) / sr, lead + n, sr, buf)
      for (let w = 0; w < nWin; w++) {
        let e = 0
        for (let i = 0; i < win; i++) { const v = buf[lead + w * win + i]; e += v * v }
        ms[w] += e / win / nCh
      }
      for (let f = 0; f < filters.length; f++) {
        const { b0, a1 } = filters[f]
        let x1 = 0, y1 = 0
        const out = pk[f]
        for (let i = 0; i < lead + nWin * win; i++) {
          const x = buf[i]
          const lp = b0 * (x + x1) - a1 * y1
          x1 = x
          y1 = lp
          if (i < lead) continue
          const h = Math.abs(x - lp)
          const w = Math.floor((i - lead) / win)
          if (h > out[w]) out[w] = h
        }
      }
    }
    for (let w = 0; w < nWin; w++) {
      if (!(ms[w] >= gate) || ms[w] === 0) continue
      for (let f = 0; f < filters.length; f++) peaks[f].push(pk[f][w])
    }
  }
  if (peaks[0].length === 0) return null

  const bands = {}
  corners.forEach(([key], f) => {
    const sorted = Float64Array.from(peaks[f]).sort()
    const out = {}
    for (const [name, q] of Object.entries(TREBLE_PERCENTILES)) {
      const v = sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))]
      out[name] = 20 * Math.log10(Math.max(v, 1e-9)) - voiceLevelDb
    }
    bands[key] = out
  })
  return { bands, windows: peaks[0].length }
}
