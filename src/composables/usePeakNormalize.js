import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { applyToRegion } from './regionApply.js'
import { normalizeRegion } from '../audio/processing.js'

export const PEAK_TARGET_DEFAULT_DB = -1

/**
 * Peak Normalize: one gain that puts the region's peak on a target.
 *
 * Its state lives as long as the window that asked for it (a fresh target
 * each time it opens), as it did when it sat in the panel — there is no live
 * node or measurement that would need to outlive it.
 */
export function usePeakNormalize() {
  const { state, totalDuration, showToast } = useEditorState()
  const targetPeak = ref(PEAK_TARGET_DEFAULT_DB)

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
