<script setup>
import { computed, ref } from 'vue'
import { createPeakHold, createVuBallistics, grFraction, useMeterFrame } from './ballistics.js'

/**
 * Backlit analog VU meter with a swinging needle.
 *
 * Modeled on the meter of the hardware it fronts: one movement, switchable
 * between gain reduction and output level. Both scales are laid out the way a
 * real moving-coil meter behaves — deflection is linear in voltage, so the dB
 * markings crowd together toward the end of their travel on their own rather
 * than being placed by hand.
 *
 *  - `gr`: rest position is hard right (no reduction); the needle swings left
 *    as the compressor works.
 *  - `vu`: conventional VU scale, 0 VU referenced to whatever dBFS the
 *    caller nominates (the hardware's +4 / +8 meter buttons).
 */
const props = defineProps({
  mode: { type: String, default: 'gr' }, // 'gr' | 'vu'
  // Gain reduction as a positive magnitude in dB.
  reductionDb: { type: Number, default: 0 },
  // Output level in dBFS, for the VU scale.
  levelDb: { type: Number, default: -Infinity },
  // dBFS that reads as 0 VU.
  referenceDbfs: { type: Number, default: -18 },
  accent: { type: String, default: '#79b8ff' },
})

// Needle sweep, degrees either side of vertical.
const SWEEP = 52

// Deflection is linear in voltage, so the dB markings bunch up on their own
// at the crowded end of the travel. Only the numerals that stay legible get
// printed; the rest are drawn as bare ticks, the way a real face is engraved.
const GR_MARKS = [0, 1, 2, 3, 4, 5, 7, 10, 15, 20]
const GR_LABELLED = new Set([0, 1, 3, 5, 10, 20])
const GR_FULL_SCALE_DB = 20 // reduction at the left-hand end of the scale

const VU_MARKS = [-20, -10, -7, -5, -3, -1, 0, 1, 2, 3]
const VU_LABELLED = new Set([-20, -10, -5, -3, 0, 3])
const VU_TOP_DB = 3 // right-hand end of the scale

/**
 * Voltage fraction (0-1 across the face) for a gain-reduction reading.
 *
 * Rest is hard right, so this is the complement of the shared scale law the
 * horizontal bar draws with — same curve, mirrored.
 */
function grDeflection(db) {
  return 1 - grFraction(db, GR_FULL_SCALE_DB)
}

