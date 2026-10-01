<script setup>
/**
 * HF Softener.
 *
 * The chain runs Duck → EQ → Air → Reso. Duck turns the whole "s" down with its
 * shape intact; EQ cuts the top of what the duck left (its detector hears the
 * ducked signal); Shape picks that cut; Air puts back a few dB of top after it,
 * on Air Boost's curve; Reso is the amount of the ResoTame stage at the end,
 * out of the chain at 0. Context,
 * Rotator, Release and vowel release were controls while the design was being
 * tuned and are now pinned (50 %, sidechain, 40 ms, on — see useHFSoftener.js). DELTA sits in the
 * header like every other plugin's monitor and never reaches the apply path.
 * ADVANCED opens a second row: Guard (the lisp guard's strength, 0 = off),
 * Band (the EQ's lower corner — where it cuts, not where it listens; that is
 * Detect) and Plosives (the T/K/P treatment).
 * The SCOPE at the top is the waveform after the cut with what was removed
 * painted around it (SoftenerScope, hfSoftenerScope.js); the readout under it
 * splits the total into Duck, EQ and Reso. The curve is the cut the kernel is
 * running right now, drawn from the same coefficient builder, with the most
 * both stages could take ghosted behind it and the input's spectrum under it;
 * the dotted line is where the detector listens (Detect), the solid one where
 * the EQ cuts (Band). Lamps on AIR MODE and PLOSIVES light while each acts.
 */
import { computed, onMounted, watch } from 'vue'
import { useHFSoftener } from '../../composables/useHFSoftener.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  amountToMaxDepthDb, amountToThresholdDb, amountToCompressionRatio, softenerSections, AIR_MAKEUP_MAX_DB,
  duckToMaxDepthDb, duckToThresholdDb, duckToSlope,
  DETECT_HZ_MIN, DETECT_HZ_MAX, BAND_HZ_MIN, BAND_HZ_MAX, bandTuningFor,
} from '../../audio/hfSoftenerProcessor.js'
import { guardToFloorDb } from '../../audio/hfSoftenerParams.js'
import { magnitudeResponseDb } from '../../audio/dsp/biquad.js'
import { airBandSections } from '../../audio/dsp/airBandCurve.js'
import Knob from '../knobs/Knob.vue'
import DeviceChoiceRocker from '../knobs/DeviceChoiceRocker.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import SoftenerScope from '../meters/SoftenerScope.vue'
import SoftenerSpectrum from '../meters/SoftenerSpectrum.vue'
import { HF_SCOPE_SECONDS } from '../../audio/hfSoftenerScope.js'
import { readTimelineEnvelope } from '../../audio/timelineEnvelope.js'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  hfAmount, hfShape, hfGuard, hfPlosives, hfBand, hfAdvancedOpen, hfResoAmount, hfAir, hfComp, hfCompAir, hfDetect, hfAirMode, hfDuck, hfBroadband, hfDelta, hfPreview,
  hfFileLevelDb, hfLevelOffset, refreshLevel,
  hfReduction, hfInputLevels, hfOutputLevels,
  togglePreview, syncAmount, syncResoAmount, syncAir, syncComp, syncDetect, scheduleAutoAir, syncAirMode, syncDuck, syncShape, syncGuard, syncPlosives, syncBand, toggleDelta,
  hfReso, hfBurstLamp, hfAirLamp, getScope, getInputSpectrum,
  apply, teardown, closeModal,
} = useHFSoftener()

const { state, appState } = useEditorState()

// An edit or a document switch changes the file's level, and with it where
// every threshold sits. Measured only while the window is open.
// Auto Air measures over the selection, so a new selection is a new answer.
watch(() => state.selection, () => {
  if (hfPreview.value) scheduleAutoAir()
}, { deep: true })

watch(() => [state.revision, appState.activeDocumentId], () => {
  if (hfPreview.value) refreshLevel()
})

onMounted(() => {
  if (!hfPreview.value) togglePreview()
})

const ACCENT = '#e8b77f'
// The plosive treatment's own colour on the scope and its lamp, and the Detect
// marker's: each differs from the accent in lightness as well as hue.
const PLOSIVE_COLOR = '#b9a6f2'
const DETECT_COLOR = '#8ab8e0'
const AIR_LAMP_COLOR = '#9fd3c7'

