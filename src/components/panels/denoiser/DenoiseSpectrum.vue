<script setup>
/**
 * Spectral Denoise display: the learned noise profile (with Threshold added,
 * dashed), the live input spectrum (dim) and the live output (accent), on the
 * kernel's log display grid (40 Hz to Nyquist). Draws only — every curve is
 * handed in.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  profileDb: { type: Object, default: null }, // Float32Array | null
  inDb: { type: Object, required: true },
  outDb: { type: Object, required: true },
  live: { type: Boolean, default: false },
  sampleRate: { type: Number, default: 44100 },
  height: { type: Number, default: 150 },
  accent: { type: String, default: '#e8a33d' },
})

const MIN_DB = -120
const MAX_DB = -20
const MIN_HZ = 40

const wrap = ref(null)
const canvas = ref(null)
let ro = null
let raf = 0

function draw() {
  raf = 0
  const el = canvas.value
  const box = wrap.value
  if (!el || !box) return
  const dpr = window.devicePixelRatio || 1
  const w = box.clientWidth
  const h = props.height
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
    el.style.width = `${w}px`
    el.style.height = `${h}px`
  }
  const g = el.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)

  const nyq = props.sampleRate / 2
  const xOfHz = hz => (Math.log(hz / MIN_HZ) / Math.log(nyq / MIN_HZ)) * w
  const yOfDb = db => h - ((Math.min(MAX_DB, Math.max(MIN_DB, db)) - MIN_DB) / (MAX_DB - MIN_DB)) * h

  // Grid
  g.strokeStyle = 'rgba(255,255,255,.06)'
  g.fillStyle = 'rgba(255,255,255,.32)'
  g.font = '9px ui-monospace, monospace'
  g.lineWidth = 1
  for (const hz of [100, 300, 1000, 3000, 10000]) {
    if (hz >= nyq) continue
    const x = Math.round(xOfHz(hz)) + 0.5
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke()
    g.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, x + 3, h - 4)
  }
  for (let db = -100; db <= -30; db += 20) {
    const y = Math.round(yOfDb(db)) + 0.5
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke()
    g.fillText(`${db}`, 3, y - 3)
  }

  const curve = (arr) => {
    const n = arr.length
    g.beginPath()
    for (let b = 0; b < n; b++) {
      // Band b spans [b, b+1)/n of the log axis; draw at its centre.
      const x = ((b + 0.5) / n) * w
      const y = yOfDb(arr[b])
      if (b === 0) g.moveTo(x, y); else g.lineTo(x, y)
    }
  }

  if (props.live) {
    curve(props.inDb)
    g.strokeStyle = 'rgba(255,255,255,.35)'
    g.lineWidth = 1.25
    g.stroke()

    curve(props.outDb)
    g.lineTo(w, h); g.lineTo(0, h); g.closePath()
    g.fillStyle = `${props.accent}22`
    g.fill()
    curve(props.outDb)
    g.strokeStyle = props.accent
    g.lineWidth = 1.5
    g.stroke()
  }

  if (props.profileDb) {
    curve(props.profileDb)
    g.setLineDash([4, 3])
    g.strokeStyle = 'rgba(140,200,255,.85)'
    g.lineWidth = 1.25
    g.stroke()
    g.setLineDash([])
  }
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(draw)
}

watch(() => [props.profileDb, props.inDb, props.outDb, props.live, props.sampleRate], schedule)

onMounted(() => {
  ro = new ResizeObserver(schedule)
  ro.observe(wrap.value)
  schedule()
})
onBeforeUnmount(() => {
  ro?.disconnect()
  if (raf) cancelAnimationFrame(raf)
})
</script>

<template>
  <div ref="wrap" class="ds-wrap" :style="{ height: `${height}px` }">
    <canvas ref="canvas" class="ds-canvas" />
  </div>
</template>

<style scoped>
.ds-wrap { position: relative; width: 100%; }
.ds-canvas { display: block; }
</style>
