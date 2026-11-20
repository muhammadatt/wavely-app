import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { applyToRegion } from './regionApply.js'
import { normalizeRegion } from '../audio/processing.js'

export const PEAK_TARGET_DEFAULT_DB = -1

/**
 * The target outlives the window: it is kept per file (perFilePluginSettings.js),
 * so reopening the window shows the active file's target, not the default.
 */
const targetPeak = ref(PEAK_TARGET_DEFAULT_DB)

/** Peak Normalize's settings, for per-file save and restore. */
export const peakNormalizeSettingsIO = {
  read: () => ({ targetPeak: targetPeak.value }),
  write: (p) => { if (Number.isFinite(p?.targetPeak)) targetPeak.value = p.targetPeak },
}

/** Peak Normalize: one gain that puts the region's peak on a target. */
export function usePeakNormalize() {
  const { state, totalDuration, showToast } = useEditorState()

  /** Normalize the selection, or the whole file when there is none (or `useSelection` is false). */
  async function apply({ useSelection = true } = {}) {
    const sel = useSelection ? state.selection : null
    const start = sel ? sel.start : 0
    const end = sel ? sel.end : totalDuration.value
    const target = targetPeak.value
    const out = await applyToRegion({
      what: 'Normalization',
      label: 'normalization',
      busy: 'Normalizing...',
      start,
      end,
      render: async r => ({
        buffer: await normalizeRegion(r.segments, r.start, r.end, target, r.ctx, r.sampleRate, r.channels),
      }),
      failed: 'Normalization failed',
    })
    if (out) showToast('Normalization applied')
    return !!out
  }

  return { targetPeak, apply }
}
