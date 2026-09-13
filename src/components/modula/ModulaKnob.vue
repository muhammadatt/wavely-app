<script setup>
/**
 * The Modula knob, in the design's two sizes.
 *
 *   big    104 px cap in a 152 px frame, with a ring. `ring="leds"` is the
 *          kit's GAIN knob: LEDs that fill with the value. `ring="ticks"` is
 *          the kit's DRIVE knob: a sunk well with a 21-tick scale (majors
 *          every fifth), a collar around the cap and a dot pointer. A
 *          detented knob draws one tick per position instead.
 *   small  58 px, label above the value. Bare by default; either ring is
 *          available scaled down (88 px frame), so a small knob can read the
 *          same way as a big one.
 *
 * Continuous by default (`min`/`max`/`step`). Pass `options` for a detented
 * knob that clicks between named positions; `modelValue` is then the option's
 * `value` rather than a number. Everything about the drag is relative — see
 * useModulaDrag.
 */
import { computed } from 'vue'
import { glow } from './modulaTheme.js'
import { dragFraction, dragSteps, quantize } from './useModulaDrag.js'

const props = defineProps({
  modelValue: { type: [Number, String], required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 1 },
  step: { type: Number, default: 0 },
  /** [{ value, label, title? }] — makes the knob detented. */
  options: { type: Array, default: null },
  size: { type: String, default: 'small' }, // 'big' | 'small'
  color: { type: String, default: '#ff8b3d' },
  /** 'bar' | 'dot' — default: dot when detented, bar otherwise. */
  indicator: { type: String, default: null },
  /** 'leds' | 'ticks' | 'none'. Big default: ticks when detented, leds otherwise. Small default: none. */
  ring: { type: String, default: null },
  label: { type: String, default: '' },
  formatValue: { type: Function, default: null },
  caption: { type: String, default: '' },
  title: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const isBig = computed(() => props.size === 'big')
const detented = computed(() => Array.isArray(props.options) && props.options.length > 1)
const count = computed(() => detented.value ? props.options.length : 0)
const index = computed(() => detented.value
  ? Math.max(0, props.options.findIndex(o => o.value === props.modelValue))
  : -1)

const frac = computed(() => {
  if (detented.value) return index.value / (count.value - 1)
  const span = props.max - props.min
  if (!(span > 0)) return 0
  return Math.max(0, Math.min(1, (Number(props.modelValue) - props.min) / span))
})
const deg = computed(() => (-135 + 270 * frac.value).toFixed(1))

const indicatorMode = computed(() => props.indicator ?? (detented.value ? 'dot' : 'bar'))
const ringMode = computed(() => {
  if (!isBig.value) return props.ring === 'ticks' || props.ring === 'leds' ? props.ring : 'none'
  return props.ring ?? (detented.value ? 'ticks' : 'leds')
})
const framed = computed(() => isBig.value || ringMode.value !== 'none')

// Ring geometry, from the design. Big: 17 LEDs on a 66 px radius about the
// 152 px frame's centre, ticks on a 66 px arm. Small: the same picture scaled
// into an 88 px frame. A detented knob gets one LED / tick per position.
const GEO = computed(() => isBig.value
  ? { half: 76, ledR: 66, ledN: 17, led: 6, arm: 66, major: 10, minor: 6, tick: 9 }
  : { half: 44, ledR: 37, ledN: 13, led: 5, arm: 37, major: 7, minor: 4, tick: 6 })
const leds = computed(() => {
  const g = GEO.value
  const n = detented.value ? count.value : g.ledN
  return Array.from({ length: n }, (_, i) => {
    const f = i / (n - 1)
    const a = (-135 + 270 * f) * Math.PI / 180
    const on = f <= frac.value + 0.001
    return {
      left: `${(g.half + g.ledR * Math.sin(a)).toFixed(1)}px`,
      top: `${(g.half - g.ledR * Math.cos(a)).toFixed(1)}px`,
      width: `${g.led}px`, height: `${g.led}px`, margin: `-${g.led / 2}px 0 0 -${g.led / 2}px`,
      background: on ? props.color : '#2c3036',
      boxShadow: on ? `0 0 9px ${glow(props.color)}` : 'inset 0 1px 1px rgba(0,0,0,.6)',
    }
  })
})
// The kit's DRIVE scale: 21 ticks, every fifth a major. Detented: one per stop.
const ticks = computed(() => {
  const g = GEO.value
  const n = detented.value ? count.value : 21
  return Array.from({ length: n }, (_, i) => {
    const f = i / (n - 1)
    const h = detented.value ? g.tick : (i % 5 === 0 ? g.major : g.minor)
    return {
      arm: { transform: `rotate(${(45 + 270 * f).toFixed(1)}deg)`, height: `${g.arm}px` },
      mark: { height: `${h}px`, background: f <= frac.value + 0.001 ? props.color : 'rgba(255,255,255,.13)' },
    }
  })
})

const valueText = computed(() => {
  if (props.formatValue) return props.formatValue(props.modelValue)
  if (detented.value) return props.options[index.value]?.label ?? ''
  return String(props.modelValue)
})
const optionTitle = computed(() => detented.value ? (props.options[index.value]?.title ?? '') : '')

const enabled = () => !props.disabled
const down = computed(() => detented.value
  ? dragSteps(34, count.value, () => index.value, (i) => emit('update:modelValue', props.options[i].value), enabled)
  : dragFraction('y', isBig.value ? 180 : 150, () => frac.value, (f) => {
    emit('update:modelValue', quantize(props.min + f * (props.max - props.min), props.step))
  }, enabled))

const halo = computed(() => `0 0 ${isBig.value ? 12 : 8}px ${glow(props.color)}`)
</script>

<template>
  <div class="mk" :class="[isBig ? 'mk-big' : 'mk-small', { 'mk-disabled': disabled }]" :title="title || optionTitle">
    <div
      v-if="framed"
      class="mk-frame"
      :class="[isBig ? 'mk-frame-big' : 'mk-frame-sm', { 'mk-frame-well': ringMode === 'ticks' }]"
    >
      <template v-if="ringMode === 'leds'">
        <div v-for="(led, i) in leds" :key="i" class="mk-led" :style="led"></div>
      </template>
      <template v-else-if="ringMode === 'ticks'">
        <div v-for="(t, i) in ticks" :key="i" class="mk-tick" :style="t.arm">
          <div class="mk-tick-mark" :style="t.mark"></div>
        </div>
      </template>
      <div
        class="mk-cap"
        :class="[isBig ? 'mk-cap-big' : 'mk-cap-small', { 'mk-cap-collar': ringMode === 'ticks' }]"
        @pointerdown="down"
      >
        <div v-if="isBig" class="mk-cap-inner"></div>
        <div class="mk-rot" :class="{ 'mk-rot-snap': detented }" :style="{ transform: `rotate(${deg}deg)` }">
          <div
            v-if="indicatorMode === 'dot'"
            :class="isBig ? 'mk-dot' : 'mk-dot-small'"
            :style="{ background: color, boxShadow: halo }"
          ></div>
          <div
            v-else
            :class="isBig ? 'mk-bar' : 'mk-bar-small'"
            :style="{ background: color, boxShadow: halo }"
          ></div>
        </div>
      </div>
    </div>

    <!-- Bare small cap -->
    <div v-else class="mk-cap mk-cap-small" @pointerdown="down">
      <div class="mk-rot" :class="{ 'mk-rot-snap': detented }" :style="{ transform: `rotate(${deg}deg)` }">
        <div class="mk-bar-small" :style="{ background: color, boxShadow: halo }"></div>
      </div>
    </div>

    <div class="mk-read">
      <template v-if="isBig">
        <div class="mk-value-big">{{ valueText }}</div>
        <div v-if="label" class="mk-label">{{ label }}</div>
      </template>
      <template v-else>
        <div v-if="label" class="mk-label mk-label-tight">{{ label }}</div>
        <div class="mk-value-small">{{ valueText }}</div>
      </template>
      <div v-if="caption" class="mk-caption">{{ caption }}</div>
    </div>
  </div>
</template>

<style scoped>
.mk { display: flex; flex-direction: column; align-items: center; }
.mk-big { gap: 14px; }
.mk-small { gap: 10px; }
.mk-disabled { opacity: .38; }
.mk-disabled .mk-cap { cursor: default; }

.mk-frame { position: relative; display: grid; place-items: center; }
.mk-frame-big { width: 152px; height: 152px; }
.mk-frame-sm { width: 88px; height: 88px; }
.mk-frame-well {
  border-radius: 50%;
  background: radial-gradient(circle at 50% 40%, #24272c, #1d1f23);
  box-shadow: inset 0 3px 8px rgba(0,0,0,.7), inset 0 -1px 0 rgba(255,255,255,.04);
}
.mk-led { position: absolute; border-radius: 50%; }
.mk-tick { position: absolute; left: 50%; top: 50%; width: 2px; margin-left: -1px; transform-origin: 50% 0; }
.mk-tick-mark { position: absolute; bottom: 0; left: 0; width: 2px; border-radius: 1px; }

.mk-cap { position: relative; border-radius: 50%; cursor: grab; touch-action: none; user-select: none; }
.mk-cap:active { cursor: grabbing; }
.mk-cap-big {
  width: 104px; height: 104px;
  background: linear-gradient(160deg, #454a52 0%, #2c3036 52%, #1c1e22 100%);
  box-shadow: 0 18px 28px -14px rgba(0,0,0,.95), inset 0 2px 2px rgba(255,255,255,.10), inset 0 -8px 14px rgba(0,0,0,.55), 0 0 0 1px rgba(0,0,0,.7);
}
/* The kit's DRIVE cap sits in a collar — a second ring of the well's own
   colour between the cap and the scale. */
.mk-cap-big.mk-cap-collar {
  box-shadow: 0 18px 28px -14px rgba(0,0,0,.95), inset 0 2px 2px rgba(255,255,255,.10), inset 0 -8px 14px rgba(0,0,0,.55), 0 0 0 1px rgba(0,0,0,.7), 0 0 0 6px #24272c, 0 0 0 7px rgba(0,0,0,.6);
}
.mk-cap-small.mk-cap-collar {
  box-shadow: 0 12px 20px -10px rgba(0,0,0,.9), inset 0 1px 1px rgba(255,255,255,.10), 0 0 0 1px rgba(0,0,0,.65), 0 0 0 4px #24272c, 0 0 0 5px rgba(0,0,0,.6);
}
.mk-cap-inner {
  position: absolute; inset: 12px; border-radius: 50%;
  background: linear-gradient(160deg, #3b4047, #24272c);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.07);
}
.mk-cap-small {
  width: 58px; height: 58px;
  background: linear-gradient(160deg, #3e4249 0%, #282b30 55%, #1d1f23 100%);
  box-shadow: 0 12px 20px -10px rgba(0,0,0,.9), inset 0 1px 1px rgba(255,255,255,.10), 0 0 0 1px rgba(0,0,0,.65);
}
.mk-rot { position: absolute; inset: 0; }
.mk-rot-snap { transition: transform .12s cubic-bezier(.3,1.5,.5,1); }
.mk-bar { position: absolute; left: 50%; top: 16px; width: 4px; height: 26px; margin-left: -2px; border-radius: 3px; }
.mk-dot { position: absolute; left: 50%; top: 15px; width: 7px; height: 7px; margin-left: -3.5px; border-radius: 50%; }
.mk-bar-small { position: absolute; left: 50%; top: 8px; width: 3px; height: 14px; margin-left: -1.5px; border-radius: 2px; }

.mk-read { display: flex; flex-direction: column; align-items: center; gap: 5px; }
.mk-small .mk-read { gap: 6px; }
.mk-label { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: .26em; color: #79808a; white-space: nowrap; }
.mk-label-tight { letter-spacing: .18em; }
.mk-value-big { font-family: 'JetBrains Mono', monospace; font-size: 19px; color: #e8edf3; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mk-value-small { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #aeb5be; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mk-caption { max-width: 80px; text-align: center; font-family: 'JetBrains Mono', monospace; font-size: 9px; line-height: 1.4; color: #565d66; }
</style>
