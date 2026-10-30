<script setup>
import { computed, onMounted } from 'vue'
import { useVoxPressor } from '../../composables/useVoxPressor.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { releaseSecondsForDial } from '../../audio/fet1176Processor.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'
import {
  VOX_DEFAULTS, VOX_OUTPUT_MIN_DB, VOX_OUTPUT_MAX_DB,
  PEAKS_BODY_WARN_DB, BODY_LOOKAHEAD_STEPS_MS, PEAKS_MAX, PEAKS_RIPPLE_WARN_DB, peaksTiming,
} from '../../audio/effects/voxPressorParams.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  voxPeaks, voxBody, voxOutput, voxListen, voxBodyLookahead, voxSpeed,
  voxDeEss, voxParallel, voxDensity, voxDeEssGr, voxParallelGr,
  voxMeasured, voxReadout, voxBusy,
  voxPreview, voxPeaksGr, voxBodyGr, voxInputLevels, voxOutputLevels,
  togglePreview, syncPeaks, syncBody, syncOutput, syncListen, syncBodyLookahead, syncSpeed,
  syncDeEss, syncParallel, syncDensity,
  apply, teardown, closeModal,
} = useVoxPressor()

const { state } = useEditorState()

onMounted(() => {
  // The chain's copy keeps its ON/BYPASS (see SchepsModal).
  if (!voxPreview.value && currentPluginCopy() === 'solo') togglePreview()
})

const ACCENT = '#e8a33d'
const PEAKS_COLOR = '#ff7a59'
const DEESS_COLOR = '#7fd1c7'
const PARALLEL_COLOR = '#b9a2ff'
const DENSITY_COLOR = '#f2d16b'

function formatPercent(v) {
  return v > 0 ? `${Math.round(v)} %` : 'OFF'
}
const METER_H = 214

const LISTEN_OPTIONS = [
  { value: 'off', label: 'OUTPUT', title: 'Hear the processed voice' },
  { value: 'peaks', label: 'PEAKS SC', title: 'Hear what the 1176 listens to: rumble turned down, plosives and sibilance kept so it can trim them' },
  { value: 'body', label: 'BODY SC', title: 'Hear what the LA-2A listens to: rumble, plosives and sibilance turned down, after the 1176' },
]

