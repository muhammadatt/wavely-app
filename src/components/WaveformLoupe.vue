<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { renderRegionToBuffer } from '../audio/processing.js'
import {
  LOUPE_SIZE_PX, loupeColumns, loupeGain, loupePosition, loupeWindow,
} from '../audio/selectionLoupe.js'

/**
 * The touch selection's magnifier (audio/selectionLoupe.js has the rules):
 * a round loupe above the finger while it drags a selection or one of its
 * edges, showing the audio around the edge much finer than the waveform —
 * and taller, scaled to what is in view — the edge as an amber line, the
 * selected side shaded, and the edge's time.
 *
 * Drawn from the timeline's own samples (channel 1), a fraction of a second
 * at a time, at most once a frame.
 */
const props = defineProps({
  /** Finger position in the waveform box, px. */
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  /** The edge under the finger, seconds. */
  time: { type: Number, required: true },
  /** The waveform's zoom, px per second. */
  pixelsPerSecond: { type: Number, required: true },
  boxW: { type: Number, required: true },
  boxH: { type: Number, required: true },
})

const { state } = useEditorState()
const canvas = ref(null)
const SIZE = LOUPE_SIZE_PX

const position = computed(() => loupePosition({ x: props.x, y: props.y, boxW: props.boxW, boxH: props.boxH }))

const label = computed(() => {
  const t = Math.max(0, props.time)
  const m = Math.floor(t / 60)
  return `${m}:${(t % 60).toFixed(3).padStart(6, '0')}`
})

let frame = 0
function schedule() {
  if (frame) return
  frame = requestAnimationFrame(() => { frame = 0; draw() })
}

function draw() {
  const el = canvas.value
  const file = state.currentFile
  if (!el || !file) return
  const dpr = window.devicePixelRatio || 1
  const px = Math.round(SIZE * dpr)
  if (el.width !== px) { el.width = px; el.height = px }
  const ctx = el.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, SIZE, SIZE)
  ctx.fillStyle = '#080a0d'
  ctx.fillRect(0, 0, SIZE, SIZE)

  const { start, end } = loupeWindow(props.time, props.pixelsPerSecond)
  const from = Math.max(0, start)
  const to = Math.max(from, end)
  // Where the visible audio sits in the loupe: the window can run past the
  // file's start, which reads as silence on the left.
  const x0 = ((from - start) / (end - start)) * SIZE
  const x1 = ((to - start) / (end - start)) * SIZE

  // The selected side, shaded as the waveform shades it.
  const sel = state.selection
  if (sel) {
    const s = ((sel.start - start) / (end - start)) * SIZE
    const e = ((sel.end - start) / (end - start)) * SIZE
    ctx.fillStyle = 'rgba(53, 211, 230, 0.14)'
    ctx.fillRect(Math.max(0, s), 0, Math.min(SIZE, e) - Math.max(0, s), SIZE)
  }

  const mid = SIZE / 2
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(SIZE, mid); ctx.stroke()

  if (to > from && x1 - x0 >= 1) {
    const [samples] = renderRegionToBuffer(state.segments, from, to, file.sampleRate, 1)
    const cols = Math.max(1, Math.round(x1 - x0))
    const peaks = loupeColumns(samples, cols)
    // Scaled to what is in view (loupeGain), so quiet gaps show their detail.
    const amp = SIZE * 0.46 * loupeGain(peaks)
    ctx.fillStyle = '#5df0b0'
    for (let c = 0; c < cols; c++) {
      const lo = peaks[c * 2]
      const hi = peaks[c * 2 + 1]
      const top = mid - hi * amp
      const h = Math.max(1, (hi - lo) * amp)
      ctx.fillRect(x0 + c, top, 1, h)
    }
  }

  // The edge itself.
  ctx.fillStyle = '#e8a33d'
  ctx.fillRect(mid - 1, 0, 2, SIZE)
}

watch(() => [props.time, props.pixelsPerSecond, state.selection?.start, state.selection?.end], schedule)
nextTick(schedule)
onBeforeUnmount(() => { if (frame) cancelAnimationFrame(frame) })
</script>

<template>
  <div
    class="loupe"
    :style="{ left: `${position.left}px`, top: `${position.top}px`, width: `${SIZE}px` }"
    aria-hidden="true"
    data-testid="waveform-loupe"
  >
    <canvas ref="canvas" class="loupe-disc" :style="{ width: `${SIZE}px`, height: `${SIZE}px` }" />
    <span class="loupe-time">{{ label }}</span>
  </div>
</template>

<style scoped>
.loupe {
  position: absolute;
  z-index: 20;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.loupe-disc {
  display: block;
  border-radius: 50%;
  border: 2px solid #e8a33d;
  box-shadow: 0 8px 22px rgba(0, 0, 0, .6);
}
.loupe-time {
  font: 600 11px 'JetBrains Mono', ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
  color: #eaf6f8;
  background: rgba(8, 10, 13, .85);
  padding: 2px 7px;
  border-radius: 6px;
}
</style>
