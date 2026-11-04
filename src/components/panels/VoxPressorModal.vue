<script setup>
import { computed, onMounted, ref } from 'vue'
import { useVoxPressor } from '../../composables/useVoxPressor.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { releaseSecondsForDial } from '../../audio/fet1176Processor.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import ModulaFillSlider from '../modula/ModulaFillSlider.vue'
import ModulaDrumCounter from '../modula/ModulaDrumCounter.vue'
import FloatingWindow from './FloatingWindow.vue'
import VoxNeedleMeter from './voxpressor/VoxNeedleMeter.vue'
import FoldedLcd from '../hardware/FoldedLcd.vue'
import VoxKneeKeys from './voxpressor/VoxKneeKeys.vue'
import VoxSlideSwitch from './voxpressor/VoxSlideSwitch.vue'
import VoxIoMeters from './voxpressor/VoxIoMeters.vue'
import { isVoxPressorBenchVisible } from '../../audio/effects/voxPressorBench.js'
import {
  VOX_DEFAULTS, outputCeilingDbOf,
  PEAKS_BODY_WARN_DB, BODY_LOOKAHEAD_STEPS_MS, PEAKS_MAX, PARALLEL_DRIVE_MAX, BODY_MAX, bodyPrFor, PEAKS_RIPPLE_WARN_DB, peaksTiming,
} from '../../audio/effects/voxPressorParams.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  voxPeaks, voxBody, voxBodyLookahead, voxSpeed,
  voxPeaksMode, voxCharacter, voxCeiling, syncPeaksMode, syncCharacter, syncCeiling,
  voxDeEss, voxParallel, voxParallelComp, voxDensity, voxParallelGr,
  voxParallelDeEss, voxParallelSibEmph, voxParallelDeEssMode, voxDeEssSplit,
  voxPeaksGuide, voxUpstreamStale, voxDownstreamPending,
  voxParallelDrive, syncParallelDrive,
  voxMeasured, voxReadout, voxBusy,
  voxPreview, voxPeaksGr, voxBodyGr, voxInputLevels, voxOutputLevels,
  togglePreview, syncPeaks, syncBody, syncBodyLookahead, syncSpeed,
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
const PEAKS_COLOR = '#ff7a5c'

/**
 * SURFACE — the faceplate's paint: 'dark' (2a, Modula steel, ships) or
 * 'light' (2b, a cream panel). The knobs, the meter bezel and the LCDs stay
 * dark on both, so they read as physical parts. A per-viewer convenience,
 * kept in this browser only.
 */
const SURFACE_KEY = 'wavely:voxpressor-surface'
function readSurface() {
  try { return localStorage.getItem(SURFACE_KEY) === 'light' ? 'light' : 'dark' } catch { return 'dark' }
}
const surface = ref(readSurface())
const light = computed(() => surface.value === 'light')
function toggleSurface() {
  surface.value = light.value ? 'dark' : 'light'
  try { localStorage.setItem(SURFACE_KEY, surface.value) } catch { /* storage blocked: this visit only */ }
}
// The bottom row's knobs: amber on steel, a deeper amber on cream.
const knobColor = computed(() => (light.value ? '#bf782a' : ACCENT))

/**
 * THE NEEDLE reads one stage at a time (PEAKS / BODY / PARALLEL, the METER
 * drum), and the line under the drum is that stage's measured readout. Turning
 * a stage's control moves the meter to it, so what you are adjusting is what
 * you are reading.
 */
const METER_OPTIONS = [
  { value: 'peaks', label: 'PEAKS', title: "The 1176's gain reduction" },
  { value: 'body', label: 'BODY', title: "The LA-2A's gain reduction" },
  { value: 'parallel', label: 'PARALLEL', title: "The parallel copy's gain reduction (the wet side)" },
]
const meter = ref('peaks')
// The effect reports reduction as NEGATIVE dB (DynamicsCompressorNode's
// convention, which the GR bars read with Math.abs); the needle wants it positive.
const meterDb = computed(() => Math.abs({ peaks: voxPeaksGr.value, body: voxBodyGr.value, parallel: voxParallelGr.value }[meter.value] ?? 0))
const meterLabel = computed(() => METER_OPTIONS.find(o => o.value === meter.value)?.label ?? '')
const follow = (stage, fn) => (v) => { meter.value = stage; fn(v) }
/**
 * THE PANEL'S 0–100 SCALE (owner, November 2026: match the other compressors).
 * Peaks and Body are stored 0–10 (`peaksDriveDb`, `bodyPrFor` read them so);
 * the knobs show and step them ×10, so Peaks 30 is the old 3 — about 3 dB off
 * the loudest peaks of typical narration — and Body 47.5 is PR 57.
 */
