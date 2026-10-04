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
 * SOFTEN is the HF Limiter's Transient detector on its OWN band (SOFT FREQ,
 * independent of Tone): it turns that band down for a few milliseconds when it
 * rises suddenly — clicks, lip smacks, hard consonants, the snap of an onset —
 * deeper than the HF Limiter's (36 dB ceiling, up to 1 dB of cut per dB of
 * rise). A gain on a band, never distortion, no latency of its own.
 *
 * Then the TAPE SHELF: the HF Limiter's dynamic shelf with its shape and timing
 * pinned (WARM split, 35 ms release, no Tail, no Transient — the Fatso Warmth 7
 * match). TAME is a macro for Threshold and Range together, TONE for where the
 * tilt starts (the corner, 2–12 kHz). See phatssParams.js for the mapping.
 *
 * In/out meters only. The readout under the Warmth knobs is what the warmth
 * stage did to this selection's low bands and peak.
 */
import { computed, onMounted, watch } from 'vue'
import { usePhatss } from '../../composables/usePhatss.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  WARMTH_MAX, ODD_EVEN_MAX, SOFTEN_MAX, TAME_MAX, TONE_MAX, OUTPUT_MIN_DB, OUTPUT_MAX_DB,
  SOFTEN_FREQ_MIN_HZ, SOFTEN_FREQ_MAX_HZ, warmthActive, tapeShelf,
} from '../../audio/phatssParams.js'
import Knob from '../knobs/Knob.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  phParams, phPreview, phInputLevels, phOutputLevels, phWarmthReadout,
  togglePreview, syncParam, scheduleWarmthReadout, apply, teardown, closeModal,
} = usePhatss()

const { state } = useEditorState()

// The readout follows the selection and the file, only while the panel is live.
watch(() => [state.selection?.start, state.selection?.end, state.revision], () => {
  if (phPreview.value) scheduleWarmthReadout()
})

onMounted(() => {
  if (!phPreview.value) togglePreview()
})

const ACCENT = '#d9a46a'

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
const fmtSoften = v => (v <= 0 ? 'OFF' : v.toFixed(1))
const fmtTone = v => {
  const hz = tapeShelf(1, v).cornerHz
  return `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)}k`
}
const fmtDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`
const fmtSoftFreq = v => (v < 1000 ? `${Math.round(v)}` : `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k`)

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
    window-id="phatss"
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
            <div class="w-[80px]" title="Softens sudden attacks the way tape rounds off transients: when the band above Soft Freq rises suddenly — a click, a lip smack, a hard T or K, the snap of an onset — it is turned down for a few milliseconds. It reacts to how suddenly the band rises, not how loud it is, so steady sound and an S are left alone. Deeper than the HF Limiter's Transient. A gain on a band, never distortion. 0 is off">
              <Knob
                :model-value="phParams.soften" @update:model-value="v => syncParam('soften', v)"
                :min="0" :max="SOFTEN_MAX" :step="0.1" :value-font-px="13"
                label="Soften" :accent="ACCENT" :format-value="fmtSoften" :disabled="!phPreview"
              />
            </div>
            <div class="w-[80px]" title="Where Soften listens and cuts, independent of Tone. It is a gentle 6 dB/oct tilt, so it reaches an octave or two below; lower takes in more of the voice's snap, higher only the very top">
              <Knob
                :model-value="phParams.softenFreq" @update:model-value="v => syncParam('softenFreq', v)"
                :min="SOFTEN_FREQ_MIN_HZ" :max="SOFTEN_FREQ_MAX_HZ" :step="10" scale="log" :value-font-px="13"
                label="Soft Freq" :accent="ACCENT" :format-value="fmtSoftFreq" :disabled="!phPreview || phParams.soften <= 0"
              />
            </div>
          </div>
          <div class="flex justify-center gap-[12px]">
            <div class="w-[80px]" title="How hard the tape rounds off the top end: lowers the threshold and deepens the most it may cut together, relative to the file's voice level. 0 is off">
              <Knob
                :model-value="phParams.tame" @update:model-value="v => syncParam('tame', v)"
                :min="0" :max="TAME_MAX" :step="0.1" :value-font-px="13"
                label="Tame" :accent="ACCENT" :format-value="fmtTame" :disabled="!phPreview"
              />
            </div>
            <div class="w-[80px]" title="Where the top-end tilt starts. It is a gentle 6 dB/oct tilt, so it reaches an octave or more below this">
              <Knob
                :model-value="phParams.tone" @update:model-value="v => syncParam('tone', v)"
                :min="0" :max="TONE_MAX" :step="0.1" :value-font-px="13"
                label="Tone" :accent="ACCENT" :format-value="fmtTone" :disabled="!phPreview || phParams.tame <= 0"
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
        Warmth fattens the low end without raising the peak, Soften rounds off sudden
        attacks, and Tame rounds off the top the way tape does, starting at Tone.
      </p>
    </div>
  </FloatingWindow>
</template>
