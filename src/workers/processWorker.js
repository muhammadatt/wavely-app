/**
 * Audio Processing Web Worker
 *
 * Handles CPU-intensive audio processing tasks off the main thread.
 * Supports: normalize, adjustVolume, la2a
 */
import { processLA2A } from '../audio/la2a.js'

self.onmessage = function (e) {
  const { type, channelData, sampleRate, params } = e.data

  switch (type) {
    case 'normalize':
      normalizeAudio(channelData, params)
      break
    case 'adjustVolume':
      adjustVolume(channelData, params)
      break
    case 'la2a':
      la2aCompress(channelData, sampleRate, params)
      break
    default:
      self.postMessage({ type: 'error', message: `Unknown operation: ${type}` })
  }
}

function la2aCompress(channelData, sampleRate, params) {
  try {
    const { channelData: result, metering } = processLA2A(channelData, sampleRate, params)
    self.postMessage(
      { type: 'done', channelData: result, metering },
      result.map(c => c.buffer)
    )
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
