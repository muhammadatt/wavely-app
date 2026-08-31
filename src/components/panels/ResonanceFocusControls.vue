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

const props = defineProps({
  focus: { type: Object, required: true },
    accent: { type: String, default: '#8de0a8' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:focus'])

const R = RESONANCE_FOCUS_RANGES
const g = computed(() => props.focus.global)

function setGlobal(name, value) {
  emit('update:focus', { ...props.focus, global: { ...g.value, [name]: value } })
}

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
  <!-- ⚠ ON A PLATE, AND THE ARGUMENT AGAINST ONE WAS WRONG. It was left
       unplated on the reasoning that a plate is what this panel uses to mean
       "one thing selected out of several", which these are not. True of the
       zone plate's PURPOSE and beside the point about its EFFECT: without a
       background the three knobs float in a flex-1 slot wider than they are,
       and centring them only moves the gap to both ends — reported as looking
       off-centre, which is what a group with no edges in a track it does not
       fill always looks like. The plate is the same one ResonanceZoneControls
       wears, so the row reads the same under either model.

       HARMONICS STAYS OUTSIDE IT. The plate is the detector — the three
       settings that decide what counts as a resonance and how much of it goes.
       Harmonic protection is a statement about which frequencies to leave
       alone, which is targeting, and it is the one targeting rule that is not
       a node. Different kind of thing, so it sits beside the box rather than
       in it. -->
  <div class="flex items-center justify-center gap-[10px]">
    <div
      class="flex items-center gap-[9px] rounded-[7px] px-[10px] py-[9px]"
      :style="{
        background: 'rgba(0,0,0,.28)',
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 20%, transparent)`,
        opacity: disabled ? 0.4 : 1,
      }"
    >
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
    </div>

    <!-- ⚠ HARMONIC PROTECTION MOVED TO THE PANEL HEADER, and its CEILING went
         with it — as a number in the button's tooltip rather than as a control.
         Both were here inside a `hidden` wrapper, so neither had been reachable
         for some time; moving the switch is what made that visible.

         The switch is global with a ceiling because the flag it replaced was per
         zone, and it loses nothing measured: the mask blocks 67-88% of every
         octave from 60 Hz to 20 kHz, which is real protection down where
         partials are widely spaced and a blanket veto up where sibilance lives.
         "Protect the fundamental region, work freely above 5 kHz" is the setting
         the effect most wants, and that is a statement about a FREQUENCY rather
         than about a partition — one switch and one ceiling say it directly, and
         say the same thing on every file, where a per-zone flag says it only if
         the zones happen to be placed sensibly on this particular voice.

         ⚠ `protectCeilHz` IS THEREFORE PINNED AT ITS DEFAULT, 5000 Hz. It is
         still a parameter and the kernel still reads it; nothing sets it. If it
         earns a control again it belongs beside the switch, not back here — this
         plate is the DETECTOR, three knobs describing one decision, and a
         frequency bound is a different kind of statement. -->
  </div>
</template>
