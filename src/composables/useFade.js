import { ref, computed } from 'vue'
import { useEditorState } from './useEditorState.js'
import { applyToRegion } from './regionApply.js'
import { renderFadeRegion } from '../audio/processing.js'
import { getTimelineDuration } from '../audio/operations.js'

export const FADE_TYPES = [
  { id: 'in', label: 'Fade In' },
  { id: 'out', label: 'Fade Out' },
]

export const FADE_CURVES = [
  { id: 'linear', label: 'Linear' },
  { id: 'expo', label: 'Expo' },
  { id: 's-curve', label: 'S-Curve' },
]

const LABELS = { in: 'fade in', out: 'fade out' }
const EPS = 1e-6

/**
 * Whether a fade over `selection` meets audio at full level on its open side,
 * and what the user will hear there; '' when it does not. A fade in that
 * starts mid-file (or a fade out that ends mid-file) steps from full level to
 * silence at that edge.
 */
export function fadeEdgeWarning(type, selection, timelineDuration) {
  if (!selection) return ''
  if (type === 'in' && selection.start > EPS) {
    return 'The audio before the selection stays at full level, so it will jump to silence where the fade starts.'
  }
  if (type === 'out' && selection.end < timelineDuration - EPS) {
    return 'The audio after the selection stays at full level, so it will jump back up where the fade ends.'
  }
  return ''
}

/**
 * Fade: in or out across the WHOLE selection — the selection is the fade's
 * length. State lives as long as the rail view that asked for it.
 */
export function useFade() {
  const { state, hasSelection, showToast } = useEditorState()
  const fadeType = ref('in')
  const curveType = ref('linear')

  /** The fade's length: the selection's. */
  const fadeSeconds = computed(() => (state.selection ? state.selection.end - state.selection.start : 0))

  const edgeWarning = computed(() =>
    fadeEdgeWarning(fadeType.value, state.selection, getTimelineDuration(state.segments)))

  async function apply() {
    if (!hasSelection.value) return false
    const { start, end } = state.selection
    const type = fadeType.value
    const curve = curveType.value
    const label = LABELS[type]
    const out = await applyToRegion({
      what: `The ${label}`,
      label: `the ${label}`,
      busy: `Applying ${label}...`,
      start,
      end,
      render: async r => ({
        buffer: await renderFadeRegion(r.segments, r.start, r.end, { type, curve }, r.ctx, r.sampleRate, r.channels),
      }),
      failed: err => `Fade failed: ${err.message}`,
    })
    if (out) {
      const curveLabel = FADE_CURVES.find(c => c.id === curve)?.label ?? curve
      showToast(`${label[0].toUpperCase()}${label.slice(1)} applied (${(end - start).toFixed(2)} s, ${curveLabel})`)
    }
    return !!out
  }

  return { fadeType, curveType, fadeSeconds, edgeWarning, apply }
}
