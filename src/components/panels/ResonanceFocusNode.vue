<script setup>
/**
 * The selected focus node's three numbers, and the arithmetic behind them.
 *
 * ⚠ IT SITS WITH THE RAIL, NOT WITH THE DETECTOR KNOBS, and that placement is
 * the model rather than a layout convenience. The rail and this plate are one
 * control split by what they edit — the rail owns WHERE a node is (frequency
 * and amount are positions on it), this owns the exact values and the width. The
 * global detector belongs in the row below with the rest of the effect-wide
 * settings, which is where a reader looks for "what is this thing doing,
 * broadly".
 *
 * Same division the panel already draws between the spectrum plot and the zone
 * controls under it, applied to a different pair.
 *
 * ⚠ HARMONIC PROTECTION SITS HERE TOO, and it is not a leftover. "Hold the
 * harmonics of the voice below 5 kHz" is a statement about WHICH FREQUENCIES TO
 * LEAVE ALONE — the same kind of statement a node makes, and the only targeting
 * rule in this model that is not a node. It began on the detector row with the
 * three global knobs and moved when that row was RENDERED and overflowed by
 * about 56 px; the move is kept because the row it moved to is where it belongs,
 * not because the other one was full.
 */
import { computed } from 'vue'
import { RESONANCE_FOCUS_MAX_NODES, RESONANCE_FOCUS_RANGES, focusSelectivityAt }
  from '../../audio/resonanceFocus.js'
import { setNodeParam, toggleNode } from '../meters/resonanceFocusRail.js'
import { bright, tint } from '../../ui/accent.js'
import DeviceField from '../knobs/DeviceField.vue'

