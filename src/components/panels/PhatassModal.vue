<script setup>
/**
 * PHAT*SS — Psycho Harmonic Analog Tape * Saturation Simulator.
 *
 * WARMTH adds low-end harmonic warmth: two fixed Saturation Bench layers
 * (quartic for even, cubic for odd, both on the low band). WARMTH sets how much
 * is mixed in, 0 is off; CHARACTER is a two-way switch over their balance
 * (ROUND = Odd/Even 50, FIRM = 25 — `CHARACTERS`; it replaced the Odd/Even
 * knob). The peak guard is pinned on with Warmth: it turns down only what
 * Warmth adds, only where the sum would pass the selection's own peak
 * (dsp/warmthGuard.js).
 *
 * TAPE takes dB off the peaks the way tape does, calibrated on the selection's
 * own peak so the knob reads in dB of peak reduction, with automatic
 * peak-restoring makeup. Its switch picks the curve (`TAPE_PANEL_CURVES`):
 * CLEAN, the cubic soft clipper, or THICK, the hysteresis tape loop.
 *
 * HF is a DETENT, not a knob: the tape speed, 30 / 15 / 7.5 IPS. It runs the
 * TAPE HF SHELF (dsp/tapeHfShelf.js) — the top end sags with level, attacks
 * stay bright, and the Tape knob makes it sag sooner — and picks TAPE's head
 * bump (the A800's playback low end at that speed). See HF_DETENTS in
 * phatassParams.js. OFF, FATSO and the bench's Tame are on the bench.
 *
 * SOFTEN moved to the HF Softener (October 2026).
 *
 * In/out meters only. The readout under the Warmth knobs is what the warmth
 * stage did to this selection's low bands and peak.
 */
import { computed, onMounted, watch } from 'vue'
import { usePhatass } from '../../composables/usePhatass.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  WARMTH_MAX, TAPE_MAX_DB, OUTPUT_MIN_DB, OUTPUT_MAX_DB, CHARACTERS, TAPE_PANEL_CURVES, TAPE_SPEEDS,
  warmthActive, tapeHfShelfParams,
} from '../../audio/phatassParams.js'
import Knob from '../knobs/Knob.vue'
import DeviceDetentRotary from '../knobs/DeviceDetentRotary.vue'
import DeviceChoiceRocker from '../knobs/DeviceChoiceRocker.vue'
import PhatassBenchPanel from './PhatassBenchPanel.vue'
import { isPhatassBenchVisible } from '../../audio/effects/phatassBench.js'
import ClassicVuMeter from '../hardware/ClassicVuMeter.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  phParams, phPreview, phInputLevels, phOutputLevels, phSatNeedle, phWarmthReadout, phTapeMakeup, phOutputMakeup,
  togglePreview, syncParam, scheduleWarmthReadout, apply, teardown, closeModal,
} = usePhatass()

const { state } = useEditorState()

// The readout follows the selection and the file, only while the panel is live.
watch(() => [state.selection?.start, state.selection?.end, state.revision], () => {
  if (phPreview.value) scheduleWarmthReadout()
})

onMounted(() => {
  if (!phPreview.value) togglePreview()
})

const ACCENT = '#d9a46a'
const showBench = isPhatassBenchVisible()

// ── Warmth readout ──────────────────────────────────────────────────────────
const READOUT_BANDS = [
  { label: 'SUB', range: '20–60' },
  { label: 'LOW', range: '60–120' },
  { label: 'BODY', range: '120–250' },
  { label: 'LO-MID', range: '250–400' },
]
const SUB_WARN_DB = 0
const PEAK_WARN_DBFS = -1
const WARN = '#ff7a6b'

