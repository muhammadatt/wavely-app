<script setup>
import { ref } from 'vue'
import { useMeterFrame } from './ballistics.js'
import { applyTilt, createLogMapper } from '../../audio/dsp/spectrumDisplay.js'

/**
 * The input's spectrum, drawn BEHIND the HF Softener's response curve on the
 * same log-frequency axis, so the Detect and Band corners the panel marks over
 * it can be read against the voice: a low "s" sitting under the band says pull
 * Band down; vowel energy crossing the Detect line says raise Detect.
 *
 * Deliberately quiet — a filled trace at low contrast. It is context for the
 * curve and the two markers, not an analyzer; the app has one of those.
 * Tilted 4.5 dB/oct (the analyzer's own programme-material convention) so the
 * sibilance octave is not drawn in the bottom few pixels.
 */
const props = defineProps({
  /** Returns the input's spectrum tap (levelTap.createSpectrumTap), or null. */
  tapFn: { type: Function, required: true },
  minHz: { type: Number, default: 100 },
  maxHz: { type: Number, default: 20000 },
  /** dB range of the trace after tilt, bottom to top. */
  floorDb: { type: Number, default: -100 },
  topDb: { type: Number, default: -20 },
})

const canvasEl = ref(null)
const CELLS = 180
const TILT_DB_PER_OCT = 4.5
let mapper = null
let mapperKey = ''

useMeterFrame(() => draw())

function draw() {
  const canvas = canvasEl.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)

  const tap = props.tapFn?.() ?? null
  if (!tap) return
  const key = `${tap.binCount}:${tap.binWidthHz}`
  if (key !== mapperKey) {
    mapper = createLogMapper({ binCount: tap.binCount, binWidthHz: tap.binWidthHz, cells: CELLS, minHz: props.minHz, maxHz: props.maxHz })
    mapperKey = key
  }
  const values = applyTilt(mapper.map(tap.getSpectrumDb(), props.floorDb - 40), mapper.centers, TILT_DB_PER_OCT)
  const span = Math.log2(props.maxHz / props.minHz)
  const xFor = (f) => (Math.log2(f / props.minHz) / span) * w
  const yFor = (db) => Math.min(h, Math.max(0, ((props.topDb - db) / (props.topDb - props.floorDb)) * h))

  ctx.beginPath()
  ctx.moveTo(xFor(mapper.centers[0]), h)
  for (let d = 0; d < mapper.cells; d++) ctx.lineTo(xFor(mapper.centers[d]), yFor(values[d]))
  ctx.lineTo(xFor(mapper.centers[mapper.cells - 1]), h)
  ctx.closePath()
  ctx.fillStyle = 'rgba(255,255,255,.07)'
  ctx.fill()
  ctx.beginPath()
  for (let d = 0; d < mapper.cells; d++) {
    const x = xFor(mapper.centers[d])
    const y = yFor(values[d])
    if (d === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = 'rgba(255,255,255,.22)'
  ctx.lineWidth = 1
  ctx.stroke()
}
</script>

<template>
  <canvas ref="canvasEl" class="absolute inset-0 w-full h-full" aria-hidden="true"></canvas>
</template>
