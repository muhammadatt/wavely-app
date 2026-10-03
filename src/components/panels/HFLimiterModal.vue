<script setup>
/**
 * HF Limiter.
 *
 * WARMTH, first in the chain, adds low-end harmonic warmth: two fixed
 * Saturation Bench layers (quartic for even, tanh for odd, both on the low
 * band). WARMTH sets how much is mixed in, 0 is off; ODD/EVEN crossfades the
 * two at constant level, over only the useful first quarter of the blend
 * (ODD_EVEN_SPAN: 100 is a mostly-odd mix, not pure even). The peak GUARD is
 * pinned on with Warmth: it turns down only what Warmth adds, only where the
 * sum would pass the selection's own peak (a lookahead limiter on the added
 * signal, dsp/warmthGuard.js), so Warmth adds density but never peak level.
 * The readout under the knobs reports what the stage did, guard included.
 * SHELF is a lookahead dynamic shelf that holds the band above FREQ at the
 * THRESHOLD (relative to the file's voice level), never deeper than RANGE, and
 * lets go over RELEASE — then, with TAIL up, over a slow second stage that only
 * a sustained cut charges. SHAPE picks the split: TIGHT is a one-octave
 * linear-phase ceiling, WARM the EL7 Fatso's 6 dB/oct one-pole tilt. TRANSIENT
 * deepens the same cut for a few milliseconds on sudden onsets — clicks, lip
 * smacks, t/k/p bursts, even below THRESHOLD — up to its own depth, stacked on
 * the shelf's; 0 is off. Read dsp/hfLimit.js for the design.
 *
 * The curve is the shelf the kernel is running right now, from the same split
 * it runs, with the deepest cut RANGE allows ghosted behind it. The lamp by
 * TRANSIENT lights while the onset softener cuts (full at 6 dB). DELTA plays only what
 * was removed and never reaches the apply path.
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useHFLimiter } from '../../composables/useHFLimiter.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { shelfResponseDb } from '../../audio/dsp/hfLimit.js'
import {
  FREQ_MIN_HZ, FREQ_MAX_HZ, THRESHOLD_MIN_DB, THRESHOLD_MAX_DB,
  RANGE_MAX_DB, RELEASE_MIN_MS, RELEASE_MAX_MS, TAIL_MIN_MS, TAIL_MAX_MS, TRANSIENT_MAX_DB, WARMTH_MAX, ODD_EVEN_MAX, warmthActive,
} from '../../audio/hfLimiterParams.js'
import Knob from '../knobs/Knob.vue'
import DeviceChoiceRocker from '../knobs/DeviceChoiceRocker.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  hflParams, hflPreview, hflDelta, hflReduction, hflTransient, hflGuard,
  hflInputLevels, hflOutputLevels, hflWarmthReadout,
  togglePreview, syncParam, scheduleWarmthReadout, toggleDelta, apply, teardown, closeModal,
} = useHFLimiter()

const { state } = useEditorState()

// The Warmth readout follows the selection and the file: re-measure when
// either moves (an edit, a new selection), but only while the panel is live.
watch(() => [state.selection?.start, state.selection?.end, state.revision], () => {
  if (hflPreview.value) scheduleWarmthReadout()
})

// ── Warmth readout ──────────────────────────────────────────────────────────
// Per band, output minus input, over the selection; the peak over the WHOLE
// selection plus Output trim (an upper bound: the shelf only lowers peaks).
const READOUT_BANDS = [
  { label: 'SUB', range: '20–60' },
  { label: 'LOW', range: '60–120' },
  { label: 'BODY', range: '120–250' },
  { label: 'LO-MID', range: '250–400' },
]
/** Flag a sub boost and a peak this close to full scale. */
const SUB_WARN_DB = 0
const PEAK_WARN_DBFS = -1
const WARN = '#ff7a6b'

