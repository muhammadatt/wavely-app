<script setup>
/**
 * Noise Reduction.
 *
 * Two cleaning passes run on the server, each with its own ON / OFF:
 * CLEAN (DeepFilterNet3 — transparent, the general first choice) and
 * DEEP CLEAN (RNNoise — takes away more: lip smacks, clicks, bumps, and some
 * of the voice with them). Both on runs Clean then Deep Clean, the ACX
 * Audiobook preset's order. The panel never names the models (see
 * NR_PASS_LABELS in src/audio/noiseReductionParams.js for the mapping and why
 * the names are the way round they are).
 *
 * An OFFLINE process, not a real-time plugin: set it up, press Process, listen
 * in the editor and Undo if it is wrong (useNoiseReduction.js). Pro only — the
 * footer's Process carries the PRO tag for anyone else.
 *
 * Modula layout: the two passes as a pair of cards (switch, what it is for,
 * its one setting — dimmed while off, since the switch says why); under them
 * a full-width OUTPUT strip with Mix, which applies to whatever the passes
 * produce and so must not sit in the row as if it were a third pass; then the
 * status well, which becomes the run's progress and Cancel while it works.
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
const CLEAN = NR_PASS_LABELS.df3
const DEEP = NR_PASS_LABELS.rnnoise

const cleanOn = computed(() => usesDf3(params.engine))
const deepOn = computed(() => usesRnnoise(params.engine))
const anyOn = computed(() => cleanOn.value || deepOn.value)

const CLEAN_ABOUT = 'Transparent removal of hiss, fans, air conditioning and more. The right first choice.'
const DEEP_ABOUT = 'Cleans lip smacks, mic bumps and room noise. Great for audiobooks and narration.'

function duration(sec) {
  if (sec < 60) return `${sec.toFixed(1)} s`
  const m = Math.floor(sec / 60)
  return `${m} min ${String(Math.round(sec - m * 60)).padStart(2, '0')} s`
}

const statusLine = computed(() => {
  if (!anyOn.value) return `Turn on ${CLEAN}, ${DEEP} or both.`
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
    :apply-disabled="processing || !anyOn"
    :apply-disabled-hint="processing ? 'Noise reduction is running' : `Turn on ${CLEAN} or ${DEEP}`"
    @apply="applyAndClose"
  >
    <div class="nr-passes">
      <section class="nr-card nr-pass" :class="{ 'is-off': !cleanOn }">
        <header class="nr-pass-head">
          <span class="m-caption nr-pass-name">{{ CLEAN }}</span>
          <ModulaLedPill
            size="sm" on-label="ON" off-label="OFF" :color="ACCENT"
            :model-value="cleanOn" :disabled="processing"
            :title="`Turn ${CLEAN} ${cleanOn ? 'off' : 'on'}`"
            @update:model-value="v => setPass('df3', v)"
          />
        </header>
        <p class="nr-about">{{ CLEAN_ABOUT }}</p>
        <div class="nr-pass-body">
          <ModulaKnob
            variant="small" :size="48" show-value
            :model-value="params.df3LimitDb" :min="NR_DF3_LIMIT_MIN_DB" :max="NR_DF3_LIMIT_MAX_DB" :step="1"
            :default-value="D.df3LimitDb" label="Max reduction" :color="ACCENT" :format-value="formatLimit"
            :disabled="!cleanOn || processing"
            title="The most Clean may take out at any moment. Lower keeps more of S, F and breath; MAX is uncapped. Double-click to reset"
            @update:model-value="setDf3Limit"
          />
        </div>
      </section>

      <section class="nr-card nr-pass" :class="{ 'is-off': !deepOn }">
        <header class="nr-pass-head">
          <span class="m-caption nr-pass-name">{{ DEEP }}</span>
          <ModulaLedPill
            size="sm" on-label="ON" off-label="OFF" :color="ACCENT"
            :model-value="deepOn" :disabled="processing"
            :title="`Turn ${DEEP} ${deepOn ? 'off' : 'on'} — it removes more than ${CLEAN}, so it is not for every recording`"
            @update:model-value="v => setPass('rnnoise', v)"
          />
        </header>
        <p class="nr-about">{{ DEEP_ABOUT }}</p>
        <div class="nr-pass-body">
          <ModulaLedPill
            size="sm" label="Protect consonants" :color="ACCENT"
            :model-value="params.protectConsonants"
            :disabled="!deepOn || processing"
            title="Keep the original audio where speech is detected but Deep Clean would suppress it — usually the start of an S or F"
            @update:model-value="setProtectConsonants"
          />
        </div>
      </section>
    </div>

    <section class="nr-card nr-output" :class="{ 'is-off': !anyOn }">
      <span class="m-caption nr-pass-name">Output</span>
      <ModulaKnob
        variant="small" :size="40" show-value editable
        :parse-value="t => parseFloat(t) / 100"
        :model-value="params.mix" :min="0" :max="1" :step="0.01"
        :default-value="D.mix" label="Mix" :color="ACCENT" :format-value="formatMix"
        :disabled="processing || !anyOn"
        title="How much of the cleaned audio to keep. Changing only Mix after an Undo reprocesses instantly. Double-click to reset"
        @update:model-value="setMix"
      />
      <p class="nr-about nr-output-about">How much of the cleaned audio to keep. Below 100% blends the original back in to hide artefacts.</p>
    </section>

    <div class="nr-card nr-display">
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
.nr-card {
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.nr-passes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.nr-pass {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 14px;
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
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-3);
}
.nr-pass .nr-about { min-height: 30px; }
/* Both pass bodies sit on the card's floor, so a knob and a pill line up
   across the pair however tall the description above runs. */
.nr-pass-body {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-top: auto;
  min-height: 92px;
  transition: opacity .15s ease;
}
/* Off: the body dims, the header and its switch stay at full strength, so the
   card reads as switched off rather than unavailable. */
.nr-pass.is-off .nr-pass-body,
.nr-pass.is-off .nr-about,
.nr-output.is-off .nr-output-about { opacity: .4; }
.nr-output {
  margin-top: 10px;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  gap: 18px;
}
.nr-output-about { flex: 1; min-width: 0; }
.nr-display {
  margin-top: 10px;
  padding: 10px 14px;
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
