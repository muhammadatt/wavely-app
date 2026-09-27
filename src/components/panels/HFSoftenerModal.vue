<script setup>
/**
 * HF Softener.
 *
 * Amount is the tuning; Split decides how it is taken — as the band cut (tone
 * changes, level holds) or a broadband duck (tone holds, level dips), same
 * total on the "s" either way; Shape picks the cut; Drive feeds an input waveshaper
 * ahead of the cut (curve and VOICED/FULL on the SATURATION row, for
 * auditioning); Air puts back a few dB of top
 * after it, on Air Boost's curve; Reso is the Threshold of the
 * optional ResoTame pre-stage, which the HF RESO rocker switches in. Context,
 * Rotator, Release and vowel release were controls while the design was being
 * tuned and are now pinned (50 %, sidechain, 40 ms, on — see useHFSoftener.js). DELTA sits in the
 * header like every other plugin's monitor and never reaches the apply path.
 * The curve is the cut the kernel is running right now, drawn from the same
 * coefficient builder, with the Amount's maximum depth ghosted behind it.
 */
import { computed, onMounted, watch } from 'vue'
import { useHFSoftener } from '../../composables/useHFSoftener.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  amountToMaxDepthDb, amountToThresholdDb, amountToCompressionRatio, softenerSections, AIR_MAKEUP_MAX_DB,
} from '../../audio/hfSoftenerProcessor.js'
import { magnitudeResponseDb } from '../../audio/dsp/biquad.js'
import { airBandSections } from '../../audio/dsp/airBandCurve.js'
import Knob from '../knobs/Knob.vue'
import DeviceChoiceRocker from '../knobs/DeviceChoiceRocker.vue'
import DeviceDetentRotary from '../knobs/DeviceDetentRotary.vue'
import DeviceTravelSlide from '../knobs/DeviceTravelSlide.vue'
import { SHAPER_CURVES } from '../../audio/dsp/shaperCurves.js'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  hfAmount, hfShape, hfLispGuard, hfReso, hfResoAmount, hfAir, hfAirMode, hfDrive, hfCurve, hfSatMode, hfEmph, hfSplit, hfBand, hfBroadband, hfDelta, hfPreview,
  hfFileLevelDb, hfLevelOffset, refreshLevel,
  hfReduction, hfInputLevels, hfOutputLevels,
  togglePreview, syncAmount, syncResoAmount, syncAir, syncAirMode, syncDrive, syncCurve, syncSatMode, syncEmph, syncSplit, syncBand, syncShape, syncLispGuard, syncReso, toggleDelta,
  apply, teardown, closeModal,
} = useHFSoftener()

const { state, appState } = useEditorState()

// An edit or a document switch changes the file's level, and with it where
// every threshold sits. Measured only while the window is open.
watch(() => [state.revision, appState.activeDocumentId], () => {
  if (hfPreview.value) refreshLevel()
})

onMounted(() => {
  if (!hfPreview.value) togglePreview()
})

const ACCENT = '#e8b77f'

const GUARD_OPTIONS = [
  { value: true, label: 'ON', title: 'Never cut an S further below the voice than a normal S sits — stops the lisp, and lets go as the next vowel starts' },
  { value: false, label: 'OFF', title: 'Cut as deep as Amount asks' },
]

const RESO_OPTIONS = [
  { value: true, label: 'ON', title: 'Run a band-limited ResoTame (5–12 kHz) ahead of the softener — the Reso knob sets how much: rings first, then sibilance. Adds 11.6 ms latency' },
  { value: false, label: 'OFF', title: 'Softener alone' },
]

const CURVE_OPTIONS = SHAPER_CURVES.map(c => ({ value: c.id, label: c.label, title: c.title }))

// An ordered axis — how much of the highs goes INTO the curve — so a slide.
const EMPH_OPTIONS = [
  { value: 'reverse', label: 'REV', title: 'OptoSmooth’s pair reversed: highs pulled out before the curve, put back after. Keeps high content clean, but lifts the harmonics the vowels make up there' },
  { value: 'off', label: 'OFF', title: 'No emphasis: the curve treats every frequency alike' },
  { value: 'opto', label: 'OPTO', title: 'OptoSmooth’s pair: highs pushed into the curve, taken back out after. The smoothest on voices — its after-shelf trims the harmonics' },
]

const BAND_OPTIONS = [
  { value: 'full', label: 'FULL', title: 'Saturate the whole voice: density and warmth' },
  { value: 'hf', label: 'HF', title: 'Saturate only above 3 kHz: an exciter — adds harmonic brightness that follows the voice. Use an odd curve; the Quartic does not excite' },
]

const AIR_MODE_OPTIONS = [
  { value: 'voiced', label: 'VOICED', title: 'Lift vowels only — the air fades out as each S arrives and stays out of the gaps, so it never hands the cut back or lifts room noise' },
  { value: 'static', label: 'STATIC', title: 'Lift everything, as Air Boost does — sibilants and room tone included' },
]

