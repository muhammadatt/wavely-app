<script setup>
/**
 * PHAT*SS — Psycho Harmonic Analog Tape * Saturation Simulator.
 *
 * WARMTH adds low-end harmonic warmth: two fixed Saturation Bench layers
 * (quartic for even, cubic for odd, both on the low band). WARMTH sets how much
 * is mixed in, 0 is off; ODD/EVEN crossfades the two at constant level over the
 * useful first quarter of the blend (ODD_EVEN_SPAN). The peak guard is pinned
 * on with Warmth: it turns down only what Warmth adds, only where the sum would
 * pass the selection's own peak (dsp/warmthGuard.js).
 *
 * SOFTEN (a lit toggle) is the HF Limiter's Transient detector on its own band
 * above 500 Hz: it turns that band down for a few milliseconds when it rises
 * suddenly — clicks, lip smacks, hard consonants, the snap of an onset. It has
 * no knob: its depth rides TAME, so the top end and the attacks turn down
 * together. A gain on a band, never distortion, no latency of its own.
 *
 * TAPE takes dB off the peaks the way tape does: a full-band cubic soft
 * clipper, calibrated on the selection's own peak so the knob reads in dB of
 * peak reduction. A waveshaper, not a compressor — quiet material is untouched.
 *
 * Then the TAPE SHELF: the HF Limiter's dynamic shelf with its shape and timing
 * pinned (WARM split, 35 ms release, no Tail, no Transient — the Fatso Warmth 7
 * match), its corner at 2 kHz. TAME is a macro for Threshold and Range together,
 * on one of two CURVES: VOICE (voiced on narration) or FATSO (fitted to the EL7
 * Fatso's Warmth knob on music). DETECT picks where the shelf listens: 2K, the
 * band it cuts, or 4K, so sibilance triggers it before vowel brightness. The
 * old Tame/Tone law is deprecated and off the panel. See phatassParams.js.
 *
 * In/out meters only. The readout under the Warmth knobs is what the warmth
 * stage did to this selection's low bands and peak.
 */
