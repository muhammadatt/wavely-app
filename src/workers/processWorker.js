/**
 * Audio Processing Web Worker
 *
 * Handles CPU-intensive audio processing tasks off the main thread.
 * Supports: normalize, adjustVolume, la2aAutoMakeup, fet1176AutoMakeup,
 * softClipperAutoMakeup, schepsAutoTrim, softClipperCeiling, voiceProfile
 */
import { computeAutoMakeupDb } from '../audio/la2aProcessor.js'
import { computeFET1176AutoMakeupDb } from '../audio/fet1176Processor.js'
import { computeSchepsAutoTrim } from '../audio/schepsProcessor.js'
import { computeSoftClipperAutoMakeupDb } from '../audio/softClipperProcessor.js'
import { measurePeakCeilingDb } from '../audio/ceilingPresets.js'
import { measureVoiceProfile } from '../audio/voiceProfile.js'

/**
 * ⚠ EVERY REPLY MUST CARRY `__id` BACK. The worker is shared and long-lived
 * now, so replies are routed by request id rather than by "the one worker that
 * was spawned for this call". `postReply` is the only way to answer.
 */
let currentId = null
function postReply(payload) {
  self.postMessage({ ...payload, __id: currentId })
}

self.onmessage = function (e) {
  const { type, channelData, sampleRate, params } = e.data
  currentId = e.data.__id

  switch (type) {
    case 'normalize':
      normalizeAudio(channelData, params)
      break
    case 'adjustVolume':
      adjustVolume(channelData, params)
      break
    case 'la2aAutoMakeup':
      autoMakeup(computeAutoMakeupDb, channelData, sampleRate, params)
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

// Runs a compressor kernel over the region purely to measure it — this is why
// it lives in the worker rather than on the main thread, so knob drags
// don't jank the UI while the measurement re-runs.
function autoMakeup(measure, channelData, sampleRate, params) {
  try {
    postReply({ type: 'done', makeupDb: measure(channelData, sampleRate, params) })
  } catch (err) {
    postReply({ type: 'error', message: err.message })
  }
}

// Same reasoning as autoMakeup, and the same cost: this one runs the whole
// Scheps wet path (two EQ cascades and the opto compressor) over the region.
function schepsAutoTrim(channelData, sampleRate, params) {
  try {
    const { trimDb, correlation, densityDb } = computeSchepsAutoTrim(channelData, sampleRate, params)
    postReply({ type: 'done', trimDb, correlation, densityDb })
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
    postReply({ type: 'done', ceilingDb })
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
    postReply({ type: 'done', profile: measureVoiceProfile(channelData, sampleRate) })
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
