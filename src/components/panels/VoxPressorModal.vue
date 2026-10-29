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
  VOX_DEFAULTS, VOX_OUTPUT_MIN_DB, VOX_OUTPUT_MAX_DB,
  PEAKS_BODY_WARN_DB, BODY_LOOKAHEAD_STEPS_MS, PEAKS_MAX,
} from '../../audio/effects/voxPressorParams.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  voxPeaks, voxBody, voxOutput, voxListen, voxBodyLookahead,
  voxMeasured, voxReadout, voxBusy,
  voxPreview, voxPeaksGr, voxBodyGr, voxInputLevels, voxOutputLevels,
  togglePreview, syncPeaks, syncBody, syncOutput, syncListen, syncBodyLookahead,
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
  { value: 'peaks', label: 'PEAKS SC', title: 'Hear what the 1176 listens to: rumble turned down, plosives and sibilance kept so it can trim them' },
  { value: 'body', label: 'BODY SC', title: 'Hear what the LA-2A listens to: rumble, plosives and sibilance turned down, after the 1176' },
]

// BENCH: LA Vintage 2A's own Lookahead on the Body stage. Off ships.
const LOOKAHEAD_OPTIONS = BODY_LOOKAHEAD_STEPS_MS.map(ms => ({
  value: ms,
  label: ms === 0 ? 'OFF' : `${ms} ms`,
  title: ms === 0
    ? 'No lookahead: the LA-2A as the hardware is'
    : `Delay the audio ${ms} ms so the opto's gain meets each onset early (adds ${ms} ms of latency; pre-ducks consonants at the top)`,
}))

function formatPeaks(v) {
  return v > 0 ? v.toFixed(1) : 'OFF'
}

function formatKnob(v) {
  return v > 0 ? String(Math.round(v)) : 'OFF'
}

function formatOutput(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
}

// The readouts are MEASURED at the knobs (`measureVoxPressor`): the knobs act
// at once, the numbers follow when the measurement lands.
const peaksNote = computed(() => {
  if (voxPeaks.value <= 0) return 'stage out'
  const r = voxReadout.value
  if (!r) return voxBusy.value ? 'measuring…' : '—'
  return `−${r.peaksDb.toFixed(1)} dB on peaks`
})
// A warning, never a cap: the knob always goes where it is turned, and this
// says when that has started lowering the voice itself (PEAKS_BODY_WARN_DB).
const peaksWarn = computed(() => {
  const r = voxReadout.value
  return !!r && voxPeaks.value > 0 && r.peaksBodyDb > PEAKS_BODY_WARN_DB
})
const bodyTouchNote = computed(() => {
  const r = voxReadout.value
  if (!r || voxPeaks.value <= 0) return ''
  const touched = `voice touched ${r.peaksBodyDb.toFixed(1)} dB`
  return r.peaksBodyDb > PEAKS_BODY_WARN_DB ? `${touched} · compressing the voice` : touched
})

const bodyNote = computed(() => {
  if (voxBody.value <= 0) return 'stage out'
  const r = voxReadout.value
  if (!r) return voxBusy.value ? 'measuring…' : '—'
  return `${r.bodyDb.toFixed(1)} dB avg leveling`
})
// The numbers on screen describe the knobs they were measured at; while a
// newer measurement is in flight they are dimmed rather than blanked.
const stale = computed(() => voxBusy.value && !!voxReadout.value)

const measuredNote = computed(() => {
  const m = voxMeasured.value
  const corner = Number.isFinite(m.cornerHz) ? `voice corner ${Math.round(m.cornerHz)} Hz` : 'voice corner 80 Hz (default)'
  // Per-stage makeup, restores included: the 1176's lands on its Output, the
  // LA-2A's is its Gain plus the restore after the chain.
  const sign = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
  const makeup = `makeup 1176 ${sign(m.peaksMakeupDb ?? 0)} · LA-2A ${sign((m.bodyMakeupDb ?? 0) + (m.makeupDb ?? 0))} dB`
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
              :model-value="voxPeaks" :min="0" :max="PEAKS_MAX" :step="0.5"
              :default-value="VOX_DEFAULTS.peaks"
              label="Peaks" :color="PEAKS_COLOR" :format-value="formatPeaks" :disabled="!voxPreview"
              title="How hard the 1176 catches the loudest peaks: about that many dB off them on typical narration (the note below says what it took on this file). 0 takes the stage out. Double-click to reset"
              @update:model-value="syncPeaks"
            />
            <span class="m-note" :class="{ 'vp-warn': peaksWarn, 'vp-stale': stale }">{{ peaksNote }}</span>
            <span class="m-note" :class="{ 'vp-warn': peaksWarn, 'vp-stale': stale }">{{ bodyTouchNote }}</span>
          </div>
          <div class="vp-col">
            <ModulaKnob
              variant="ticks" :size="130" show-value editable
              :model-value="voxBody" :min="0" :max="100" :step="1"
              :default-value="VOX_DEFAULTS.body"
              label="Body · LA-2A Peak Red." :color="ACCENT" :format-value="formatKnob" :disabled="!voxPreview"
              title="The LA-2A's Peak Reduction, aligned to this file's level and to what the 1176 stage hands it. 0 takes the stage out. Double-click to reset"
              @update:model-value="syncBody"
            />
            <span class="m-note" :class="{ 'vp-stale': stale }">{{ bodyNote }}</span>
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
        <div class="vp-listen vp-bench">
          <span class="m-caption">Bench · Body lookahead</span>
          <ModulaSegmented
            :model-value="voxBodyLookahead" :options="LOOKAHEAD_OPTIONS"
            aria-label="Body lookahead" :disabled="!voxPreview"
            @update:model-value="syncBodyLookahead"
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
              title="Output trim, after the peak-restoring makeup and the source-peak ceiling. Double-click to reset"
              @update:model-value="syncOutput"
            />
          </template>
        </LevelMeter>
      </div>
    </div>

    <p class="vp-about">
      Stage 1 (dev): a 1176 trims the peaks, then an LA-2A levels the voice.
      Both listen through a voice detector that ignores rumble; the LA-2A also
      ignores plosives and sibilance. Each makes up its own level, as in a hand-built chain, so what they take off comes back as loudness;
      a lookahead limiter after each holds the source's peak with a gain, never a clipper.
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
.vp-bench { padding-top: 8px; border-top: 1px dashed rgba(255, 255, 255, .08); }
.vp-warn { color: #f0b429; }
.vp-stale { opacity: .55; }
.vp-about {
  margin: 12px 8px 0;
  text-align: center;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-4);
}
</style>
