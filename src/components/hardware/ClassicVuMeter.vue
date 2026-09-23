<script setup>
import { computed, ref } from 'vue'
import { createVuBallistics, useMeterFrame } from '../meters/ballistics.js'
import { VU_SCALE, vuFraction, vuFractionToDeg, grToVuFraction } from './hardwareDial.js'

/**
 * The Classic 76 face's amber VU movement, reading gain reduction the way the
 * hardware's GR position does: the needle rests on 0 and falls left, one
 * division per dB.
 *
 * Damped by the same two-pole VU ballistics as every other meter in the app
 * (`meters/ballistics.js`), so it reads the same quantity at the same speed
 * as the bar meter it replaces. With the unit off the needle drops to its
 * left stop, as a de-energised movement does.
 */
const props = defineProps({
  /** Gain reduction in dB, either sign (the compressors report it negative). */
  reductionDb: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  /** Displayed width; the face is drawn at 400 px and scaled. */
  width: { type: Number, default: 228 },
})

const NATIVE_W = 400
const NATIVE_H = 229 // the face without its nameplate strip, as the design crops it
const scale = computed(() => props.width / NATIVE_W)

const INK = '#2a2420'
const RED = '#a3201f'
const MINORS = [-18, -16, -14, -12, -9, -8, -6, -4, -0.5, 0.5, 1.5, 2.5]

const ticks = [
  ...VU_SCALE.map(([db]) => ({ db, major: true })),
  ...MINORS.map(db => ({ db, major: false })),
].map(({ db, major }) => ({
  rot: `rotate(${vuFractionToDeg(vuFraction(db)).toFixed(2)}deg)`,
  w: major ? 2.4 : 1.4,
  h: major ? 11 : 6.5,
  col: db >= 0 ? RED : INK,
}))

