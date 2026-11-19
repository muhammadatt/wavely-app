<script setup>
import { usePeakNormalize, PEAK_TARGET_DEFAULT_DB as TARGET_DEFAULT_DB } from '../../../composables/usePeakNormalize.js'
import FloatingWindow from '../FloatingWindow.vue'
import ModulaKnob from '../../modula/ModulaKnob.vue'

defineProps({ z: { type: Number, default: 500 } })

const { targetPeak, apply } = usePeakNormalize()

const ACCENT = '#e8a33d'

function formatDb(v) {
  return v.toFixed(1)
}
const formatTarget = v => `${formatDb(v)} dB`
</script>

<template>
  <FloatingWindow
    window-id="normalize"
    :z="z"
    :width="380"
    :accent="ACCENT"
    design="modula"
    brand-lead="PEAK"
    brand-tail="NORMALIZE"
    :show-engage="false"
    show-preview
    :previewable="false"
    show-apply
    @apply="apply()"
  >
    <!-- One parameter, so it carries the face: the kit's large tick-ring knob
         rather than a lone slider adrift in the panel. -->
    <div class="pn-panel">
      <ModulaKnob
        data-help="target-peak"
        variant="ticks" :size="156" show-value editable
        v-model="targetPeak" :min="-12" :max="0" :step="0.5" :default-value="TARGET_DEFAULT_DB"
        label="Target Peak" :color="ACCENT" :format-value="formatTarget"
        title="Where the selection's loudest peak lands. Double-click to reset; click the value to type one"
      />
      <p class="pn-note">
        Scales the selection so its loudest peak lands at
        <span class="pn-value">{{ formatDb(targetPeak) }} dBFS</span>.
      </p>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.pn-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 20px 18px 16px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.pn-note {
  margin: 0;
  text-align: center;
  font: 500 10.5px/1.5 var(--m-font-ui);
  color: var(--m-ink-4);
}
.pn-value {
  font-family: var(--m-font-mono);
  color: var(--m-accent);
  white-space: nowrap;
}
</style>
