/**
 * Audio Processing Web Worker
 *
 * Handles CPU-intensive audio processing tasks off the main thread.
 * Supports: normalize, adjustVolume, la2aAutoMakeup, fet1176AutoMakeup,
 * schepsAutoTrim, softClipperSpeechLevel
 */
import { computeAutoMakeupDb } from '../audio/la2aProcessor.js'
import { computeFET1176AutoMakeupDb } from '../audio/fet1176Processor.js'
import { computeSchepsAutoTrim } from '../audio/schepsProcessor.js'
import { measureSpeechLevelDb } from '../audio/staticThreshold.js'

self.onmessage = function (e) {
  const { type, channelData, sampleRate, params } = e.data

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
    case 'schepsAutoTrim':
      schepsAutoTrim(channelData, sampleRate, params)
      break
    case 'softClipperSpeechLevel':
      softClipperSpeechLevel(channelData, sampleRate)
      break
    default:
      self.postMessage({ type: 'error', message: `Unknown operation: ${type}` })
  }
}

// Runs a compressor kernel over the region purely to measure it — this is why
// it lives in the worker rather than on the main thread, so knob drags
// don't jank the UI while the measurement re-runs.
function autoMakeup(measure, channelData, sampleRate, params) {
  try {
    self.postMessage({ type: 'done', makeupDb: measure(channelData, sampleRate, params) })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}

// Same reasoning as autoMakeup, and the same cost: this one runs the whole
// Scheps wet path (two EQ cascades and the opto compressor) over the region.
function schepsAutoTrim(channelData, sampleRate, params) {
  try {
    const { trimDb, correlation, densityDb } = computeSchepsAutoTrim(channelData, sampleRate, params)
    self.postMessage({ type: 'done', trimDb, correlation, densityDb })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
  }
}

/**
 * Speech level for the soft clipper's static threshold mode.
 *
 * Same reasoning as autoMakeup — it runs a real SoftClipperKernel over the
 * region to reuse the stage's own tracker rather than defining a second
 * "speech level", so it is far too heavy for the main thread.
 *
 * ⚠ A null result is a legitimate answer, not a failure: a region too short or
 * too quiet to measure has no speech level, and the caller must fall back to
 * the adaptive tracker rather than render against a made-up number.
 */
function softClipperSpeechLevel(channelData, sampleRate) {
  try {
    self.postMessage({ type: 'done', speechLevelDb: measureSpeechLevelDb(channelData, sampleRate) })
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message })
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
