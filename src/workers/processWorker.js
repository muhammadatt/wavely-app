/**
 * Audio Processing Web Worker
 *
 * Handles CPU-intensive audio processing tasks off the main thread.
 * Supports: normalize, loudnessNormalize, adjustVolume, la2aAutoMakeup,
 * fet1176AutoMakeup, softClipperAutoMakeup, schepsAutoTrim, softClipperCeiling,
 * voiceProfile, measureLoudness
 */
import { computeAutoMakeupPlan } from '../audio/la2aProcessor.js'
import { computeFET1176AutoMakeupDb } from '../audio/fet1176Processor.js'
import { computeSchepsAutoTrim } from '../audio/schepsProcessor.js'
import { computeSoftClipperAutoMakeupDb } from '../audio/softClipperProcessor.js'
import { measurePeakCeilingDb } from '../audio/ceilingPresets.js'
import { measureVoiceProfile } from '../audio/voiceProfile.js'
import { measureLoudness as measureLoudnessOf } from '../audio/dsp/loudness.js'
import { renderLoudnessNormalize } from '../audio/dsp/loudnessNormalize.js'

/**
 * ⚠ EVERY REPLY MUST CARRY `__id` BACK. The worker is shared and long-lived
 * now, so replies are routed by request id rather than by "the one worker that
 * was spawned for this call". `postReply` is the only way to answer.
 */
let currentId = null
function postReply(payload) {
  self.postMessage({ ...payload, __id: currentId })
}

/**
 * Reply with a SUCCESS. Use this rather than writing the type inline.
 *
 * ⚠ THE MAIN THREAD RESOLVES ON `type === 'done'` AND REJECTS EVERYTHING ELSE,
 * so a success spelled any other way is a rejected measurement, not a warning —
 * and it fails QUIETLY, because every caller catches. A handler added here
 * posted `type: 'complete'` and shipped: `refreshAutoMakeup` logged to the
 * console and left the Gain knob wherever it was, so OptoSmooth's auto makeup
 * silently stopped working altogether while the panel went on claiming AUTO.
 *
 * The string is stated once, here, so a new handler cannot invent a different
 * word for it. `getMeasureWorker` in processing.js is the other half.
 */
function postDone(payload) {
  postReply({ type: 'done', ...payload })
}

/**
 * Reply with a SUCCESS that hands buffers back rather than copying them.
 *
 * Same contract as `postDone` — `type: 'done'`, `__id` echoed — and split out
 * only because a reply carrying rendered audio must transfer it: a stereo
 * hour is several hundred megabytes, and a structured clone of that is a
 * copy the main thread pays for twice.
 */
function postDoneTransfer(payload, transfer) {
  self.postMessage({ type: 'done', ...payload, __id: currentId }, transfer)
}

self.onmessage = function (e) {
  const { type, channelData, sampleRate, params } = e.data
  currentId = e.data.__id

  switch (type) {
    case 'normalize':
      normalizeAudio(channelData, params)
      break
    case 'measureLoudness':
      measureLoudness(channelData, sampleRate)
      break
    case 'loudnessNormalize':
      loudnessNormalize(channelData, sampleRate, params)
      break
    case 'adjustVolume':
      adjustVolume(channelData, params)
      break
    case 'la2aAutoMakeup':
      la2aAutoMakeup(channelData, sampleRate, params)
      break
    case 'fet1176AutoMakeup':
      autoMakeup(computeFET1176AutoMakeupDb, channelData, sampleRate, params)
      break
    case 'softClipperAutoMakeup':
      autoMakeup(computeSoftClipperAutoMakeupDb, channelData, sampleRate, params)
      break
    case 'schepsAutoTrim':
      schepsAutoTrim(channelData, sampleRate, params)
      break
    case 'softClipperCeiling':
      softClipperCeiling(channelData, sampleRate, params)
      break
    case 'voiceProfile':
      voiceProfile(channelData, sampleRate)
      break
    default:
      postReply({ type: 'error', message: `Unknown operation: ${type}` })
  }
}

/**
 * OptoSmooth's makeup, which unlike every other plugin's has a REFERENCE.
 *
 * ⚠ `reference` RIDES IN `params` AND IS NOT A KERNEL PARAM. It selects how the
 * solve measures, not how the kernel renders, so it is pulled back out before
 * the params reach the kernel — passing it through would have it silently
 * ignored, which is the failure mode where a control looks wired and is not.
 *
 * Only `makeupDb` comes back. The ceiling the percentile reference needs is
 * measured over the WHOLE region by `computeLA2AAutoMakeup`, not here, because
 * this worker only ever sees the capped analysis window — see `regionPeakDb`.
 */
function la2aAutoMakeup(channelData, sampleRate, params) {
  const { reference = 'peak', ...kernelParams } = params ?? {}
  try {
    const plan = computeAutoMakeupPlan(channelData, sampleRate, kernelParams, { reference })
    postDone({ makeupDb: plan.makeupDb })
  } catch (err) {
    postReply({ type: 'error', message: err.message })
  }
}

