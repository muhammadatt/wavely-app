<script setup>
import { computed, onMounted, ref } from 'vue'
import { useVoxPressor } from '../../composables/useVoxPressor.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { releaseSecondsForDial } from '../../audio/fet1176Processor.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import ModulaFillSlider from '../modula/ModulaFillSlider.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'
import { isVoxPressorBenchVisible } from '../../audio/effects/voxPressorBench.js'
import {
  VOX_DEFAULTS, VOX_OUTPUT_MIN_DB, VOX_OUTPUT_MAX_DB,
  PEAKS_BODY_WARN_DB, BODY_LOOKAHEAD_STEPS_MS, PEAKS_MAX, PARALLEL_DRIVE_MAX, BODY_MAX, bodyPrFor, PEAKS_RIPPLE_WARN_DB, peaksTiming,
} from '../../audio/effects/voxPressorParams.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  voxPeaks, voxBody, voxOutput, voxBodyLookahead, voxSpeed,
  voxPeaksMode, voxCharacter, voxCeiling, syncPeaksMode, syncCharacter, syncCeiling,
  voxDeEss, voxParallel, voxParallelComp, voxDensity, voxDeEssGr, voxParallelGr,
  voxParallelDeEss, voxParallelSibEmph, voxParallelDeEssMode, voxDeEssSplit,
  voxPeaksGuide, voxPeaksAuto, togglePeaksAuto, voxUpstreamStale, voxDownstreamPending,
  voxParallelDrive, syncParallelDrive,
  voxMeasured, voxReadout, voxBusy,
  voxPreview, voxPeaksGr, voxBodyGr, voxInputLevels, voxOutputLevels,
  togglePreview, syncPeaks, syncBody, syncOutput, syncBodyLookahead, syncSpeed,
  syncDeEss, syncParallel, syncParallelComp, syncDensity,
  syncParallelDeEss, syncParallelSibEmph, syncParallelDeEssMode, syncDeEssSplit,
  apply, teardown, closeModal,
} = useVoxPressor()

const { state } = useEditorState()

// The bench: dev builds (or the localStorage flag) only, and shut by default.
const showBench = isVoxPressorBenchVisible()
const benchOpen = ref(false)

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


// The 1176's SPEED (`PEAKS_SPEEDS`): AUTO follows the voice's pitch.
const SPEED_OPTIONS = [
  { value: 'auto', label: 'AUTO', title: 'Release follows the voice: slow enough for its pitch that the gain does not ripple on each cycle' },
  { value: 'gentle', label: 'GENTLE', title: 'Slow attack and release: the cleanest, catches the least' },
  { value: 'normal', label: 'NORMAL', title: 'Medium attack and release' },
  { value: 'fast', label: 'FAST', title: 'Fast attack and release: grabs every onset; can ripple on low voices' },
]

// PEAKS CHARACTER: the 1176's ratio button (`PEAKS_MODES`).
const PEAKS_MODE_OPTIONS = [
  { value: 'hard', label: 'HARD', title: '12:1: a limiter. The loudest peaks are held down hard; the rest is left alone' },
  { value: 'soft', label: 'SOFT', title: '4:1: a gentler peak compressor for a dynamic performance. Starts at the same place, takes less off each step' },
]

// CHARACTER: the LA-2As' tube colour (Body, and the Parallel copy when it is the LA-2A).
const CHARACTER_OPTIONS = [
  { value: 'warm', label: 'WARM', title: "The LA-2A's tube cell and output valve: a little even-harmonic warmth" },
  { value: 'clean', label: 'CLEAN', title: 'The same leveling as a pure gain: no tube colour. Also cleans the Parallel copy when it is the LA-2A' },
]

// OUTPUT CEILING: where the output peak lands.
const CEILING_OPTIONS = [
  { value: 'source', label: 'SOURCE', title: "The output peak stays at the source's own peak" },
  { value: '-1', label: '−1 dB', title: 'The output peak lands at −1 dBFS (podcast / streaming)' },
  { value: '-3', label: '−3 dB', title: 'The output peak lands at −3 dBFS (ACX)' },
]

const PARALLEL_DEESS_OPTIONS = [0, 25, 50, 75, 100].map(v => ({
  value: v, label: v === 0 ? 'OFF' : String(v),
  title: v === 0 ? 'No de-esser on the copy' : `De-ess the parallel copy before the blend (${v})`,
}))
const PARALLEL_DEESS_MODE_OPTIONS = [
  { value: 'broadband', label: 'FULL', title: 'Turn the whole copy down: the dry carries the fricative untouched' },
  { value: 'shelf', label: '4K', title: 'Cut the copy above 4 kHz' },
  { value: 'shelf-low', label: '2.5K', title: 'Cut the copy above 2.5 kHz' },
]
const SIB_EMPH_OPTIONS = [
  { value: true, label: 'ON', title: "The parallel 1176's detector hears sibilance +15 dB, so it ducks the copy on an \"s\"" },
  { value: false, label: 'OFF', title: 'The parallel 1176 hears the voice flat' },
]

