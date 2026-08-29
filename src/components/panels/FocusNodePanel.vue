<script setup>
/**
 * The floating editor for one focus node, opened by clicking it on the plot.
 *
 * ⚠ IT EXISTS BECAUSE WIDTH HAD ONLY A WHEEL. Frequency and amount are on the
 * drag, which is the right gesture for setting them by ear; width was left on
 * the wheel alone, and a wheel is a poor control on a trackpad and no control
 * at all for anyone driving by keyboard or touch. A node's three numbers are
 * now typeable, and the two things you can only do to a node — change its shape
 * and delete it — are here rather than nowhere.
 *
 * ⚠ HTML, NOT CANVAS, AND THAT IS THE POINT. The plot draws the node; this
 * edits it. Real inputs bring focus, selection, typing, tab order and a screen
 * reader's understanding of a spin button for free, none of which a canvas has.
 *
 * It floats over the plot rather than sitting under it, which is what keeps the
 * panel's chrome from growing back: the whole reason the rail and the plate row
 * were deleted is that a control surface beside the picture is a second thing
 * to cross-reference. A card that appears on the node you clicked and closes
 * again is not that.
 */
import { computed } from 'vue'
import { RESONANCE_FOCUS_RANGES } from '../../audio/resonanceFocus.js'
import { bright, tint } from '../../ui/accent.js'
import DeviceField from '../knobs/DeviceField.vue'

const props = defineProps({
  node: { type: Object, required: true },
  index: { type: Number, required: true },
  count: { type: Number, default: 1 },
  /** Auditioning this node's region alone. Monitoring state, never a parameter. */
  solo: { type: Boolean, default: false },
  accent: { type: String, default: '#8de0a8' },
})

const emit = defineEmits(['patch', 'delete', 'close', 'solo'])

const R = RESONANCE_FOCUS_RANGES

const SHAPES = [
  { id: 'bell', label: 'BELL', title: 'Work harder around this frequency.' },
  { id: 'low', label: 'LOW', title: 'Work harder on everything BELOW this frequency. A wide bell cannot say this — it falls away on both sides.' },
  { id: 'high', label: 'HIGH', title: 'Work harder on everything ABOVE this frequency.' },
]

const shape = computed(() => props.node.shape ?? 'bell')
const bypassed = computed(() => props.node.enabled === false)

const hz = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k` : String(Math.round(v)))
const oct = v => (v < 1 ? `${(v * 12).toFixed(0)}st` : `${v.toFixed(2)}oct`)
const signedDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`

/** Width means "transition" on a shelf and "spread" on a bell — so say which. */
const widthLabel = computed(() => (shape.value === 'bell' ? 'Width' : 'Slope'))

function chip(on, warn = false) {
  const ink = warn ? '#ffb27a' : props.accent
  return {
    font: `600 8px 'JetBrains Mono',monospace`,
    letterSpacing: '.1em',
    color: on ? (warn ? ink : bright(ink)) : 'rgba(255,255,255,.4)',
    background: on ? (warn ? 'rgba(255,178,122,.14)' : tint(ink, 0.14)) : 'rgba(255,255,255,.03)',
    boxShadow: on
      ? `inset 0 0 0 1px ${warn ? 'rgba(255,178,122,.5)' : tint(ink, 0.5)}`
      : 'inset 0 0 0 1px rgba(255,255,255,.07)',
  }
}
</script>

<template>
  <div
    class="rounded-[10px] px-[10px] py-[8px]"
    style="width:268px;background:rgba(14,18,20,.96)"
    :style="{ boxShadow: `inset 0 0 0 1px ${tint(accent, 0.28)}, 0 8px 24px rgba(0,0,0,.6)` }"
    role="group"
    :aria-label="`Focus node ${index + 1} of ${count}`"
    @keydown.esc.stop="emit('close')"
    @pointerdown.stop
    @dblclick.stop
    @wheel.stop
  >
    <div class="flex items-center justify-between mb-[7px]">
      <span
        style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.12em"
        :style="{ color: bright(accent) }"
      >FOCUS {{ index + 1 }} OF {{ count }}</span>
      <button
        type="button"
        class="px-[5px] leading-none rounded"
        style="font:600 11px 'JetBrains Mono',monospace;color:rgba(255,255,255,.45)"
        aria-label="Close"
        title="Close (Esc)"
        @click="emit('close')"
      >×</button>
    </div>

    <div class="flex items-start gap-[7px]">
      <DeviceField
        :model-value="node.hz" :min="R.hz.min" :max="R.hz.max" :step="1"
        label="Freq" unit="Hz" :format-value="hz" :accent="accent" :width="66"
        @update:model-value="emit('patch', { hz: $event })"
      />
      <!-- ⚠ "WIDTH", NEVER "Q". Q belongs to a filter and this is not one — it
           is an area of attention. It is also NOT the same axis as the global
           Sharp knob: sharpness says what shape counts as a resonance, this
           says where you are looking. -->
      <DeviceField
        :model-value="node.spanOct" :min="R.spanOct.min" :max="R.spanOct.max" :step="0.05"
        :label="widthLabel" :format-value="oct"
        :parse="t => (/st$/i.test(t) ? parseFloat(t) / 12 : parseFloat(t))"
        :accent="accent" :width="66"
        @update:model-value="emit('patch', { spanOct: $event })"
      />
      <DeviceField
        :model-value="node.biasDb" :min="R.biasDb.min" :max="R.biasDb.max" :step="0.5"
        label="Amount" unit="dB" :format-value="signedDb" :accent="accent" :width="66"
        @update:model-value="emit('patch', { biasDb: $event })"
      />
    </div>

    <div class="flex items-center gap-[4px] mt-[8px]">
      <button
        v-for="s in SHAPES"
        :key="s.id"
        type="button"
        class="px-[7px] py-[3px] rounded-full"
        :aria-pressed="String(shape === s.id)"
        :title="s.title"
        :style="chip(shape === s.id)"
        @click="emit('patch', { shape: s.id })"
      >{{ s.label }}</button>

      <span class="flex-1"></span>

      <!-- ⚠ DELTA IS A MONITORING STATE AND MUST NEVER BECOME A PARAMETER. It
           is drawn in amber rather than the accent for exactly the reason the
           zone panel drew its own that way: bypass is stored and rendered, this
           is not, and two identical lamps would say they were the same kind of
           control. -->
      <button
        type="button"
        class="px-[7px] py-[3px] rounded-full"
        :aria-pressed="String(solo)"
        title="Hear only what this node's region is removing. Monitoring only — Apply always renders the processed audio."
        :style="chip(solo, true)"
        @click="emit('solo')"
      >DELTA</button>
      <button
        type="button"
        class="px-[7px] py-[3px] rounded-full"
        :aria-pressed="String(bypassed)"
        title="Bypass this node. It keeps its position and its settings."
        :style="chip(bypassed, true)"
        @click="emit('patch', { enabled: bypassed })"
      >{{ bypassed ? 'BYP' : 'ON' }}</button>
      <button
        type="button"
        class="px-[7px] py-[3px] rounded-full"
        title="Delete this node"
        style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.1em;
               color:rgba(255,255,255,.4);box-shadow:inset 0 0 0 1px rgba(255,255,255,.07)"
        @click="emit('delete')"
      >DEL</button>
    </div>
  </div>
</template>
