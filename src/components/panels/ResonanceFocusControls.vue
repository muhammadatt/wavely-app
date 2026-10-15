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
import ModulaKnob from '../modula/ModulaKnob.vue'
import { RESONANCE_FOCUS_GLOBAL } from '../../audio/resonanceFocus.js'

const props = defineProps({
  focus: { type: Object, required: true },
  accent: { type: String, default: 'var(--m-accent)' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:focus'])

const R = RESONANCE_FOCUS_RANGES
/** Double-click resets to the stock global, the one every factory patch starts from. */
const DEF = RESONANCE_FOCUS_GLOBAL
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
       vocabularies.

       The plate is the Modula panel ResoTame's control row sits on, so this
       group carries no background of its own — the rules either side of it in
       that row are what mark it as the detector. HARMONICS STAYS OUTSIDE IT:
       harmonic protection is a statement about which frequencies to leave
       alone, which is targeting rather than detection. -->
  <div class="rfc" :class="{ 'is-disabled': disabled }">
    <ModulaKnob
      variant="small" :size="44" show-value editable
      :model-value="g.selectivity" :min="R.selectivity.min" :max="R.selectivity.max" :step="0.5"
      :default-value="DEF?.selectivity ?? null"
      label="Threshold" :color="accent" :format-value="plain" :disabled="disabled"
      title="The global detection threshold. Use focus nodes to offset this. Double-click to reset"
      @update:model-value="setGlobal('selectivity', $event)"
    />
    <!-- ⚠ GLOBAL, AND THAT IS THE DESIGN RATHER THAN A SIMPLIFICATION.
         Sharpness says WHAT SHAPE counts as a resonance — a property of the
         detector. A node's Width says WHERE you are paying attention — a
         property of the map. It is also what keeps the kernel on its uniform
         fast path: one sharpness means one reference envelope. -->
    <ModulaKnob
      variant="small" :size="44" show-value editable :parse-value="t => parseFloat(t) / 100"
      :model-value="g.sharpness" :min="R.sharpness.min" :max="R.sharpness.max" :step="0.01"
      :default-value="DEF?.sharpness ?? null"
      label="Sharp" :color="accent" :format-value="pct" :disabled="disabled"
      title="What shape counts as a resonance. Not a node width. Double-click to reset"
      @update:model-value="setGlobal('sharpness', $event)"
    />
    <ModulaKnob
      variant="small" :size="44" show-value editable :parse-value="t => parseFloat(t) / 100"
      :model-value="g.depth" :min="R.depth.min" :max="R.depth.max" :step="0.01"
      :default-value="DEF?.depth ?? null"
      label="Depth" :color="accent" :format-value="pct" :disabled="disabled"
      title="How much of what is found gets removed. Double-click to reset"
      @update:model-value="setGlobal('depth', $event)"
    />

    <!-- ⚠ MAX CUT AND THE HARMONIC CEILING HAVE NO CONTROL HERE. `maxCut` is
         still a parameter at its stock value (the row has no room for it, the
         same call the zone panel made), and `protectCeilHz` lives beside the
         harmonic switch on the panel, not on this plate: a frequency bound is
         a different kind of statement from the three knobs of one decision. -->
  </div>
</template>

<style scoped>
.rfc {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 14px;
}
.rfc.is-disabled { opacity: .5; }
</style>
