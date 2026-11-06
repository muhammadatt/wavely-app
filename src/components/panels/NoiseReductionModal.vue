<script setup>
/**
 * Noise Reduction.
 *
 * Two cleaning passes run on the server, each with its own ON / OFF:
 * DEEP CLEAN (DeepFilterNet3 — the strong one) and LIGHT CLEAN (RNNoise — the
 * gentle one). Both on runs Deep then Light, the ACX Audiobook preset's order.
 * The panel never names the models (src/audio/noiseReductionParams.js,
 * NR_PASS_LABELS): it used to offer an "engine" choice of DF3 / RNNoise / Both,
 * which asked the user to pick between two model names; two switches say what
 * each pass does and make "both" the obvious combination rather than a third
 * option.
 *
 * An OFFLINE process, not a real-time plugin: set it up, press Process, listen
 * in the editor and Undo if it is wrong (useNoiseReduction.js). Pro only — the
 * footer's Process carries the PRO tag for anyone else.
 *
 * Modula layout: a card per pass (its switch, what it is for, its one setting —
 * dimmed while the pass is off, since the switch says why) and Output, over a
 * status well that turns into the run's progress and Cancel while it works.
 */
import { computed } from 'vue'
import { useNoiseReduction } from '../../composables/useNoiseReduction.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  NOISE_REDUCTION_DEFAULTS,
  NR_DF3_LIMIT_MIN_DB,
  NR_DF3_LIMIT_MAX_DB,
  NR_PASS_LABELS,
  usesDf3,
  usesRnnoise,
} from '../../audio/noiseReductionParams.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaButton from '../modula/ModulaButton.vue'
import ModulaLedPill from '../modula/ModulaLedPill.vue'
import ModulaSwitch from '../modula/ModulaSwitch.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  params, processing, hasSelection,
  setPass, setDf3Limit, setProtectConsonants, setMix,
  apply, cancel, closeModal,
} = useNoiseReduction()

const { state } = useEditorState()

const ACCENT = '#e8a33d'
const D = NOISE_REDUCTION_DEFAULTS

const deepOn = computed(() => usesDf3(params.engine))
const lightOn = computed(() => usesRnnoise(params.engine))
const anyOn = computed(() => deepOn.value || lightOn.value)

const DEEP_ABOUT = 'Transparent removal of hiss, fans, air conditioning and more. The right first choice.'
const LIGHT_ABOUT = 'Cleans lip smacks, mic bumps and room noise. Great for audiobooks and narration.'

function duration(sec) {
  if (sec < 60) return `${sec.toFixed(1)} s`
  const m = Math.floor(sec / 60)
  return `${m} min ${String(Math.round(sec - m * 60)).padStart(2, '0')} s`
}

