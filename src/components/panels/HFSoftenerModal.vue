<script setup>
/**
 * HF Softener.
 *
 * Amount and Context are the tuning; Shape picks the cut. Rotator, Release and
 * vowel release were controls while the design was being tuned and are now
 * pinned (sidechain, 40 ms, on — see useHFSoftener.js). DELTA sits in the
 * header like every other plugin's monitor and never reaches the apply path.
 * The curve is the cut the kernel is running right now, drawn from the same
 * coefficient builder, with the Amount's maximum depth ghosted behind it.
 */
import { computed, onMounted, watch } from 'vue'
import { useHFSoftener } from '../../composables/useHFSoftener.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  amountToMaxDepthDb, amountToThresholdDb, amountToCompressionRatio, softenerSections,
} from '../../audio/hfSoftenerProcessor.js'
import { magnitudeResponseDb } from '../../audio/dsp/biquad.js'
import Knob from '../knobs/Knob.vue'
import DeviceChoiceRocker from '../knobs/DeviceChoiceRocker.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  hfAmount, hfContext, hfShape, hfLispGuard, hfReso, hfDelta, hfPreview,
  hfFileLevelDb, hfLevelOffset, refreshLevel,
  hfReduction, hfThresholdLift, hfInputLevels, hfOutputLevels,
  togglePreview, syncAmount, syncContext, syncShape, syncLispGuard, syncReso, toggleDelta,
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
  { value: true, label: 'ON', title: 'Run a band-limited ResoTame (5–12 kHz, peaks only) ahead of the softener — takes rings and whistly S, leaves ordinary S to the softener. Adds 11.6 ms latency' },
  { value: false, label: 'OFF', title: 'Softener alone' },
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

const CURVE_FREQS = Array.from({ length: 160 }, (_, i) =>
  F_MIN * Math.pow(F_MAX / F_MIN, i / 159),
)
const GRID_FREQS = [100, 1000, 4500, 10000, 20000]

function xFor(freqHz) {
  return (Math.log2(freqHz / F_MIN) / Math.log2(F_MAX / F_MIN)) * CURVE_W
}

function yFor(db) {
  // 0 dB on the top edge; the shelf only ever cuts.
  return (db / DB_MIN) * CURVE_H
}

function shelfPath(gainDb) {
  const sr = state.currentFile?.sampleRate ?? 44100
  const db = magnitudeResponseDb(softenerSections(sr, gainDb, hfShape.value), CURVE_FREQS, sr)
  return CURVE_FREQS.map(
    (f, i) => `${i === 0 ? 'M' : 'L'}${xFor(f).toFixed(1)},${Math.max(0.5, yFor(db[i])).toFixed(1)}`,
  ).join(' ')
}

const maxDepthDb = computed(() => amountToMaxDepthDb(hfAmount.value / 100))
const maxPath = computed(() => shelfPath(-maxDepthDb.value))
const livePath = computed(() => shelfPath(-Math.min(hfReduction.value, maxDepthDb.value)))
const liveFill = computed(() => `${livePath.value} L${CURVE_W},0 L0,0 Z`)

// The TRUE compression ratio (1.5:1 at the default, 6:1 at 100 %), not the
// spec's divisor. Max depth is on the meter's scale and rarely the limit.
const ratioLabel = computed(() => `${amountToCompressionRatio(hfAmount.value / 100).toFixed(1)}:1`)

const thresholdLabel = computed(() => {
  // The threshold actually in force: the Amount's nominal plus the file's
  // level offset, so the readout names the level the detector compares to.
  const t = amountToThresholdDb(hfAmount.value / 100) + hfLevelOffset.value
  return hfAmount.value === 0 ? 'OFF' : `${t.toFixed(0)} dBFS`
})


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
    :width="620"
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
      <GainReductionBar :reduction-db="-hfReduction" :accent="ACCENT" :full-scale-db="24" title="SHELF DEPTH" />

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
            <line :x1="0" :y1="0.5" :x2="CURVE_W" :y2="0.5" stroke="rgba(255,255,255,.14)" stroke-width="1" />
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

          <div class="flex gap-[38px] mt-[16px]">
            <div class="w-[112px] flex flex-col items-center">
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
            <div class="w-[112px] flex flex-col items-center">
              <Knob
                :model-value="hfContext"
                @update:model-value="syncContext"
                :min="0" :max="100" :step="1"
                label="Context" :accent="ACCENT" :format-value="formatPct"
                :disabled="!hfPreview"
              />
              <!-- Deliberately unsmoothed: with Context up, the same sibilant
                   is treated differently by phrase, and the readout says so. -->
              <span style="font:600 8.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.35)">
                +{{ hfThresholdLift.toFixed(1) }} dB LIFT
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
