<script setup>
/**
 * Noise Reduction — layout 4b of the redesign study
 * (docs/design/noise-reduction/Noise_Reduction_Redesign.dc.html).
 *
 * Two cleaning passes run on the server: CLEAN (DeepFilterNet3 — transparent,
 * the general first choice) and DEEP CLEAN (RNNoise — takes away more: lip
 * smacks, clicks, bumps, and some of the voice with them). BOTH runs Clean
 * then Deep Clean, the ACX Audiobook preset's order. The panel never names the
 * models (NR_PASS_LABELS in src/audio/noiseReductionParams.js).
 *
 *   MODE TILES   Clean / Deep Clean / Both — one choice, so there is no
 *                "everything off" state to explain. The line under the tiles
 *                says what the chosen mode is for.
 *   PASS CARDS   one per pass, its state (ACTIVE / OFF) in the corner and its
 *                setting dimmed while the mode leaves it out. Clean: Max
 *                reduction as a drag readout with LIGHT / STD / HEAVY / MAX
 *                tiers (the mastering chain's 6 / 12 / 18 dB, MAX uncapped).
 *                Deep Clean: VOICE GUARD (`protectConsonants`).
 *   MIX          its own card under both — it blends whatever the passes made
 *                — as a ring knob whose arc shows how much cleaned audio is
 *                kept, with the value beside it.
 *
 * No status line (the design drops it): the footer says what Process does,
 * and while a run is going the footer's note becomes its stage, elapsed time
 * and Cancel (FloatingWindow's `offline-note` slot). The processing overlay
 * on the waveform shows the same stage.
 *
 * An OFFLINE process: set it up, Process, listen in the editor, Undo if it is
 * wrong (useNoiseReduction.js). Pro only — the footer's Process carries the
 * PRO tag for anyone else.
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
import ModulaField from '../modula/ModulaField.vue'
import FloatingWindow from './FloatingWindow.vue'
import { radioArrowKey, radioTabStop } from '../../ui/radioKeys.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  params, processing,
  setEngine, setDf3Limit, setProtectConsonants, setMix,
  apply, cancel, closeModal,
} = useNoiseReduction()

const { state } = useEditorState()

const ACCENT = '#e8a33d'
const D = NOISE_REDUCTION_DEFAULTS
const CLEAN = NR_PASS_LABELS.df3
const DEEP = NR_PASS_LABELS.rnnoise

const MODES = [
  { value: 'df3', label: CLEAN, sub: 'Hiss, fans, AC' },
  { value: 'rnnoise', label: DEEP, sub: 'Mouth noise, bumps' },
  { value: 'both', label: 'Both', sub: 'Clean, then Deep' },
]

const MODE_ABOUT = {
  df3: 'Transparent removal of hiss, fans, air conditioning and more. The right first choice.',
  rnnoise: 'Cleans lip smacks, mic bumps and room noise. Best for audiobooks and narration.',
  both: `${CLEAN} emoves broadband hiss, then ${DEEP} removes lip smack and room noise.`,
}

/** The mastering chain's light / standard / heavy tiers, and uncapped. */
const TIERS = [
  { label: 'LIGHT', value: 6 },
  { label: 'STD', value: 12 },
  { label: 'HEAVY', value: 18 },
  { label: 'MAX', value: NR_DF3_LIMIT_MAX_DB },
]

const cleanOn = computed(() => usesDf3(params.engine))
const deepOn = computed(() => usesRnnoise(params.engine))
const anyOn = computed(() => cleanOn.value || deepOn.value)

function formatLimit(v) {
  return v >= NR_DF3_LIMIT_MAX_DB ? 'MAX' : `${Math.round(v)} dB`
}

function parseLimit(t) {
  return /max/i.test(t) ? NR_DF3_LIMIT_MAX_DB : parseFloat(t)
}

function pickTier(v) {
  if (cleanOn.value && !processing.value) setDf3Limit(v)
}

function toggleGuard() {
  if (deepOn.value && !processing.value) setProtectConsonants(!params.protectConsonants)
}

const modeStop = computed(() => radioTabStop(MODES, m => m.value === params.engine))
const tierStop = computed(() => radioTabStop(TIERS, t => t.value === Math.round(params.df3LimitDb)))