const PARALLEL_COMP_OPTIONS = [
  { value: 'la2a', label: 'LA-2A', title: 'A slow, smooth opto copy (an LA Vintage 2A): thickens the body without grabbing the onsets' },
  { value: '1176', label: '1176', title: 'A fast 4:1 1176 copy (New York compression)' },
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

function formatBody(v) {
  if (v <= 0) return 'OFF'
  return Number.isInteger(v * 2) ? v.toFixed(1) : v.toFixed(2)
}

function formatDrive(v) {
  return v.toFixed(1)
}

const formatSplit = v => (v <= 0 ? 'ALL WIDE' : v >= 100 ? 'ALL SPLIT' : `${100 - Math.round(v)} / ${Math.round(v)}`)

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

// THE PEAKS GUIDE (`measureVoxPressor`'s `peaksGuide`): green up to the knob
// that brings the loudest peaks down to the voice, amber until the stage
// starts compressing the voice itself, red past it. A guide, never a cap.
const GUIDE_OK = '#6fd08c'
const GUIDE_EDGE = '#e8a33d'
const GUIDE_OVER = '#ff5a5a'
const peaksZones = computed(() => {
  const g = voxPeaksGuide.value
  if (!g) return null
  const red = Math.max(g.target, g.warn)
  return [
    { from: 0, to: g.target, color: GUIDE_OK },
    { from: g.target, to: red, color: GUIDE_EDGE },
    { from: red, to: PEAKS_MAX, color: GUIDE_OVER },
  ]
})
const guideNote = computed(() => {
  const g = voxPeaksGuide.value
  if (!g) return ''
  if (g.gapDb < 0.5) return 'peaks already sit with the voice'
  return `peaks stand ${g.gapDb.toFixed(1)} dB over the voice · ${g.target.toFixed(1)} levels them`
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
  return `PR ${Math.round(bodyPrFor(voxBody.value))} · ${r.bodyDb.toFixed(1)} dB avg leveling`
})
// The numbers on screen describe the knobs they were measured at; while a
// newer measurement is in flight they are dimmed rather than blanked.
// Only when the measurement in flight can change them: a Parallel move
// re-solves Parallel alone and leaves these exactly as they are.
const stale = computed(() => voxUpstreamStale.value)

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
              :zones="peaksZones"
              title="How hard the 1176 catches the loudest peaks: about that many dB off them on typical narration (the note below says what it took on this file). The ring is green up to where this file's loudest peaks come down to the voice, amber after, red where the stage starts compressing the voice itself — the later stages are there for that. 0 takes the stage out. Double-click to reset"
              @update:model-value="syncPeaks"
            />
            <div class="vp-guide">
              <button
                type="button" class="vp-auto" :class="{ 'is-on': voxPeaksAuto }" :disabled="!voxPreview"
                role="switch" :aria-checked="voxPeaksAuto" :style="{ '--vp-auto': GUIDE_OK }"
                title="Set Peaks for this file: just enough to bring its loudest peaks down to the voice, and follow the selection. Turn the knob to take over; AUTO drops and keeps the value"
                @click="togglePeaksAuto"
              ><span class="vp-auto-dot"></span>AUTO</button>
              <span class="m-note" :class="{ 'vp-stale': stale }">{{ guideNote }}</span>
            </div>
            <span class="m-note" :class="{ 'vp-warn': peaksWarn, 'vp-stale': stale }"><i v-if="stale" class="vp-pulse" aria-hidden="true"></i>{{ peaksNote }}</span>
            <span class="m-note" :class="{ 'vp-warn': peaksWarn, 'vp-stale': stale }">{{ bodyTouchNote }}</span>
            <span class="m-note" :class="{ 'vp-warn': rippleWarn, 'vp-stale': stale }">{{ rippleNote }}</span>
          </div>
          <div class="vp-col">
            <ModulaKnob
              variant="ticks" :size="108" show-value editable
              :model-value="voxBody" :min="0" :max="BODY_MAX" :step="0.25"
              :default-value="VOX_DEFAULTS.body"
              label="Body · LA-2A" :color="ACCENT" :format-value="formatBody" :disabled="!voxPreview"
              title="How hard the LA-2A levels the voice: its Peak Reduction over the useful span, 1 = PR 42, 4.75 = PR 57, 10 = PR 78 (4 points a step), aligned to this file's level and to what the 1176 stage hands it. 0 takes the stage out. Double-click to reset"
              @update:model-value="syncBody"
            />
            <span class="m-note" :class="{ 'vp-stale': stale }"><i v-if="stale" class="vp-pulse" aria-hidden="true"></i>{{ bodyNote }}</span>
            <ModulaSegmented
              :model-value="voxCharacter" :options="CHARACTER_OPTIONS"
              aria-label="Character" :disabled="!voxPreview"
              @update:model-value="syncCharacter"
            />
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
            <ModulaFillSlider
              orientation="horizontal" :length="120"
              :model-value="voxDeEssSplit" :min="0" :max="100" :step="1" :default-value="VOX_DEFAULTS.deEssSplit"
              label="" :ends="['WIDE', 'SPLIT']" flat :format-value="formatSplit"
              :color="DEESS_COLOR" :disabled="!voxPreview || voxDeEss <= 0"
              aria-label="De-ess split between wide band and split band"
              title="Where the De-ess Amount goes. Left: all to the wide band Duck, which turns the whole S down and keeps its tone. Right: all to the split band EQ, which cuts only the top end. Double-click to reset"
              @update:model-value="syncDeEssSplit"
            />
          </div>
          <div class="vp-col vp-col-sm">
            <div class="vp-pair">
              <ModulaKnob
                variant="ticks" :size="80" show-value editable
                :model-value="voxParallel" :min="0" :max="100" :step="1"
                :default-value="VOX_DEFAULTS.parallel"
                label="Parallel" :color="PARALLEL_COLOR" :format-value="formatPercent" :disabled="!voxPreview"
                title="Parallel compression: a heavily compressed copy blended under the voice. The peaks stay put and the quieter parts come up. 0 takes the stage out. Double-click to reset"
                @update:model-value="syncParallel"
              />
              <ModulaKnob
                variant="small" :size="52" show-value editable
                :model-value="voxParallelDrive" :min="0" :max="PARALLEL_DRIVE_MAX" :step="0.5"
                :default-value="VOX_DEFAULTS.parallelDrive"
                label="Drive" :color="PARALLEL_COLOR" :format-value="formatDrive" :disabled="!voxPreview || voxParallel <= 0"
                title="How hard the parallel copy is compressed. On the LA-2A it is Peak Reduction: 0 = PR 38, 3 = PR 50, 10 = PR 78; the 1176 is set so the same position compresses about as hard. The copy's makeup is re-measured. Double-click to reset"
                @update:model-value="syncParallelDrive"
              />
            </div>
            <ModulaSegmented
              :model-value="voxParallelComp" :options="PARALLEL_COMP_OPTIONS"
              aria-label="Parallel compressor" :disabled="!voxPreview || voxParallel <= 0"
              @update:model-value="syncParallelComp"
            />
            <!-- De-ess and Parallel re-solve after Body: their makeups land last. -->
            <span class="m-note vp-pending" :class="{ 'is-on': voxBusy && voxPreview }" aria-live="polite">
              <i class="vp-pulse" aria-hidden="true"></i>{{ voxDownstreamPending ? 'updating makeup' : 'measuring' }}
            </span>
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
          <span class="m-caption">Peaks</span>
          <ModulaSegmented
            :model-value="voxPeaksMode" :options="PEAKS_MODE_OPTIONS"
            aria-label="Peaks character" :disabled="!voxPreview || voxPeaks <= 0"
            @update:model-value="syncPeaksMode"
          />
          <span class="m-caption">Speed</span>
          <ModulaSegmented
            :model-value="voxSpeed" :options="SPEED_OPTIONS"
            aria-label="Peaks speed" :disabled="!voxPreview || voxPeaks <= 0"
            @update:model-value="syncSpeed"
          />
        </div>
        <div class="vp-listen">
          <span class="m-caption">Ceiling</span>
          <ModulaSegmented
            :model-value="voxCeiling" :options="CEILING_OPTIONS"
            aria-label="Output ceiling" :disabled="!voxPreview"
            @update:model-value="syncCeiling"
          />
        </div>
        <div v-if="showBench" class="vp-bench-wrap">
          <button
            type="button" class="vp-bench-toggle" :aria-expanded="benchOpen"
            title="Dev-only A/B settings and the measured values. Not on the shipping faceplate"
            @click="benchOpen = !benchOpen"
          >BENCH {{ benchOpen ? '▴' : '▾' }}</button>
          <div v-if="benchOpen" class="vp-bench-body">
            <div class="vp-listen vp-bench">
              <span class="m-caption">Body lookahead</span>
              <ModulaSegmented
                :model-value="voxBodyLookahead" :options="LOOKAHEAD_OPTIONS"
                aria-label="Body lookahead" :disabled="!voxPreview"
                @update:model-value="syncBodyLookahead"
              />
            </div>
            <div class="vp-listen vp-bench">
              <span class="m-caption">Parallel de-ess</span>
              <ModulaSegmented
                :model-value="voxParallelDeEss" :options="PARALLEL_DEESS_OPTIONS"
                aria-label="Parallel de-ess" :disabled="!voxPreview || voxParallel <= 0"
                @update:model-value="syncParallelDeEss"
              />
            </div>
            <div class="vp-listen vp-bench">
              <span class="m-caption">Parallel de-ess cut</span>
              <ModulaSegmented
                :model-value="voxParallelDeEssMode" :options="PARALLEL_DEESS_MODE_OPTIONS"
                aria-label="Parallel de-ess cut" :disabled="!voxPreview || voxParallel <= 0 || voxParallelDeEss <= 0"
                @update:model-value="syncParallelDeEssMode"
              />
            </div>
            <div v-if="voxParallelComp === '1176'" class="vp-listen vp-bench">
              <span class="m-caption">1176 sib detector</span>
              <ModulaSegmented
                :model-value="voxParallelSibEmph" :options="SIB_EMPH_OPTIONS"
                aria-label="Parallel 1176 sibilance detector" :disabled="!voxPreview || voxParallel <= 0"
                @update:model-value="syncParallelSibEmph"
              />
            </div>
            <span class="m-note vp-measured">{{ measuredNote }}</span>
          </div>
        </div>
      </div>

      <div class="vp-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="voxOutputLevels" label="OUT" :height="METER_H">
          <template #below>
            <ModulaKnob
              variant="trim" :model-value="voxOutput" show-value
              :min="VOX_OUTPUT_MIN_DB" :max="VOX_OUTPUT_MAX_DB" :step="0.1"
              :default-value="VOX_DEFAULTS.output" :format-value="formatOutput"
              aria-label="Output" :disabled="!voxPreview"
              title="Output trim, after the ceiling: anything but 0 moves the peak off it. Double-click to reset"
              @update:model-value="syncOutput"
            />
          </template>
        </LevelMeter>
      </div>
    </div>

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
.vp-pair { display: flex; align-items: flex-end; gap: 10px; }
.vp-listen {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.vp-measured { text-align: center; }
.vp-bench { padding-top: 8px; border-top: 1px dashed rgba(255, 255, 255, .08); }
.vp-bench-wrap { margin-top: 10px; border-top: 1px dashed rgba(255, 255, 255, .1); padding-top: 8px; display: flex; flex-direction: column; align-items: center; }
.vp-bench-toggle {
  border: 0; border-radius: 6px; padding: 4px 10px; cursor: pointer;
  background: linear-gradient(180deg, #34383e, #25282d);
  box-shadow: 0 2px 4px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .1), 0 0 0 1px rgba(0, 0, 0, .5);
  font: 600 10px/1 var(--m-font-mono); letter-spacing: .1em; color: var(--m-ink-3, #8a929a);
}
.vp-bench-toggle:hover { color: var(--m-ink-2, #c3c9cf); }
.vp-bench-body { align-self: stretch; display: flex; flex-direction: column; }
.vp-warn { color: #f0b429; }
.vp-stale { opacity: .7; }
/* A measurement in flight: a pulsing dot ahead of the numbers it will replace. */
.vp-pulse {
  display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%;
  background: #e8a33d; box-shadow: 0 0 6px #e8a33d; vertical-align: 1px;
  animation: vp-pulse 0.9s ease-in-out infinite;
}
@keyframes vp-pulse { 0%, 100% { opacity: .45 } 50% { opacity: 1 } }
.vp-pending { visibility: hidden; }
.vp-pending.is-on { visibility: visible; }
.vp-guide { display: flex; align-items: center; gap: 8px; margin: 2px 0 2px; }
.vp-auto {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  padding: 4px 9px; border: 0; border-radius: 6px; cursor: pointer;
  background: linear-gradient(180deg, #34383e, #25282d);
  box-shadow: 0 2px 4px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .1), 0 0 0 1px rgba(0, 0, 0, .5);
  font: 600 10px/1 var(--m-font-mono); letter-spacing: .08em; color: var(--m-ink-3, #8a929a);
}
.vp-auto:hover:not(:disabled) { color: var(--m-ink-2, #c3c9cf); }
.vp-auto:disabled { opacity: .4; cursor: default; }
.vp-auto-dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(0, 0, 0, .5); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .18); }
.vp-auto.is-on { color: var(--vp-auto); box-shadow: inset 0 1px 3px rgba(0, 0, 0, .6), 0 0 0 1px color-mix(in oklab, var(--vp-auto) 45%, #000); }
.vp-auto.is-on .vp-auto-dot { background: var(--vp-auto); box-shadow: 0 0 6px var(--vp-auto); }
</style>
