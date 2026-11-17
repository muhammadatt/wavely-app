/**
 * Helpers the marketing renderers share (see scripts/marketing-render.mjs).
 * Every renderer is `export default function render(channels, settings)` →
 * `{ channels, note }`: the dry clip (Float32Array per channel, 44.1 kHz) and
 * the sample's panel settings over the effect's defaults, rendered the way
 * Apply renders a selection of the whole clip.
 */

export const SR = 44100

export const peakDb = (channels) => {
  let p = 0
  for (const c of channels) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]))
  return p > 0 ? 20 * Math.log10(p) : -Infinity
}

/** Render `channels` through `process`, padded by its latency and trimmed back to the input. */
export function renderAligned(channels, latency, process) {
  const n = channels[0].length
  const padded = channels.map((c) => { const q = new Float32Array(n + latency); q.set(c); return q })
  return process(padded).map(c => c.slice(latency, latency + n))
}
