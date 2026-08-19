import { ref, watch } from 'vue'
import { useEditorState } from './useEditorState.js'
import { useWindows } from './useWindows.js'
import { startMasterAnalyzer, stopMasterAnalyzer, getMasterAnalyzer } from '../audio/analyzer.js'

// Registry id of this window. Must match the entry in src/ui/registry.js.
export const SPECTRUM_ANALYZER_WINDOW_ID = 'spectrum-analyzer'

/**
 * The standalone spectrum analyzer.
 *
 * A measurement instrument, not an effect: nothing to preview, nothing to
 * apply, no undo entry. That is why it carries no ON/BYPASS pill and no Apply
 * bar — there is nothing it could bypass, and a faceplate with a dead Apply
 * button on it reads as a broken effect rather than as a meter.
 *
 * Settings are module-level so they survive closing and reopening the window.
 * Someone who works at 16k FFT with a 4.5 dB/oct tilt is going to want that
 * again next time, and re-dialling four controls per session is the kind of
 * friction that gets a tool left closed.
 */

/** FFT resolution, in points. */
const fftSize = ref(4096)
/**
 * Inter-frame averaging, 0..0.95.
 *
 * The default is heavier than the EQ backdrop's 0.5, because this trace is read
 * on its own rather than as texture behind a curve, and an unaveraged FFT of
 * speech flickers too fast to read a level off.
 */
const smoothing = ref(0.72)
/** Tilt, dB per octave. 4.5 is the usual setting for programme material. */
const slope = ref(4.5)
/** Bottom of the dB window. The top is fixed at 0 dBFS — there is nothing above it. */
const floorDb = ref(-100)
const showPeakHold = ref(true)
/** Freeze the display, to read a moment that has already gone past. */
const frozen = ref(false)

export const FFT_OPTIONS = [
  { value: 1024, label: '1K', title: '43 Hz bins — fast, follows transients' },
  { value: 2048, label: '2K', title: '22 Hz bins' },
  { value: 4096, label: '4K', title: '11 Hz bins — general purpose' },
  { value: 8192, label: '8K', title: '5 Hz bins' },
  { value: 16384, label: '16K', title: '3 Hz bins — separates hum harmonics' },
]

export const SLOPE_OPTIONS = [
  { value: 0, label: 'OFF', title: 'Raw dBFS per bin' },
  { value: 3, label: '3', title: '3 dB/oct — pink noise reads flat' },
  { value: 4.5, label: '4.5', title: '4.5 dB/oct — speech and music read flat' },
  { value: 6, label: '6', title: '6 dB/oct — emphasises the top end' },
]

export function useSpectrumAnalyzer() {
  const { getAudioContext } = useEditorState()
  const { closeWindow } = useWindows()

  /**
   * Attach the tap. Called when the window mounts, which is a click — so the
   * AudioContext is being created or resumed inside a user gesture, as it must
   * be.
   */
  function start() {
    startMasterAnalyzer(getAudioContext(), {
      fftSize: fftSize.value,
      smoothing: smoothing.value,
    })
  }

  /**
   * Detach the tap.
   *
   * An analyser left connected keeps being pulled for every quantum of every
   * playback for the rest of the session, for a display nobody is looking at.
   *
   * Hung off the component's unmount rather than off the close button, because
   * the button is not the only way out: Escape reaches the window manager
   * directly (see EditorScreen's escape ladder), which pops the window without
   * anyone emitting `close`. Unmount is the one event every route out shares.
   */
  function detach() {
    stopMasterAnalyzer()
  }

  /** Close the window. The tap goes with the component, via `detach`. */
  function close() {
    closeWindow(SPECTRUM_ANALYZER_WINDOW_ID)
  }

  /**
   * Latest frame, or null while frozen.
   *
   * A function rather than a reactive value: this is thousands of floats
   * arriving sixty times a second, and putting it through a ref would have Vue
   * diff a typed array to redraw a canvas that redraws itself anyway. Same
   * arrangement as EqPlot's spectrumFn and the resonance display's dataFn.
   *
   * Freezing returns null rather than the last frame, so the display holds what
   * it already drew instead of re-reading an analyser that is still moving.
   */
  function frameFn() {
    if (frozen.value) return null
    const t = getMasterAnalyzer()
    if (!t) return null
    return { db: t.getSpectrumDb(), binWidthHz: t.binWidthHz }
  }

  // Both are properties of the analyser node itself, so they are pushed rather
  // than read per frame.
  watch(fftSize, v => getMasterAnalyzer()?.setFftSize(v))
  watch(smoothing, v => getMasterAnalyzer()?.setSmoothing(v))

  return {
    fftSize, smoothing, slope, floorDb, showPeakHold, frozen,
    start, detach, close, frameFn,
  }
}
