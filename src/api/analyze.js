/**
 * API client for server-side analysis passes.
 *
 * The counterpart to spotEffects.js: uploads a rendered region and gets
 * measurements back rather than audio. Used by realtime effects whose
 * parameters cannot be derived in the browser — sibilance detection needs
 * Silero-grade voicing labels and an F0 contour, neither of which has a browser
 * implementation here.
 *
 * Analysis is one-shot by design. The expensive half runs once and freezes; the
 * knobs the user actually turns are recomputed locally from what comes back.
 */

import { renderRegionToBuffer, floatChannelsToWavBlob } from '../audio/processing.js'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

/**
 * Rescale event sample offsets from the analysis rate to the project's.
 *
 * The pipeline decodes everything to 44.1 kHz, so a 48 kHz project gets offsets
 * that are about 9% short — and silently worse the further into the selection
 * you go, which is exactly the kind of bug that reads as "the de-esser is a bit
 * late" rather than as a unit mismatch. Doing it here rather than in each caller
 * means there is one place to get it right.
 */
function rescaleEvents(events, fromRate, toRate) {
  if (!Number.isFinite(fromRate) || fromRate <= 0 || fromRate === toRate) return events
  const k = toRate / fromRate
  return events.map(ev => ({
    ...ev,
    startSample: Math.round(ev.startSample * k),
    endSample: Math.round(ev.endSample * k),
  }))
}

/**
 * Run sibilance detection over a region of the timeline.
 *
 * @param {object} options
 * @param {Array}  options.segments    - Timeline segments
 * @param {number} options.start       - Region start (seconds)
 * @param {number} options.end         - Region end (seconds)
 * @param {number} options.sampleRate  - Project sample rate
 * @param {number} options.channels    - Channel count
 * @param {object} [options.params]    - Detection + initial decision parameters
 * @returns {Promise<object>} the server result, with `measuredEvents` already
 *   rescaled to the project's sample rate and offsets relative to `start`.
 */
export async function analyzeSibilance({
  segments, start, end, sampleRate, channels, params = {},
}) {
  const channelData = renderRegionToBuffer(segments, start, end, sampleRate, channels)
  const wavBlob = floatChannelsToWavBlob(channelData, sampleRate, channels)

  const formData = new FormData()
  formData.append('file', wavBlob, 'selection.wav')
  formData.append('params', JSON.stringify(params))

  const res = await fetch(`${API_BASE}/api/analyze/sibilance`, {
    method: 'POST',
    body: formData,
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `Analysis failed: ${res.status}` }))
    throw new Error(body.error || `Analysis failed: ${res.status}`)
  }

  const result = await res.json()
  return {
    ...result,
    analysisSampleRate: result.sampleRate,
    sampleRate,
    measuredEvents: rescaleEvents(result.measuredEvents ?? [], result.sampleRate, sampleRate),
  }
}

/**
 * Run voice-activity detection over a region of the timeline.
 *
 * The auto-leveler's one server dependency. Everything else it does — clip
 * segmentation, per-clip loudness, the gain solve, the crossfades — runs in the
 * browser against the mask this returns, so this is called once per analysis
 * and never again while the controls move.
 *
 * NO SAMPLE-RATE RESCALING, unlike analyzeSibilance above. The route answers in
 * frame indices and tells us the frame duration, so a 48 kHz project multiplies
 * by its own rate and lands on its own grid. That removes the whole class of
 * bug the rescaleEvents helper exists to patch rather than patching it again.
 *
 * @param {object} options
 * @param {Array}  options.segments   - Timeline segments
 * @param {number} options.start      - Region start (seconds)
 * @param {number} options.end        - Region end (seconds)
 * @param {number} options.sampleRate - Project sample rate
 * @param {number} options.channels   - Channel count
 * @returns {Promise<{ voicedRuns: Array<[number,number]>, numFrames: number,
 *                     frameDurationS: number, noiseFloorDbfs: number|null }>}
 */
export async function analyzeVoiceActivity({ segments, start, end, sampleRate, channels }) {
  const channelData = renderRegionToBuffer(segments, start, end, sampleRate, channels)
  const wavBlob = floatChannelsToWavBlob(channelData, sampleRate, channels)

  const formData = new FormData()
  formData.append('file', wavBlob, 'selection.wav')
  formData.append('params', JSON.stringify({}))

  const res = await fetch(`${API_BASE}/api/analyze/vad`, {
    method: 'POST',
    body: formData,
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `Analysis failed: ${res.status}` }))
    throw new Error(body.error || `Analysis failed: ${res.status}`)
  }

  return res.json()
}