const statusLine = computed(() => {
  if (!anyOn.value) return `Turn on ${NR_PASS_LABELS.df3}, ${NR_PASS_LABELS.rnnoise} or both.`
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
    :width="600"
    :accent="ACCENT"
    design="modula"
    brand-lead="NOISE REDUCTION"
    :show-engage="false"
    offline
    show-apply
    apply-label="Process selection"
    apply-label-short="Process"
    apply-feature="noiseReduction"
    :apply-disabled="processing || !anyOn"
    :apply-disabled-hint="processing ? 'Noise reduction is running' : `Turn on ${NR_PASS_LABELS.df3} or ${NR_PASS_LABELS.rnnoise}`"
    @apply="applyAndClose"
  >
    <div class="nr-passes">
      <section class="nr-pass" :class="{ 'is-off': !deepOn }">
        <header class="nr-pass-head">
          <span class="m-caption nr-pass-name">{{ NR_PASS_LABELS.df3 }}</span>
          <ModulaLedPill
            size="sm" on-label="ON" off-label="OFF" :color="ACCENT"
            :model-value="deepOn" :disabled="processing"
            :title="`Turn ${NR_PASS_LABELS.df3} ${deepOn ? 'off' : 'on'}`"
            @update:model-value="v => setPass('df3', v)"
          />
        </header>
        <p class="nr-about">{{ DEEP_ABOUT }}</p>
        <div class="nr-pass-body">
          <ModulaKnob
            variant="small" :size="56" show-value
            :model-value="params.df3LimitDb" :min="NR_DF3_LIMIT_MIN_DB" :max="NR_DF3_LIMIT_MAX_DB" :step="1"
            :default-value="D.df3LimitDb" label="Max reduction" :color="ACCENT" :format-value="formatLimit"
            :disabled="!deepOn || processing"
            title="The most Deep Clean may take out at any moment. Lower keeps more of S, F and breath; MAX is uncapped. Double-click to reset"
            @update:model-value="setDf3Limit"
          />
        </div>
      </section>

      <section class="nr-pass" :class="{ 'is-off': !lightOn }">
        <header class="nr-pass-head">
          <span class="m-caption nr-pass-name">{{ NR_PASS_LABELS.rnnoise }}</span>
          <ModulaLedPill
            size="sm" on-label="ON" off-label="OFF" :color="ACCENT"
            :model-value="lightOn" :disabled="processing"
            :title="`Turn ${NR_PASS_LABELS.rnnoise} ${lightOn ? 'off' : 'on'}`"
            @update:model-value="v => setPass('rnnoise', v)"
          />
        </header>
        <p class="nr-about">{{ LIGHT_ABOUT }}</p>
        <!-- Captioned underneath rather than through the switch's own label,
             which sits beside the track and does not fit the card. -->
        <div
          class="nr-pass-body nr-switch"
          title="Keep the original audio where speech is detected but Light Clean would suppress it — usually the start of an S or F"
        >
          <ModulaSwitch
            :model-value="params.protectConsonants" :color="ACCENT"
            aria-label="Protect consonants"
            :disabled="!lightOn || processing"
            @update:model-value="setProtectConsonants"
          />
          <span class="m-caption nr-switch-label">Protect consonants</span>
        </div>
      </section>

      <section class="nr-pass nr-output">
        <header class="nr-pass-head">
          <span class="m-caption nr-pass-name">Output</span>
        </header>
        <p class="nr-about">Below 100% blends the original back in to hide artefacts.</p>
        <div class="nr-pass-body">
          <ModulaKnob
            variant="small" :size="56" show-value editable
            :parse-value="t => parseFloat(t) / 100"
            :model-value="params.mix" :min="0" :max="1" :step="0.01"
            :default-value="D.mix" label="Mix" :color="ACCENT" :format-value="formatMix"
            :disabled="processing || !anyOn"
            title="How much of the cleaned audio to keep. Changing only Mix after an Undo reprocesses instantly. Double-click to reset"
            @update:model-value="setMix"
          />
        </div>
      </section>
    </div>

    <div class="nr-display">
      <div v-if="processing" class="nr-running">
        <span class="nr-running-lamp"></span>
        <span class="nr-running-text">{{ state.processingStage || 'Starting…' }}</span>
        <ModulaButton variant="ghost" size="sm" @click="cancel">Cancel</ModulaButton>
      </div>
      <p v-else class="nr-status" :class="{ 'is-warn': !anyOn }">{{ statusLine }}</p>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.nr-passes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.nr-pass {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 12px 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.nr-pass-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 30px;
}
.nr-pass-name { color: var(--m-ink); white-space: nowrap; }
.nr-about {
  margin: 0;
  min-height: 45px;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-3);
}
.nr-pass-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: auto;
  transition: opacity .15s ease;
}
/* Off: the body dims, the header and its switch stay at full strength, so the
   card reads as switched off rather than unavailable. */
.nr-pass.is-off .nr-pass-body,
.nr-pass.is-off .nr-about { opacity: .4; }
.nr-switch { gap: 10px; padding-top: 10px; }
.nr-switch-label { color: #aeb6bd; }
.nr-display {
  margin-top: 10px;
  padding: 10px 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
/* Same height as the running row, so Cancel appearing never moves the window. */
.nr-status {
  margin: 0;
  min-height: 28px;
  display: flex;
  align-items: center;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-3);
}
.nr-status.is-warn { color: #ffb27a; }
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
</style>