const SAT_MODE_OPTIONS = [
  { value: 'voiced', label: 'VOICED', title: 'Saturate vowels only — the shaper fades out as each S arrives, so it never adds harmonics to sibilance' },
  { value: 'full', label: 'FULL', title: 'Saturate everything, sibilants included; the cut downstream cleans up what it adds' },
]

const SHAPE_OPTIONS = [
  { value: 'shelf', label: 'SHELF', title: 'Cut everything above 4.5 kHz — the spec’s original shape' },
  { value: 'band', label: 'BAND', title: 'Cut the sibilance band and return to flat above 11 kHz, so the air stays' },
]




// ── Response curve ──────────────────────────────────────────────────────────
const CURVE_W = 360
const CURVE_H = 96
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
  const secs = softenerSections(sr, gainDb, hfShape.value)
  if (hfAir.value > 0) secs.push(...airBandSections(sr, hfAir.value))
  const db = magnitudeResponseDb(secs, CURVE_FREQS, sr).map(v => v + levelDb)
  return CURVE_FREQS.map(
    (f, i) => `${i === 0 ? 'M' : 'L'}${xFor(f).toFixed(1)},${Math.min(CURVE_H - 0.5, Math.max(0.5, yFor(db[i]))).toFixed(1)}`,
  ).join(' ')
}

const maxDepthDb = computed(() => amountToMaxDepthDb(hfAmount.value / 100))
const splitFrac = computed(() => hfSplit.value / 100)
const maxPath = computed(() => shelfPath(-maxDepthDb.value * (1 - splitFrac.value), -maxDepthDb.value * splitFrac.value))
const livePath = computed(() => shelfPath(-Math.min(hfReduction.value, maxDepthDb.value), -hfBroadband.value))
const totalReduction = computed(() => hfReduction.value + hfBroadband.value)
const liveFill = computed(() => `${livePath.value} L${CURVE_W},${Y0} L0,${Y0} Z`)

// The TRUE compression ratio (1.5:1 at the default, 6:1 at 100 %), not the
// spec's divisor. Max depth is on the meter's scale and rarely the limit.
const ratioLabel = computed(() => `${amountToCompressionRatio(hfAmount.value / 100).toFixed(1)}:1`)

const thresholdLabel = computed(() => {
  // The threshold actually in force: the Amount's nominal plus the file's
  // level offset, so the readout names the level the detector compares to.
  const t = amountToThresholdDb(hfAmount.value / 100) + hfLevelOffset.value
  return hfAmount.value === 0 ? 'OFF' : `${t.toFixed(0)} dBFS`
})


function fmtCut(v) {
  return v >= 0.05 ? `−${v.toFixed(1)} dB` : '0.0 dB'
}

const driveCaption = computed(() => {
  if (!(hfDrive.value > 0)) return 'SAT OFF'
  // The Quartic's products are even-order and weak at band level: as an
  // exciter it measures as a no-op, and the panel says so rather than looking broken.
  if (hfBand.value === 'hf' && hfCurve.value === 'quartic') return 'QUARTIC · NO EXCITE'
  const what = hfBand.value === 'hf' ? 'EXCITE' : 'SAT'
  return `${what} · ${hfSatMode.value === 'voiced' ? 'VOWELS' : 'FULL'}`
})

function formatDrive(v) {
  return v > 0 ? `${Math.round(v)}%` : 'OFF'
}

function formatAir(v) {
  return v > 0 ? `+${Number(v).toFixed(1)}` : 'OFF'
}

