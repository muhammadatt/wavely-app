<script setup>
/**
 * Noise Reduction.
 *
 * DeepFilterNet3 and/or RNNoise on the selection, run on the server. There is
 * no real-time preview — the models do not run in the browser — so the centre
 * well is the plugin's own audition: Process the selection once, then Listen,
 * switching Original / Denoised and turning Mix live against the held result.
 * Apply commits exactly what was heard (see useNoiseReduction.js).
 *
 * Modula layout: the engine choice and the audition row in the centre well,
 * the engine settings and Mix in a panel below.
 */
import { computed, onUnmounted } from 'vue'
import { useNoiseReduction } from '../../composables/useNoiseReduction.js'
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
  params, processing, listening, listenTo, hasResult, resultCoversSelection, isStale,
  hasSelection, result,
  setEngine, setDf3Limit, setProtectConsonants, setMix, setListenTo,
  process, toggleAudition, apply, teardown, closeModal,
} = useNoiseReduction()

onUnmounted(teardown)

const ACCENT = '#e8a33d'
const D = NOISE_REDUCTION_DEFAULTS

const ENGINE_OPTIONS = [
  { value: 'df3', label: 'DF3', title: 'DeepFilterNet3 — the strongest model, for broadband noise, hiss and room tone' },
  { value: 'rnnoise', label: 'RNNoise', title: 'RNNoise — a lighter model, for steady background noise' },
  { value: 'both', label: 'Both', title: 'DeepFilterNet3, then RNNoise on what it leaves — the ACX Audiobook preset’s order' },
]

const LISTEN_OPTIONS = [
  { value: 'original', label: 'Original' },
  { value: 'denoised', label: 'Denoised' },
]

const df3On = computed(() => usesDf3(params.engine))
const rnnoiseOn = computed(() => usesRnnoise(params.engine))

const statusLine = computed(() => {
  if (processing.value) return 'Processing on the server…'
  if (!hasSelection.value) return 'Select the audio to clean up.'
  if (isStale.value) return 'The audio or a setting changed since processing — process again to listen.'
  if (!hasResult.value) return 'Process the selection to hear the result before you apply it.'
  const r = result.value
  const secs = (r.end - r.start).toFixed(1)
  if (!resultCoversSelection.value) {
    return `Holding ${secs} s processed from a different region — Apply processes the selection again.`
  }
  return `${secs} s processed. Mix and Original / Denoised are live; Apply writes what you hear.`
})

function formatLimit(v) {
  return v >= NR_DF3_LIMIT_MAX_DB ? 'MAX' : `${Math.round(v)} dB`
}

function formatMix(v) {
  return `${Math.round(v * 100)}%`
}

async function applyAndClose() {
  await apply()
  teardown()
  closeModal()
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
    show-preview
    :previewable="false"
    preview-hint="Real-time preview isn’t available for server noise reduction — use Process and Listen in the window"
    show-apply
    apply-feature="noiseReduction"
    :apply-disabled="processing"
    apply-disabled-hint="Noise reduction is running"
    @apply="applyAndClose"
    @close="teardown"
  >
    <div class="nr-display">
      <div class="nr-top">
        <div class="nr-field">
          <span class="m-caption">Engine</span>
          <ModulaSegmented
            :model-value="params.engine" :options="ENGINE_OPTIONS"
            aria-label="Noise reduction engine" :disabled="processing"
            @update:model-value="setEngine"
          />
        </div>
        <ModulaButton
          variant="accent" :disabled="processing || !hasSelection"
          @click="process"
        >{{ processing ? 'Processing…' : 'Process' }}</ModulaButton>
      </div>

      <div class="nr-audition">
        <ModulaButton
          :model-value="listening" :disabled="!hasResult || processing"
          :title="hasResult ? 'Play the processed region from its start' : 'Process the selection first'"
          @click="toggleAudition"
        >{{ listening ? '■ Stop' : '▶ Listen' }}</ModulaButton>
        <ModulaSegmented
          :model-value="listenTo" :options="LISTEN_OPTIONS"
          aria-label="Hear the original or the denoised audio" :disabled="!hasResult"
          @update:model-value="setListenTo"
        />
      </div>

      <p class="nr-status" :class="{ 'is-warn': isStale }">{{ statusLine }}</p>
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
          title="How much of the denoised audio to use. Below 100% blends the original back in, which hides model artefacts at the cost of some noise. Live — no need to process again. Double-click to reset"
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
.nr-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.nr-field { display: flex; flex-direction: column; gap: 8px; }
.nr-audition {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #0b0e13;
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, .85), 0 0 0 1px #1c222c, 0 1px 0 rgba(255, 255, 255, .05);
}
.nr-status { margin: 0; font: 500 10px/1.5 var(--m-font-ui); color: var(--m-ink-3); }
.nr-status.is-warn { color: #ffb27a; }
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
