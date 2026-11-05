<script setup>
/**
 * Noise Reduction.
 *
 * DeepFilterNet3 and/or RNNoise on the selection, run on the server. An
 * OFFLINE process, not a real-time plugin: choose the settings, press Process,
 * listen to the result in the editor and Undo if it is wrong (see
 * useNoiseReduction.js for why the old in-window audition was removed). Pro
 * only — the footer's Process carries the PRO tag and opens the upgrade prompt
 * for anyone else.
 *
 * Modula layout: the engine choice and a line on what Process will do in the
 * top well, the engine settings and Mix in a panel below.
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
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import ModulaSwitch from '../modula/ModulaSwitch.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  params, processing, hasSelection,
  setEngine, setDf3Limit, setProtectConsonants, setMix,
  apply, closeModal,
} = useNoiseReduction()

const { state } = useEditorState()

const ACCENT = '#e8a33d'
const D = NOISE_REDUCTION_DEFAULTS

const ENGINE_OPTIONS = [
  { value: 'df3', label: 'DF3', title: 'DeepFilterNet3 — the strongest model, for broadband noise, hiss and room tone' },
  { value: 'rnnoise', label: 'RNNoise', title: 'RNNoise — a lighter model, for steady background noise' },
  { value: 'both', label: 'Both', title: 'DeepFilterNet3, then RNNoise on what it leaves — the ACX Audiobook preset’s order' },
]

const df3On = computed(() => usesDf3(params.engine))
const rnnoiseOn = computed(() => usesRnnoise(params.engine))

function duration(sec) {
  if (sec < 60) return `${sec.toFixed(1)} s`
  const m = Math.floor(sec / 60)
  return `${m} min ${String(Math.round(sec - m * 60)).padStart(2, '0')} s`
}

const statusLine = computed(() => {
  if (processing.value) return 'Processing on the server…'
  if (!hasSelection.value) return 'Select the audio to clean up, or Select all.'
  const { start, end } = state.selection
  return `Process cleans the ${duration(end - start)} selection on the server and replaces it. ` +
    'Listen in the editor afterwards — Undo puts the original back.'
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
      </div>
      <p class="nr-status">{{ statusLine }}</p>
    </div>

    <div class="nr-controls">
      <div class="nr-group" :class="{ 'is-off': !df3On }">
        <span class="m-caption">DeepFilterNet3</span>
        <ModulaKnob
          variant="small" :size="56" show-value
          :model-value="params.df3LimitDb" :min="NR_DF3_LIMIT_MIN_DB" :max="NR_DF3_LIMIT_MAX_DB" :step="1"
          :default-value="D.df3LimitDb" label="Max reduction" :color="ACCENT" :format-value="formatLimit"
          :disabled="!df3On || processing"
          title="The most DF3 may take out of any frequency at any moment. Lower keeps more of the voice's edges (S, F, breath); MAX is uncapped. Double-click to reset"
          @update:model-value="setDf3Limit"
        />
      </div>

      <div class="nr-group" :class="{ 'is-off': !rnnoiseOn }">
        <span class="m-caption">RNNoise</span>
        <!-- Captioned underneath rather than through the switch's own label,
             which sits beside the track and does not fit a third of the panel. -->
        <div
          class="nr-switch"
          title="Keep the original audio where speech is detected but RNNoise would suppress it — its usual casualty is the start of an S or F"
        >
          <ModulaSwitch
            :model-value="params.protectConsonants" :color="ACCENT"
            aria-label="Protect consonants"
            :disabled="!rnnoiseOn || processing"
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
          title="How much of the denoised audio to keep. Below 100% blends the original back in, which hides model artefacts at the cost of some noise. Double-click to reset"
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
.nr-status { margin: 0; font: 500 10px/1.5 var(--m-font-ui); color: var(--m-ink-3); }
.nr-controls {
  margin-top: 12px;
  padding: 14px 16px 12px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
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
  transition: opacity .15s ease;
}
.nr-group.is-off { opacity: .45; }
.nr-switch { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.nr-switch-label { color: #aeb6bd; }
</style>