const KNOB_SCALE = 10
const peaksShown = computed(() => voxPeaks.value * KNOB_SCALE)
const bodyShown = computed(() => voxBody.value * KNOB_SCALE)
const onPeaks = follow('peaks', v => syncPeaks(v / KNOB_SCALE))
const onPeaksMode = follow('peaks', v => syncPeaksMode(v))
const onSpeed = follow('peaks', v => syncSpeed(v))
const onBody = follow('body', v => syncBody(v / KNOB_SCALE))
const onCharacter = follow('body', v => syncCharacter(v))
const onParallel = follow('parallel', v => syncParallel(v))
const onDrive = follow('parallel', v => syncParallelDrive(v))
const onParallelComp = follow('parallel', v => syncParallelComp(v))

/**
 * The two folded LCDs (FoldedLcd, LA Vintage 2A's Lookahead hideaway): one
 * engraved line until clicked open. They step a number, so they step the
 * option's INDEX and print its label.
 */
const optionIndex = (opts, v) => Math.max(0, opts.findIndex(o => o.value === v))
const speedIndex = computed(() => optionIndex(SPEED_OPTIONS, voxSpeed.value))
const ceilingIndex = computed(() => optionIndex(CEILING_OPTIONS, voxCeiling.value))
const formatSpeed = i => SPEED_OPTIONS[Math.round(i)]?.label ?? ''
const formatCeiling = i => CEILING_OPTIONS[Math.round(i)]?.label ?? ''
const onSpeedIndex = i => onSpeed(SPEED_OPTIONS[Math.round(i)].value)
const onCeilingIndex = i => syncCeiling(CEILING_OPTIONS[Math.round(i)].value)

/** Where the output peak lands, dBFS: the ceiling, or the source's own peak. */
const ceilingMarkDb = computed(() => {
  const c = outputCeilingDbOf(voxCeiling.value)
  if (Number.isFinite(c)) return c
  const s = voxMeasured.value.sourcePeakDb
  return Number.isFinite(s) ? s : null
})

function formatPercent(v) {
  return v > 0 ? `${Math.round(v)} %` : 'OFF'
}

// The 1176's SPEED (`PEAKS_SPEEDS`): AUTO follows the voice's pitch.
const SPEED_OPTIONS = [
  { value: 'gentle', label: 'GENTLE', title: 'Slow attack and release: the cleanest, catches the least' },
  { value: 'normal', label: 'NORMAL', title: 'Medium attack and release' },
  { value: 'fast', label: 'FAST', title: 'Fast attack and release: grabs every onset; can ripple on low voices' },
  { value: 'auto', label: 'AUTO', title: 'Release follows the voice: slow enough for its pitch that the gain does not ripple on each cycle' },
]

// PEAKS KNEE: the 1176's ratio button (`PEAKS_MODES`), drawn as its curve.
const PEAKS_MODE_OPTIONS = [
  { value: 'hard', label: 'Hard knee', d: 'M3 15 L12 6 L21 4', title: 'HARD, 12:1: a limiter. The loudest peaks are held down hard; the rest is left alone' },
  { value: 'soft', label: 'Soft knee', d: 'M3 15 L8 10 C11 7 14 5.2 21 4', title: 'SOFT, 4:1: a gentler peak compressor for a dynamic performance. Starts at the same place, takes less off each step' },
]

// CHARACTER: the LA-2As' tube colour (Body, and the Parallel copy when it is the LA-2A).
const CHARACTER_OPTIONS = [
  { value: 'warm', label: 'WARM', title: "The LA-2A's tube cell and output valve: a little even-harmonic warmth" },
  { value: 'clean', label: 'CLEAN', title: 'The same leveling as a pure gain: no tube colour. Also cleans the Parallel copy when it is the LA-2A' },
]