const props = defineProps({
  focus: { type: Object, required: true },
  /** Which node this is editing, or -1. */
  selected: { type: Number, default: -1 },
  /**
   * The pitch range the protection mask searches, for the caption. Fixed rather
   * than chosen — see HARMONIC_PITCH_RANGE.
   */
  pitchRangeCaption: { type: String, default: '' },
  accent: { type: String, default: '#8de0a8' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:focus'])

const R = RESONANCE_FOCUS_RANGES
const nodes = computed(() => props.focus.nodes ?? [])
const node = computed(() => nodes.value[props.selected] ?? null)

function setGlobal(name, value) {
  emit('update:focus', { ...props.focus, global: { ...props.focus.global, [name]: value } })
}

function setNodes(next) {
  if (next !== nodes.value) emit('update:focus', { ...props.focus, nodes: next })
}

function setNode(name, value) {
  setNodes(setNodeParam(nodes.value, props.selected, name, value))
}

/**
 * THE SUM, PRINTED. This is the answer to "do nodes override the global
 * settings or add to them?" — not a rule in a tooltip that has to be
 * remembered, but the arithmetic on screen at the frequency being edited.
 * `SENS 12 = 20 − 8` cannot be misread as an override, because both terms are
 * visibly present and visibly different quantities.
 *
 * ⚠ `clamped` matters more than it looks. Past the end of the range the field
 * keeps accepting numbers and the sound stops changing, which is
 * indistinguishable from a broken control. Saying "at the limit" is the
 * difference between a bound and a bug.
 */
const sum = computed(() => (node.value ? focusSelectivityAt(props.focus, node.value.hz) : null))

const g = computed(() => props.focus.global)
const hz = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k` : String(Math.round(v)))
const oct = v => (v < 1 ? `${(v * 12).toFixed(0)}st` : `${v.toFixed(2)}oct`)
const signedDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`
</script>

<template>
  <!-- ⚠ TWO ROOTS ON ONE ROW: the plate flexes, the protection block does not.
       The wrapper is the caller's, so this component's own `class` from the
       parent lands on the plate — which is why the plate keeps `flex-1` here
       rather than relying on the parent. -->
  <!-- Fixed height whether or not a node is selected. A block that appears and
       disappears moves everything under it on a click, and selecting a node is
       the most frequent gesture on this panel. -->
  <div
    class="flex flex-1 min-w-0 items-center gap-[10px] rounded-[9px] px-[10px]"
    style="height:44px"
    :style="{
      background: 'rgba(255,255,255,.025)',
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.05)',
      opacity: disabled ? 0.45 : 1,
    }"
  >
    <span
      v-if="!node"
      style="font:500 9px 'JetBrains Mono',monospace;letter-spacing:.1em;color:rgba(255,255,255,.3)"
    >
      <!-- Says what the patch IS, not only what is missing. With no nodes the
           effect is one global setting applied everywhere, which is a complete
           and valid patch rather than an unfinished one — and it is the default,
           so this is the first thing anyone reads here. -->
      {{ nodes.length
        ? 'SELECT A NODE ON THE RAIL'
        : 'NO FOCUS NODES — THE DETECTOR RUNS AT ITS GLOBAL SETTING EVERYWHERE' }}
    </span>

    <template v-else>
      <span class="flex flex-col gap-[2px] shrink-0" style="min-width:132px">
        <span
          style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.12em"
          :style="{ color: bright(accent) }"
        >FOCUS {{ selected + 1 }} OF {{ nodes.length }}</span>
        <span
          style="font:500 8.5px 'JetBrains Mono',monospace;color:rgba(255,255,255,.42)"
          :title="`Global threshold ${sum.global}, offset by this node's ${sum.bias.toFixed(1)} dB of focus`"
        >THRESH {{ sum.effective.toFixed(1) }} = {{ sum.global.toFixed(0) }}
          {{ sum.bias >= 0 ? '−' : '+' }} {{ Math.abs(sum.bias).toFixed(1) }}</span>
      </span>

      <span
        v-if="sum.clamped"
        class="shrink-0 px-[6px] py-[2px] rounded-full"
        style="font:600 7.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:#ffb27a;
               background:rgba(255,178,122,.12)"
        title="The sum ran past the end of the sensitivity range. Turning this node further will not change the sound."
      >AT THE LIMIT</span>

      <DeviceField
        :model-value="node.hz" @update:model-value="setNode('hz', $event)"
        :min="R.hz.min" :max="R.hz.max" :step="1" label="Freq" unit="Hz"
        :format-value="hz" :accent="accent" :disabled="disabled" :width="58"
      />
      <!-- ⚠ "WIDTH", NEVER "Q". Q belongs to a filter and this is not one — it
           is an area of attention, and the label is the cheapest place to stop
           the parametric-EQ reading and the costliest one to get wrong. It is
           also NOT the same axis as the global Sharpness knob: sharpness says
           what shape counts as a resonance, this says where you are looking. -->
      <DeviceField
        :model-value="node.spanOct" @update:model-value="setNode('spanOct', $event)"
        :min="R.spanOct.min" :max="R.spanOct.max" :step="0.05" label="Width"
        :format-value="oct"
        :parse="t => (/st$/i.test(t) ? parseFloat(t) / 12 : parseFloat(t))"
        :accent="accent" :disabled="disabled" :width="58"
      />
      <DeviceField
        :model-value="node.biasDb" @update:model-value="setNode('biasDb', $event)"
        :min="R.biasDb.min" :max="R.biasDb.max" :step="0.5" label="Amount" unit="dB"
        :format-value="signedDb" :accent="accent" :disabled="disabled" :width="58"
      />

      <button
        type="button"
        class="px-[7px] py-[3px] rounded-full shrink-0"
        :aria-pressed="String(node.enabled === false)"
        title="Bypass this node. It keeps its position and its settings."
        :style="{
          font: `600 8px 'JetBrains Mono',monospace`,
          letterSpacing: '.1em',
          color: node.enabled === false ? '#ffb27a' : 'rgba(255,255,255,.36)',
          background: node.enabled === false ? 'rgba(255,178,122,.12)' : 'rgba(255,255,255,.03)',
          boxShadow: node.enabled === false
            ? 'inset 0 0 0 1px rgba(255,178,122,.45)'
            : 'inset 0 0 0 1px rgba(255,255,255,.06)',
        }"
        :disabled="disabled"
        @click="setNodes(toggleNode(nodes, selected))"
      >{{ node.enabled === false ? 'BYPASSED' : 'BYPASS' }}</button>

      <span
        class="ml-auto shrink-0"
        style="font:500 8px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.22)"
      >{{ nodes.length }}/{{ RESONANCE_FOCUS_MAX_NODES }}</span>
    </template>
  </div>

  <!-- The one targeting rule that is not a node. GLOBAL, WITH A CEILING,
       replacing the per-zone flag — and it loses nothing measured. The flag
       existed for one reason: the mask blocks 67-88% of every octave from
       60 Hz to 20 kHz, which is real protection down where partials are widely
       spaced and a blanket veto up where sibilance lives, so "protect the
       fundamental region, work freely above 5 kHz" was the setting the effect
       most wanted and could not express while the mask was global.

       That is a statement about a FREQUENCY, not about a partition. One switch
       and one ceiling say it directly, and say the same thing on every file —
       where a per-zone flag says it only if the zones happen to be placed
       somewhere sensible on this particular voice. -->
  <div class="flex items-center gap-[7px] shrink-0 ml-[10px]">
    <button
      type="button"
      class="px-[9px] py-[5px] rounded-full"
      :aria-pressed="String(g.protect)"
      :title="`Hold the harmonics of the tracked voice, below the ceiling. Pitch range ${pitchRangeCaption}.`"
      :style="{
        font: `600 8px 'JetBrains Mono',monospace`,
        letterSpacing: '.1em',
        color: g.protect ? bright(accent) : 'rgba(255,255,255,.36)',
        background: g.protect ? tint(accent, 0.14) : 'rgba(255,255,255,.03)',
        boxShadow: g.protect
          ? `inset 0 0 0 1px ${tint(accent, 0.5)}`
          : 'inset 0 0 0 1px rgba(255,255,255,.06)',
      }"
      :disabled="disabled"
      @click="setGlobal('protect', !g.protect)"
    >HARMONICS</button>
    <!-- The ceiling only exists while the mask does, and hiding it costs no
         layout: the slot keeps its width either way, so switching protection on
         does not shove the row sideways. -->
    <span class="block" style="width:62px">
      <DeviceField
        v-if="g.protect"
        :model-value="g.protectCeilHz" @update:model-value="setGlobal('protectCeilHz', $event)"
        :min="R.protectCeilHz.min" :max="R.protectCeilHz.max" :step="50"
        label="Up to" unit="Hz" :format-value="hz"
        :accent="accent" :disabled="disabled" :width="62"
      />
    </span>
  </div>
</template>
