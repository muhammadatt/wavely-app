import { getEffectChain } from './effectChain.js'
import { createSpectrumTap } from './effects/levelTap.js'

/**
 * The master spectrum tap — one analyser on the signal that leaves the app.
 *
 * WHY IT HANGS OFF THE EFFECT CHAIN'S OUTPUT AND NOT OFF A PLUGIN. Every effect
 * window already carries its own taps, and those show that plugin's output with
 * everything downstream of it missing. The standalone analyzer answers a
 * different question — "what does this file sound like right now" — so it has
 * to sit where the user's ears do: after the whole chain, before the speakers.
 * Opening it while three effects are engaged shows their combined result, and
 * bypassing one of them moves the trace.
 *
 * Asking for the chain is also what makes it work at all on a file with no
 * effects in use: playback routes through the chain only if one exists, so
 * creating it here is what puts the audio somewhere the tap can see it.
 *
 * A module singleton rather than a per-component instance, because an
 * AnalyserNode is a permanent connection into the graph and a window that is
 * opened and closed repeatedly would otherwise leave a trail of them running.
 */

let tap = null
let tapContext = null

/**
 * Start (or return) the master tap.
 *
 * Safe to call repeatedly — the second call reconfigures the existing tap
 * instead of adding a second one.
 */
export function startMasterAnalyzer(audioContext, { fftSize, smoothing } = {}) {
  if (tap && tapContext !== audioContext) stopMasterAnalyzer()

  if (!tap) {
    const chain = getEffectChain(audioContext)
    tap = createSpectrumTap(audioContext, chain.getOutputNode(), {
      fftSize: fftSize ?? 4096,
      smoothing: smoothing ?? 0.5,
      // Wider than the EQ backdrop's window at both ends. That trace is drawn
      // as a texture behind a curve, so it only has to look like the audio;
      // this one is read as a measurement, and clipping the range would make
      // a hot file and a very hot file draw identically at the top while a
      // room tone at -95 dBFS sat flat on the floor.
      minDecibels: -140,
      maxDecibels: 0,
    })
    tapContext = audioContext
    return tap
  }

  if (fftSize !== undefined) tap.setFftSize(fftSize)
  if (smoothing !== undefined) tap.setSmoothing(smoothing)
  return tap
}

/** The running tap, or null. */
export function getMasterAnalyzer() {
  return tap
}

export function stopMasterAnalyzer() {
  tap?.destroy()
  tap = null
  tapContext = null
}