const labels = VU_SCALE.map(([db]) => {
  const a = vuFractionToDeg(vuFraction(db))
  return {
    rot: `rotate(${a.toFixed(2)}deg)`,
    counter: `rotate(${(-a).toFixed(2)}deg)`,
    text: db > 0 ? `+${db}` : String(db),
    col: db >= 0 ? RED : INK,
  }
})

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
    class="vu-frame"
    :style="{ width: width + 'px', height: (NATIVE_H * scale).toFixed(1) + 'px' }"
    role="meter"
    aria-label="Gain reduction"
    :aria-valuenow="Math.abs(reductionDb).toFixed(1)"
    aria-valuemin="0"
    aria-valuemax="20"
  >
    <div class="vu-scaler" :style="{ transform: `scale(${scale})` }">
      <div class="vu-root">
        <div class="vu-brush" />
        <div class="vu-chrome" />
        <div class="vu-chrome-light" />
        <div class="vu-well">
          <div class="vu-face">
            <div class="vu-amber" />
            <div class="vu-paper" />
            <div class="vu-lamp" />
            <svg viewBox="0 0 356 200" class="vu-arc">
              <path d="M70.3 99 A145 145 0 0 1 225.7 59.1" :style="{ fill: 'none', stroke: INK, strokeWidth: '1.7px', strokeLinecap: 'round' }" />
              <path d="M225.7 59.1 A145 145 0 0 1 285.7 99" :style="{ fill: 'none', stroke: RED, strokeWidth: '3px', strokeLinecap: 'round' }" />
            </svg>
            <div v-for="(t, i) in ticks" :key="'t' + i" class="vu-arm" :style="{ height: '145px', transform: t.rot }">
              <div :style="{ position: 'absolute', top: 0, left: -t.w / 2 + 'px', width: t.w + 'px', height: t.h + 'px', background: t.col, borderRadius: '.5px' }" />
            </div>
            <div v-for="(l, i) in labels" :key="'n' + i" class="vu-arm" :style="{ height: '168px', transform: l.rot }">
              <div class="vu-num" :style="{ color: l.col, transform: l.counter }">{{ l.text }}</div>
            </div>
            <div class="vu-word">VU</div>
            <div class="vu-sub">METER</div>
            <div class="vu-needle-shadow" :style="{ transform: needleRot }" />
            <div class="vu-needle" :style="{ transform: needleRot }" />
            <div class="vu-pivot" />
            <div class="vu-glass" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vu-frame {
  position: relative; overflow: hidden; box-sizing: content-box; flex: 0 0 auto;
  border-bottom: 9px solid #a2a5a9; border-radius: 10px;
  box-shadow: 0 0 0 1px rgba(0,0,0,.7), 0 3px 8px rgba(0,0,0,.5);
}
.vu-scaler { position: absolute; left: 0; top: 0; width: 400px; height: 229px; transform-origin: 0 0; }
.vu-root {
  position: relative; width: 400px; height: 300px; border-radius: 20px;
  background: linear-gradient(180deg,#43464a 0%,#24262a 18%,#15161a 70%,#0b0c0e 100%);
  font-family: 'Archivo Narrow', Oswald, Helvetica, sans-serif;
}
.vu-brush { position: absolute; inset: 0; border-radius: 20px; pointer-events: none; background-image: repeating-linear-gradient(0deg,rgba(255,255,255,.022) 0 1px,rgba(0,0,0,.03) 1px 2px); }
.vu-chrome { position: absolute; inset: 0; border-radius: 20px; pointer-events: none; background: linear-gradient(180deg,#f6f6f4 0%,#d9dadc 10%,#aeb1b5 30%,#8c8f94 50%,#b9bbbe 70%,#e1e2e3 86%,#9da0a4 100%); box-shadow: inset 0 2px 0 rgba(255,255,255,.95), inset 0 -2px 3px rgba(0,0,0,.35), inset 0 0 0 1px rgba(0,0,0,.25); }
.vu-chrome-light { position: absolute; inset: 0; border-radius: 20px; pointer-events: none; background: radial-gradient(70% 40% at 30% 0%,rgba(255,255,255,.55),rgba(255,255,255,0) 70%), radial-gradient(60% 50% at 80% 100%,rgba(0,0,0,.18),rgba(0,0,0,0) 70%); }
.vu-well { position: absolute; inset: 15px; border-radius: 11px; background: #0a0b0c; box-shadow: 0 3px 8px rgba(0,0,0,.95) inset, 0 -1px 0 rgba(255,255,255,.06) inset, 0 1px 0 rgba(255,255,255,.08); }
.vu-face { position: absolute; left: 7px; right: 7px; top: 7px; height: 200px; border-radius: 5px; overflow: hidden; background: linear-gradient(175deg,#fbf6e8 0%,#f2ebd7 46%,#e2d8bd 100%); box-shadow: 0 2px 5px rgba(0,0,0,.6) inset; }
.vu-amber { position: absolute; inset: 0; background: radial-gradient(120% 90% at 50% 112%, rgba(255,214,120,.98) 0%, rgba(243,170,49,.96) 38%, rgba(214,126,22,.96) 72%, rgba(176,92,12,.96) 100%); }
.vu-paper { position: absolute; inset: 0; background-image: repeating-linear-gradient(0deg,rgba(90,70,40,.05) 0 1px,transparent 1px 3px), repeating-linear-gradient(90deg,rgba(90,70,40,.045) 0 1px,transparent 1px 3px); }
.vu-lamp { position: absolute; left: -14%; right: -14%; top: -46px; height: 96px; background: radial-gradient(46% 100% at 28% 100%, rgba(255,255,255,.62) 0%, rgba(255,255,255,.22) 45%, rgba(255,255,255,0) 78%), radial-gradient(46% 100% at 72% 100%, rgba(255,255,255,.58) 0%, rgba(255,255,255,.2) 45%, rgba(255,255,255,0) 78%); filter: blur(9px); }
.vu-arc { position: absolute; inset: 0; width: 100%; height: 100%; }
.vu-arm { position: absolute; left: 50%; bottom: 4px; width: 0; transform-origin: 50% 100%; }
.vu-num { position: absolute; top: -7px; left: -15px; width: 30px; text-align: center; font-size: 13.5px; font-weight: 600; letter-spacing: .02em; }
.vu-word { position: absolute; left: 0; right: 0; bottom: 44px; text-align: center; font-size: 19px; font-weight: 700; letter-spacing: .22em; color: #2a2420; text-indent: .22em; }
.vu-sub { position: absolute; left: 0; right: 0; bottom: 33px; text-align: center; font-size: 8.5px; font-weight: 600; letter-spacing: .32em; color: rgba(42,36,32,.62); text-indent: .32em; }
.vu-needle-shadow { position: absolute; left: calc(50% + 3px); bottom: 1px; width: 9px; margin-left: -4.5px; height: 150px; transform-origin: 50% 99%; background: rgba(48,36,22,.26); clip-path: polygon(43% 0%, 57% 0%, 100% 100%, 0% 100%); filter: blur(2px); }
.vu-needle { position: absolute; left: 50%; bottom: 4px; width: 9px; margin-left: -4.5px; height: 153px; transform-origin: 50% 100%; clip-path: polygon(43% 0%, 57% 0%, 100% 100%, 0% 100%); background: linear-gradient(90deg,#5b564e 0%,#1a1713 30%,#0e0c0a 52%,#2b2620 74%,#615b52 100%); }
.vu-pivot { position: absolute; left: 50%; bottom: -16px; margin-left: -18px; width: 36px; height: 36px; border-radius: 50%; background: radial-gradient(40% 36% at 33% 24%, #ffffff 0%, #e4e4e2 20%, #a9a9a7 48%, #6b6b69 72%, #313130 92%, #1c1c1b 100%); box-shadow: 0 3px 6px rgba(0,0,0,.55), 0 1px 0 rgba(255,255,255,.55) inset, 0 0 0 1.5px rgba(30,26,22,.35); }
.vu-glass { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(106deg, rgba(255,255,255,.34) 0%, rgba(255,255,255,.2) 24%, rgba(255,255,255,.03) 24.6%, rgba(255,255,255,.07) 100%); box-shadow: 0 0 40px rgba(60,44,20,.45) inset, 0 -14px 26px rgba(50,36,16,.16) inset; }
</style>
