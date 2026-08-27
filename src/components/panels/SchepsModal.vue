<script setup>
import { computed, onMounted, watch } from 'vue'
import { useScheps } from '../../composables/useScheps.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { pultecNetSections, pultecSections } from '../../audio/dsp/pultec.js'
import { magnitudeResponseDb } from '../../audio/dsp/biquad.js'
import Knob from '../knobs/Knob.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  schepsCharacter, schepsSquash, schepsMix, schepsOutput,
  schepsAutoTrim, schepsAutoTrimBusy, schepsWetTrimDb,
  schepsPreview, schepsReduction, schepsInputLevels, schepsOutputLevels,
  togglePreview, syncCharacter, syncSquash, syncMix, syncOutput,
  toggleAutoTrim, refreshAutoTrim, apply, teardown, closeModal,
} = useScheps()

const { state } = useEditorState()

// Default to engaged when the panel opens, matching the other plugin windows.
onMounted(() => {
  if (!schepsPreview.value) togglePreview()
})

// The trim is measured from the selected region, so a new selection needs a
// fresh measurement.
watch(() => state.selection, () => refreshAutoTrim(), { deep: true })

const ACCENT = '#c98bd8'

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
  return String(Math.round(v))
}

function formatOutput(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

const trimReadout = computed(() => {
  if (!schepsAutoTrim.value) return 'OFF'
  if (schepsAutoTrimBusy.value) return '···'
  const v = schepsWetTrimDb.value
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
})

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
    :width="680"
    :accent="ACCENT"
    brand-lead="SCHEPS"
    brand-tail="PARALLEL"
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
    <div class="px-[26px] pt-[20px] pb-[26px]">
      <!-- The wet path's gain reduction, not the summed output's: the blend
           only passes a fraction of it on. -->
      <GainReductionBar :reduction-db="schepsReduction" :accent="ACCENT" />

      <div class="flex items-start justify-between gap-[20px] mt-[20px]">
        <LevelMeter :levels="schepsInputLevels" label="IN" :height="150" />

        <div class="flex-1 flex flex-col items-center">
          <!-- Response curve: pre, post, and the net of the two -->
          <svg
            :viewBox="`0 0 ${CURVE_W} ${CURVE_H}`"
            class="w-full"
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
            <path :d="netFill" :fill="ACCENT" fill-opacity="0.1" />
            <path
              :d="prePath" stroke="rgba(255,255,255,.3)" stroke-width="1.25"
              fill="none" stroke-dasharray="3 3"
            />
            <path
              :d="postPath" stroke="rgba(255,255,255,.3)" stroke-width="1.25"
              fill="none" stroke-dasharray="1 3"
            />
            <path :d="netPath" :stroke="ACCENT" stroke-width="2" fill="none" />
          </svg>
          <div class="relative w-full mt-[3px] h-[10px]">
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

          <!-- Trace key. Without it the two faint traces read as decoration. -->
          <div class="flex gap-[16px] mt-[9px]">
            <span
              v-for="k in [
                { d: '3 3', c: 'rgba(255,255,255,.4)', t: 'Into compressor' },
                { d: '1 3', c: 'rgba(255,255,255,.4)', t: 'Recovery' },
                { d: '', c: ACCENT, t: 'Net' },
              ]"
              :key="k.t"
              class="flex items-center gap-[5px]"
              style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.34)"
            >
              <svg width="14" height="4" style="overflow:visible">
                <line
                  x1="0" y1="2" x2="14" y2="2"
                  :stroke="k.c" stroke-width="1.6" :stroke-dasharray="k.d || undefined"
                />
              </svg>
              {{ k.t }}
            </span>
          </div>

          <SegmentedSwitch
            :model-value="schepsCharacter"
            @update:model-value="syncCharacter"
            :options="CHARACTER_OPTIONS"
            :accent="ACCENT"
            :disabled="!schepsPreview"
            :caption="CHARACTER_CAPTION[schepsCharacter]"
            class="mt-[16px]"
          />

          <div class="flex gap-[30px] mt-[16px] justify-center">
            <div class="w-[124px]">
              <Knob
                :model-value="schepsSquash"
                @update:model-value="syncSquash"
                :min="0" :max="100" :step="1"
                label="Squash" :accent="ACCENT" :format-value="formatSquash"
                :disabled="!schepsPreview"
              />
            </div>
            <div class="w-[124px] flex flex-col items-center">
              <Knob
                :model-value="schepsMix"
                @update:model-value="syncMix"
                :min="0" :max="100" :step="1"
                label="Mix" :accent="ACCENT" :format-value="formatMix"
                :disabled="!schepsPreview"
              />
              <!-- Auto trim sets the wet path's gain BEFORE the blend sums, so
                   pushing Mix changes character rather than loudness. Switching
                   it off drops to a textbook equal-power crossfade with the wet
                   path at whatever level the chain leaves it. -->
              <button
                class="mt-[7px] px-2.5 py-[4px] rounded-full cursor-pointer transition-all disabled:cursor-default"
                :style="{
                  background: schepsAutoTrim ? 'color-mix(in srgb, ' + ACCENT + ' 16%, transparent)' : 'rgba(255,255,255,.05)',
                  border: `1px solid ${schepsAutoTrim ? 'color-mix(in srgb, ' + ACCENT + ' 42%, transparent)' : 'rgba(255,255,255,.09)'}`,
                  color: schepsAutoTrim ? 'color-mix(in srgb, ' + ACCENT + ' 55%, #ffffff)' : 'rgba(255,255,255,.4)',
                  font: `700 8.5px 'JetBrains Mono',monospace`,
                  letterSpacing: '.1em',
                  opacity: schepsPreview ? 1 : 0.4,
                }"
                :disabled="!schepsPreview"
                :title="schepsAutoTrim
                  ? 'Auto trim on: the wet path is level-matched to the dry one, so Mix is a character control. Click to switch it off.'
                  : 'Auto trim off: the wet path runs at whatever level the chain leaves it. Click to level-match it.'"
                @click="toggleAutoTrim"
              >TRIM {{ trimReadout }}</button>
            </div>
            <div class="w-[96px]">
              <Knob
                :model-value="schepsOutput"
                @update:model-value="syncOutput"
                :min="-12" :max="12" :step="0.1" :value-font-px="13"
                label="Output" :accent="ACCENT" :format-value="formatOutput"
                :disabled="!schepsPreview" bipolar
              />
            </div>
          </div>
        </div>

        <LevelMeter :levels="schepsOutputLevels" label="OUT" :height="150" />
      </div>

      <p
        class="mt-[16px] text-center"
        style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.35)"
      >
        Andrew Scheps' vocal trick: a Pultec pushes the lows out of the way and
        lifts 8 kHz so the opto cell rides the voice instead of the plosives, a
        second Pultec puts the low end back, and the whole squashed copy is
        blended under the original.
      </p>
    </div>
  </FloatingWindow>
</template>
