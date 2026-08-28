<script setup>
/**
 * THE GLOBAL DETECTOR, for the focus targeting model.
 *
 * Threshold, Sharp, Depth and the cut ceiling — one set, applying everywhere,
 * with no partition to select first. The focus nodes are offsets FROM these and
 * live with the rail; see ResonanceFocusNode.
 *
 * ⚠ HARMONIC PROTECTION IS NOT HERE, and it was, until the row was rendered and
 * did not fit. It went to the targeting row rather than being shrunk, on its
 * own merits: "hold the harmonics below 5 kHz" is a statement about WHICH
 * FREQUENCIES TO LEAVE ALONE, which is what that row is for and is not what the
 * other three knobs do.
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
import Knob from '../knobs/Knob.vue'
import DeviceField from '../knobs/DeviceField.vue'

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
  <!-- CENTRED IN ITS TRACK. The block is narrower than the flex-1 slot the row
       gives it, and left-packed the leftover reads as a missing control at the
       end of the row rather than as spacing. The shipping panel does not have
       this problem because its zone plate has a visible background that fills
       the slot; a plate would be wrong here, since these are the effect's
       GLOBAL settings and a plate is what this panel uses to mean "one thing
       selected out of several". -->
  <div class="flex items-center justify-center gap-[9px]">
    <div class="w-[76px] shrink-0">
      <Knob
        :model-value="g.selectivity" @update:model-value="setGlobal('selectivity', $event)"
        :min="R.selectivity.min" :max="R.selectivity.max" :step="0.5" :value-font-px="11"
        label="Threshold" :accent="accent" :format-value="plain" :disabled="disabled"
        title="The detection threshold, everywhere. Focus nodes offset this — they do not replace it."
      />
    </div>
    <div class="w-[76px] shrink-0">
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
    <div class="w-[76px] shrink-0">
      <Knob
        :model-value="g.depth" @update:model-value="setGlobal('depth', $event)"
        :min="R.depth.min" :max="R.depth.max" :step="0.01" :value-font-px="11"
        label="Depth" :accent="accent" :format-value="pct" :disabled="disabled"
        title="How much of what is found gets removed."
      />
    </div>

    <div class="w-[62px] shrink-0">
      <!-- ⚠ GLOBAL, AND THIS IS THE ONE THING ZONES COULD SAY THAT FOCUS
           CANNOT. A bias moves a threshold; it cannot express a per-band
           CEILING, and the honest ceiling differs by band — 12 dB in the low
           mids is fine and the same 12 dB on sibilance is a lisp. Recorded as a
           real cost of the model rather than papered over. If listening misses
           it, the answer is an optional fourth node field, not a return to
           absolute per-band values. -->
      <DeviceField
        :model-value="g.maxCut" @update:model-value="setGlobal('maxCut', $event)"
        :min="R.maxCut.min" :max="R.maxCut.max" :step="1" label="Max Cut" unit="dB"
        :format-value="plain" :accent="accent" :disabled="disabled"
        title="Ceiling on any one cut, everywhere. A focus bias cannot express a per-band ceiling — see the note in the source."
      />
    </div>
  </div>
</template>