/** A lamp: dark at 0, lit and glowing at 1. */
function lampStyle(level, colour) {
  const on = Math.min(1, Math.max(0, level))
  return {
    background: on > 0.05 ? colour : 'rgba(255,255,255,.16)',
    opacity: on > 0.05 ? 0.45 + 0.55 * on : 1,
    boxShadow: on > 0.05 ? `0 0 ${Math.round(3 + 5 * on)}px ${colour}` : 'none',
  }
}

/**
 * The timeline's peak envelope around the playhead, for the scope's lookahead
 * (and its history when the effect is bypassed). One scratch per side: both
 * are read in the same frame. See ClipperScope / SoftClipperModal.
 */
const envelopeScratch = { ahead: null, behind: null }
function envelope(offsetSeconds, seconds, columns) {
  if (!state.segments?.length) return null
  const side = offsetSeconds < 0 ? 'behind' : 'ahead'
  if (envelopeScratch[side]?.length !== columns) envelopeScratch[side] = new Float32Array(columns)
  return readTimelineEnvelope(state.segments, state.playhead + offsetSeconds, seconds, columns, envelopeScratch[side])
}

const PLOSIVE_OPTIONS = [
  { value: true, label: 'ON', title: 'Catch T, K and P releases — a burst straight out of a stop’s silence — and cut them harder, with the lisp guard lifted: a T cannot lisp' },
  { value: false, label: 'OFF', title: 'Treat plosive bursts like any other top-end event' },
]

const COMP_OPTIONS = [
  { value: true, label: 'ON', title: 'Add Air to make up for the top end the cut removes: half of what it is measured to take, on the selection. Adds to the Air knob, never replaces it' },
  { value: false, label: 'OFF', title: 'No compensation: Air is only what the knob says' },
]

// What actually reaches the kernel: the knob plus the compensation.
const totalAir = computed(() => hfAir.value + (hfComp.value ? hfCompAir.value : 0))

const AIR_MODE_OPTIONS = [
  { value: 'voiced', label: 'VOICED', title: 'Lift vowels only — the air fades out as each S arrives and stays out of the gaps, so it never hands the cut back or lifts room noise' },
  { value: 'static', label: 'STATIC', title: 'Lift everything, as Air Boost does — sibilants and room tone included' },
]

const SHAPE_OPTIONS = [
  { value: 'shelf', label: 'SHELF', title: 'Cut everything above the Band corner — the spec’s original shape' },
  { value: 'band', label: 'BAND', title: 'Cut the sibilance band and return to flat above it, so the air stays' },
]




// ── Response curve ──────────────────────────────────────────────────────────
const CURVE_W = 360
const CURVE_H = 110
const F_MIN = 100
const F_MAX = 20000
const DB_MIN = -10
// Headroom above 0 dB for the Air makeup's lift.
const DB_MAX = AIR_MAKEUP_MAX_DB

const CURVE_FREQS = Array.from({ length: 160 }, (_, i) =>
  F_MIN * Math.pow(F_MAX / F_MIN, i / 159),
)
const GRID_FREQS = [100, 1000, 4500, 10000, 20000]

function xFor(freqHz) {
  return (Math.log2(freqHz / F_MIN) / Math.log2(F_MAX / F_MIN)) * CURVE_W
}

function yFor(db) {
  return ((DB_MAX - db) / (DB_MAX - DB_MIN)) * CURVE_H
}
const Y0 = yFor(0)

// The cut, the broadband duck and the air makeup after them, as one response —
// what the audio gets. The duck moves the whole curve down.
function shelfPath(gainDb, levelDb = 0) {
  const sr = state.currentFile?.sampleRate ?? 44100
  const secs = softenerSections(sr, gainDb, hfShape.value, bandTuningFor(hfBand.value))
  if (totalAir.value > 0) secs.push(...airBandSections(sr, totalAir.value))
  const db = magnitudeResponseDb(secs, CURVE_FREQS, sr).map(v => v + levelDb)
  return CURVE_FREQS.map(
    (f, i) => `${i === 0 ? 'M' : 'L'}${xFor(f).toFixed(1)},${Math.min(CURVE_H - 0.5, Math.max(0.5, yFor(db[i]))).toFixed(1)}`,
  ).join(' ')
}

