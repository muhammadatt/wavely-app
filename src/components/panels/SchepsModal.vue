<script setup>
import { computed, onMounted, watch } from 'vue'
import { useScheps } from '../../composables/useScheps.js'
import { hasChainSlot } from '../../composables/usePluginChain.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { pultecNetSections, pultecSections } from '../../audio/dsp/pultec.js'
import { magnitudeResponseDb } from '../../audio/dsp/biquad.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import ModulaLedPill from '../modula/ModulaLedPill.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import {
  SCHEPS_PRESET_PLUGIN, SCHEPS_OUTPUT_MIN_DB, SCHEPS_OUTPUT_MAX_DB,
} from '../../audio/pluginPresets/scheps.js'
import { SCHEPS_DEFAULTS } from '../../audio/effects/schepsParams.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  schepsCharacter, schepsSquash, schepsMix, schepsOutput,
  schepsAutoTrim, schepsAutoTrimBusy, schepsWetTrimDb,
  schepsPreview, schepsReduction, schepsInputLevels, schepsOutputLevels,
  togglePreview, syncCharacter, syncSquash, syncMix, syncOutput,
  toggleAutoTrim, applyParams, refreshAutoTrim, apply, teardown, closeModal,
} = useScheps()

const presets = usePluginPresets(SCHEPS_PRESET_PLUGIN, {
  read: () => ({
    character: schepsCharacter.value,
    squash: schepsSquash.value,
    mix: schepsMix.value,
    output: schepsOutput.value,
    autoTrim: schepsAutoTrim.value,
  }),
  write: p => applyParams(p),
})

const { state } = useEditorState()

// Default to engaged when the panel opens, matching the other plugin windows.
onMounted(() => {
  // A plugin that already has a slot keeps its ON/BYPASS: opening its
  // editor from the chain must not un-bypass it.
  if (!schepsPreview.value && !hasChainSlot('scheps-parallel')) togglePreview()
})

// The trim is measured from the selected region, so a new selection needs a
// fresh measurement.
watch(() => state.selection, () => refreshAutoTrim(), { deep: true })

const ACCENT = '#e8a33d'
const METER_H = 214

const CHARACTER_OPTIONS = [
  { value: 'thick', label: 'THICK', title: 'Bass-forward: the low end comes back louder than it left' },
  { value: 'presence', label: 'PRESENCE', title: 'Top-forward: a 4–10 kHz lift with the top octave scooped' },
]

const CHARACTER_CAPTION = {
  thick: 'weight and body',
  presence: 'clarity and forward mids',
}

// ── Response curve ──────────────────────────────────────────────────────────
// Three traces, all drawn from the same coefficient builders the kernel uses:
// what the compressor is fed (pre), what comes back out (post), and the net of
// the two — the curve the wet path actually carries. Showing all three is the
// only way the plugin's one real idea is visible on the panel: the pre curve is
// there to shape the SIDECHAIN, and the net is what you hear.
const CURVE_W = 420
const CURVE_H = 104
const F_MIN = 20
const F_MAX = 20000
// Wide enough to hold Thick's post-EQ recovery, which reaches +9 dB at the
// bottom — the largest single move either character makes.
const DB_RANGE = 12

const CURVE_FREQS = Array.from({ length: 200 }, (_, i) =>
  F_MIN * Math.pow(F_MAX / F_MIN, i / 199),
)

const GRID_FREQS = [20, 100, 1000, 10000, 20000]
const GRID_DB = [-8, -4, 0, 4, 8]

function xFor(freqHz) {
  return (Math.log2(freqHz / F_MIN) / Math.log2(F_MAX / F_MIN)) * CURVE_W
}

function yFor(db) {
  return CURVE_H / 2 - (Math.max(-DB_RANGE, Math.min(DB_RANGE, db)) / DB_RANGE) * (CURVE_H / 2)
}

function pathFor(sections, sr) {
  const db = magnitudeResponseDb(sections, CURVE_FREQS, sr)
  return CURVE_FREQS.map(
    (f, i) => `${i === 0 ? 'M' : 'L'}${xFor(f).toFixed(1)},${yFor(db[i]).toFixed(1)}`,
  ).join(' ')
}

// The response is sample-rate dependent, so use the file's rate where we have
// one and fall back to the most common rate before a file is loaded.
const sampleRate = computed(() => state.currentFile?.sampleRate ?? 44100)

const prePath = computed(() =>
  pathFor(pultecSections(sampleRate.value, schepsCharacter.value, 'pre'), sampleRate.value))