import { computed, onMounted, watch } from 'vue'
import { usePhatass } from '../../composables/usePhatass.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  WARMTH_MAX, ODD_EVEN_MAX, TAME_MAX, SOFTEN_MAX, TAPE_MAX_DB, OUTPUT_MIN_DB, OUTPUT_MAX_DB,
  warmthActive, tapeShelf, softenLaw, CURVE_DETECT,
} from '../../audio/phatassParams.js'
import Knob from '../knobs/Knob.vue'
import DeviceChoiceRocker from '../knobs/DeviceChoiceRocker.vue'
import PhatassBenchPanel from './PhatassBenchPanel.vue'
import { isPhatassBenchVisible } from '../../audio/effects/phatassBench.js'
import ClassicVuMeter from '../hardware/ClassicVuMeter.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  phParams, phPreview, phInputLevels, phOutputLevels, phSatNeedle, phWarmthReadout, phTapeMakeup,
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
// A CHANGE against the selection's own peak (Output included), absolute under it.
const readoutPeak = computed(() => {
  const r = phWarmthReadout.value
  const out = Number(phParams.output) || 0
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
const fmtOddEven = v => (v <= 0 ? 'ODD' : `${Math.round(v)}`)
const fmtTame = v => (v <= 0 ? 'OFF' : v.toFixed(1))
const fmtTape = v => (v <= 0 ? 'OFF' : `−${v.toFixed(1)}`)
// The makeup TAPE gives back: what it measured off the peak, so the peak lands where it started.
const tapeMakeupCaption = computed(() => {
  if (!(phParams.tape > 0)) return ''
  if (phTapeMakeup.value.pending) return 'MAKEUP …'
  return `MAKEUP +${(Number(phParams.tapeMakeupDb) || 0).toFixed(1)}`
})
const fmtDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`
const fmtSoften = v => (v <= 0 ? 'OFF' : v.toFixed(1))
// What the Soften knob currently allows on one attack.
const softenCaption = computed(() => {
  const d = softenLaw(phParams.soften).depthDb
  return d > 0 ? `UP TO −${Math.round(d)} dB` : ''
})

const CURVE_OPTIONS = [
  { value: 'voice', label: 'VOICE', title: 'Tame voiced on narration: it starts on the brightest sibilance at low settings and keeps going deeper to the top of the knob' },
  { value: 'fatso', label: 'FATSO', title: 'Tame fitted to the Warmth knob of an EL7 Fatso (on music): lighter at the bottom of the knob, about 6 dB later than VOICE everywhere' },
]
const DETECT_OPTIONS = [
  { value: '2k', label: '2K', title: 'The shelf listens to the same band it cuts, everything above 2 kHz: loud vowel brightness and sibilance both trigger it' },
  { value: '4k', label: '4K', title: 'The shelf listens above 4 kHz but still cuts from 2 kHz: sibilance triggers it before vowel brightness does' },
]
// What Tame currently does on the chosen curve.
const curveCaption = computed(() => {
  const s = tapeShelf(phParams.tame, phParams.tone, phParams.curve)
  return s.rangeDb > 0 ? `CUTS UP TO ${Math.round(s.rangeDb)} dB` : 'TAME IS 0'
})
const detectCaption = computed(() => (phParams.detect === '4k' ? 'SIBILANCE FIRST' : 'ALL TREBLE'))

// Each curve brings its paired detector (VOICE + 4K, FATSO + 2K); DETECT can
// still be moved afterwards.
function setCurve(v) {
  syncParam('curve', v)
  if (CURVE_DETECT[v]) syncParam('detect', CURVE_DETECT[v])
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

        <div class="flex-1 flex flex-col items-center gap-[14px]">
          <div class="flex justify-center gap-[12px]">
            <div class="w-[80px]" title="Low-end harmonic warmth: an even (quartic) and an odd (cubic) saturator on the low band, voiced for body and fatness. Warmth sets how much of what they add is mixed in — the clean signal is never touched. Calibrated on this file, so a setting means the same on a quiet recording and a hot one. Never raises the selection’s peak: a guard turns the added warmth down for a few milliseconds where it would. 0 is off">
              <Knob
                :model-value="phParams.warmth" @update:model-value="v => syncParam('warmth', v)"
                :min="0" :max="WARMTH_MAX" :step="0.1" :value-font-px="13"
                label="Warmth" :accent="ACCENT" :format-value="fmtWarmth" :disabled="!phPreview"
              />
            </div>
            <div class="w-[80px]" title="From pure Odd (cubic: firmer, more edge) toward Even (quartic: rounder, fuller, more sub). The added level stays about the same as you turn it. The knob covers only the useful part of the blend">
              <Knob
                :model-value="phParams.oddEven" @update:model-value="v => syncParam('oddEven', v)"
                :min="0" :max="ODD_EVEN_MAX" :step="1" :value-font-px="13"
                label="Odd/Even" :accent="ACCENT" :format-value="fmtOddEven" :disabled="!phPreview || phParams.warmth <= 0"
              />
            </div>
            <div class="w-[80px]" title="Softens sudden attacks the way tape rounds off transients: when the band above 500 Hz rises suddenly — a click, a lip smack, a hard T or K, the snap of an onset — it is turned down for a few milliseconds. It reacts to how suddenly the voice rises, not how loud it is, so steady sound is left alone. The knob sets how deep one attack may be taken down (up to 36 dB at 10) and how hard it leans in. A gain on a band, never distortion. 0 is off">
              <Knob
                :model-value="phParams.soften" @update:model-value="v => syncParam('soften', v)"
                :min="0" :max="SOFTEN_MAX" :step="0.1" :value-font-px="13"
                label="Soften" :accent="ACCENT" :format-value="fmtSoften" :disabled="!phPreview"
              />
              <div
                class="text-center h-[10px] mt-[4px]"
                :style="{ font: `600 8.5px/1 'JetBrains Mono', monospace`, letterSpacing: '.08em', color: 'rgba(255,255,255,.45)' }"
              >{{ softenCaption }}</div>
            </div>
          </div>
          <div class="flex justify-center gap-[12px]">
            <div class="w-[80px]" title="Takes this many dB off the selection’s loudest peak the way tape saturation does: the top of each wave is rounded off, while everything more than about 9 dB under the peak passes untouched. A waveshaper, not a compressor, so it adds odd harmonics as it works — about 2 % at 1 dB, 4 % at 2 dB, 9 % at 3.5. Past 3.5 dB the very top is clipped flat. Peaks carried by sibilance lose somewhat less than the number. MAKEUP is automatic: what Tape actually took off the peak is measured on the selection and given back, so the peak returns to where it started and the reduction becomes loudness. 0 is off">
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
            <div class="w-[80px]" title="How hard the tape rounds off the top end: lowers the threshold and deepens the most it may cut together, relative to the file's voice level. 0 is off">
              <Knob
                :model-value="phParams.tame" @update:model-value="v => syncParam('tame', v)"
                :min="0" :max="TAME_MAX" :step="0.1" :value-font-px="13"
                label="Tame" :accent="ACCENT" :format-value="fmtTame" :disabled="!phPreview"
              />
            </div>
            <div class="w-[80px]">
              <Knob
                :model-value="phParams.output" @update:model-value="v => syncParam('output', v)"
                :min="OUTPUT_MIN_DB" :max="OUTPUT_MAX_DB" :step="0.1" :value-font-px="13" bipolar
                label="Output" :accent="ACCENT" :format-value="fmtDb" :disabled="!phPreview"
              />
            </div>
          </div>
        </div>

        <LevelMeter :levels="phOutputLevels" label="OUT" :height="150" />
      </div>

      <div class="flex justify-center items-end gap-[28px] mt-[16px]">
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px/1 'JetBrains Mono', monospace;letter-spacing:.14em;color:rgba(255,255,255,.4)">CURVE</span>
          <DeviceChoiceRocker
            :model-value="phParams.curve" :options="CURVE_OPTIONS" :accent="ACCENT"
            :disabled="!phPreview || phParams.tame <= 0" label="Tame curve" :caption="curveCaption"
            @update:model-value="setCurve"
          />
        </div>
        <div class="flex flex-col items-center gap-[8px]">
          <span style="font:600 9px/1 'JetBrains Mono', monospace;letter-spacing:.14em;color:rgba(255,255,255,.4)">DETECT</span>
          <DeviceChoiceRocker
            :model-value="phParams.detect" :options="DETECT_OPTIONS" :accent="ACCENT"
            :disabled="!phPreview || phParams.tame <= 0" label="Tame detector" :caption="detectCaption"
            @update:model-value="v => syncParam('detect', v)"
          />
        </div>
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
        Soften rounds off sudden attacks, and Tame rounds off the top from 2 kHz.
      </p>

      <!-- Bench only: gated off in production builds. See phatassBench.js. -->
      <PhatassBenchPanel
        v-if="showBench"
        :params="phParams" :disabled="!phPreview"
        @set="(k, v) => syncParam(k, v)"
      />
    </div>
  </FloatingWindow>
</template>
