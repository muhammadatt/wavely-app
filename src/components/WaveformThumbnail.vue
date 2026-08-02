<script setup>
import { onMounted, ref, watch } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { getSegmentDuration, getTimelineDuration } from '../audio/operations.js'

/**
 * Tiny waveform preview for a document, drawn from cached peaks only — it
 * never touches decoded audio, so it stays cheap enough to render a list of
 * fifteen at once. This is how you navigate a set of drum hits or takes that
 * are indistinguishable by filename.
 */
const props = defineProps({
  doc: { type: Object, required: true },
  width: { type: Number, default: 116 },
  height: { type: Number, default: 30 },
  color: { type: String, default: 'rgba(255,255,255,.35)' },
})

const { getPeakCache, peakCacheVersion } = useEditorState()
const canvas = ref(null)

function draw() {
  const el = canvas.value
  if (!el) return

  const dpr = window.devicePixelRatio || 1
  el.width = props.width * dpr
  el.height = props.height * dpr
  const ctx = el.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, props.width, props.height)

  const segments = props.doc?.segments ?? []
  const duration = getTimelineDuration(segments)
  if (!duration) return

  const mid = props.height / 2
  const half = props.height / 2 - 1
  const secondsPerPx = duration / props.width

  ctx.fillStyle = props.color

  for (let x = 0; x < props.width; x++) {
    const tStart = x * secondsPerPx
    const tEnd = tStart + secondsPerPx

    // Locate the segment under this column. Linear scan is fine — thumbnails
    // are ~116 columns and timelines are a handful of segments.
    let seg = null
    for (const s of segments) {
      if (tStart >= s.outputStart && tStart < s.outputStart + getSegmentDuration(s)) { seg = s; break }
    }
    if (!seg) continue

    if (seg.sourceBuffer === null) {
      // Silence segment — a hairline reads as "intentionally empty" where a
      // gap would read as "failed to render".
      ctx.fillRect(x, mid - 0.5, 1, 1)
      continue
    }

    const cache = getPeakCache(seg.sourceBufferId)
    if (!cache) continue

    const sampleRate = seg.sourceBuffer.sampleRate
    const srcStart = seg.sourceStart + (tStart - seg.outputStart)
    const srcEnd = Math.min(seg.sourceEnd, srcStart + (tEnd - tStart))

    const lane = cache.channels[0]
    if (!lane) continue
    const peakCount = lane.length / 2
    const i0 = Math.max(0, Math.floor((srcStart * sampleRate) / cache.samplesPerPx))
    const i1 = Math.min(peakCount - 1, Math.ceil((srcEnd * sampleRate) / cache.samplesPerPx))

    let min = 1
    let max = -1
    for (let i = i0; i <= i1; i++) {
      // Mix channels by taking the outer envelope — a thumbnail wants the
      // loudest thing that happened, not an average that hides it.
      for (let ch = 0; ch < cache.channels.length; ch++) {
        const c = cache.channels[ch]
        const lo = c[i * 2]
        const hi = c[i * 2 + 1]
        if (lo < min) min = lo
        if (hi > max) max = hi
      }
    }
    if (min > max) continue

    const yTop = mid - max * half
    const yBottom = mid - min * half
    ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop))
  }
}

onMounted(draw)
watch(
  () => [props.doc?.id, props.doc?.segments, props.width, props.height, peakCacheVersion.value],
  draw,
  { deep: true }
)
</script>

<template>
  <canvas
    ref="canvas"
    :style="{ width: `${width}px`, height: `${height}px` }"
    class="block rounded-[4px]"
  ></canvas>
</template>
