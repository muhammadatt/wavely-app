/**
 * Running every detector over the real corpus, and reducing what they said.
 *
 * Split from the CLI so the same run can be driven from a test or another
 * script without going through argv and console.log — the synthetic side is
 * arranged the same way, with harness.js doing the work and the script doing
 * the printing.
 *
 * The reduction here is deliberately thin. On the synthetic corpus a result can
 * be scored, because the right answer was planted; here there is no right
 * answer to score against, so this counts what was offered and leaves the
 * interpretation to whoever reads it. Anything cleverer would be inventing
 * ground truth that does not exist.
 */

import { analyzeVoiceRxV2 } from '../../src/audio/voicerx/v2/index.js'
import { DETECTORS } from './detectors.js'
import { listCorpus, excerpts, maskHealth, CORPUS_DIR } from './realCorpus.js'

function median(values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function runDetectors({ dir = CORPUS_DIR, seconds = 45, windows = 3 } = {}) {
  const started = Date.now()
  const corpus = listCorpus(dir)
  const files = []

  for (const file of corpus) {
    let loaded
    try {
      loaded = excerpts(file, { seconds, windows })
    } catch (err) {
      files.push({ name: file.name, error: err.message, windows: [] })
      continue
    }

    const entry = {
      name: file.name,
      seconds: loaded.audio.seconds,
      sampleRate: loaded.audio.sampleRate,
      channels: loaded.audio.channels,
      bitDepth: loaded.audio.bitDepth,
      windows: [],
    }

    for (const w of loaded.windows) {
      const record = { startSeconds: w.startSeconds, detectors: {} }

      // v2's internals carry the mask measurements, and they are the reason
      // this report exists at all — every other number depends on the mask
      // having found the voice. Run it once directly for those, separately from
      // the detector adapter, which deliberately exposes only bands.
      try {
        const v2 = analyzeVoiceRxV2(w.audio, loaded.audio.sampleRate)
        record.mask = maskHealth(v2)
        record.voiceType = v2.ok ? v2.voiceType : null
        record.medianF0Hz = v2.ok ? v2.medianF0Hz : null
      } catch (err) {
        record.error = err.message
      }

      for (const [name, detector] of Object.entries(DETECTORS)) {
        try {
          const out = detector(w.audio, loaded.audio.sampleRate)
          record.detectors[name] = out.ok
            ? {
              ok: true,
              bands: out.bands.map(b => ({
                freqHz: Math.round(b.freqHz * 10) / 10,
                gainDb: Math.round(b.gainDb * 100) / 100,
                q: b.q,
              })),
              advisories: out.advisories ?? [],
            }
            : { ok: false, reason: out.reason, bands: [], advisories: [] }
        } catch (err) {
          record.detectors[name] = { ok: false, reason: `threw: ${err.message}`, bands: [], advisories: [] }
        }
      }

      entry.windows.push(record)
    }

    files.push(entry)
  }

  const allWindows = files.flatMap(f => f.windows)

  const summary = {}
  for (const name of Object.keys(DETECTORS)) {
    const outs = allWindows.map(w => w.detectors[name]).filter(Boolean)
    const bandCounts = outs.map(o => o.bands.length)
    const gains = outs.flatMap(o => o.bands.map(b => Math.abs(b.gainDb)))
    summary[name] = {
      windows: outs.length,
      windowsWithBands: outs.filter(o => o.bands.length > 0).length,
      bandsPerWindow: outs.length ? bandCounts.reduce((a, b) => a + b, 0) / outs.length : 0,
      totalGainDb: gains.reduce((a, b) => a + b, 0),
      largestGainDb: gains.length ? Math.max(...gains) : 0,
      refused: outs.filter(o => !o.ok).length,
      advisories: outs.reduce((a, o) => a + (o.advisories?.length ?? 0), 0),
    }
  }

  const masks = allWindows.map(w => w.mask).filter(Boolean)
  const maskSummary = {
    windows: masks.length,
    measured: masks.filter(m => m.noiseFloorMeasured).length,
    medianLiveFraction: median(masks.map(m => m.liveFraction)) ?? 0,
    medianTopLiveHz: Math.round(median(masks.map(m => m.topLiveHz)) ?? 0),
    medianSpeechSnrDb: median(masks.map(m => m.medianSpeechSnrDb).filter(v => v !== null)),
  }

  return {
    dir,
    seconds,
    windowCount: allWindows.length,
    elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
    files,
    summary,
    maskSummary,
  }
}
