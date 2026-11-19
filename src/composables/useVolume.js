import { ref } from 'vue'
import { useEditorState } from './useEditorState.js'
import { applyToRegion } from './regionApply.js'
import { adjustVolumeRegion } from '../audio/processing.js'

const signedDb = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`

/**
 * Volume: a fixed gain over the selection. State lives as long as the rail
 * view that asked for it, as it did in the panel.
 */
export function useVolume() {
  const { state, hasSelection, showToast } = useEditorState()
  const gainDb = ref(0)

  async function apply() {
    if (!hasSelection.value) return false
    const { start, end } = state.selection
    const gain = gainDb.value
    const out = await applyToRegion({
      what: 'The volume adjustment',
      label: 'the volume adjustment',
      busy: 'Adjusting volume...',
      start,
      end,
      render: async r => ({
        buffer: await adjustVolumeRegion(r.segments, r.start, r.end, gain, r.ctx, r.sampleRate, r.channels),
      }),
      failed: 'Volume adjustment failed',
    })
    if (out) showToast(`Volume adjusted by ${signedDb(gain)} dB`)
    return !!out
  }

  return { gainDb, apply }
}