function pickMode(m) {
  if (!processing.value) setEngine(m.value)
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
    apply-disabled-hint="Noise reduction is running"
    @apply="applyAndClose"
  >
    <!-- Mode tiles -->
    <div class="of-tiles" role="radiogroup" aria-label="Noise reduction mode">
      <button
        v-for="(m, i) in MODES" :key="m.value"
        type="button" class="of-tile m-focusable" role="radio"
        :class="{ 'is-on': params.engine === m.value }"
        :aria-checked="String(params.engine === m.value)"
        :tabindex="i === modeStop ? 0 : -1"
        :disabled="processing"
        @click="pickMode(m)" @keydown="radioArrowKey($event, i, MODES, pickMode)"
      >
        <span class="of-tile-label">{{ m.label }}</span>
        <span class="of-tile-sub">{{ m.sub }}</span>
      </button>
    </div>
    <p class="of-mode-about">{{ MODE_ABOUT[params.engine] ?? '' }}</p>

    <!-- Pass cards -->
    <div class="of-cards">
      <section class="of-card of-col">
        <header class="of-card-head">
          <span class="of-card-name">{{ CLEAN }}</span>
          <span class="of-card-state" :class="{ 'is-on': cleanOn }">{{ cleanOn ? 'ACTIVE' : 'OFF' }}</span>
        </header>
        <div class="of-rule"></div>
        <div class="of-card-body" :class="{ 'is-off': !cleanOn }">
          <div class="of-row">
            <span class="of-setting">MAX REDUCTION</span>
            <ModulaField
              :model-value="params.df3LimitDb" :min="NR_DF3_LIMIT_MIN_DB" :max="NR_DF3_LIMIT_MAX_DB" :step="1"
              :width="52" :default-value="D.df3LimitDb" :format-value="formatLimit" :parse="parseLimit"
              :disabled="!cleanOn || processing" aria-label="Max reduction"
              @update:model-value="setDf3Limit"
            />
          </div>
          <div class="of-tiers" role="radiogroup" aria-label="Max reduction tier">
            <button
              v-for="(t, i) in TIERS" :key="t.label"
              type="button" class="of-tier m-focusable" role="radio"
              :class="{ 'is-on': Math.round(params.df3LimitDb) === t.value }"
              :aria-checked="String(Math.round(params.df3LimitDb) === t.value)"
              :tabindex="i === tierStop ? 0 : -1"
              :disabled="!cleanOn || processing"
              :title="t.value >= NR_DF3_LIMIT_MAX_DB ? 'Uncapped' : `At most ${t.value} dB of reduction`"
              @click="pickTier(t.value)" @keydown="radioArrowKey($event, i, TIERS, o => pickTier(o.value))"
            >{{ t.label }}</button>
          </div>
        </div>
      </section>

      <section class="of-card of-col">
        <header class="of-card-head">
          <span class="of-card-name">{{ DEEP }}</span>
          <span class="of-card-state" :class="{ 'is-on': deepOn }">{{ deepOn ? 'ACTIVE' : 'OFF' }}</span>
        </header>
        <div class="of-rule"></div>
        <div class="of-card-body" :class="{ 'is-off': !deepOn }">
          <div class="of-row">
            <span class="of-setting">VOICE GUARD</span>
            <span class="of-toggle-wrap">
              <span class="of-toggle-word" :class="{ 'is-on': params.protectConsonants && deepOn }">{{ params.protectConsonants ? 'ON' : 'OFF' }}</span>
              <button
                type="button" class="of-toggle m-focusable" role="switch"
                :class="{ 'is-on': params.protectConsonants && deepOn }"
                :aria-checked="String(params.protectConsonants)" aria-label="Voice guard"
                :disabled="!deepOn || processing"
                @click="toggleGuard"
              ><span class="of-toggle-puck" :style="{ left: params.protectConsonants ? '23px' : '3px' }"></span></button>
            </span>
          </div>
          <span class="of-about">Protect soft vocal onsets that deep clean can sometimes cut.</span>
        </div>
      </section>
    </div>

    <!-- Mix -->
    <section class="of-card of-wide" :class="{ 'is-off': !anyOn }">
      <div class="of-wide-text">
        <span class="of-card-name">MIX</span>
        <span class="of-about">Below 100% blends the original back in to mask potential noise reduction artifacts.</span>
      </div>
      <div class="of-wide-controls">
        <ModulaKnob
          variant="halo" :size="56"
          :model-value="params.mix" :min="0" :max="1" :step="0.01"
          :default-value="D.mix" :color="ACCENT" aria-label="Mix"
          :disabled="processing || !anyOn"
          title="How much of the cleaned audio to keep. Drag up or down; double-click to reset"
          @update:model-value="setMix"
        />
        <ModulaField
          :model-value="Math.round(params.mix * 100)" :min="0" :max="100" :step="1"
          :width="52" :default-value="Math.round(D.mix * 100)" :format-value="v => `${Math.round(v)}%`"
          :disabled="processing || !anyOn" aria-label="Mix"
          @update:model-value="v => setMix(v / 100)"
        />
      </div>
    </section>

    <template #offline-note>
      <span v-if="processing" class="of-running">
        <span class="of-running-lamp"></span>
        <span class="of-running-text">{{ state.processingStage || 'Starting…' }}</span>
        <ModulaButton variant="ghost" size="sm" @click="cancel">Cancel</ModulaButton>
      </span>
      <span v-else class="of-note">No preview - Renders on the server.</span>
    </template>
  </FloatingWindow>
</template>

<!-- The 4b face is shared with the Auto Leveler. -->
<style scoped src="./offlineFace.css"></style>
