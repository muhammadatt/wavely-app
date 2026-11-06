<script setup>
/**
 * Noise Reduction.
 *
 * DeepFilterNet3 and/or RNNoise on the selection, run on the server. An
 * OFFLINE process, not a real-time plugin: choose the settings, press Process,
 * listen to the result in the editor and Undo if it is wrong (see
 * useNoiseReduction.js). Pro only — the footer's Process carries the PRO tag
 * and opens the upgrade prompt for anyone else.
 *
 * Modula layout: the engine choice, with a line on what the chosen engine is
 * for, in the top well; under it only the settings that engine reads, then
 * Mix. A setting the engine ignores is hidden rather than greyed out — three
 * dimmed controls read as "unavailable", the same misreading the OFFLINE badge
 * had. While processing, the well shows the run and a Cancel button.
 */
import { computed } from 'vue'
import { useNoiseReduction } from '../../composables/useNoiseReduction.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  NOISE_REDUCTION_DEFAULTS,
  NR_DF3_LIMIT_MIN_DB,
  NR_DF3_LIMIT_MAX_DB,
  usesDf3,
  usesRnnoise,
} from '../../audio/noiseReductionParams.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaButton from '../modula/ModulaButton.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import ModulaSwitch from '../modula/ModulaSwitch.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  params, processing, hasSelection,
  setEngine, setDf3Limit, setProtectConsonants, setMix,
  apply, cancel, closeModal,
} = useNoiseReduction()

const { state } = useEditorState()

const ACCENT = '#e8a33d'
const D = NOISE_REDUCTION_DEFAULTS

/** Labels name the model; the line under the switch says what it is for. */
const ENGINES = {
  df3: { label: 'DeepFilterNet3', about: 'The strongest model. Hiss, fans, air conditioning and room tone — the right first choice.' },
  rnnoise: { label: 'RNNoise', about: 'A lighter touch for steady background noise. Leaves more of the room, and more of the voice.' },
  both: { label: 'Both', about: 'DeepFilterNet3, then RNNoise on what it leaves — the ACX Audiobook preset’s order. For noise DeepFilterNet3 alone does not clear.' },
}
const ENGINE_OPTIONS = Object.entries(ENGINES).map(([value, e]) => ({ value, label: e.label }))

const df3On = computed(() => usesDf3(params.engine))
const rnnoiseOn = computed(() => usesRnnoise(params.engine))

function duration(sec) {
  if (sec < 60) return `${sec.toFixed(1)} s`
  const m = Math.floor(sec / 60)
  return `${m} min ${String(Math.round(sec - m * 60)).padStart(2, '0')} s`
}

const statusLine = computed(() => {
  if (!hasSelection.value) return 'Select the audio to clean up, or Select all.'
  const { start, end } = state.selection
  return `Cleans the ${duration(end - start)} selection and replaces it. Undo puts it back.`
})

function formatLimit(v) {
  return v >= NR_DF3_LIMIT_MAX_DB ? 'MAX' : `${Math.round(v)} dB`
}

function formatMix(v) {
  return `${Math.round(v * 100)}%`
}

async function applyAndClose() {
  if (await apply()) closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="noise-reduction"
    :z="z"
    :width="560"
    :accent="ACCENT"
    design="modula"
    brand-lead="NOISE REDUCTION"
    :show-engage="false"
    offline
    show-apply
    apply-label="Process selection"
    apply-label-short="Process"
    apply-feature="noiseReduction"
    :apply-disabled="processing"
    apply-disabled-hint="Noise reduction is running"
    @apply="applyAndClose"
  >
    <div class="nr-display">
      <div class="nr-field">
        <span class="m-caption">Engine</span>
        <ModulaSegmented
          :model-value="params.engine" :options="ENGINE_OPTIONS"
          aria-label="Noise reduction engine" :disabled="processing"
          @update:model-value="setEngine"
        />
        <p class="nr-about">{{ ENGINES[params.engine].about }}</p>
      </div>

      <div v-if="processing" class="nr-running">
        <span class="nr-running-lamp"></span>
        <span class="nr-running-text">{{ state.processingStage || 'Starting…' }}</span>
        <ModulaButton variant="ghost" size="sm" @click="cancel">Cancel</ModulaButton>
      </div>
      <p v-else class="nr-status">{{ statusLine }}</p>
    </div>

    <div class="nr-controls">
      <div v-if="df3On" class="nr-group">
        <span class="m-caption">DeepFilterNet3</span>
        <ModulaKnob
          variant="small" :size="56" show-value
          :model-value="params.df3LimitDb" :min="NR_DF3_LIMIT_MIN_DB" :max="NR_DF3_LIMIT_MAX_DB" :step="1"
          :default-value="D.df3LimitDb" label="Max reduction" :color="ACCENT" :format-value="formatLimit"
          :disabled="processing"
          title="The most DeepFilterNet3 may take out at any moment. Lower keeps more of S, F and breath; MAX is uncapped. Double-click to reset"
          @update:model-value="setDf3Limit"
        />
      </div>

      <div v-if="rnnoiseOn" class="nr-group">
        <span class="m-caption">RNNoise</span>
        <!-- Captioned underneath rather than through the switch's own label,
             which sits beside the track and does not fit the column. -->
        <div
          class="nr-switch"
          title="Keep the original audio where speech is detected but RNNoise would suppress it — usually the start of an S or F"
        >
          <ModulaSwitch
            :model-value="params.protectConsonants" :color="ACCENT"
            aria-label="Protect consonants"
            :disabled="processing"
            @update:model-value="setProtectConsonants"
          />
          <span class="m-caption nr-switch-label">Protect consonants</span>
        </div>
      </div>

      <div class="nr-group">
        <span class="m-caption">Output</span>
        <ModulaKnob
          variant="small" :size="56" show-value editable
          :parse-value="t => parseFloat(t) / 100"
          :model-value="params.mix" :min="0" :max="1" :step="0.01"
          :default-value="D.mix" label="Mix" :color="ACCENT" :format-value="formatMix"
          :disabled="processing"
          title="How much of the denoised audio to keep. Below 100% blends the original back in, which hides artefacts at the cost of some noise. Changing only Mix after an Undo reprocesses instantly. Double-click to reset"
          @update:model-value="setMix"
        />
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.nr-display {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.nr-field { display: flex; flex-direction: column; gap: 8px; }
.nr-about { margin: 0; min-height: 30px; font: 500 10px/1.5 var(--m-font-ui); color: var(--m-ink-3); }
/* Same height as the running row, so Cancel appearing never moves the window. */
.nr-status { margin: 0; min-height: 28px; display: flex; align-items: center; font: 500 10px/1.5 var(--m-font-ui); color: var(--m-ink-3); }
.nr-running {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
}
.nr-running-text {
  flex: 1;
  min-width: 0;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-2);
  font-variant-numeric: tabular-nums;
}
.nr-running-lamp {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #e78040;
  animation: nr-pulse 1.2s ease-in-out infinite;
}
@keyframes nr-pulse { 50% { opacity: .3; } }
.nr-controls {
  margin-top: 12px;
  padding: 14px 16px 12px;
  display: grid;
  /* Only the engine's own settings show, so the column count follows them:
     two for DeepFilterNet3 or RNNoise alone, three for Both. */
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 12px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.nr-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.nr-switch { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.nr-switch-label { color: #aeb6bd; }
</style>