// Runs a compressor kernel over the region purely to measure it — this is why
// it lives in the worker rather than on the main thread, so knob drags
// don't jank the UI while the measurement re-runs.
function autoMakeup(measure, channelData, sampleRate, params) {
  try {
    postDone({ makeupDb: measure(channelData, sampleRate, params) })
  } catch (err) {
    postReply({ type: 'error', message: err.message })
  }
}

// Same reasoning as autoMakeup, and the same cost: this one runs the whole
// Scheps wet path (two EQ cascades and the opto compressor) over the region.
function schepsAutoTrim(channelData, sampleRate, params) {
  try {
    const { trimDb, correlation, densityDb } = computeSchepsAutoTrim(channelData, sampleRate, params)
    postDone({ trimDb, correlation, densityDb })
  } catch (err) {
    postReply({ type: 'error', message: err.message })
  }
}

/**
 * Where a soft clipper ceiling preset lands for this region, in dBFS.
 *
 * Lighter than the makeup measurements — it is a percentile of block peaks, not
 * a kernel render — but it runs here for the same reason they do: it is
 * triggered by selection changes, and a scan of the whole region on the main
 * thread would jank a selection drag.
 *
 * ⚠ A null result is a legitimate answer, not a failure: a region with no
 * measurable content has no ceiling, and the caller must leave the current one
 * alone rather than moving it somewhere meaningless.
 */
function softClipperCeiling(channelData, sampleRate, params) {
  try {
    const ceilingDb = measurePeakCeilingDb(channelData, sampleRate, params.percentile)
    postDone({ ceilingDb })
  } catch (err) {
    postReply({ type: 'error', message: err.message })
  }
}

/**
 * This speaker's median pitch and sub-fundamental corner.
 *
 * The heaviest of the measurements here — it runs the F0 tracker over every
 * frame of the region — which is exactly why it is on this side of the
 * boundary. It is triggered by a button rather than a drag, so it does not need
 * to be fast; it does need not to freeze the panel while it runs.
 *
 * ⚠ A null profile is a legitimate answer. A region with no pitched material
 * has no voice to aim at, and the caller must leave the zones where they are.
 */
function voiceProfile(channelData, sampleRate) {
  try {
    postDone({ profile: measureVoiceProfile(channelData, sampleRate) })
  } catch (err) {
    postReply({ type: 'error', message: err.message })
  }
}

/**
 * Every loudness reading for a region — LUFS, ACX's RMS, sample and true peak.
 *
 * ⚠ THIS ONE IS NOT WINDOW-CAPPED AND MUST NOT BECOME SO. Every other
 * measurement in this worker answers "what is this knob doing", and a
 * representative thirty seconds answers that. Integrated loudness is a
 * statement about the whole region by definition — cap it and a file whose
 * first half-minute is a loud cold open reads hot, and the normalizer then
 * takes the entire recording down to match. `measureRegionLoudness` in
 * processing.js is the main-thread half and passes the full region.
 */
function measureLoudness(channelData, sampleRate) {
  try {
    postDone({ loudness: measureLoudnessOf(channelData, sampleRate) })
  } catch (err) {
    postReply({ type: 'error', message: err.message })
  }
}

/**
 * Render a region normalized to a loudness target.
 *
 * The report comes back MEASURED ON THE OUTPUT rather than predicted from the
 * gain — see dsp/loudnessNormalize.js for why that distinction is the point of
 * the whole module.
 */
function loudnessNormalize(channelData, sampleRate, params) {
  try {
    const { target, peakMode } = params ?? {}
    const { channelData: out, report } =
      renderLoudnessNormalize(channelData, sampleRate, target, peakMode)
    postDoneTransfer({ channelData: out, report }, out.map(c => c.buffer))
  } catch (err) {
    postReply({ type: 'error', message: err.message })
  }
}

function adjustVolume(channelData, params) {
  const { gainDb } = params
  const gain = Math.pow(10, gainDb / 20) // dB to linear

  const result = channelData.map(channel => {
    const output = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) {
      output[i] = Math.max(-1, Math.min(1, channel[i] * gain))
    }
    return output
  })

  self.postMessage(
    { type: 'done', channelData: result },
    result.map(c => c.buffer)
  )
}

function normalizeAudio(channelData, params) {
  const { targetPeakDb } = params
  const targetPeak = Math.pow(10, targetPeakDb / 20) // dBFS to linear

  // Find current peak across all channels
  let currentPeak = 0
  for (const channel of channelData) {
    for (let i = 0; i < channel.length; i++) {
      const abs = Math.abs(channel[i])
      if (abs > currentPeak) currentPeak = abs
    }
  }

  if (currentPeak === 0) {
    // Silent audio, nothing to normalize
    self.postMessage({ type: 'done', channelData }, channelData.map(c => c.buffer))
    return
  }

  const gain = targetPeak / currentPeak

  // Apply gain to all channels
  const result = channelData.map(channel => {
    const output = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) {
      output[i] = Math.max(-1, Math.min(1, channel[i] * gain))
    }
    return output
  })

  self.postMessage(
    { type: 'done', channelData: result },
    result.map(c => c.buffer)
  )
}
