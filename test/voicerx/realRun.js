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
import { listCorpus, excerpts, maskHealth, quietLevelDbfs, CORPUS_DIR } from './realCorpus.js'

/**
 * How close a band has to sit to the measured fundamental to be flagged.
 *
 * A fifth of an octave, which is 15% in frequency. Wide enough to catch a band
 * aimed at F0 by a detector whose centre estimate wanders, narrow enough that a
 * genuine correction an octave up cannot be mistaken for one.
 */
const NEAR_F0_OCTAVES = 0.2

/**
 * How close two bands from different windows of the same file have to sit to
 * count as the same finding. A third of an octave — the same critical-band
 * spacing v2 uses to decide two corrections are acting on one colour.
 */
const REPEAT_OCTAVES = 0.33

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

      // Absolute level of the quietest frames, in dBFS. The SNR mask divides
      // the voiced spectrum by the pause spectrum, and a ratio says nothing
      // about whether the denominator is real room tone or edited-in digital
      // silence. A floor near -90 dBFS means the pauses were gated or replaced,
      // the measured SNR is meaningless however large it looks, and the mask is
      // trusting the whole spectrum because it has nothing to compare against.
      record.quietLevelDbfs = quietLevelDbfs(w.audio)

      for (const [name, detector] of Object.entries(DETECTORS)) {
        try {
          const out = detector(w.audio, loaded.audio.sampleRate)
          const f0 = record.medianF0Hz
          record.detectors[name] = out.ok
            ? {
              ok: true,
              bands: out.bands.map(b => ({
                freqHz: Math.round(b.freqHz * 10) / 10,
                gainDb: Math.round(b.gainDb * 100) / 100,
                q: b.q,
                // Correcting the fundamental is never right: it is the voice's
                // own pitch, not a defect in it, and a cut there thins the
                // whole delivery.
                nearF0: !!(f0 && Math.abs(Math.log2(b.freqHz / f0)) < NEAR_F0_OCTAVES),
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

  // Does a detector say the same thing about two different minutes of the same
  // finished file? A user who analyses twice and gets different answers has no
  // reason to believe either. Only files with more than one window can say.
  for (const f of files) {
    if (f.windows.length < 2) continue
    f.repeatability = {}
    for (const name of Object.keys(DETECTORS)) {
      const perWindow = f.windows.map(w => w.detectors[name]?.bands ?? [])
      const first = perWindow[0]
      let recurring = 0
      for (const band of first) {
        const inAll = perWindow.slice(1).every(
          other => other.some(b => Math.abs(Math.log2(b.freqHz / band.freqHz)) < REPEAT_OCTAVES),
        )
        if (inAll) recurring++
      }
      f.repeatability[name] = {
        bandsPerWindow: perWindow.map(b => b.length),
        recurringInEveryWindow: recurring,
        ofFirstWindow: first.length,
      }
    }
  }

  const summary = {}
  for (const name of Object.keys(DETECTORS)) {
    const outs = allWindows.map(w => w.detectors[name]).filter(Boolean)
    const bandCounts = outs.map(o => o.bands.length)
    const gains = outs.flatMap(o => o.bands.map(b => Math.abs(b.gainDb)))
    const allBands = outs.flatMap(o => o.bands)
    // Where the invented corrections land, by octave. A detector whose mistakes
    // are scattered has a noisy estimator; one whose mistakes pile into a
    // couple of octaves has a specific bug with an address.
    const histogram = {}
    for (const b of allBands) {
      const key = Math.round(Math.log2(b.freqHz / 62.5) * 2) / 2
      const label = `${Math.round(62.5 * 2 ** key)}Hz`
      histogram[label] = (histogram[label] ?? 0) + 1
    }

    const repeat = files.map(f => f.repeatability?.[name]).filter(Boolean)
    summary[name] = {
      windows: outs.length,
      windowsWithBands: outs.filter(o => o.bands.length > 0).length,
      bandsPerWindow: outs.length ? bandCounts.reduce((a, b) => a + b, 0) / outs.length : 0,
      totalGainDb: gains.reduce((a, b) => a + b, 0),
      largestGainDb: gains.length ? Math.max(...gains) : 0,
      refused: outs.filter(o => !o.ok).length,
      advisories: outs.reduce((a, o) => a + (o.advisories?.length ?? 0), 0),
      bandsNearF0: allBands.filter(b => b.nearF0).length,
      totalBands: allBands.length,
      histogram,
      recurringFraction: repeat.length
        ? repeat.reduce((a, r) => a + (r.ofFirstWindow ? r.recurringInEveryWindow / r.ofFirstWindow : 1), 0) / repeat.length
        : null,
    }
  }

  const masks = allWindows.map(w => w.mask).filter(Boolean)
  const maskSummary = {
    windows: masks.length,
    measured: masks.filter(m => m.noiseFloorMeasured).length,
    medianLiveFraction: median(masks.map(m => m.liveFraction)) ?? 0,
    medianTopLiveHz: Math.round(median(masks.map(m => m.topLiveHz)) ?? 0),
    medianSpeechSnrDb: median(masks.map(m => m.medianSpeechSnrDb).filter(v => v !== null)),
    medianQuietLevelDbfs: median(allWindows.map(w => w.quietLevelDbfs).filter(v => Number.isFinite(v))),
    windowsWithGatedSilence: allWindows.filter(w => w.quietLevelDbfs < -80).length,
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
