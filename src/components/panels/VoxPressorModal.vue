<script setup>
import { computed, onMounted } from 'vue'
import { useVoxPressor } from '../../composables/useVoxPressor.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'
import {
  VOX_DEFAULTS, VOX_OUTPUT_MIN_DB, VOX_OUTPUT_MAX_DB, PEAKS_MAX_DB, BODY_MAX_DB,
} from '../../audio/effects/voxPressorParams.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  voxPeaks, voxBody, voxOutput, voxListen,
  voxMeasured, voxReadout, voxBusy,
  voxPreview, voxPeaksGr, voxBodyGr, voxInputLevels, voxOutputLevels,
  togglePreview, syncPeaks, syncBody, syncOutput, syncListen,
  apply, teardown, closeModal,
} = useVoxPressor()

const { state } = useEditorState()

onMounted(() => {
  // The chain's copy keeps its ON/BYPASS (see SchepsModal).
  if (!voxPreview.value && currentPluginCopy() === 'solo') togglePreview()
})

const ACCENT = '#e8a33d'
const PEAKS_COLOR = '#ff7a59'
const METER_H = 214

const LISTEN_OPTIONS = [
  { value: 'off', label: 'OUTPUT', title: 'Hear the processed voice' },
  { value: 'peaks', label: 'PEAKS SC', title: 'Hear what the 1176 listens to: rumble and sibilance turned down, plosives kept' },
  { value: 'body', label: 'BODY SC', title: 'Hear what the LA-2A listens to: rumble, plosives and sibilance turned down, after the 1176' },
]

function formatDb(v) {
  return v > 0 ? `${v.toFixed(1)} dB` : 'OFF'
}

function formatOutput(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
}

/** Peaks: what was reached, and whether the 1176 is reaching into the voice. */
const peaksNote = computed(() => {
  if (voxPeaks.value <= 0) return 'stage out'
  if (voxBusy.value) return 'solving…'
  const r = voxReadout.value
  if (!r) return '—'
  const reached = `−${r.peaksDb.toFixed(1)} dB on peaks`
  return r.peaksLimited ? `${reached} · voice crest too low` : reached
})
const peaksWarn = computed(() => {
  const r = voxReadout.value
  return !!r && voxPeaks.value > 0 && (r.peaksLimited || r.peaksBodyDb > 0.5)
})
const bodyTouchNote = computed(() => {
  const r = voxReadout.value
  if (!r || voxPeaks.value <= 0) return ''
  return `body touched ${r.peaksBodyDb.toFixed(1)} dB`
})

const bodyNote = computed(() => {
  if (voxBody.value <= 0) return 'stage out'
  if (voxBusy.value) return 'solving…'
  const r = voxReadout.value
  return r ? `${r.bodyDb.toFixed(1)} dB avg leveling` : '—'
})

const measuredNote = computed(() => {
  const m = voxMeasured.value
  const corner = Number.isFinite(m.cornerHz) ? `voice corner ${Math.round(m.cornerHz)} Hz` : 'voice corner 80 Hz (default)'
  const makeup = `makeup ${m.makeupDb >= 0 ? '+' : ''}${(m.makeupDb ?? 0).toFixed(1)} dB`
  return `${corner} · ${makeup}`
})

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
    window-id="vox-pressor"
    :z="z"
    :width="700"
    :accent="ACCENT"
    design="modula"
    brand-lead="VOXPRESSOR"
    :engaged="voxPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!voxPreview"
    apply-disabled-hint="Turn VoxPressor on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="vp-grid">
      <div class="vp-meter">
        <LevelMeter variant="modula" scale-side="left" :levels="voxInputLevels" label="IN" :height="METER_H" />
      </div>

      <div class="vp-panel">
        <GainReductionBar :reduction-db="voxPeaksGr" :accent="PEAKS_COLOR" title="PEAKS · 1176" :full-scale-db="12" />
        <GainReductionBar :reduction-db="voxBodyGr" :accent="ACCENT" title="BODY · LA-2A" :full-scale-db="12" />

        <div class="vp-controls">
          <div class="vp-col">
            <ModulaKnob
              variant="ticks" :size="130" show-value editable
              :model-value="voxPeaks" :min="0" :max="PEAKS_MAX_DB" :step="0.5"
              :default-value="VOX_DEFAULTS.peaks"
              label="Peaks" :color="PEAKS_COLOR" :format-value="formatDb" :disabled="!voxPreview"
              title="dB the 1176 takes off the loudest voice peaks, solved for this file. Double-click to reset"
              @update:model-value="syncPeaks"
            />
            <span class="m-note" :class="{ 'vp-warn': peaksWarn }">{{ peaksNote }}</span>
            <span class="m-note" :class="{ 'vp-warn': peaksWarn }">{{ bodyTouchNote }}</span>
          </div>
          <div class="vp-col">
            <ModulaKnob
              variant="ticks" :size="130" show-value editable
              :model-value="voxBody" :min="0" :max="BODY_MAX_DB" :step="0.5"
              :default-value="VOX_DEFAULTS.body"
              label="Body" :color="ACCENT" :format-value="formatDb" :disabled="!voxPreview"
              title="Average dB of leveling the LA-2A does on the voice, solved for this file. Double-click to reset"
              @update:model-value="syncBody"
            />
            <span class="m-note">{{ bodyNote }}</span>
          </div>
        </div>

        <div class="vp-listen">
          <span class="m-caption">Listen</span>
          <ModulaSegmented
            :model-value="voxListen" :options="LISTEN_OPTIONS"
            aria-label="Listen" :disabled="!voxPreview"
            @update:model-value="syncListen"
          />
        </div>
        <span class="m-note vp-measured">{{ measuredNote }}</span>
      </div>

      <div class="vp-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="voxOutputLevels" label="OUT" :height="METER_H">
          <template #below>
            <ModulaKnob
              variant="trim" :model-value="voxOutput" show-value
              :min="VOX_OUTPUT_MIN_DB" :max="VOX_OUTPUT_MAX_DB" :step="0.1"
              :default-value="VOX_DEFAULTS.output" :format-value="formatOutput"
              aria-label="Output" :disabled="!voxPreview"
              title="Output trim, after the level-matched makeup and the source-peak ceiling. Double-click to reset"
              @update:model-value="syncOutput"
            />
          </template>
        </LevelMeter>
      </div>
    </div>

    <p class="vp-about">
      Stage 1 (dev): a 1176 trims the peaks, then an LA-2A levels the voice.
      Both listen through a voice detector that ignores rumble and sibilance;
      the LA-2A also ignores plosives. Output is level-matched to the input.
    </p>
  </FloatingWindow>
</template>

<style scoped>
.vp-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}
.vp-meter {
  display: flex;
  justify-content: center;
  padding: 12px 4px;
}
.vp-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 14px 16px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.vp-controls {
  display: flex;
  justify-content: space-around;
  gap: 8px;
  padding-top: 4px;
}
.vp-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-height: 190px;
}
.vp-listen {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.vp-measured { text-align: center; }
.vp-warn { color: #f0b429; }
.vp-about {
  margin: 12px 8px 0;
  text-align: center;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-4);
}
</style>