// OUTPUT CEILING: where the output peak lands.
const CEILING_OPTIONS = [
  { value: 'source', label: 'SRC', title: "The output peak stays at the source's own peak" },
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
  return v > 0 ? String(Math.round(v)) : 'OFF'
}

function formatBody(v) {
  if (v <= 0) return 'OFF'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function formatDrive(v) {
  return v.toFixed(1)
}

const formatSplit = v => (v <= 0 ? 'ALL WIDE' : v >= 100 ? 'ALL SPLIT' : `${100 - Math.round(v)} / ${Math.round(v)}`)

function formatKnob(v) {
  return v > 0 ? String(Math.round(v)) : 'OFF'
}

// The readouts are MEASURED at the knobs (`measureVoxPressor`): the knobs act
// at once, the numbers follow when the measurement lands.
// A warning, never a cap: the knob always goes where it is turned, and this
// says when that has started lowering the voice itself (PEAKS_BODY_WARN_DB).
const peaksWarn = computed(() => {
  const r = voxReadout.value
  return !!r && voxPeaks.value > 0 && r.peaksBodyDb > PEAKS_BODY_WARN_DB
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
    { from: 0, to: g.target * KNOB_SCALE, color: GUIDE_OK },
    { from: g.target * KNOB_SCALE, to: red * KNOB_SCALE, color: GUIDE_EDGE },
    { from: red * KNOB_SCALE, to: PEAKS_MAX * KNOB_SCALE, color: GUIDE_OVER },
  ]
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

// The line under the METER drum: the selected stage's measured readout.
/**
 * MINIMAL, as Body's and Parallel's (owner, November 2026): what it took off
 * the peaks and what it cost the voice. The ripple only appears when it warns;
 * the guide is on the knob's ring.
 */
const peaksLine = computed(() => {
  if (voxPeaks.value <= 0) return 'stage out'
  const r = voxReadout.value
  if (!r) return voxBusy.value ? 'measuring…' : '—'
  const line = `−${r.peaksDb.toFixed(1)} dB peaks · −${r.peaksBodyDb.toFixed(1)} dB body`
  return rippleWarn.value ? `${line} · ${rippleNote.value}` : line
})
const statusLines = computed(() => {
  if (meter.value === 'peaks') {
    return [{ text: peaksLine.value, warn: peaksWarn.value || rippleWarn.value }]
  }
  if (meter.value === 'body') return [{ text: bodyNote.value }]
  const comp = voxParallelComp.value === 'la2a' ? 'LA-2A' : '1176'
  const line = voxParallel.value > 0
    ? `mix ${formatPercent(voxParallel.value)} · drive ${formatDrive(voxParallelDrive.value)} · ${comp} copy`
    : 'stage out'
  return [{ text: line }, { text: voxBusy.value && voxPreview.value ? (voxDownstreamPending.value ? 'updating makeup…' : 'measuring…') : '' }]
})
// Dimmed, with a pulse, while a measurement that can change them is running.
const statusStale = computed(() => (meter.value === 'parallel' ? voxBusy.value && voxPreview.value : stale.value))

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
    :width="800"
    :accent="ACCENT"
    design="modula"
    :surface="surface"
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
    <template #header-center>
      <button
        type="button" class="vp-surface" :aria-pressed="String(light)"
        :title="light ? 'Dark faceplate' : 'Light faceplate'" :aria-label="light ? 'Switch to the dark faceplate' : 'Switch to the light faceplate'"
        @pointerdown.stop @click="toggleSurface"
      >
        <svg v-if="light" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      </button>
    </template>

    <div class="vp" :class="{ 'is-light': light }">
      <!-- ── TOP: Peaks and Body flank the needle meter ─────────────────── -->
      <div class="vp-top">
        <section class="vp-col" aria-label="Peaks">
          <div class="vp-title-row"><span class="vp-title" :class="{ 'is-lit': meter === 'peaks' }">Peak reduction</span></div>
          <ModulaKnob
            variant="ticks" :size="104"
            :model-value="peaksShown" :min="0" :max="PEAKS_MAX * KNOB_SCALE" :step="1"
            :default-value="VOX_DEFAULTS.peaks * KNOB_SCALE"
            aria-label="Peaks" :color="PEAKS_COLOR" :format-value="formatPeaks" :disabled="!voxPreview"
            :zones="peaksZones"
            title="How hard the 1176 catches the loudest peaks: every 10 is about 1 dB off them on typical narration (the line under the meter says what it took on this file). The ring is green up to where this file's loudest peaks come down to the voice, amber after, red where the stage starts compressing the voice itself — the later stages are there for that. 0 takes the stage out. Double-click to reset"
            @update:model-value="onPeaks"
          />
          <FoldedLcd
            class="vp-fold vp-ctl-gap" name="Attack / release" label-position="above"
            :model-value="speedIndex" :min="0" :max="SPEED_OPTIONS.length - 1" :step="1"
            :format="formatSpeed" :disabled="!voxPreview || voxPeaks <= 0"
            @update:model-value="onSpeedIndex"
          />
          <div class="vp-ctl">
            <span class="vp-cap">Knee</span>
            <VoxKneeKeys
              :model-value="voxPeaksMode" :options="PEAKS_MODE_OPTIONS" :color="ACCENT" :surface="surface"
              aria-label="Peaks knee" :disabled="!voxPreview || voxPeaks <= 0"
              @update:model-value="onPeaksMode"
            />
          </div>
        </section>

        <div class="vp-centre">
          <VoxNeedleMeter :db="meterDb" :label="meterLabel" :scale="0.82" />
          <div class="vp-ctl">
            <span class="vp-cap">Meter</span>
            <ModulaDrumCounter v-model="meter" class="vp-drum" :options="METER_OPTIONS" aria-label="What the needle reads" />
          </div>
          <div class="vp-status" :class="{ 'is-stale': statusStale }" aria-live="polite">
            <span v-for="(l, i) in statusLines" :key="i" class="vp-status-line" :class="{ 'is-warn': l.warn }">
              <i v-if="i === 0 && statusStale" class="vp-pulse" aria-hidden="true"></i>{{ l.text || '\u00a0' }}
            </span>
          </div>
        </div>

        <section class="vp-col" aria-label="Body">
          <div class="vp-title-row"><span class="vp-title" :class="{ 'is-lit': meter === 'body' }">Body leveler</span></div>
          <ModulaKnob
            variant="ticks" :size="104"
            :model-value="bodyShown" :min="0" :max="BODY_MAX * KNOB_SCALE" :step="0.5"
            :default-value="VOX_DEFAULTS.body * KNOB_SCALE"
            aria-label="Body" :color="ACCENT" :format-value="formatBody" :disabled="!voxPreview"
            title="How hard the LA-2A levels the voice: its Peak Reduction over the useful span, 10 = PR 42, 47.5 = PR 57, 100 = PR 78, aligned to this file's level and to what the 1176 stage hands it. 0 takes the stage out. Double-click to reset"
            @update:model-value="onBody"
          />
          <div class="vp-ctl vp-ctl-gap">
            <span class="vp-cap" aria-hidden="true">&nbsp;</span>
            <VoxSlideSwitch
              :model-value="voxCharacter" :options="CHARACTER_OPTIONS" :color="ACCENT" :surface="surface"
              aria-label="Character" :disabled="!voxPreview"
              @update:model-value="onCharacter"
            />
          </div>
        </section>
      </div>

      <!-- ── BOTTOM (layout B): Parallel | De-ess · Detail | Output ─────── -->
      <div class="vp-bottom">
        <section class="vp-col" aria-label="Parallel">
          <div class="vp-title-row"><span class="vp-title" :class="{ 'is-lit': meter === 'parallel' }">Parallel</span></div>
          <div class="vp-knob-row">
            <ModulaKnob
              variant="led" :size="84"
              :model-value="voxParallel" :min="0" :max="100" :step="1"
              :default-value="VOX_DEFAULTS.parallel"
              aria-label="Parallel mix" :color="knobColor" :format-value="formatPercent" :disabled="!voxPreview"
              title="Parallel compression: a heavily compressed copy blended under the voice. The peaks stay put and the quieter parts come up. 0 takes the stage out. Double-click to reset"
              @update:model-value="onParallel"
            />
            <div class="vp-ctl">
              <ModulaKnob
                variant="plain" :size="44"
                :model-value="voxParallelDrive" :min="0" :max="PARALLEL_DRIVE_MAX" :step="0.5"
                :default-value="VOX_DEFAULTS.parallelDrive"
                aria-label="Parallel drive" :color="knobColor" :format-value="formatDrive" :disabled="!voxPreview || voxParallel <= 0"
                title="How hard the parallel copy is compressed. On the LA-2A it is Peak Reduction: 0 = PR 38, 3 = PR 50, 10 = PR 78; the 1176 is set so the same position compresses about as hard. The copy's makeup is re-measured. Double-click to reset"
                @update:model-value="onDrive"
              />
              <span class="vp-cap">Drive</span>
            </div>
          </div>
          <div class="vp-ctl">
            <span class="vp-cap" aria-hidden="true">&nbsp;</span>
            <VoxSlideSwitch
              :model-value="voxParallelComp" :options="PARALLEL_COMP_OPTIONS" :color="ACCENT" :surface="surface"
              aria-label="Parallel compressor" :disabled="!voxPreview || voxParallel <= 0"
              @update:model-value="onParallelComp"
            />
          </div>
        </section>

        <div class="vp-middle">
          <section class="vp-col" aria-label="De-ess">
            <div class="vp-title-row"><span class="vp-title">De-ess</span></div>
            <div class="vp-knob-row">
              <ModulaKnob
                variant="led" :size="84"
                :model-value="voxDeEss" :min="0" :max="100" :step="1"
                :default-value="VOX_DEFAULTS.deEss"
                aria-label="De-ess" :color="knobColor" :format-value="formatKnob" :disabled="!voxPreview"
                title="The HF Softener's Amount, after the compressors: takes down the sibilance they brought up. 0 takes the stage out. Double-click to reset"
                @update:model-value="syncDeEss"
              />
            </div>
            <div class="vp-ctl">
              <span class="vp-cap">Band</span>
              <ModulaFillSlider
                class="vp-band" orientation="horizontal" :length="150"
                :model-value="voxDeEssSplit" :min="0" :max="100" :step="1" :default-value="VOX_DEFAULTS.deEssSplit"
                label="" :ends="['WIDE', 'SPLIT']" flat :format-value="formatSplit"
                :color="ACCENT" :disabled="!voxPreview || voxDeEss <= 0"
                aria-label="De-ess split between wide band and split band"
                title="Where the De-ess Amount goes. Left: all to the wide band Duck, which turns the whole S down and keeps its tone. Right: all to the split band EQ, which cuts only the top end. Double-click to reset"
                @update:model-value="syncDeEssSplit"
              />
            </div>
          </section>
          <section class="vp-col" aria-label="Detail">
            <div class="vp-title-row"><span class="vp-title">Detail</span></div>
            <div class="vp-knob-row">
              <ModulaKnob
                variant="led" :size="84"
                :model-value="voxDensity" :min="0" :max="100" :step="1"
                :default-value="VOX_DEFAULTS.density"
                aria-label="Detail (density)" :color="knobColor" :format-value="formatPercent" :disabled="!voxPreview"
                title="Density: the Cambridge Inflator's Effect, anchored at the source peak — lifts the body under a fixed peak with odd harmonics. 0 takes the stage out. Double-click to reset"
                @update:model-value="syncDensity"
              />
            </div>
          </section>
        </div>

        <section class="vp-col" aria-label="Output">
          <div class="vp-title-row"></div>
          <div class="vp-knob-row vp-out-head">
            <FoldedLcd
              class="vp-fold" name="Output level" label-position="above"
              :model-value="ceilingIndex" :min="0" :max="CEILING_OPTIONS.length - 1" :step="1"
              :format="formatCeiling" :disabled="!voxPreview"
              @update:model-value="onCeilingIndex"
            />
          </div>
          <VoxIoMeters class="vp-io" :in-levels="voxInputLevels" :out-levels="voxOutputLevels" :ceiling-db="ceilingMarkDb" />
        </section>
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
  </FloatingWindow>
</template>

<style scoped>
/* ── Surface: the cream panel (2b) repaints only the type and the trays;
   knobs, the meter bezel and the LCDs stay dark on both. ── */
.vp {
  --vp-title: #b6bdc4;
  --vp-title-lit: #ff8a6e;
  --vp-cap: #a0a8b0;
  --vp-note: #c9d0d6;
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 10px 12px 12px;
}
.vp.is-light {
  --vp-title: #41464e;
  --vp-title-lit: #b23a1f;
  --vp-cap: #555b64;
  --vp-note: #3a3f47;
}
.vp-top { display: grid; grid-template-columns: 170px minmax(0, 1fr) 170px; align-items: start; gap: 14px; }
.vp-bottom { display: grid; grid-template-columns: 196px minmax(0, 1fr) 196px; gap: 14px; align-items: start; }
.vp-middle { display: grid; grid-template-columns: 150px 150px; justify-content: center; gap: 12px; align-items: start; }
.vp-col { display: flex; flex-direction: column; align-items: center; gap: 12px; min-width: 0; }
.vp-centre { display: flex; flex-direction: column; align-items: center; gap: 14px; padding-top: 6px; min-width: 0; }
.vp-title-row { height: 12px; display: flex; align-items: center; justify-content: center; }
.vp-title { font: 600 10px/1 var(--m-font-ui); letter-spacing: .14em; text-transform: uppercase; color: var(--vp-title); transition: color .2s ease; }
.vp-title.is-lit { color: var(--vp-title-lit); }
.vp-cap { font: 500 9px/1 var(--m-font-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--vp-cap); white-space: nowrap; }
.vp-ctl { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 7px; }
.vp-ctl-gap { margin-top: 8px; }
.vp-knob-row { height: 84px; display: flex; align-items: center; justify-content: center; gap: 18px; }
.vp-out-head { flex-direction: column; gap: 7px; }
.vp-io { align-self: stretch; }
.vp-band { width: 150px; }
/* The band slider's channel: dark on steel, a pressed cream groove on the light panel. */
.vp.is-light .vp-band :deep(.m-fs-hchan) {
  background: linear-gradient(180deg, #b9b3a8, #cfc9bf);
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, .35), inset 0 0 0 1px rgba(0, 0, 0, .12), 0 1px 0 rgba(255, 255, 255, .6);
}
.vp-band :deep(.m-fs-ends) { font: 600 9px/1 var(--m-font-mono); letter-spacing: .08em; color: var(--vp-note); }

/* The METER drum at the design's size: room for PARALLEL in the window, the
   neighbours squeezed either side, raised dark caps on the arrows (both
   surfaces: they are parts, not paint). */
.vp-drum :deep(.m-drum-window) { padding: 0 8px; }
.vp-drum :deep(.m-drum-side) { width: 44px; font-size: 9px; overflow: hidden; white-space: nowrap; }
.vp-drum :deep(.m-drum-cur) { width: 74px; }
.vp-drum :deep(.m-drum-val) { font-size: 13px; }
.vp-drum :deep(.m-drum-arrow) {
  background: linear-gradient(160deg, #4d596a 0%, #323b48 52%, #222931 100%);
  box-shadow: 0 6px 12px -6px rgba(0, 0, 0, .9), inset 0 1px 0 rgba(255, 255, 255, .1), 0 0 0 1px rgba(0, 0, 0, .65);
}
.vp-drum :deep(.m-drum-arrow:not(:disabled):hover) { background: linear-gradient(160deg, #56637a 0%, #384253 52%, #262d36 100%); }
.vp-drum :deep(.m-drum-tri--left) { border-right-color: #eaf6f8; }
.vp-drum :deep(.m-drum-tri--right) { border-left-color: #eaf6f8; }
.vp.is-light .vp-drum :deep(.m-drum-arrow) { box-shadow: inset 0 1px 0 rgba(255, 255, 255, .2), 0 1px 1px rgba(40, 30, 20, .35), 0 5px 9px -4px rgba(40, 30, 20, .4); }
.vp.is-light .vp-drum :deep(.m-drum-window) { box-shadow: inset 0 2px 8px rgba(0, 0, 0, .9), 0 0 0 1px rgba(0, 0, 0, .6), 0 1px 0 1px rgba(255, 255, 255, .55); }

/* The selected stage's readout under the METER drum. */
.vp-status { display: flex; flex-direction: column; align-items: center; gap: 5px; min-height: 26px; transition: opacity .15s ease; }
.vp-status.is-stale { opacity: .7; }
.vp-status-line { font: 500 9px/1.1 var(--m-font-mono); color: var(--vp-note); white-space: nowrap; }
.vp-status-line.is-warn { color: #f0b429; }
.vp.is-light .vp-status-line.is-warn { color: #b0640f; }
.vp-pulse {
  display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%;
  background: #e8a33d; box-shadow: 0 0 6px #e8a33d; vertical-align: 0;
  animation: vp-pulse 0.9s ease-in-out infinite;
}
@keyframes vp-pulse { 0%, 100% { opacity: .45 } 50% { opacity: 1 } }


/* The folded LCDs take the panel's inks (FoldedLcd reads the --hw-* tokens). */
.vp-fold { --hw-dim: var(--vp-cap); --hw-dim-hover: var(--vp-note); --hw-ink: var(--vp-note); }
/* Closed, the name and the value must not read as one phrase: the name is a
   quiet caption, the value an amber LCD readout in its own small well. */
.vp-fold :deep(.pg-readout) { display: inline-flex; align-items: center; gap: 7px; }
.vp-fold :deep(.pg-name) { font: 500 9px/1 var(--m-font-mono); letter-spacing: .14em; color: var(--vp-cap); }
.vp-fold :deep(.pg-value) {
  padding: 3px 6px; border-radius: 3px; background: #0b0c0e;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, .9), 0 1px 0 rgba(255, 255, 255, .06);
  font: 600 9px/1 var(--m-font-mono); letter-spacing: .06em; color: #e0a65c;
  text-shadow: 0 0 4px rgba(255, 140, 40, .3);
}
.vp.is-light .vp-fold :deep(.pg-value) { box-shadow: inset 0 1px 3px rgba(0, 0, 0, .9), 0 1px 0 rgba(255, 255, 255, .6); }
.vp-fold :deep(.pg-readout:hover .pg-name) { color: var(--vp-note); }

/* Open, the name is a caption like every other control's: above, in the panel's mono. */
.vp-fold :deep(.pg-title--above) {
  font: 500 9px/1 var(--m-font-mono); letter-spacing: .14em; text-transform: uppercase;
  color: var(--vp-cap); text-shadow: none;
}
.vp.is-light .vp-fold { --hw-ink-shadow: none; --hw-hover-bg: rgba(0, 0, 0, .06); --hw-manual: #b0640f; }

/* The surface toggle in the header. */
.vp-surface {
  width: 30px; height: 30px; border: none; border-radius: 50%; cursor: pointer; flex: none;
  display: grid; place-items: center; background: transparent; color: var(--m-ink-2);
  box-shadow: var(--m-shadow-raised);
}
.vp-surface:hover { color: var(--m-ink); }
.vp-surface:focus-visible { outline: 2px solid #7fe9f6; outline-offset: 2px; }

/* ── Bench (dev only) ── */
.vp-listen { display: flex; align-items: center; justify-content: center; gap: 10px; }
.vp-listen .m-caption { color: var(--vp-cap); }
.vp-measured { text-align: center; color: var(--vp-note); }
.vp-bench { padding-top: 8px; border-top: 1px dashed rgba(127, 127, 127, .25); }
.vp-bench-wrap { margin-top: -6px; border-top: 1px dashed rgba(127, 127, 127, .3); padding-top: 8px; display: flex; flex-direction: column; align-items: center; }
.vp-bench-toggle {
  border: 0; border-radius: 6px; padding: 4px 10px; cursor: pointer;
  background: linear-gradient(180deg, #34383e, #25282d);
  box-shadow: 0 2px 4px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .1), 0 0 0 1px rgba(0, 0, 0, .5);
  font: 600 10px/1 var(--m-font-mono); letter-spacing: .1em; color: #8a929a;
}
.vp-bench-toggle:hover { color: #c3c9cf; }
.vp-bench-body { align-self: stretch; display: flex; flex-direction: column; gap: 6px; }
</style>