// The 1176's SPEED (`PEAKS_SPEEDS`): AUTO follows the voice's pitch.
const SPEED_OPTIONS = [
  { value: 'auto', label: 'AUTO', title: 'Release follows the voice: slow enough for its pitch that the gain does not ripple on each cycle' },
  { value: 'gentle', label: 'GENTLE', title: 'Slow attack and release: the cleanest, catches the least' },
  { value: 'normal', label: 'NORMAL', title: 'Medium attack and release' },
  { value: 'fast', label: 'FAST', title: 'Fast attack and release: grabs every onset; can ripple on low voices' },
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

// Gain ripple: the 1176 moving its gain within the voice's own cycles. A
// warning, never a limit, like the voice-touched note.
const rippleWarn = computed(() => {
  const r = voxReadout.value
  return !!r && voxPeaks.value > 0 && Number.isFinite(r.peaksRippleDb) && r.peaksRippleDb > PEAKS_RIPPLE_WARN_DB
})
const rippleNote = computed(() => {
  const r = voxReadout.value
  if (!r || voxPeaks.value <= 0 || !Number.isFinite(r.peaksRippleDb)) return ''
  const v = `ripple ${r.peaksRippleDb.toFixed(0)} dB`
  return rippleWarn.value ? `${v} · distorting${voxSpeed.value === 'gentle' ? '' : ', try GENTLE'}` : v
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
  const t = peaksTiming(voxSpeed.value, m.voiceF0Hz)
  const release = `release ${Math.round(releaseSecondsForDial(t.release) * 1000)} ms`
  const speed = voxSpeed.value === 'auto'
    ? (Number.isFinite(m.voiceF0Hz) ? `F0 ${Math.round(m.voiceF0Hz)} Hz → ${release}` : `${release} until F0 is measured`)
    : release
  // Per-stage makeup, restores included: the 1176's lands on its Output, the
  // LA-2A's is its Gain plus the restore after the chain.
  const sign = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
  const makeup = `makeup 1176 ${sign(m.peaksMakeupDb ?? 0)} · LA-2A ${sign((m.bodyMakeupDb ?? 0) + (m.makeupDb ?? 0))} dB`
  return `${corner} · ${speed} · ${makeup}`
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
    :width="900"
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
        <div class="vp-bars">
          <GainReductionBar :reduction-db="voxPeaksGr" :accent="PEAKS_COLOR" title="PEAKS · 1176" :full-scale-db="12" />
          <GainReductionBar :reduction-db="voxDeEssGr" :accent="DEESS_COLOR" title="DE-ESS" :full-scale-db="12" />
          <GainReductionBar :reduction-db="voxBodyGr" :accent="ACCENT" title="BODY · LA-2A" :full-scale-db="12" />
          <GainReductionBar :reduction-db="voxParallelGr" :accent="PARALLEL_COLOR" title="PARALLEL (WET)" :full-scale-db="12" />
        </div>

        <div class="vp-controls">
          <div class="vp-col">
            <ModulaKnob
              variant="ticks" :size="108" show-value editable
              :model-value="voxPeaks" :min="0" :max="PEAKS_MAX" :step="0.5"
              :default-value="VOX_DEFAULTS.peaks"
              label="Peaks" :color="PEAKS_COLOR" :format-value="formatPeaks" :disabled="!voxPreview"
              title="How hard the 1176 catches the loudest peaks: about that many dB off them on typical narration (the note below says what it took on this file). 0 takes the stage out. Double-click to reset"
              @update:model-value="syncPeaks"
            />
            <span class="m-note" :class="{ 'vp-warn': peaksWarn, 'vp-stale': stale }">{{ peaksNote }}</span>
            <span class="m-note" :class="{ 'vp-warn': peaksWarn, 'vp-stale': stale }">{{ bodyTouchNote }}</span>
            <span class="m-note" :class="{ 'vp-warn': rippleWarn, 'vp-stale': stale }">{{ rippleNote }}</span>
          </div>
          <div class="vp-col">
            <ModulaKnob
              variant="ticks" :size="108" show-value editable
              :model-value="voxBody" :min="0" :max="100" :step="1"
              :default-value="VOX_DEFAULTS.body"
              label="Body · LA-2A Peak Red." :color="ACCENT" :format-value="formatKnob" :disabled="!voxPreview"
              title="The LA-2A's Peak Reduction, aligned to this file's level and to what the 1176 stage hands it. 0 takes the stage out. Double-click to reset"
              @update:model-value="syncBody"
            />
            <span class="m-note" :class="{ 'vp-stale': stale }">{{ bodyNote }}</span>
          </div>
        </div>

        <div class="vp-controls vp-row2">
          <div class="vp-col vp-col-sm">
            <ModulaKnob
              variant="ticks" :size="80" show-value editable
              :model-value="voxDeEss" :min="0" :max="100" :step="1"
              :default-value="VOX_DEFAULTS.deEss"
              label="De-ess" :color="DEESS_COLOR" :format-value="formatKnob" :disabled="!voxPreview"
              title="The HF Softener's Amount, after the compressors: takes down the sibilance they brought up. 0 takes the stage out. Double-click to reset"
              @update:model-value="syncDeEss"
            />
          </div>
          <div class="vp-col vp-col-sm">
            <ModulaKnob
              variant="ticks" :size="80" show-value editable
              :model-value="voxParallel" :min="0" :max="100" :step="1"
              :default-value="VOX_DEFAULTS.parallel"
              label="Parallel" :color="PARALLEL_COLOR" :format-value="formatPercent" :disabled="!voxPreview"
              title="Parallel compression: a fast 4:1 1176 copy blended under the voice. The peaks stay put and the quieter parts come up. 0 takes the stage out. Double-click to reset"
              @update:model-value="syncParallel"
            />
          </div>
          <div class="vp-col vp-col-sm">
            <ModulaKnob
              variant="ticks" :size="80" show-value editable
              :model-value="voxDensity" :min="0" :max="100" :step="1"
              :default-value="VOX_DEFAULTS.density"
              label="Density" :color="DENSITY_COLOR" :format-value="formatPercent" :disabled="!voxPreview"
              title="The Cambridge Inflator's Effect, anchored at the source peak: lifts the body under a fixed peak with odd harmonics. 0 takes the stage out. Double-click to reset"
              @update:model-value="syncDensity"
            />
          </div>
        </div>

        <div class="vp-listen">
          <span class="m-caption">Speed</span>
          <ModulaSegmented
            :model-value="voxSpeed" :options="SPEED_OPTIONS"
            aria-label="Peaks speed" :disabled="!voxPreview || voxPeaks <= 0"
            @update:model-value="syncSpeed"
          />
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
      Dev: a 1176 trims the peaks, an LA-2A levels the voice, then a de-esser, a parallel 1176 and an anchored Inflator.
      The compressors listen through a voice detector that ignores rumble; the LA-2A also
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
  gap: 4px;
  min-height: 176px;
}
.vp-bars {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 14px;
}
.vp-row2 { padding-top: 10px; border-top: 1px solid rgba(255, 255, 255, .06); }
.vp-col-sm { min-height: 0; }
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
