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
  rnnoise: 'Cleans lip smacks, mic bumps and room noise. Great for audiobooks and narration.',
  both: `${CLEAN} takes out the broadband noise floor, then ${DEEP} removes what it leaves — the ACX audiobook order.`,
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

const mixText = computed(() => `${Math.round(params.mix * 100)}%`)

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
    <div class="nr-tiles" role="radiogroup" aria-label="Noise reduction mode">
      <button
        v-for="m in MODES" :key="m.value"
        type="button" class="nr-tile m-focusable" role="radio"
        :class="{ 'is-on': params.engine === m.value }"
        :aria-checked="String(params.engine === m.value)"
        :disabled="processing"
        @click="setEngine(m.value)"
      >
        <span class="nr-tile-label">{{ m.label }}</span>
        <span class="nr-tile-sub">{{ m.sub }}</span>
      </button>
    </div>
    <p class="nr-mode-about">{{ MODE_ABOUT[params.engine] ?? '' }}</p>

    <!-- Pass cards -->
    <div class="nr-passes">
      <section class="nr-card nr-pass">
        <header class="nr-pass-head">
          <span class="nr-pass-name">{{ CLEAN }}</span>
          <span class="nr-pass-state" :class="{ 'is-on': cleanOn }">{{ cleanOn ? 'ACTIVE' : 'OFF' }}</span>
        </header>
        <div class="nr-rule"></div>
        <div class="nr-pass-body" :class="{ 'is-off': !cleanOn }">
          <div class="nr-row">
            <span class="nr-setting">MAX REDUCTION</span>
            <ModulaField
              :model-value="params.df3LimitDb" :min="NR_DF3_LIMIT_MIN_DB" :max="NR_DF3_LIMIT_MAX_DB" :step="1"
              :width="52" :default-value="D.df3LimitDb" :format-value="formatLimit" :parse="parseLimit"
              :disabled="!cleanOn || processing" aria-label="Max reduction"
              @update:model-value="setDf3Limit"
            />
          </div>
          <div class="nr-tiers" role="radiogroup" aria-label="Max reduction tier">
            <button
              v-for="t in TIERS" :key="t.label"
              type="button" class="nr-tier m-focusable" role="radio"
              :class="{ 'is-on': Math.round(params.df3LimitDb) === t.value }"
              :aria-checked="String(Math.round(params.df3LimitDb) === t.value)"
              :disabled="!cleanOn || processing"
              :title="t.value >= NR_DF3_LIMIT_MAX_DB ? 'Uncapped' : `At most ${t.value} dB of reduction`"
              @click="pickTier(t.value)"
            >{{ t.label }}</button>
          </div>
        </div>
      </section>

      <section class="nr-card nr-pass">
        <header class="nr-pass-head">
          <span class="nr-pass-name">{{ DEEP }}</span>
          <span class="nr-pass-state" :class="{ 'is-on': deepOn }">{{ deepOn ? 'ACTIVE' : 'OFF' }}</span>
        </header>
        <div class="nr-rule"></div>
        <div class="nr-pass-body" :class="{ 'is-off': !deepOn }">
          <div class="nr-row">
            <span class="nr-setting">VOICE GUARD</span>
            <span class="nr-toggle-wrap">
              <span class="nr-toggle-word" :class="{ 'is-on': params.protectConsonants && deepOn }">{{ params.protectConsonants ? 'ON' : 'OFF' }}</span>
              <button
                type="button" class="nr-toggle m-focusable" role="switch"
                :class="{ 'is-on': params.protectConsonants && deepOn }"
                :aria-checked="String(params.protectConsonants)" aria-label="Voice guard"
                :disabled="!deepOn || processing"
                @click="toggleGuard"
              ><span class="nr-toggle-puck" :style="{ left: params.protectConsonants ? '23px' : '3px' }"></span></button>
            </span>
          </div>
          <span class="nr-about">Guard soft vocal onsets that deep clean can sometimes remove.</span>
        </div>
      </section>
    </div>

    <!-- Mix -->
    <section class="nr-card nr-mix" :class="{ 'is-off': !anyOn }">
      <div class="nr-mix-text">
        <span class="nr-pass-name">MIX</span>
        <span class="nr-about">Below 100% blends the original back in to hide artefacts.</span>
      </div>
      <div class="nr-mix-controls">
        <ModulaKnob
          variant="ring" :size="56"
          :model-value="params.mix" :min="0" :max="1" :step="0.01"
          :default-value="D.mix" :color="ACCENT"
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
      <span v-if="processing" class="nr-running">
        <span class="nr-running-lamp"></span>
        <span class="nr-running-text">{{ state.processingStage || 'Starting…' }}</span>
        <ModulaButton variant="ghost" size="sm" @click="cancel">Cancel</ModulaButton>
      </span>
      <span v-else class="nr-note">No preview - Renders on the server.</span>
    </template>
  </FloatingWindow>
</template>

