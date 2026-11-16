import { peakDb } from './shared.mjs'

/**
 * Peak Normalize: NormalizeWindow.vue's applyNormalize → processing.js
 * normalizeRegion → processWorker.js `normalizeAudio`.
 *
 * ⚠ The worker op is a module-private function in a Worker script (it posts
 * its result with self.postMessage), so it cannot be imported in Node. This is
 * that function's arithmetic copied line for line: one gain that puts the
 * region's sample peak on the target, then the same [-1, 1] clamp.
 *
 * Settings: `targetPeak` (dBFS) — the panel's knob; the panel has no settings
 * writer, so the editor's "Try it" link opens it at its own default (-1 dB).
 */
const TARGET_DEFAULT_DB = -1 // NormalizeWindow.vue's TARGET_DEFAULT_DB

export default function render(channels, settings) {
  const targetPeakDb = Number.isFinite(settings.targetPeak) ? settings.targetPeak : TARGET_DEFAULT_DB
  const targetPeak = Math.pow(10, targetPeakDb / 20)
  let currentPeak = 0
  for (const c of channels) for (let i = 0; i < c.length; i++) currentPeak = Math.max(currentPeak, Math.abs(c[i]))
  if (currentPeak === 0) return { channels, note: 'silent, unchanged' }
  const gain = targetPeak / currentPeak
  const out = channels.map((c) => {
    const o = new Float32Array(c.length)
    for (let i = 0; i < c.length; i++) o[i] = Math.max(-1, Math.min(1, c[i] * gain))
    return o
  })
  return { channels: out, note: `target ${targetPeakDb} dBFS, gain ${(20 * Math.log10(gain)).toFixed(2)} dB, peak ${peakDb(out).toFixed(2)} dBFS` }
}