// The guard is pinned on with Warmth; this is how far it is turning the added warmth down.
const guardText = computed(() => {
  if (!warmthActive(hflParams) || !hflPreview.value) return ''
  const v = hflGuard.value
  return v > 0.05 ? `−${v.toFixed(1)} dB` : '0.0 dB'
})
const readoutCells = computed(() => {
  const r = hflWarmthReadout.value
  return READOUT_BANDS.map((b, i) => {
    const raw = r.bandsDb ? r.bandsDb[i] : null
    const v = raw
    return {
      ...b,
      text: r.bandsPending && v == null ? '…' : v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`,
      warn: i === 0 && v != null && v > SUB_WARN_DB,
      stale: r.bandsPending,
    }
  })
})
// The peak is shown as a CHANGE against the selection's own peak (Output
// included), with the absolute level under it for the clipping check.
const readoutPeak = computed(() => {
  const r = hflWarmthReadout.value
  const out = Number(hflParams.output) || 0
  const abs = r.peakDb == null ? null : r.peakDb + out
  const delta = abs == null || r.inputPeakDb == null ? null : abs - r.inputPeakDb
  return {
    text: r.peakPending && delta == null ? '…' : delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`,
    abs: abs == null ? 'dBFS' : `${abs.toFixed(1)} dBFS`,
    warn: abs != null && abs > PEAK_WARN_DBFS,
    stale: r.peakPending,
  }
})

onMounted(() => {
  if (!hflPreview.value) togglePreview()
})

const ACCENT = '#e8b07f'

// ── Response curve ──────────────────────────────────────────────────────────
const CURVE_W = 360
const CURVE_H = 96
const F_MIN = 500
const F_MAX = 20000
const DB_MIN = -RANGE_MAX_DB

const CURVE_FREQS = Array.from({ length: 140 }, (_, i) =>
  F_MIN * Math.pow(F_MAX / F_MIN, i / 139),
)
const GRID_FREQS = [1000, 2000, 5000, 10000, 20000]

function xFor(freqHz) {
  return (Math.log2(freqHz / F_MIN) / Math.log2(F_MAX / F_MIN)) * CURVE_W
}

function yFor(db) {
  return (Math.max(DB_MIN, Math.min(0, db)) / DB_MIN) * CURVE_H
}

const sampleRate = computed(() => state.currentFile?.sampleRate ?? 44100)

function pathFor(gain) {
  const db = shelfResponseDb(sampleRate.value, hflParams.freq, gain, CURVE_FREQS, hflParams.shape)
  return CURVE_FREQS.map(
    (f, i) => `${i === 0 ? 'M' : 'L'}${xFor(f).toFixed(1)},${yFor(db[i]).toFixed(1)}`,
  ).join(' ')
}

// The live cut follows the meter, so the curve moves with the audio.
const livePath = computed(() => pathFor(Math.pow(10, -hflReduction.value / 20)))
const floorPath = computed(() => pathFor(Math.pow(10, -hflParams.range / 20)))
const liveFill = computed(() => `${livePath.value} L${CURVE_W},0 L0,0 Z`)

// ── Transient lamp: instant on, held fall, so one edge is visible ──────────
const lamp = ref(0)
let lampFrame = null
function lampTick() {
  const target = Math.min(1, hflTransient.value / 6)
  lamp.value = target > lamp.value ? target : lamp.value * 0.92
  lampFrame = requestAnimationFrame(lampTick)
}
onMounted(() => { lampFrame = requestAnimationFrame(lampTick) })
onBeforeUnmount(() => { if (lampFrame !== null) cancelAnimationFrame(lampFrame) })
watch(hflPreview, on => { if (!on) lamp.value = 0 })

function gridLabel(f) {
  return f >= 1000 ? `${f / 1000}k` : String(f)
}

const fmtFreq = v => (v >= 10000 ? `${(v / 1000).toFixed(1)}k` : `${(v / 1000).toFixed(2)}k`)
const fmtDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`
const fmtRange = v => (v <= 0 ? 'OFF' : `−${v.toFixed(1)}`)
const fmtMs = v => `${Math.round(v)}`
const fmtTail = v => (v < TAIL_MIN_MS ? 'OFF' : `${Math.round(v)}`)

const SHAPE_OPTIONS = [
  { value: 'tight', label: 'TIGHT', title: 'A one-octave, linear-phase split: a ceiling on the band above Freq, leaving everything below it alone' },
  { value: 'warm', label: 'WARM', title: 'A gentle 6 dB/oct split, the EL7 Fatso’s Warmth: the whole top end tilts down, starting an octave or more below Freq' },
]
const fmtTransient = v => (v <= 0 ? 'OFF' : `−${v.toFixed(1)}`)
const fmtWarmth = v => (v <= 0 ? 'OFF' : v.toFixed(1))
const fmtOddEven = v => (v <= 0 ? 'ODD' : `${Math.round(v)}`)

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
    window-id="hf-limiter"
    :z="z"
    :width="700"
    :accent="ACCENT"
    brand-lead="HF"
    brand-tail="LIMITER"
    :engaged="hflPreview"
    show-delta
    :delta="hflDelta"
    :delta-disabled="!hflPreview"
    delta-title="Hear only what is being removed — it should sound like hiss, sibilance and edges, not voice. Monitoring only; Apply always renders the processed audio."
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!hflPreview"
    apply-disabled-hint="Turn HF Limiter on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-delta="toggleDelta"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="px-[26px] pt-[22px] pb-[26px]">
      <GainReductionBar
        :reduction-db="-hflReduction" :accent="ACCENT"
        :full-scale-db="RANGE_MAX_DB" ballistics="none" title="HF REDUCTION"
      />

      <div class="flex items-center justify-between gap-[22px] mt-[18px]">
        <LevelMeter :levels="hflInputLevels" label="IN" :height="150" />

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
            <line :x1="0" :y1="0" :x2="CURVE_W" :y2="0" stroke="rgba(255,255,255,.14)" stroke-width="1" />
            <line
              :x1="xFor(hflParams.freq)" :y1="0" :x2="xFor(hflParams.freq)" :y2="CURVE_H"
              :stroke="ACCENT" stroke-opacity=".35" stroke-width="1" stroke-dasharray="3 3"
            />
            <path :d="floorPath" stroke="rgba(255,255,255,.22)" stroke-width="1.2" fill="none" stroke-dasharray="4 3" />
            <path :d="liveFill" :fill="ACCENT" fill-opacity="0.12" />
            <path :d="livePath" :stroke="ACCENT" stroke-width="2" fill="none" />
          </svg>
          <div class="relative w-full mt-[4px] h-[10px]">
            <span
              v-for="f in GRID_FREQS" :key="f"
              class="absolute top-0"
              :style="{
                left: `${(xFor(f) / CURVE_W) * 100}%`,
                transform: f >= F_MAX ? 'translateX(-100%)' : 'translateX(-50%)',
                fontWeight: 600, fontSize: '8px',
                fontFamily: 'JetBrains Mono, monospace',
                letterSpacing: '0.08em', color: 'rgba(255,255,255,.28)',
              }"
            >{{ gridLabel(f) }}</span>
          </div>
        </div>

        <LevelMeter :levels="hflOutputLevels" label="OUT" :height="150" />
      </div>

      <div class="flex justify-center gap-[12px] mt-[18px]">
        <div class="w-[80px]" title="Where bright starts: the band above this is what the limiter listens to and turns down">
          <Knob
            :model-value="hflParams.freq" @update:model-value="v => syncParam('freq', v)"
            :min="FREQ_MIN_HZ" :max="FREQ_MAX_HZ" :step="10" scale="log" :value-font-px="13"
            label="Freq" :accent="ACCENT" :format-value="fmtFreq" :disabled="!hflPreview"
          />
        </div>
        <div class="w-[80px]" title="Where the band is held, dB relative to the file's voice level — the same setting does the same thing on a quiet recording and a hot one">
          <Knob
            :model-value="hflParams.threshold" @update:model-value="v => syncParam('threshold', v)"
            :min="THRESHOLD_MIN_DB" :max="THRESHOLD_MAX_DB" :step="0.5" :value-font-px="13"
            label="Threshold" :accent="ACCENT" :format-value="fmtDb" :disabled="!hflPreview"
          />
        </div>
        <div class="w-[80px]" title="The deepest the shelf may cut. Keeps a hard S from turning into a lisp; 0 takes the shelf out">
          <Knob
            :model-value="hflParams.range" @update:model-value="v => syncParam('range', v)"
            :min="0" :max="RANGE_MAX_DB" :step="0.5" :value-font-px="13"
            label="Range" :accent="ACCENT" :format-value="fmtRange" :disabled="!hflPreview"
          />
        </div>
        <div class="w-[80px]" title="How quickly the top comes back after a bright moment, ms">
          <Knob
            :model-value="hflParams.release" @update:model-value="v => syncParam('release', v)"
            :min="RELEASE_MIN_MS" :max="RELEASE_MAX_MS" :step="1" scale="log" :value-font-px="13"
            label="Release" :accent="ACCENT" :format-value="fmtMs" :disabled="!hflPreview"
          />
        </div>
        <div class="w-[80px]" title="A slow second release stage, ms. A sustained bright passage charges it and the top comes back over this long; a single click barely does and recovers at the Release speed. Fully down is OFF, a single-stage release">
          <Knob
            :model-value="hflParams.tail" @update:model-value="v => syncParam('tail', v)"
            :min="0" :max="TAIL_MAX_MS" :step="5" :value-font-px="13"
            label="Tail" :accent="ACCENT" :format-value="fmtTail" :disabled="!hflPreview"
          />
        </div>
        <div class="w-[80px] relative" title="Extra cut on sudden bright onsets — clicks, lip smacks, T, K and P bursts — even below the threshold, for a few milliseconds. Reacts to how suddenly the top end rises, not how loud it is, so a steady S is left to the shelf. Stacks on top of the shelf; 0 is off">
          <Knob
            :model-value="hflParams.transient" @update:model-value="v => syncParam('transient', v)"
            :min="0" :max="TRANSIENT_MAX_DB" :step="0.5" :value-font-px="13"
            label="Transient" :accent="ACCENT" :format-value="fmtTransient" :disabled="!hflPreview"
          />
          <span
            class="absolute top-[2px] right-[6px] w-[7px] h-[7px] rounded-full"
            :style="{
              background: ACCENT,
              opacity: 0.12 + 0.88 * lamp,
              boxShadow: lamp > 0.05 ? `0 0 ${6 * lamp}px ${ACCENT}` : 'none',
            }"
            aria-hidden="true"
          />
        </div>
        <div class="w-[80px]">
          <Knob
            :model-value="hflParams.output" @update:model-value="v => syncParam('output', v)"
            :min="-12" :max="12" :step="0.1" :value-font-px="13" bipolar
            label="Output" :accent="ACCENT" :format-value="fmtDb" :disabled="!hflPreview"
          />
        </div>
      </div>

      <div class="flex justify-center items-end gap-[28px] mt-[16px]">
        <div class="w-[80px]" title="Low-end harmonic warmth BEFORE the limiter: an even (quartic) and an odd (tanh) saturator on the low band, voiced for body and fatness. Warmth sets how much of what they add is mixed in — the clean signal is never touched. Calibrated on this file, so a setting means the same on a quiet recording and a hot one. 0 is off">
          <Knob
            :model-value="hflParams.warmth" @update:model-value="v => syncParam('warmth', v)"
            :min="0" :max="WARMTH_MAX" :step="0.1" :value-font-px="13"
            label="Warmth" :accent="ACCENT" :format-value="fmtWarmth" :disabled="!hflPreview"
          />
        </div>
        <div class="w-[80px]" title="From pure Odd (tanh: firmer, more edge) toward Even (quartic: rounder, fuller, more sub). The added level stays about the same as you turn it. The knob covers only the useful part of the blend — past it the even side mostly adds sub; the bench voicing is 36">
          <Knob
            :model-value="hflParams.oddEven" @update:model-value="v => syncParam('oddEven', v)"
            :min="0" :max="ODD_EVEN_MAX" :step="1" :value-font-px="13"
            label="Odd/Even" :accent="ACCENT" :format-value="fmtOddEven" :disabled="!hflPreview || hflParams.warmth <= 0"
          />
        </div>
        <div class="flex flex-col items-center gap-[8px] pb-[22px]" title="Peak guard, always on with Warmth: Warmth may add density but never raises the selection’s peak. Where the added warmth would push the result past the selection’s own peak, it is turned down for a few milliseconds; the voice itself is never touched. The figure is how far it is turning the warmth down right now">
          <span style="font:600 9px/1 'JetBrains Mono', monospace;letter-spacing:.14em;color:rgba(255,255,255,.4)">GUARD</span>
          <span style="font:600 12px/1 'JetBrains Mono', monospace;color:rgba(255,255,255,.7);min-width:52px;text-align:center">{{ guardText || '—' }}</span>
        </div>
        <div class="flex flex-col items-center gap-[8px] pb-[22px]">
          <span style="font:600 9px/1 'JetBrains Mono', monospace;letter-spacing:.14em;color:rgba(255,255,255,.4)">SHAPE</span>
          <DeviceChoiceRocker
            :model-value="hflParams.shape" :options="SHAPE_OPTIONS" :accent="ACCENT"
            :disabled="!hflPreview" label="Shape"
            @update:model-value="v => syncParam('shape', v)"
          />
        </div>
      </div>

      <div
        v-if="warmthActive(hflParams)"
        class="mt-[12px] flex justify-center items-end gap-[18px]"
        title="What Warmth (with its peak guard) does to this selection: each low band's level change, output minus input (bands over the selection, up to its first 30 s), and how much the highest peak over the whole selection moves (after Output), with the new peak level under it. Red: a sub boost, or a peak above −1 dBFS"
      >
        <div v-for="c in readoutCells" :key="c.label" class="flex flex-col items-center gap-[3px]">
          <span style="font:600 8.5px/1 'JetBrains Mono', monospace;letter-spacing:.1em;color:rgba(255,255,255,.4)">{{ c.label }}</span>
          <span
            :style="{ font: `600 13px/1 'JetBrains Mono', monospace`, color: c.warn ? WARN : 'rgba(255,255,255,.85)', opacity: c.stale ? 0.45 : 1 }"
          >{{ c.text }}</span>
          <span style="font:500 8px/1 'JetBrains Mono', monospace;color:rgba(255,255,255,.3)">{{ c.range }}</span>
        </div>
        <div class="flex flex-col items-center gap-[3px] pl-[14px]" style="border-left:1px solid rgba(255,255,255,.08)">
          <span style="font:600 8.5px/1 'JetBrains Mono', monospace;letter-spacing:.1em;color:rgba(255,255,255,.4)">PEAK</span>
          <span
            :style="{ font: `600 13px/1 'JetBrains Mono', monospace`, color: readoutPeak.warn ? WARN : 'rgba(255,255,255,.85)', opacity: readoutPeak.stale ? 0.45 : 1 }"
          >{{ readoutPeak.text }}</span>
          <span
            :style="{ font: `500 8px/1 'JetBrains Mono', monospace`, color: readoutPeak.warn ? WARN : 'rgba(255,255,255,.3)' }"
          >{{ readoutPeak.abs }}</span>
        </div>
      </div>

      <p
        class="mt-[16px] text-center"
        style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.35)"
      >
        Warmth fattens the low end first, then the top end is held at a ceiling: brightness
        and harshness on the shelf, clicks and sharp onsets on Transient.
      </p>
    </div>
  </FloatingWindow>
</template>