<style scoped>
/* ── Mode tiles: three raised keys in a dark well ── */
.nr-tiles {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-radius: 14px;
  background: linear-gradient(180deg, #1a1c20, #22252a);
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, .8);
}
.nr-tile {
  flex: 1;
  min-width: 0;
  height: 54px;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: linear-gradient(180deg, #2c3036, #23262b);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, .6);
}
.nr-tile.is-on {
  background: linear-gradient(180deg, #3c4149, #2a2e34);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .14), 0 8px 16px -8px rgba(0, 0, 0, .9), 0 0 0 1px rgba(0, 0, 0, .6);
}
.nr-tile:disabled { cursor: default; }
.nr-tile-label {
  font: 700 11px/1 var(--m-font-ui);
  letter-spacing: .14em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, .5);
}
.nr-tile-sub { font: 500 10px/1 var(--m-font-ui); color: rgba(255, 255, 255, .38); }
.nr-tile.is-on .nr-tile-label { color: #3fd0de; }
.nr-tile.is-on .nr-tile-sub { color: #c9d0d6; }
.nr-mode-about {
  margin: 10px 6px 0;
  min-height: 30px;
  font: 500 10px/1.5 var(--m-font-ui);
  color: #b6bdc4;
  text-wrap: pretty;
}

/* ── Cards ── */
.nr-card {
  border-radius: 16px;
  background: linear-gradient(180deg, #3c4655, #2c343f);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.nr-passes {
  margin-top: 6px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.nr-pass {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
}
.nr-pass-head { display: flex; justify-content: space-between; align-items: center; }
.nr-pass-name {
  font: 600 10px/1 var(--m-font-ui);
  letter-spacing: .14em;
  text-transform: uppercase;
  color: #eaf6f8;
}
.nr-pass-state {
  font: 700 8px/1 'JetBrains Mono', monospace;
  letter-spacing: .12em;
  color: #a0a8b0;
}
.nr-pass-state.is-on { color: #e8a33d; }
.nr-rule { height: 1px; background: rgba(0, 0, 0, .35); box-shadow: 0 1px 0 rgba(255, 255, 255, .04); }
.nr-pass-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: opacity .15s ease;
}
.nr-pass-body.is-off, .nr-mix.is-off { opacity: .4; }
.nr-row { display: flex; justify-content: space-between; align-items: center; min-height: 23px; }
.nr-setting {
  font: 600 9px/1 var(--m-font-ui);
  letter-spacing: .14em;
  color: #aeb6bd;
}
.nr-about { font: 500 10px/1.5 var(--m-font-ui); color: #b6bdc4; }

/* Max reduction tiers: a flat segmented strip in a well */
.nr-tiers {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
  background: linear-gradient(180deg, #1a1c20, #22252a);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, .8);
}
.nr-tier {
  flex: 1;
  border: none;
  cursor: pointer;
  padding: 6px 0;
  border-radius: 6px;
  font: 700 9px/1.2 var(--m-font-ui);
  letter-spacing: .12em;
  white-space: nowrap;
  color: rgba(255, 255, 255, .5);
  background: transparent;
}
.nr-tier.is-on {
  color: #e8a33d;
  background: linear-gradient(180deg, #3c4149, #2a2e34);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .14), 0 6px 12px -6px rgba(0, 0, 0, .9), 0 0 0 1px rgba(0, 0, 0, .6);
}
.nr-tier:disabled { cursor: default; }

/* Voice guard: a small switch with its state word beside it */
.nr-toggle-wrap { display: flex; align-items: center; gap: 8px; }
.nr-toggle-word {
  font: 700 9px/1 var(--m-font-ui);
  letter-spacing: .14em;
  color: rgba(255, 255, 255, .5);
}
.nr-toggle-word.is-on { color: #eaf6f8; }
.nr-toggle {
  position: relative;
  flex: none;
  width: 44px;
  height: 24px;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  background: linear-gradient(180deg, #15171a, #23262b);
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, .85), 0 1px 0 rgba(255, 255, 255, .05);
}
.nr-toggle.is-on { background: linear-gradient(180deg, #5a4220, #3b2c17); }
.nr-toggle:disabled { cursor: default; }
.nr-toggle-puck {
  position: absolute;
  top: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  transition: left .18s cubic-bezier(.4, 1.4, .5, 1);
  background: linear-gradient(160deg, #50555e, #2b2e34);
  box-shadow: 0 4px 8px -3px rgba(0, 0, 0, .95), inset 0 1px 0 rgba(255, 255, 255, .18), 0 0 0 1px rgba(0, 0, 0, .6);
}

/* ── Mix ── */
.nr-mix {
  margin-top: 10px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: center;
  padding: 14px;
  transition: opacity .15s ease;
}
.nr-mix-text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.nr-mix-controls { display: flex; align-items: center; gap: 14px; }

/* ── Footer note (FloatingWindow's own note style; its CSS is scoped, so a
   slotted note restates it) ── */
.nr-note {
  margin-right: 6px;
  font: 500 11px var(--m-font-ui, 'Inter', system-ui, sans-serif);
  color: rgba(159, 196, 232, .8);
  white-space: nowrap;
}
.nr-running {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-right: 6px;
}
.nr-running-text {
  font: 500 11px var(--m-font-ui);
  color: rgba(159, 196, 232, .9);
  white-space: nowrap;
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
