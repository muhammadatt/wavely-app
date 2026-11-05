<script setup>
/**
 * VOXPRESSOR GR NEEDLE — the analog gain-reduction meter at the centre of the
 * faceplate (docs/design/voxpressor, "VoxVU"): a cream face in a dark bezel,
 * 0–20 dB GR on a compressed scale, red from 10. What it reads is chosen by
 * the panel (PEAKS / BODY / PARALLEL), and `label` says which.
 *
 * The scale is the design's piecewise table (dB → degrees), so 0–3 dB, where
 * a voice chain lives most of the time, takes half the arc.
 *
 * Drawn at the design size (384 × 174) and scaled by `scale`, so the face's
 * hairlines stay the design's.
 */
import { computed } from 'vue'

const props = defineProps({
  /** Gain reduction, dB (positive). */
  db: { type: Number, default: 0 },
  label: { type: String, default: '' },
  scale: { type: Number, default: 0.82 },
})

const W = 384
const H = 174
const P = [[0, 42], [1, 30], [2, 20], [3, 11], [5, -3], [7, -15], [10, -28], [15, -40], [20, -48]]
function ang(db) {
  const d = Math.max(0, Math.min(20, Number.isFinite(db) ? db : 0))
  for (let i = 1; i < P.length; i++) {
    if (d <= P[i][0]) {
      const [d0, a0] = P[i - 1]
      const [d1, a1] = P[i]
      return a0 + ((d - d0) / (d1 - d0)) * (a1 - a0)
    }
  }
  return -48
}
const CX = 180
const CY = 186
const pt = (a, r) => [CX + r * Math.sin((a * Math.PI) / 180), CY - r * Math.cos((a * Math.PI) / 180)]
function arcPath(a0, a1, r) {
  const [x0, y0] = pt(a0, r)
  const [x1, y1] = pt(a1, r)
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`
}
const MAJOR = [0, 1, 2, 3, 5, 7, 10, 20]
const MINOR = [0.5, 1.5, 2.5, 4, 6, 8.5, 12.5, 15, 17.5]
function tick(db, len, w) {
  const a = ang(db)
  const [x1, y1] = pt(a, 126)
  const [x2, y2] = pt(a, 126 + len)
  return { x1, y1, x2, y2, w, c: db >= 10 ? '#c4402b' : '#2a2420' }
}
const arc = arcPath(ang(20), ang(0), 126)
const redArc = arcPath(ang(20), ang(10), 129)
const ticks = [...MAJOR.map(d => tick(d, 10, 1.6)), ...MINOR.map(d => tick(d, 5, 1))]
const labels = MAJOR.map((d) => {
  const [x, y] = pt(ang(d), 148)
  return { t: String(d), x, y, c: d >= 10 ? '#b33a26' : '#2a2420' }
})

const needle = computed(() => `rotate(${ang(props.db).toFixed(2)}deg)`)
</script>

<template>
  <div class="vn" :style="{ width: `${W * scale}px`, height: `${H * scale}px` }" role="meter"
    :aria-label="`${label} gain reduction`" aria-valuemin="0" aria-valuemax="20" :aria-valuenow="Math.round(db * 10) / 10">
    <div class="vn-bezel" :style="{ transform: `scale(${scale})` }">
      <div class="vn-face">
        <svg viewBox="0 0 360 150" width="360" height="150" class="vn-svg" aria-hidden="true">
          <path :d="redArc" fill="none" stroke="#c4402b" stroke-width="4" />
          <path :d="arc" fill="none" stroke="#2a2420" stroke-width="1.2" />
          <line v-for="(t, i) in ticks" :key="i" :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2" :stroke="t.c" :stroke-width="t.w" />
        </svg>
        <span v-for="l in labels" :key="l.t" class="vn-num" :style="{ left: `${l.x}px`, top: `${l.y}px`, color: l.c }">{{ l.t }}</span>
        <div class="vn-legend">
          <span class="vn-label">{{ label }}</span>
          <span class="vn-unit">dB GR</span>
        </div>
        <div class="vn-needle" :style="{ transform: needle }"><div class="vn-needle-bar"></div></div>
        <div class="vn-hub"></div>
        <div class="vn-glass"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vn { position: relative; flex: none; }
.vn-bezel {
  position: absolute; left: 0; top: 0; width: 384px; height: 174px; box-sizing: border-box;
  transform-origin: 0 0; padding: 12px; border-radius: 90px;
  background: linear-gradient(180deg, #121417, #262a31);
  box-shadow: 0 18px 30px -14px rgba(0, 0, 0, .95), inset 0 1px 0 rgba(255, 255, 255, .12), inset 0 -2px 4px rgba(0, 0, 0, .6), 0 0 0 1px rgba(0, 0, 0, .7);
}
.vn-face {
  position: relative; width: 360px; height: 150px; border-radius: 76px; overflow: hidden;
  background: radial-gradient(ellipse 70% 90% at 50% 35%, #fdf4da 0%, #f0dfb0 60%, #d9c288 100%);
  box-shadow: inset 0 4px 12px rgba(0, 0, 0, .55), inset 0 0 0 1px rgba(0, 0, 0, .5);
}
.vn-svg { position: absolute; inset: 0; }
.vn-num { position: absolute; transform: translate(-50%, -50%); font: 600 11px/1 var(--m-font-mono); }
.vn-legend { position: absolute; left: 0; right: 0; top: 80px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.vn-label { font: 700 9px/1 var(--m-font-mono); letter-spacing: .14em; color: rgba(42, 36, 32, .85); }
.vn-unit { font: 600 8px/1 var(--m-font-mono); letter-spacing: .12em; color: rgba(42, 36, 32, .6); }
.vn-needle {
  position: absolute; left: 179px; top: 30px; width: 2px; height: 156px;
  transform-origin: 50% 100%; transition: transform .14s ease-out;
}
.vn-needle-bar { position: absolute; inset: 0; border-radius: 1px; background: linear-gradient(180deg, #c4402b 0 22px, #1d1a16 22px); }
.vn-hub {
  position: absolute; left: 144px; top: 124px; width: 72px; height: 40px; border-radius: 36px 36px 0 0;
  background: linear-gradient(180deg, #2d3138, #15171a);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .12), 0 -2px 6px rgba(0, 0, 0, .35);
}
.vn-glass { position: absolute; inset: 0; border-radius: 76px; pointer-events: none; background: linear-gradient(170deg, rgba(255, 255, 255, .35) 0%, rgba(255, 255, 255, 0) 38%); }
</style>
