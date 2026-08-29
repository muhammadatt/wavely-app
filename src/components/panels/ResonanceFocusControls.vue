<script setup>
/**
 * THE GLOBAL DETECTOR, for the focus targeting model.
 *
 * Threshold, Sharp, Depth and the cut ceiling — one set, applying everywhere,
 * with no partition to select first. The focus nodes are offsets FROM these and
 * live with the rail; see ResonanceFocusNode.
 *
 * ⚠ MAX CUT HAS NO CONTROL, AND THAT IS THE PRECEDENT RATHER THAN A FUDGE. Ten
 * controls do not fit one 688 px row; the shipping zone panel hit the identical
 * wall and resolved it the same way — "collapsing them cost two settings... the
 * SOFT/HARD knee switch and the per-zone Max Cut. Both remain parameters at
 * their stock values; only the controls are gone." `maxCut` is still a
 * parameter, still in the patch, still honoured by the kernel.
 *
 * ⚠ THE EXISTENCE OF THIS BLOCK IS THE MODEL'S MAIN CLAIM. Under zones the same
 * settings are per-zone with no global value at all, so the panel can only ever
 * show one partition's numbers and there is no answer at all to "what is this
 * effect doing, broadly?". Here that is the first thing on the row, and every
 * departure from it is visible as an excursion on the rail above.
 *
 * It occupies the slot ResonanceZoneControls occupies under the shipping model,
 * and it is deliberately about the same width: an A/B between two targeting
 * models should not also be an A/B between two panel layouts.
 */
import { computed } from 'vue'
import { RESONANCE_FOCUS_RANGES } from '../../audio/resonanceFocus.js'
import { bright, tint } from '../../ui/accent.js'
import Knob from '../knobs/Knob.vue'
import DeviceField from '../knobs/DeviceField.vue'

const props = defineProps({
  focus: { type: Object, required: true },
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
const g = computed(() => props.focus.global)

function setGlobal(name, value) {
  emit('update:focus', { ...props.focus, global: { ...g.value, [name]: value } })
}

const hz = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k` : String(Math.round(v)))
const plain = v => v.toFixed(0)
const pct = v => `${Math.round(v * 100)}%`
</script>

<template>
  <!-- Ordered as the detector reads: the threshold, then what counts as a
       resonance, then how much of what is found gets removed.
       ⚠ THE LABELS ARE THE SHIPPING PANEL'S — Threshold / Sharp / Depth, the
       same three words ResonanceZoneControls uses for the same three settings.
       An A/B between two targeting models must not also be an A/B between two
       vocabularies. They are also short enough to fit a 58 px knob: rendered at
       full length, "Sensitivity" and "Sharpness" overlapped their neighbours
       and the row was unreadable. -->
  <!-- CENTRED IN ITS TRACK. The block is narrower than the flex-1 slot the row
       gives it, and left-packed the leftover reads as a missing control at the
       end of the row rather than as spacing. The shipping panel does not have
       this problem because its zone plate has a visible background that fills
       the slot; a plate would be wrong here, since these are the effect's
       GLOBAL settings and a plate is what this panel uses to mean "one thing
       selected out of several". -->
  <div class="flex items-center justify-center gap-[9px]">
    <div class="w-[68px] shrink-0">
      <Knob
        :model-value="g.selectivity" @update:model-value="setGlobal('selectivity', $event)"
        :min="R.selectivity.min" :max="R.selectivity.max" :step="0.5" :value-font-px="11"
        label="Threshold" :accent="accent" :format-value="plain" :disabled="disabled"
        title="The global detection threshold. Use focus nodes to offset this."
      />
    </div>
    <div class="w-[68px] shrink-0">
      <!-- ⚠ GLOBAL, AND THAT IS THE DESIGN RATHER THAN A SIMPLIFICATION.
           Sharpness says WHAT SHAPE counts as a resonance — a property of the
           detector. A node's Width says WHERE you are paying attention — a
           property of the map. Keeping them on different axes is what stops the
           panel having to explain "node Q versus sharpness", which is the
           question that sinks every node-style resonance suppressor.

           It is also what keeps the kernel on its uniform fast path: the
           reference envelope's scale is a property of the whole transform, so
           each DISTINCT sharpness costs one more inverse FFT per frame. One
           value means one envelope, always. -->
      <Knob
        :model-value="g.sharpness" @update:model-value="setGlobal('sharpness', $event)"
        :min="R.sharpness.min" :max="R.sharpness.max" :step="0.01" :value-font-px="11"
        label="Sharp" :accent="accent" :format-value="pct" :disabled="disabled"
        title="What shape counts as a resonance. Not a node width."
      />
    </div>
    <div class="w-[68px] shrink-0">
      <Knob
        :model-value="g.depth" @update:model-value="setGlobal('depth', $event)"
        :min="R.depth.min" :max="R.depth.max" :step="0.01" :value-font-px="11"
        label="Depth" :accent="accent" :format-value="pct" :disabled="disabled"
        title="How much of what is found gets removed."
      />
    </div>

    <!-- HARMONIC PROTECTION: GLOBAL, WITH A CEILING, replacing the per-zone
         flag — and it loses nothing measured. The flag existed for one reason:
         the mask blocks 67-88% of every octave from 60 Hz to 20 kHz, which is
         real protection down where partials are widely spaced and a blanket
         veto up where sibilance lives, so "protect the fundamental region, work
         freely above 5 kHz" was the setting the effect most wanted and could
         not express while the mask was global.

         That is a statement about a FREQUENCY, not about a partition. One
         switch and one ceiling say it directly, and say the same thing on every
         file — where a per-zone flag says it only if the zones happen to be
         placed somewhere sensible on this particular voice. -->
    <div class="flex items-center gap-[7px] shrink-0">
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
           layout: the slot keeps its width either way, so switching protection
           on does not shove the row sideways. -->
      <span class="block" style="width:62px">
        <DeviceField
          v-if="g.protect"
          :model-value="g.protectCeilHz" @update:model-value="setGlobal('protectCeilHz', $event)"
          :min="R.protectCeilHz.min" :max="R.protectCeilHz.max" :step="50" log
          label="Up to" unit="Hz" :format-value="hz"
          :accent="accent" :disabled="disabled" :width="62"
        />
      </span>
    </div>
  </div>
</template>