/** Voltage fraction (0-1 across the face) for a VU reading. */
function vuFraction(vu) {
  return Math.pow(10, (vu - VU_TOP_DB) / 20)
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function fractionToAngle(f) {
  return -SWEEP + clamp01(f) * SWEEP * 2
}

const isGr = computed(() => props.mode === 'gr')

const marks = computed(() =>
  isGr.value
    ? GR_MARKS.map(db => ({
        label: GR_LABELLED.has(db) ? String(db) : '',
        angle: fractionToAngle(grDeflection(db)),
        major: GR_LABELLED.has(db),
      }))
    : VU_MARKS.map(db => ({
        label: VU_LABELLED.has(db) ? (db > 0 ? `+${db}` : String(db)) : '',
        angle: fractionToAngle(vuFraction(db)),
        major: VU_LABELLED.has(db),
        hot: db >= 0,
      }))
)

/**
 * Where the needle would sit with no movement mass, 0-1 across the face.
 */
function targetDeflection() {
  if (isGr.value) return grDeflection(Math.max(0, props.reductionDb))
  const vu = Number.isFinite(props.levelDb) ? props.levelDb - props.referenceDbfs : -60
  return clamp01(vuFraction(vu))
}

/**
 * VU damping, run explicitly rather than left to a CSS transition.
 *
 * A transition restarts from wherever it was every time the prop changes, so
 * its timing depends on how often the caller pushes; the movement it models
 * has one time constant regardless. Running it per frame also means the bar
 * meter and this one are damped by the same code.
 */
const deflection = ref(0)
// Distance travelled from rest, which is hard left on the level scale and hard
// right on the GR scale. Holding the excursion rather than the deflection lets
// one peak hold serve both without knowing which way the needle points.
const peakExcursion = ref(0)
const needle = createVuBallistics()
// Shared hold and fall rate: the excursion is already a scale fraction, which
// is the unit the peak hold defaults are expressed in.
const peak = createPeakHold()
let lastMode = props.mode

useMeterFrame((dtMs) => {
  if (props.mode !== lastMode) {
    // A held GR peak is meaningless on the level scale, and the reverse.
    lastMode = props.mode
    peak.reset(0)
  }
  const target = targetDeflection()
  deflection.value = needle.push(target, dtMs)
  peakExcursion.value = peak.push(isGr.value ? 1 - target : target, dtMs)
})

const needleAngle = computed(() => fractionToAngle(deflection.value))
const peakAngle = computed(() =>
  fractionToAngle(isGr.value ? 1 - peakExcursion.value : peakExcursion.value)
)
const showPeak = computed(() => peakExcursion.value > 0.005)

// The red arc: 0 VU and above on the level scale; the GR scale has none.
const redArc = computed(() => {
  if (isGr.value) return null
  return { from: fractionToAngle(vuFraction(0)), to: SWEEP }
})

const PIVOT_X = 100
const PIVOT_Y = 104
const FACE_R = 86

function polar(angleDeg, radius) {
  const rad = (angleDeg - 90) * Math.PI / 180
  return {
    x: PIVOT_X + radius * Math.cos(rad),
    y: PIVOT_Y + radius * Math.sin(rad),
  }
}

/** SVG arc path along the scale radius. */
function arcPath(fromDeg, toDeg, radius) {
  const a = polar(fromDeg, radius)
  const b = polar(toDeg, radius)
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${radius} ${radius} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`
}

const scaleArc = computed(() => arcPath(-SWEEP, SWEEP, FACE_R))
const redArcPath = computed(() => (redArc.value ? arcPath(redArc.value.from, redArc.value.to, FACE_R) : ''))

const tickLines = computed(() =>
  marks.value.map(m => {
    const outer = polar(m.angle, FACE_R)
    const inner = polar(m.angle, FACE_R - (m.major ? 11 : 8))
    const text = polar(m.angle, FACE_R - 22)
    return { ...m, x1: outer.x, y1: outer.y, x2: inner.x, y2: inner.y, tx: text.x, ty: text.y }
  })
)

const caption = computed(() => (isGr.value ? 'GAIN REDUCTION' : 'VU'))
</script>

<template>
  <div class="relative rounded-[10px] overflow-hidden"
       :style="{
         background: 'linear-gradient(175deg,#f3ead4,#dfd2b4 62%,#cfc09e)',
         boxShadow: `inset 0 0 22px rgba(120,96,54,.35), inset 0 0 0 1px rgba(0,0,0,.45), 0 0 18px color-mix(in srgb, ${accent} 18%, transparent)`,
       }">
    <svg viewBox="0 0 200 118" class="block w-full">
      <!-- Scale arc -->
      <path :d="scaleArc" fill="none" stroke="#3a3226" stroke-width="1.6" />
      <path v-if="redArcPath" :d="redArcPath" fill="none" stroke="#c0392b" stroke-width="3.2" />

      <!-- Ticks + numerals -->
      <g v-for="(t, i) in tickLines" :key="i">
        <line :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2"
              :stroke="t.hot ? '#b03225' : '#3a3226'" :stroke-width="t.major ? 1.7 : 1.1" stroke-linecap="round" />
        <text v-if="t.label" :x="t.tx" :y="t.ty" text-anchor="middle" dominant-baseline="middle"
              :fill="t.hot ? '#a82f22' : '#3a3226'"
              style="font:700 9px 'JetBrains Mono',monospace">{{ t.label }}</text>
      </g>

      <!-- Caption -->
      <text :x="PIVOT_X" :y="PIVOT_Y - 21" text-anchor="middle"
            fill="rgba(58,50,38,.72)"
            style="font:700 7.5px 'Inter',system-ui;letter-spacing:.22em">{{ caption }}</text>

      <!-- Peak hold: a fast marker riding the scale arc, so the transient
           depth the damped needle averages away is still readable. -->
      <g v-show="showPeak" :style="{
           transform: `rotate(${peakAngle}deg)`,
           transformBox: 'view-box',
           transformOrigin: `${PIVOT_X}px ${PIVOT_Y}px`,
         }">
        <line :x1="PIVOT_X" :y1="PIVOT_Y - FACE_R - 1" :x2="PIVOT_X" :y2="PIVOT_Y - FACE_R + 13"
              stroke="#8c2f22" stroke-width="2.2" stroke-linecap="round" opacity="0.85" />
      </g>

      <!-- Needle. Damped in script, not by a CSS transition. -->
      <g :style="{
           transform: `rotate(${needleAngle}deg)`,
           transformBox: 'view-box',
           transformOrigin: `${PIVOT_X}px ${PIVOT_Y}px`,
         }">
        <line :x1="PIVOT_X" :y1="PIVOT_Y + 6" :x2="PIVOT_X" :y2="PIVOT_Y - FACE_R + 4"
              stroke="#14100a" stroke-width="1.9" stroke-linecap="round" />
      </g>
      <circle :cx="PIVOT_X" :cy="PIVOT_Y" r="7" fill="#1b1710" />
      <circle :cx="PIVOT_X" :cy="PIVOT_Y" r="4" fill="#3d3527" />
    </svg>

    <!-- Glass: a soft top-left highlight over the whole face -->
    <div class="absolute inset-0 pointer-events-none"
         style="background:linear-gradient(150deg,rgba(255,255,255,.42),rgba(255,255,255,0) 46%)"></div>
  </div>
</template>