const postPath = computed(() =>
  pathFor(pultecSections(sampleRate.value, schepsCharacter.value, 'post'), sampleRate.value))
const netPath = computed(() =>
  pathFor(pultecNetSections(sampleRate.value, schepsCharacter.value), sampleRate.value))

const netFill = computed(
  () => `${netPath.value} L${CURVE_W},${yFor(0)} L0,${yFor(0)} Z`,
)

function gridLabel(f) {
  return f >= 1000 ? `${f / 1000}k` : String(f)
}

function gridLabelStyle(freqHz) {
  if (freqHz <= F_MIN) return { left: '0%', transform: 'none' }
  if (freqHz >= F_MAX) return { left: '100%', transform: 'translateX(-100%)' }
  return { left: `${(xFor(freqHz) / CURVE_W) * 100}%`, transform: 'translateX(-50%)' }
}

// ── Readouts ────────────────────────────────────────────────────────────────

function formatSquash(v) {
  return String(Math.round(v))
}

function formatMix(v) {
  return `${Math.round(v)}%`
}

function formatOutput(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
}

const trimReadout = computed(() => {
  if (!schepsAutoTrim.value) return 'wet path unmatched'
  if (schepsAutoTrimBusy.value) return 'measuring…'
  const v = schepsWetTrimDb.value
  return `wet ${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
})

const TRACE_KEY = [
  { d: '3 3', c: 'rgba(255,255,255,.45)', t: 'Into compressor' },
  { d: '1 3', c: 'rgba(255,255,255,.45)', t: 'Recovery' },
  { d: '', c: ACCENT, t: 'Net' },
]

// Preview is transport playback — the worklet is already in the chain, so what
// makes it live is that audio is running while you turn the knob.
function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

function close() {
  teardown()
}

async function applyAndClose() {
  await apply()
  teardown()
  closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="scheps-parallel"
    :z="z"
    :width="740"
    :accent="ACCENT"
    design="modula"
    brand-lead="SCHEPS PARALLEL"
    :presets="presets"
    :presets-disabled="!schepsPreview"
    presets-disabled-hint="Turn Scheps Parallel on to use presets"
    :engaged="schepsPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!schepsPreview"
    apply-disabled-hint="Turn Scheps Parallel on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="sc-grid">
      <div class="sc-meter">
        <LevelMeter variant="modula" scale-side="left" :levels="schepsInputLevels" label="IN" :height="METER_H" />
      </div>

      <div class="sc-panel">
        <!-- The wet path's gain reduction, not the summed output's: the blend
             only passes a fraction of it on. -->
        <GainReductionBar :reduction-db="schepsReduction" :accent="ACCENT" />

        <!-- Response curve: pre, post, and the net of the two -->
        <div class="sc-curve">
          <svg
            :viewBox="`0 0 ${CURVE_W} ${CURVE_H}`"
            class="sc-well"
            :style="{ height: `${CURVE_H}px` }"
            preserveAspectRatio="none"
          >
            <line
              v-for="f in GRID_FREQS" :key="`f${f}`"
              :x1="xFor(f)" :y1="0" :x2="xFor(f)" :y2="CURVE_H"
              stroke="rgba(255,255,255,.06)" stroke-width="1"
            />
            <line
              v-for="d in GRID_DB" :key="`d${d}`"
              :x1="0" :y1="yFor(d)" :x2="CURVE_W" :y2="yFor(d)"
              :stroke="d === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.05)'"
              stroke-width="1"
            />
            <path :d="netFill" :fill="ACCENT" fill-opacity="0.12" />
            <path
              :d="prePath" stroke="rgba(255,255,255,.34)" stroke-width="1.25"
              fill="none" stroke-dasharray="3 3"
            />
            <path
              :d="postPath" stroke="rgba(255,255,255,.34)" stroke-width="1.25"
              fill="none" stroke-dasharray="1 3"
            />
            <path :d="netPath" :stroke="ACCENT" stroke-width="2" fill="none" />
          </svg>
          <div class="sc-axis">
            <span v-for="f in GRID_FREQS" :key="f" :style="gridLabelStyle(f)">{{ gridLabel(f) }}</span>
          </div>
          <!-- Trace key. Without it the two faint traces read as decoration. -->
          <div class="sc-key">
            <span v-for="k in TRACE_KEY" :key="k.t">
              <svg width="14" height="4" style="overflow:visible">
                <line
                  x1="0" y1="2" x2="14" y2="2"
                  :stroke="k.c" stroke-width="1.6" :stroke-dasharray="k.d || undefined"
                />
              </svg>
              {{ k.t }}
            </span>
          </div>
        </div>

        <div class="sc-controls">
          <div class="sc-col">
            <span class="m-caption">Character</span>
            <ModulaSegmented
              :model-value="schepsCharacter" :options="CHARACTER_OPTIONS"
              aria-label="Character" :disabled="!schepsPreview"
              @update:model-value="syncCharacter"
            />
            <span class="m-note">{{ CHARACTER_CAPTION[schepsCharacter] }}</span>
          </div>

          <ModulaKnob
            variant="ticks" :size="130" show-value editable
            :model-value="schepsSquash" :min="0" :max="100" :step="1"
            :default-value="SCHEPS_DEFAULTS.squash"
            label="Squash" :color="ACCENT" :format-value="formatSquash" :disabled="!schepsPreview"
            title="How hard the opto cell rides the wet copy. Double-click to reset"
            @update:model-value="syncSquash"
          />
          <ModulaKnob
            variant="ticks" :size="130" show-value editable
            :model-value="schepsMix" :min="0" :max="100" :step="1"
            :default-value="SCHEPS_DEFAULTS.mix"
            label="Mix" :color="ACCENT" :format-value="formatMix" :disabled="!schepsPreview"
            title="How much of the squashed copy sits under the original. Double-click to reset"
            @update:model-value="syncMix"
          />

          <!-- Auto trim sets the wet path's gain BEFORE the blend sums, so
               pushing Mix changes character rather than loudness. Switching
               it off drops to a textbook equal-power crossfade with the wet
               path at whatever level the chain leaves it. -->
          <div class="sc-col">
            <ModulaLedPill
              label="AUTO TRIM" :color="ACCENT"
              :model-value="schepsAutoTrim" :disabled="!schepsPreview"
              :title="schepsAutoTrim
                ? 'Auto trim on: the wet path is level-matched to the dry one, so Mix is a character control. Click to switch it off.'
                : 'Auto trim off: the wet path runs at whatever level the chain leaves it. Click to level-match it.'"
              @update:model-value="toggleAutoTrim"
            />
            <span class="m-note">{{ trimReadout }}</span>
          </div>
        </div>
      </div>

      <div class="sc-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="schepsOutputLevels" label="OUT" :height="METER_H">
          <template #below>
            <ModulaKnob
              variant="trim" :model-value="schepsOutput" show-value
              :min="SCHEPS_OUTPUT_MIN_DB" :max="SCHEPS_OUTPUT_MAX_DB" :step="0.1"
              :default-value="SCHEPS_DEFAULTS.output" :format-value="formatOutput"
              aria-label="Output" :disabled="!schepsPreview"
              title="Output: a trim on the whole plugin, after the blend. Double-click to reset"
              @update:model-value="syncOutput"
            />
          </template>
        </LevelMeter>
      </div>
    </div>

    <p class="sc-about">
      Andrew Scheps' vocal trick: a Pultec pushes the lows out of the way and
      lifts 8 kHz so the opto cell rides the voice instead of the plosives, a
      second Pultec puts the low end back, and the whole squashed copy is
      blended under the original.
    </p>
  </FloatingWindow>
</template>

<style scoped>
.sc-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}
.sc-meter {
  display: flex;
  justify-content: center;
  padding: 12px 4px;
}
.sc-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 14px 16px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.sc-curve { display: flex; flex-direction: column; }
.sc-well {
  display: block;
  width: 100%;
  border-radius: 6px;
  background: #0b0e13;
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, .85), 0 0 0 1px #1c222c, 0 1px 0 rgba(255, 255, 255, .05);
}
.sc-axis {
  position: relative;
  height: 10px;
  margin-top: 4px;
  font: 600 8px/1 var(--m-font-mono);
  letter-spacing: .08em;
  color: var(--m-ink-4);
}
.sc-axis span { position: absolute; top: 0; }
.sc-key {
  display: flex;
  justify-content: center;
  gap: 16px;
  margin-top: 8px;
  font: 600 8px/1 var(--m-font-mono);
  letter-spacing: .08em;
  color: var(--m-ink-4);
}
.sc-key span { display: flex; align-items: center; gap: 5px; }
.sc-controls {
  display: flex;
  align-items: center;
  justify-content: space-around;
  gap: 8px;
  padding-top: 4px;
}
.sc-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.sc-about {
  margin: 12px 8px 0;
  text-align: center;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-4);
}
</style>
