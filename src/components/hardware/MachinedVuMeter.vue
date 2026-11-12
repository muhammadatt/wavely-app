<script setup>
import { computed, ref } from 'vue'
import { createVuBallistics, useMeterFrame } from '../meters/ballistics.js'
import { VU_SCALE, vuFraction, vuFractionToDeg, grToVuFraction } from './hardwareDial.js'

/**
 * The Vintage 2A face's gain-reduction movement: a cream, backlit scale in a
 * machined grey bezel, with a red band over the top of the scale, a single VU
 * legend and a fine tapered needle.
 *
 * Same movement as `ClassicVuMeter` — the same scale table, the same two-pole
 * VU ballistics, resting on 0 and falling left one division per dB, dropping
 * to its left stop with the unit off — in a different case. The Classic 76
 * keeps the chrome one.
 */
const props = defineProps({
  /** Gain reduction in dB, either sign (the compressors report it negative). */
  reductionDb: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  /** Displayed width; the meter is drawn at 292 × 172 and scaled. */
  width: { type: Number, default: 292 },
})

const NATIVE_W = 292
const NATIVE_H = 172
const scale = computed(() => props.width / NATIVE_W)

const INK = '#2b2621'
const RED = '#b3262b'
const MINORS = [-18, -16, -14, -12, -9, -8, -6, -4, -0.5, 0.5, 1.5, 2.5]

const MARKS = [
  ...VU_SCALE.map(([db]) => ({ f: vuFraction(db), major: true, red: db >= 0, text: db > 0 ? `+${db}` : String(db) })),
  ...MINORS.map(db => ({ f: vuFraction(db), major: false, red: db >= 0 })),
]
const TICKS = MARKS.map(({ f, major, red }) => {
  const w = major ? 2.4 : 1.4
  return {
    rot: `rotate(${vuFractionToDeg(f).toFixed(2)}deg)`,
    left: `${-w / 2}px`, w: `${w}px`, h: `${major ? 11 : 6.5}px`,
    col: red ? RED : INK,
  }
})
const LABELS = MARKS.filter(m => m.text !== undefined).map(({ f, red, text }) => {
  const a = vuFractionToDeg(f)
  return { rot: `rotate(${a.toFixed(2)}deg)`, counter: `rotate(${(-a).toFixed(2)}deg)`, text, col: red ? RED : INK }
})

// Arcs about the needle's pivot, (178, 196.1) in the face's 356 × 200 viewBox.
function arc(f0, f1, r) {
  const p = (f) => {
    const a = (vuFractionToDeg(f) * Math.PI) / 180
    return `${(178 + r * Math.sin(a)).toFixed(1)} ${(196.1 - r * Math.cos(a)).toFixed(1)}`
  }
  return `M${p(f0)} A${r} ${r} 0 0 1 ${p(f1)}`
}
const RED_FROM = vuFraction(0)
const BAND = arc(RED_FROM, 1, 150)
const INK_ARC = arc(0, RED_FROM, 145)
const RED_ARC = arc(RED_FROM, 1, 145)

const REST = vuFraction(0)
const needle = createVuBallistics({ initial: REST })
const fraction = ref(REST)
useMeterFrame((dt) => {
  fraction.value = needle.push(props.active ? grToVuFraction(props.reductionDb) : 0, dt)
})
const needleRot = computed(() => `rotate(${vuFractionToDeg(fraction.value).toFixed(2)}deg)`)
</script>

<template>
  <div
    class="mvu"
    :style="{ width: width + 'px', height: (NATIVE_H * scale).toFixed(1) + 'px' }"
    role="meter"
    aria-label="Gain reduction"
    :aria-valuenow="active ? Math.abs(reductionDb).toFixed(1) : '0.0'"
    aria-valuemin="0"
    aria-valuemax="20"
  >
    <div class="mvu-scaler" :style="{ transform: `scale(${scale})` }">
      <div class="mvu-bezel">
        <div class="mvu-well">
          <div class="mvu-window">
            <div class="mvu-face">
              <div class="mvu-paper" />
              <svg viewBox="0 0 356 200" class="mvu-arc">
                <path :d="BAND" :style="{ fill: 'none', stroke: RED, strokeWidth: '5px', opacity: .9 }" />
                <path :d="INK_ARC" :style="{ fill: 'none', stroke: INK, strokeWidth: '1.2px' }" />
                <path :d="RED_ARC" :style="{ fill: 'none', stroke: RED, strokeWidth: '1.2px' }" />
              </svg>
              <div v-for="(t, i) in TICKS" :key="'t' + i" class="mvu-arm" :style="{ height: '145px', transform: t.rot }">
                <div :style="{ position: 'absolute', top: 0, left: t.left, width: t.w, height: t.h, background: t.col }" />
              </div>
              <div v-for="(l, i) in LABELS" :key="'n' + i" class="mvu-arm" :style="{ height: '170px', transform: l.rot }">
                <div class="mvu-num" :style="{ color: l.col, transform: l.counter }">{{ l.text }}</div>
              </div>
              <div class="mvu-word">VU</div>
              <div class="mvu-sub">GAIN REDUCTION</div>
              <div class="mvu-needle-shadow" :style="{ transform: needleRot }" />
              <div class="mvu-needle" :style="{ transform: needleRot }" />
              <div class="mvu-pivot" />
              <div class="mvu-lamp" />
              <div class="mvu-glass" />
              <div class="mvu-glint" />
              <div class="mvu-lip" />
              <div class="mvu-vignette" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mvu { position: relative; flex: 0 0 auto; }