const maxDepthDb = computed(() => amountToMaxDepthDb(hfAmount.value / 100))
const duckMaxDb = computed(() => duckToMaxDepthDb(hfDuck.value / 100))
// Each stage's ceiling, stacked: the most the two could ever take together.
const maxPath = computed(() => shelfPath(-maxDepthDb.value, -duckMaxDb.value))
const livePath = computed(() => shelfPath(-Math.min(hfReduction.value, maxDepthDb.value), -hfBroadband.value))
const totalReduction = computed(() => hfReduction.value + hfBroadband.value + (hfResoAmount.value > 0 ? hfReso.value : 0))
const liveFill = computed(() => `${livePath.value} L${CURVE_W},${Y0} L0,${Y0} Z`)

// The TRUE compression ratio (1.5:1 at the default, 6:1 at 100 %), not the
// spec's divisor. Max depth is on the meter's scale and rarely the limit.
const ratioLabel = computed(() => `${amountToCompressionRatio(hfAmount.value / 100).toFixed(1)}:1`)

const duckRatioLabel = computed(() => `${(1 / (1 - duckToSlope(hfDuck.value / 100))).toFixed(1)}:1`)
const duckThresholdLabel = computed(() => {
  const t = duckToThresholdDb(hfDuck.value / 100) + hfLevelOffset.value
  return hfDuck.value === 0 ? 'OFF' : `${t.toFixed(0)} dBFS`
})

const thresholdLabel = computed(() => {
  // The threshold actually in force: the Amount's nominal plus the file's
  // level offset, so the readout names the level the detector compares to.
  const t = amountToThresholdDb(hfAmount.value / 100) + hfLevelOffset.value
  return hfAmount.value === 0 ? 'OFF' : `${t.toFixed(0)} dBFS`
})


function fmtCut(v) {
  return v >= 0.05 ? `−${v.toFixed(1)} dB` : '0.0 dB'
}


function formatHz(v) {
  return `${(v / 1000).toFixed(1)}k`
}

function quantizeHz(v) {
  return Math.round(v / 100) * 100
}

function formatAir(v) {
  return v > 0 ? `+${Number(v).toFixed(1)}` : 'OFF'
}

function formatPct(v) {
  return `${Math.round(v)}%`
}

function formatGuard(v) {
  return v > 0 ? `${Math.round(v)}%` : 'OFF'
}

const guardLabel = computed(() =>
  hfGuard.value > 0 ? `FLOOR ${guardToFloorDb(hfGuard.value).toFixed(0)} dB` : 'NO GUARD',
)

/** A marker's label beside its line, on the side that keeps it on the face. */
function markerLabelStyle(freqHz, side) {
  const pct = (xFor(freqHz) / CURVE_W) * 100
  return {
    left: `${pct}%`,
    transform: side === 'left' ? 'translateX(calc(-100% - 4px))' : 'translateX(4px)',
    font: "700 8px 'JetBrains Mono',monospace",
    letterSpacing: '.1em',
    whiteSpace: 'nowrap',
  }
}

function gridLabel(f) {
  return f >= 1000 ? `${f / 1000}k` : String(f)
}