function formatPct(v) {
  return `${Math.round(v)}%`
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
      <!-- 24 dB full scale: the deepest the shelf can go, at Amount 100 %. -->
      <!-- The total taken off the "s"; the readout under it says how it was
           taken — as tone (the band cut) or as level (the broadband duck). -->
      <GainReductionBar :reduction-db="-totalReduction" :accent="ACCENT" :full-scale-db="24" title="REDUCTION" />
      <p
        class="mt-[6px] text-right"
        style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)"
      >
        TONE {{ fmtCut(hfReduction) }} · LEVEL {{ fmtCut(hfBroadband) }}
      </p>

      <div class="flex items-center justify-between gap-[22px] mt-[18px]">
        <LevelMeter :levels="hfInputLevels" label="IN" :height="150" />

        <div class="flex-1 flex flex-col items-center">
          <svg
            :viewBox="`0 0 ${CURVE_W} ${CURVE_H}`"
            class="w-full"
            :style="{ height: `${CURVE_H}px` }"
            preserveAspectRatio="none"
          >
            <line
              v-for="f in GRID_FREQS" :key="f"
              :x1="xFor(f)" :y1="0" :x2="xFor(f)" :y2="CURVE_H"
              stroke="rgba(255,255,255,.07)" stroke-width="1"
            />
            <line :x1="0" :y1="Y0" :x2="CURVE_W" :y2="Y0" stroke="rgba(255,255,255,.14)" stroke-width="1" />
            <path :d="maxPath" :stroke="ACCENT" stroke-opacity="0.3" stroke-dasharray="3 3" stroke-width="1.5" fill="none" />
            <path :d="liveFill" :fill="ACCENT" fill-opacity="0.12" />
            <path :d="livePath" :stroke="ACCENT" stroke-width="2" fill="none" />
          </svg>
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
                :model-value="hfAmount"
                @update:model-value="syncAmount"
                :min="0" :max="100" :step="1"
                label="Amount" :accent="ACCENT" :format-value="formatPct"
                :disabled="!hfPreview"
              />
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                {{ thresholdLabel }} · {{ ratioLabel }}
              </span>
            </div>
            <div class="w-[104px] flex flex-col items-center">
              <Knob
                :model-value="hfSplit"
                @update:model-value="syncSplit"
                :min="0" :max="100" :step="1"
                label="Split" :accent="ACCENT" :format-value="formatPct"
                :disabled="!hfPreview"
                title="How the reduction is taken. 0 %: all as the band cut — the level holds but the tone changes on each S. 100 %: all as a broadband duck — the tone holds but the voice dips. The total taken off the S stays the same, and the lisp guard caps it either way."
              />
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                TONE ↔ LEVEL
              </span>
            </div>
            <div class="w-[104px] flex flex-col items-center">
              <Knob
                :model-value="hfAir"
                @update:model-value="syncAir"
                :min="0" :max="AIR_MAKEUP_MAX_DB" :step="0.1"
                label="Air" :accent="ACCENT" :format-value="formatAir"
                :disabled="!hfPreview"
                title="Put back a few dB of top after the cut, on Air Boost's curve. AIR MODE decides whether it follows the vowels or lifts everything."
              />
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                {{ hfAirMode === 'voiced' ? 'AIR BAND · VOWELS' : 'AIR BAND · ALL' }}
              </span>
            </div>
            <div class="w-[104px] flex flex-col items-center">
              <Knob
                :model-value="hfDrive"
                @update:model-value="syncDrive"
                :min="0" :max="100" :step="1"
                label="Drive" :accent="ACCENT" :format-value="formatDrive"
                :disabled="!hfPreview"
                title="Input waveshaper ahead of the cut. 50 % puts every curve at the same distortion on a nominal-level voice, so switching curves compares character, not strength. Adds 50 samples of latency while on."
              />
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                {{ driveCaption }}
              </span>
            </div>
            <div class="w-[104px] flex flex-col items-center">
              <!-- ResoTame's Threshold, same meaning: how far a peak must
                   stand above the local spectrum before it is cut. Higher is
                   gentler. Live only while HF RESO is in. -->
              <Knob
                :model-value="hfResoAmount"
                @update:model-value="syncResoAmount"
                :min="0" :max="100" :step="1"
                label="Reso" :accent="ACCENT" :format-value="formatPct"
                :disabled="!hfPreview || !hfReso"
                title="How much the ResoTame pre-stage takes. The first half catches rings and whistles; the second half takes sibilance too, in even steps, and the softener's own cut eases off as it does. Threshold, depth and cut ceiling move together."
              />
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                {{ !hfReso ? 'HF RESO OFF' : hfResoAmount < 50 ? 'RINGS · 5–12k' : 'RINGS + S · 5–12k' }}
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
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">LISP GUARD</span>
          <DeviceChoiceRocker
            :model-value="hfLispGuard" :options="GUARD_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview" label="Lisp guard"
            @update:model-value="syncLispGuard"
          />
        </div>
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">HF RESO</span>
          <DeviceChoiceRocker
            :model-value="hfReso" :options="RESO_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview" label="ResoTame pre-stage"
            @update:model-value="syncReso"
          />
        </div>
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">AIR MODE</span>
          <DeviceChoiceRocker
            :model-value="hfAirMode" :options="AIR_MODE_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview || !(hfAir > 0)" label="Air mode"
            @update:model-value="syncAirMode"
          />
        </div>
      </div>


      <div class="flex justify-center items-center gap-[48px] mt-[18px]">
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">SAT CURVE</span>
          <DeviceDetentRotary
            :model-value="hfCurve" :options="CURVE_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview" label="Saturation curve" :show-label="false"
            @update:model-value="syncCurve"
          />
        </div>
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">EMPH</span>
          <DeviceTravelSlide
            :model-value="hfEmph" :options="EMPH_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview" label="Saturation emphasis"
            @update:model-value="syncEmph"
          />
        </div>
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">SAT BAND</span>
          <DeviceChoiceRocker
            :model-value="hfBand" :options="BAND_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview" label="Saturation band"
            @update:model-value="syncBand"
          />
        </div>
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4)">SAT MODE</span>
          <DeviceChoiceRocker
            :model-value="hfSatMode" :options="SAT_MODE_OPTIONS" :accent="ACCENT"
            :disabled="!hfPreview" label="Saturation mode"
            @update:model-value="syncSatMode"
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