.mvu-scaler { position: absolute; left: 0; top: 0; width: 292px; height: 172px; transform-origin: 0 0; }
.mvu-bezel {
  width: 292px; height: 172px; box-sizing: border-box;
  border-style: solid; border-width: 11px; border-color: #a9aeb1 #868b8e #6c7174 #959a9d; border-radius: 2px;
  box-shadow: 0 1px 0 0 rgba(159,152,152,.55);
}
.mvu-well {
  height: 100%; box-sizing: border-box; padding: 3px; border-radius: 3px;
  background: linear-gradient(180deg,#575c5f,#8a8f92); box-shadow: inset 0 1px 2px rgba(0,0,0,.5);
}
.mvu-window { position: relative; width: 264px; height: 144px; overflow: hidden; border-radius: 2px; box-shadow: 0 0 0 1px rgba(0,0,0,.45); }
/* The face is drawn at the chrome meter's 356 × 200 and fitted to the window. */
.mvu-face {
  position: absolute; left: -4px; top: 0; width: 356px; height: 200px;
  transform: scale(.765); transform-origin: 0 0;
  font-family: 'Archivo Narrow', Oswald, Helvetica, sans-serif;
}
.mvu-paper { position: absolute; inset: 0; background: radial-gradient(120% 110% at 50% 95%,#fbe6b8 0%,#efcf8c 45%,#dfb069 85%,#cc9a4f 100%); }
.mvu-arc { position: absolute; inset: 0; width: 100%; height: 100%; }
.mvu-arm { position: absolute; left: 50%; bottom: 4px; width: 0; transform-origin: 50% 100%; }
.mvu-num { position: absolute; top: -7px; left: -15px; width: 30px; text-align: center; font-size: 13px; font-weight: 600; line-height: 1; }
.mvu-word { position: absolute; left: 0; right: 0; bottom: 70px; text-align: center; font-size: 21px; font-weight: 700; line-height: 1; letter-spacing: .14em; text-indent: .14em; color: #2b2621; }
.mvu-sub { position: absolute; left: 0; right: 0; bottom: 54px; text-align: center; font-size: 8.5px; font-weight: 600; line-height: 1; letter-spacing: .32em; text-indent: .32em; color: #5a5048; }
.mvu-needle-shadow {
  position: absolute; left: calc(50% + 5px); bottom: 4px; width: 2px; margin-left: -1px; height: 150px;
  transform-origin: 50% 100%; background: rgba(60,40,15,.28); filter: blur(1.5px);
}
.mvu-needle {
  position: absolute; left: 50%; bottom: 4px; width: 3px; margin-left: -1.5px; height: 152px;
  transform-origin: 50% 100%; clip-path: polygon(35% 0, 65% 0, 100% 100%, 0 100%); background: #15120f;
}
.mvu-pivot {
  position: absolute; left: 50%; bottom: -3px; width: 16px; height: 16px; margin-left: -8px; border-radius: 50%;
  background: radial-gradient(circle at 40% 35%,#5a5550,#1a1714 70%); box-shadow: 0 1px 2px rgba(0,0,0,.4);
}
.mvu-lamp {
  position: absolute; left: -14%; right: -14%; top: -52px; height: 104px; pointer-events: none;
  background: radial-gradient(46% 100% at 28% 100%,rgba(255,255,255,.62) 0%,rgba(255,255,255,.24) 45%,rgba(255,255,255,0) 78%),
    radial-gradient(46% 100% at 72% 100%,rgba(255,255,255,.56) 0%,rgba(255,255,255,.2) 45%,rgba(255,255,255,0) 78%);
  filter: blur(10px);
}
.mvu-glass { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(106deg,rgba(255,255,255,.36) 0%,rgba(255,255,255,.2) 22%,rgba(255,255,255,.02) 22.6%,rgba(255,255,255,0) 60%,rgba(255,255,255,.07) 100%); }
.mvu-glint { position: absolute; left: 62%; top: -20%; width: 9%; height: 140%; pointer-events: none; transform: rotate(16deg); background: linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.2) 50%,rgba(255,255,255,0)); filter: blur(2px); }
.mvu-lip { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; pointer-events: none; background: linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.35) 30%,rgba(255,255,255,.35) 70%,rgba(255,255,255,0)); }
.mvu-vignette { position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 16px 22px -12px rgba(50,30,10,.55), inset 0 0 36px rgba(90,60,20,.3), inset 0 -12px 22px -10px rgba(50,36,16,.18); }
</style>