function gridLabelStyle(freqHz) {
  if (freqHz <= F_MIN) return { left: '0%', transform: 'none' }
  if (freqHz >= F_MAX) return { left: '100%', transform: 'translateX(-100%)' }
  return { left: `${(xFor(freqHz) / CURVE_W) * 100}%`, transform: 'translateX(-50%)' }
}

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
    window-id="hf-softener"
    :z="z"
    :width="800"
    :accent="ACCENT"
    brand-lead="HF"
    brand-tail="SOFTENER"
    :engaged="hfPreview"
    show-delta
    :delta="hfDelta"
    :delta-disabled="!hfPreview"
    delta-title="Hear only what is being removed — it should sound like sibilance and nothing else. Monitoring only; Apply always renders the processed audio."
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!hfPreview"
    apply-disabled-hint="Turn HF Softener on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-delta="toggleDelta"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="px-[26px] pt-[22px] pb-[26px]">
      <!-- Activity: the waveform with what was removed painted on it. -->
      <SoftenerScope
        :data-fn="getScope"
        :envelope-fn="envelope"
        :window-seconds="HF_SCOPE_SECONDS * 2"
        :accent="ACCENT"
        :plosive-color="PLOSIVE_COLOR"
        :height="140"
        title="HF Softener activity: the waveform after the cut, with what was removed around it — playhead at the centre, played audio to its left, audio about to play to its right"
        @request-play="togglePlayback"
      />

      <!-- The total taken off, and which stage took it: the Duck (level), the
           EQ (tone) and Reso (rings, 5–12 kHz). -->
      <div class="flex items-baseline justify-between mt-[10px] px-[2px]">
        <div class="flex items-baseline gap-[12px]">
          <span style="font:700 9.5px 'JetBrains Mono',monospace;letter-spacing:.18em;color:rgba(255,255,255,.5)">REDUCTION</span>
          <span style="font:700 20px 'JetBrains Mono',monospace;color:#f3d3ac;font-variant-numeric:tabular-nums;min-width:92px">{{ fmtCut(totalReduction) }}</span>
        </div>
        <div class="flex items-center gap-[18px]" style="font:600 10px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.6);font-variant-numeric:tabular-nums">
          <span>DUCK {{ fmtCut(hfBroadband) }}</span>
          <span>EQ {{ fmtCut(hfReduction) }}</span>
          <span>RESO <template v-if="hfResoAmount > 0">{{ fmtCut(hfReso) }}</template><span v-else style="color:rgba(255,255,255,.35)">OFF</span></span>
        </div>
      </div>

      <div class="flex items-center justify-between gap-[22px] mt-[16px]">
        <LevelMeter :levels="hfInputLevels" label="IN" :height="150" />

        <div class="flex-1 flex flex-col items-center">
          <!-- The input's spectrum behind the cut's curve, with where the
               detector listens (Detect) and where the EQ cuts (Band). -->
          <div class="relative w-full" :style="{ height: `${CURVE_H}px` }">
            <SoftenerSpectrum :tap-fn="getInputSpectrum" :min-hz="F_MIN" :max-hz="F_MAX" />
            <svg
              :viewBox="`0 0 ${CURVE_W} ${CURVE_H}`"
              class="absolute inset-0 w-full h-full"
              preserveAspectRatio="none"
            >
              <line
                v-for="f in GRID_FREQS" :key="f"
                :x1="xFor(f)" :y1="0" :x2="xFor(f)" :y2="CURVE_H"
                stroke="rgba(255,255,255,.07)" stroke-width="1"
              />
              <line :x1="0" :y1="Y0" :x2="CURVE_W" :y2="Y0" stroke="rgba(255,255,255,.14)" stroke-width="1" />
              <line
                :x1="xFor(hfDetect)" :y1="0" :x2="xFor(hfDetect)" :y2="CURVE_H"
                :stroke="DETECT_COLOR" stroke-opacity="0.8" stroke-width="1" stroke-dasharray="2 3"
                vector-effect="non-scaling-stroke"
              />
              <line
                :x1="xFor(hfBand)" :y1="0" :x2="xFor(hfBand)" :y2="CURVE_H"
                :stroke="ACCENT" stroke-opacity="0.7" stroke-width="1"
                vector-effect="non-scaling-stroke"
              />
              <path :d="maxPath" :stroke="ACCENT" stroke-opacity="0.3" stroke-dasharray="3 3" stroke-width="1.5" fill="none" />
              <path :d="liveFill" :fill="ACCENT" fill-opacity="0.12" />
              <path :d="livePath" :stroke="ACCENT" stroke-width="2" fill="none" />
            </svg>
            <span
              class="absolute bottom-[3px]"
              :style="{ ...markerLabelStyle(hfDetect, 'left'), color: DETECT_COLOR }"
            >DETECT {{ formatHz(hfDetect) }}</span>
            <span
              class="absolute top-[3px]"
              :style="{ ...markerLabelStyle(hfBand, 'right'), color: ACCENT }"
            >BAND {{ formatHz(hfBand) }}</span>
          </div>
          <div class="relative w-full mt-[4px] h-[10px]">
            <span
              v-for="f in GRID_FREQS" :key="f"
              class="absolute top-0"
              :style="{
                ...gridLabelStyle(f),
                fontWeight: 600,
                fontSize: '8px',
                fontFamily: 'JetBrains Mono, monospace',
                letterSpacing: '0.08em',
                color: 'rgba(255,255,255,.28)',
              }"
            >{{ gridLabel(f) }}</span>
          </div>

          <div class="flex gap-[10px] mt-[16px]">
            <div class="w-[104px] flex flex-col items-center">
              <Knob
                :model-value="hfDuck"
                @update:model-value="syncDuck"
                :min="0" :max="100" :step="1"
                label="Duck" :accent="ACCENT" :format-value="formatPct"
                :disabled="!hfPreview"
                title="First stage: turns the whole S down, keeping its shape and tone — the gentlest way to de-ess, like a clip-gain de-esser. Threshold, ratio (up to 4:1) and depth (up to 12 dB) rise together."
              />
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                {{ duckThresholdLabel }} · {{ duckRatioLabel }}
              </span>
            </div>
            <div class="w-[104px] flex flex-col items-center">
              <Knob
                :model-value="hfAmount"
                @update:model-value="syncAmount"
                :min="0" :max="100" :step="1"
                label="EQ" :accent="ACCENT" :format-value="formatPct"
                :disabled="!hfPreview"
                title="Second stage: a dynamic cut of the top end, on whatever the Duck left hot — it hears the ducked S, so turning Duck up makes it back off. Threshold, ratio (up to 6:1) and depth (up to 24 dB) rise together."
              />
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                {{ thresholdLabel }} · {{ ratioLabel }}
              </span>
            </div>
            <div class="w-[104px] flex flex-col items-center">
              <Knob
                :model-value="hfDetect"
                @update:model-value="syncDetect"
                :min="DETECT_HZ_MIN" :max="DETECT_HZ_MAX" scale="log" :quantize="quantizeHz"
                label="Detect" :accent="ACCENT" :format-value="formatHz" :value-font-px="17"
                :disabled="!hfPreview"
                title="Where the detector starts listening. Raise it when bright vowels trip the cut: an ordinary S is compensated to read the same at any setting, while vowel top end, which sits lower, drops out of the detector."
              />
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                ABOVE {{ formatHz(hfDetect) }}
              </span>
            </div>
            <div class="w-[104px] flex flex-col items-center">
              <Knob
                :model-value="hfAir"
                @update:model-value="syncAir"
                :min="0" :max="AIR_MAKEUP_MAX_DB" :step="0.1"
                label="Air" :accent="ACCENT" :format-value="formatAir"
                :disabled="!hfPreview"
                title="Add top after the cut, on Air Boost's curve. HF COMP adds its measured compensation on top of this; AIR MODE decides whether it follows the vowels or lifts everything."
              />
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                {{ hfComp ? `+${hfCompAir.toFixed(1)} COMP` : 'NO COMP' }}
              </span>
            </div>
            <div class="w-[104px] flex flex-col items-center">
              <!-- The Reso stage's amount macro (HF_RESO_KNOTS), last in the
                   chain; 0 takes it out. -->
              <Knob
                :model-value="hfResoAmount"
                @update:model-value="syncResoAmount"
                :min="0" :max="100" :step="1"
                label="Reso" :accent="ACCENT" :format-value="formatPct"
                :disabled="!hfPreview"
                title="How much the ResoTame stage at the end of the chain takes. It catches rings and whistles; on an S it only takes what the Duck and EQ left above a normal S, so with the lisp guard on a well-treated S is left alone. Threshold, depth and cut ceiling move together."
              />
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                {{ hfResoAmount > 0 ? 'RINGS + S · 5–12k' : 'OFF' }}
              </span>
            </div>
          </div>
        </div>

        <LevelMeter :levels="hfOutputLevels" label="OUT" :height="150" />
      </div>

      <div class="flex justify-center gap-[48px] mt-[20px]">
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">SHAPE</span>
          <DeviceChoiceRocker
            :model-value="hfShape" :options="SHAPE_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview" label="Cut shape"
            @update:model-value="syncShape"
          />
        </div>
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">HF COMP</span>
          <DeviceChoiceRocker
            :model-value="hfComp" :options="COMP_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview" label="HF compensation"
            @update:model-value="syncComp"
          />
        </div>
        <div class="flex flex-col items-center gap-[8px]">
          <span class="flex items-center gap-[6px]" style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">
            AIR MODE
            <span
              class="w-[6px] h-[6px] rounded-full"
              :style="lampStyle(hfAirLamp, AIR_LAMP_COLOR)"
              title="Lit while the Air lift is being applied — in VOICED mode, on the vowels only"
            ></span>
          </span>
          <DeviceChoiceRocker
            :model-value="hfAirMode" :options="AIR_MODE_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview" label="Air mode"
            @update:model-value="syncAirMode"
          />
        </div>
      </div>

      <div class="flex justify-center mt-[16px]">
        <button
          type="button"
          class="px-[10px] py-[3px] rounded-[4px]"
          style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.45);border:1px solid rgba(255,255,255,.12)"
          :aria-expanded="hfAdvancedOpen"
          @click="hfAdvancedOpen = !hfAdvancedOpen"
        >
          ADVANCED {{ hfAdvancedOpen ? '▴' : '▾' }}
        </button>
      </div>

      <div v-if="hfAdvancedOpen" class="flex justify-center items-start gap-[28px] mt-[14px]">
        <div class="w-[104px] flex flex-col items-center">
          <Knob
            :model-value="hfGuard"
            @update:model-value="syncGuard"
            :min="0" :max="100" :step="1"
            label="Guard" :accent="ACCENT" :format-value="formatGuard"
            :disabled="!hfPreview"
            title="Lisp guard strength. No cut may take an S further below the voice than this floor, so it never ends up quieter than a normal S sits — stops the lisp, and lets go as the next vowel starts. Higher is stricter; 0 turns it off. Covers Reso too."
          />
          <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
            {{ guardLabel }}
          </span>
        </div>
        <div class="w-[104px] flex flex-col items-center">
          <Knob
            :model-value="hfBand"
            @update:model-value="syncBand"
            :min="BAND_HZ_MIN" :max="BAND_HZ_MAX" scale="log" :quantize="quantizeHz"
            label="Band" :accent="ACCENT" :format-value="formatHz" :value-font-px="17"
            :disabled="!hfPreview"
            title="Where the EQ cuts — the band's lower corner. Lower it for an S that sits low (3–5 kHz, common on deeper voices and on SH); raise it for a high, thin S. The band keeps its shape as it moves. Detect decides what triggers the cut; this decides what it takes."
          />
          <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
            CUT FROM {{ formatHz(hfBand) }}
          </span>
        </div>
        <div class="flex flex-col items-center gap-[8px] pt-[6px]">
          <span class="flex items-center gap-[6px]" style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">
            PLOSIVES
            <span
              class="w-[6px] h-[6px] rounded-full"
              :style="lampStyle(hfPlosives ? hfBurstLamp : 0, PLOSIVE_COLOR)"
              title="Flashes when a T, K or P release is caught and cut harder"
            ></span>
          </span>
          <DeviceChoiceRocker
            :model-value="hfPlosives" :options="PLOSIVE_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview" label="Plosives"
            @update:model-value="syncPlosives"
          />
        </div>
      </div>

      <p
        class="mt-[14px] text-center"
        style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)"
      >
        <template v-if="hfFileLevelDb !== null">
          FILE LEVEL {{ hfFileLevelDb.toFixed(1) }} dBFS · THRESHOLDS
          {{ hfLevelOffset >= 0 ? '+' : '' }}{{ hfLevelOffset.toFixed(1) }} dB
        </template>
        <template v-else>FILE LEVEL —</template>
      </p>

      <p
        class="mt-[10px] text-center"
        style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.35)"
      >
        Dips the sibilance band only while a consonant spikes, and lets go as the
        next vowel starts. Breath and air pass untouched.
      </p>
    </div>
  </FloatingWindow>
</template>