const readoutCells = computed(() => {
  const r = phWarmthReadout.value
  return READOUT_BANDS.map((b, i) => {
    const v = r.bandsDb ? r.bandsDb[i] : null
    return {
      ...b,
      text: r.bandsPending && v == null ? '…' : v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`,
      warn: i === 0 && v != null && v > SUB_WARN_DB,
      stale: r.bandsPending,
    }
  })
})
// A CHANGE against the selection's own peak (Output and the bench's output trim
// included), absolute under it.
const readoutPeak = computed(() => {
  const r = phWarmthReadout.value
  const trim = phParams.outputMakeup && phParams.outputMakeup !== 'off' ? Number(phParams.outputMakeupDb) || 0 : 0
  const out = (Number(phParams.output) || 0) + trim
  const abs = r.peakDb == null ? null : r.peakDb + out
  const delta = abs == null || r.inputPeakDb == null ? null : abs - r.inputPeakDb
  return {
    text: r.peakPending && delta == null ? '…' : delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`,
    abs: abs == null ? 'dBFS' : `${abs.toFixed(1)} dBFS`,
    warn: abs != null && abs > PEAK_WARN_DBFS,
    stale: r.peakPending,
  }
})

const fmtWarmth = v => (v <= 0 ? 'OFF' : v.toFixed(1))
const fmtTape = v => (v <= 0 ? 'OFF' : `−${v.toFixed(1)}`)
// The makeup TAPE gives back: what it measured off the peak, so the peak lands where it started.
const tapeMakeupCaption = computed(() => {
  if (!(phParams.tape > 0)) return ''
  if (phTapeMakeup.value.pending) return 'MAKEUP …'
  // Signed: with the bench's post head bump the makeup can be a cut.
  const v = Number(phParams.tapeMakeupDb) || 0
  return `MAKEUP ${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}`
})
const fmtDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`
const CHARACTER_TITLES = {
  50: 'Rounder and fuller: more of the even (quartic) layer',
  25: 'Firmer, with more edge: more of the odd (cubic) layer',
}
const CHARACTER_OPTIONS = CHARACTERS.map(c => ({ ...c, title: CHARACTER_TITLES[c.value] }))
// A bench or legacy Odd/Even off the two positions lights neither half.
const characterValue = computed(() => Number(phParams.oddEven))

const TAPE_CURVE_TITLES = {
  cubic: 'A clean soft clipper: rounds off only the top of each wave, adding mostly the third harmonic, and clips flat past about 3.5 dB',
  hysteresis: 'Magnetic tape\'s own loop, with memory: low, heavy hits like kicks are squashed about twice as hard as snares, and peaks round off without a hard clip. Heavier on the processor',
}
const TAPE_CURVE_OPTIONS = TAPE_PANEL_CURVES.map(c => ({ ...c, title: TAPE_CURVE_TITLES[c.value] }))

const HF_OPTIONS = [
  { value: 'ips30', label: '30 IPS', title: 'Tape at 30 inches per second: the most HF headroom. Only the brightest passages sag a little at the very top; the head bump sits lowest and is gentlest' },
  { value: 'ips15', label: '15 IPS', title: 'Tape at 15 inches per second: bright passages lose some top end, and the loss reaches lower as they get hotter. Attacks stay bright. The head bump moves down an octave' },
  { value: 'ips7', label: '7.5 IPS', title: 'Tape at 7.5 inches per second: the least HF headroom. The top end darkens on anything bright and the loss reaches into the upper mids; the head bump is an octave lower again' },
]
const BENCH_HF = {
  off: { value: 'off', label: 'OFF', title: 'Set on the bench: the top end untouched, no head bump' },
}
// A bench-only position shows on the dial rather than leaving it blank.
const hfOptions = computed(() => (BENCH_HF[phParams.hf] ? [...HF_OPTIONS, BENCH_HF[phParams.hf]] : HF_OPTIONS))
// What the current position may cut at most.
const hfCaption = computed(() => {
  const t = tapeHfShelfParams(phParams.hf, phParams.voiceLevelDb)
  return t ? `UP TO −${Math.round(t.rangeDb)} dB` : 'TOP UNTOUCHED'
})
// What the Tape switch's caption says: the head bump the speed brings.
const tapeCurveCaption = computed(() => {
  if (!(phParams.tape > 0)) return 'TAPE IS OFF'
  if (phParams.tapeHeadBump !== 'speed') return 'BUMP · BENCH'
  const sp = TAPE_SPEEDS[phParams.hf]
  return sp ? `BUMP · ${sp.label} IPS` : 'NO BUMP'
})

const LABEL = "font:600 9px/1 'JetBrains Mono', monospace;letter-spacing:.14em;color:rgba(255,255,255,.4)"

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
    window-id="phatass"
    :z="z"
    :width="560"
    :accent="ACCENT"
    brand-lead="PHAT"
    brand-tail="*SS"
    :engaged="phPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!phPreview"
    apply-disabled-hint="Turn PHAT*SS on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="px-[26px] pt-[22px] pb-[26px]">
      <div
        class="flex justify-center mb-[18px]"
        title="SATURATION: how much TAPE and Warmth are adding, against the clean signal — the energy of everything they add, averaged over the last fraction of a second. 0 is −40 dB (barely there), 100 is as much added as the signal itself; red from about half. Warmth reads far higher than TAPE: its low layers reshape the whole low band"
      >
        <ClassicVuMeter face="saturation" :value="phSatNeedle" :active="phPreview" :width="228" />
      </div>
      <div class="flex items-center justify-between gap-[22px]">
        <LevelMeter :levels="phInputLevels" label="IN" :height="150" />

        <div class="flex-1 flex flex-col items-center gap-[16px]">
          <div class="flex justify-center items-start gap-[10px]">
            <div class="w-[80px]" title="Low-end harmonic warmth: an even (quartic) and an odd (cubic) saturator on the low band, voiced for body and fatness. Warmth sets how much of what they add is mixed in — the clean signal is never touched. Calibrated on this file, so a setting means the same on a quiet recording and a hot one. Never raises the selection’s peak: a guard turns the added warmth down for a few milliseconds where it would. 0 is off">
              <Knob
                :model-value="phParams.warmth" @update:model-value="v => syncParam('warmth', v)"
                :min="0" :max="WARMTH_MAX" :step="0.1" :value-font-px="13"
                label="Warmth" :accent="ACCENT" :format-value="fmtWarmth" :disabled="!phPreview"
              />
            </div>
            <div class="w-[80px]" title="Takes this many dB off the selection’s loudest peak the way tape saturation does, and gives it back as level: MAKEUP is automatic — what Tape actually took off the peak is measured on the selection and returned, so the peak lands where it started. CLEAN rounds off only the top of each wave; THICK is magnetic tape’s own loop, heavier on kicks. Turning it up also drives the top end into the HF sag, and brings in the speed’s head bump. 0 is off">
              <Knob
                :model-value="phParams.tape" @update:model-value="v => syncParam('tape', v)"
                :min="0" :max="TAPE_MAX_DB" :step="0.1" :value-font-px="13"
                label="Tape" :accent="ACCENT" :format-value="fmtTape" :disabled="!phPreview"
              />
              <div
                class="text-center h-[10px] mt-[4px]"
                :style="{ font: `600 8.5px/1 'JetBrains Mono', monospace`, letterSpacing: '.08em', color: 'rgba(255,255,255,.45)' }"
              >{{ tapeMakeupCaption }}</div>
            </div>
            <div
              class="w-[96px] flex flex-col items-center"
              title="The tape speed. The treble sags on bright, hot passages — slower tape sags sooner, deeper and further down — while attacks stay bright, and turning Tape up drives it harder. The speed also sets Tape’s head bump, the playback head’s low-end lift, an octave lower at each slower speed. A dull take is left mostly alone"
            >
              <DeviceDetentRotary
                :model-value="phParams.hf" :options="hfOptions" :accent="ACCENT"
                :disabled="!phPreview" label="Speed"
                @update:model-value="v => syncParam('hf', v)"
              />
              <div
                class="text-center h-[10px] mt-[4px]"
                :style="{ font: `600 8.5px/1 'JetBrains Mono', monospace`, letterSpacing: '.08em', color: 'rgba(255,255,255,.45)' }"
              >{{ hfCaption }}</div>
            </div>
            <div class="w-[80px]">
              <Knob
                :model-value="phParams.output" @update:model-value="v => syncParam('output', v)"
                :min="OUTPUT_MIN_DB" :max="OUTPUT_MAX_DB" :step="0.1" :value-font-px="13" bipolar
                label="Output" :accent="ACCENT" :format-value="fmtDb" :disabled="!phPreview"
              />
            </div>
          </div>
          <div class="flex justify-center items-end gap-[28px]">
            <div class="flex flex-col items-center gap-[8px]" title="The character of Warmth: ROUND leans to the even (quartic) layer — rounder, fuller; FIRM to the odd (cubic) one — firmer, more edge. The added level stays about the same either way">
              <span :style="LABEL">CHARACTER</span>
              <DeviceChoiceRocker
                :model-value="characterValue" :options="CHARACTER_OPTIONS" :accent="ACCENT"
                :disabled="!phPreview || phParams.warmth <= 0" label="Warmth character"
                @update:model-value="v => syncParam('oddEven', v)"
              />
            </div>
            <div class="flex flex-col items-center gap-[8px]" title="Which tape Tape drives: CLEAN, a soft clipper that rounds off only the top of each wave, or THICK, magnetic tape’s own loop — heavier on kicks and low hits, peaks rounded without a hard clip">
              <span :style="LABEL">TAPE</span>
              <DeviceChoiceRocker
                :model-value="phParams.tapeCurve" :options="TAPE_CURVE_OPTIONS" :accent="ACCENT"
                :disabled="!phPreview || phParams.tape <= 0" label="Tape type" :caption="tapeCurveCaption"
                @update:model-value="v => syncParam('tapeCurve', v)"
              />
            </div>
          </div>
        </div>

        <LevelMeter :levels="phOutputLevels" label="OUT" :height="150" />
      </div>

      <div
        v-if="warmthActive(phParams)"
        class="mt-[16px] flex justify-center items-end gap-[18px]"
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
        Warmth fattens the low end without raising the peak, Tape rounds off the peaks,
        and the speed sets how the top end sags and where the low end bumps, the way driven tape does.
      </p>

      <!-- Bench only: gated off in production builds. See phatassBench.js. -->
      <PhatassBenchPanel
        v-if="showBench"
        :params="phParams" :disabled="!phPreview" :trim-pending="phOutputMakeup.pending"
        @set="(k, v) => syncParam(k, v)"
      />
    </div>
  </FloatingWindow>
</template>
