<script setup>
import { computed, onMounted } from 'vue'
import { useResonance } from '../../composables/useResonance.js'
import { PITCH_RANGES, effectivePitchRange } from '../../audio/resonanceParams.js'
import { useEditorState } from '../../composables/useEditorState.js'
import Knob from '../knobs/Knob.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'
import DeviceRangeSlider from '../knobs/DeviceRangeSlider.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import ResonanceSpectrum from '../meters/ResonanceSpectrum.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  resDepth, resSharpness, resSelectivity, resAttack, resRelease,
  resMaxReduction, resFreqFloor, resFreqCeil, resMode, resPreserveHarmonics,
  resPitchRange, resPreview, resDelta, resReduction, resInputLevels, resOutputLevels,
  resDisplayFn, hasSelection,
  togglePreview, toggleDelta, syncDepth, syncSharpness, syncSelectivity, syncAttack,
  syncRelease, syncMaxReduction, syncFreqFloor, syncFreqCeil, syncMode,
  syncPitchRange, togglePreserveHarmonics, apply, teardown, closeModal,
} = useResonance()

const { state } = useEditorState()

onMounted(() => {
  if (!resPreview.value) togglePreview()
})

const ACCENT = '#8de0a8'

const MODE_OPTIONS = [
  { value: 'soft', label: 'SOFT', title: 'Gradual knee above the threshold' },
  { value: 'hard', label: 'HARD', title: 'Linear above the threshold' },
]

// Which pitches harmonic protection looks for. Nothing else about the effect
// assumes speech, and this should not either — see PITCH_RANGES.
const PITCH_RANGE_OPTIONS = Object.entries(PITCH_RANGES).map(([value, r]) => ({
  value,
  label: r.label,
  title: r.title,
}))

const percent = v => `${Math.round(v * 100)}`
const oneDp = v => v.toFixed(1)
const ms = v => `${Math.round(v)}`
const db = v => `${Math.round(v)}`

/**
 * Frequency for the range readout. Carries its unit, because the two ends of
 * the band now share one readout and "40 – 20k" reads as a pair of unrelated
 * numbers where "40 Hz – 20 kHz" reads as a span.
 */
const hz = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`)

/**
 * Round a frequency off the range track to something printable.
 *
 * The track steps in constant octaves, so its raw values are things like
 * 8347.2 Hz. Snapping by decade keeps the readout to three figures at every
 * point on the scale, and keeps a handle nudged with the arrow keys landing on
 * round numbers rather than drifting through the decimals.
 */
function snapHz(v) {
  if (v < 100) return Math.round(v)
  if (v < 1000) return Math.round(v / 5) * 5
  if (v < 10000) return Math.round(v / 50) * 50
  return Math.round(v / 250) * 250
}

const modeCaption = computed(() =>
  resMode.value === 'soft' ? 'gradual knee' : 'linear above threshold',
)

// The kernel clamps the low end to what its analysis frame can resolve, so show
// what it will actually search rather than what the preset asked for.
const pitchRangeCaption = computed(() => {
  const sr = state.currentFile?.sampleRate ?? 44100
  const r = effectivePitchRange(sr, resPitchRange.value)
  return `${Math.round(r.minHz)}–${Math.round(r.maxHz)} Hz`
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
    window-id="resonance-suppressor"
    :z="z"
    :width="660"
    :accent="ACCENT"
    brand-lead="RESO"
    brand-tail="TAME"
    :engaged="resPreview"
    @toggle-engaged="togglePreview"
    @close="close"
  >
    <!-- Delta sits beside ON/BYPASS because it is the same kind of control:
         both change what reaches the speakers and neither changes the file.
         Putting it down among the parameters would have implied it was one. -->
    <template #header-center>
      <button
        class="flex items-center gap-2 px-3 py-1.5 rounded-full border cursor-pointer transition-opacity disabled:cursor-default"
        :style="{
          background: resDelta ? `color-mix(in srgb, ${ACCENT} 26%, transparent)` : 'transparent',
          borderColor: resDelta
            ? `color-mix(in srgb, ${ACCENT} 55%, transparent)`
            : 'rgba(255,255,255,.14)',
          opacity: resPreview ? 1 : 0.4,
        }"
        :disabled="!resPreview"
        :aria-pressed="String(resDelta)"
        title="Hear only what is being removed. Monitoring only — Apply always renders the processed audio."
        @pointerdown.stop
        @click="toggleDelta"
      >
        <span
          :style="{
            font: `700 9px 'JetBrains Mono',monospace`,
            letterSpacing: '.14em',
            color: resDelta
              ? `color-mix(in srgb, ${ACCENT} 55%, #ffffff)`
              : 'rgba(255,255,255,.45)',
          }"
        >DELTA</span>
      </button>
    </template>
    <div class="px-[26px] pt-[18px] pb-[18px]">
      <!-- The display, not a meter. This effect cuts a few narrow bands and
           leaves the rest alone, so "how much" without "where" describes almost
           nothing about it — see the note in ResonanceSpectrum. -->
      <ResonanceSpectrum
        :data-fn="resDisplayFn"
        :reduction-db="resReduction"
        :accent="ACCENT"
        :selectivity-db="resSelectivity"
        :freq-floor-hz="resFreqFloor"
        :freq-ceil-hz="resFreqCeil"
        :height="140"
        :delta="resDelta"
      />

      <div class="flex items-center justify-between gap-[18px] mt-[16px]">
        <LevelMeter :levels="resInputLevels" label="IN" :height="104" />

        <div class="flex-1 flex justify-center gap-[28px]">
          <div class="w-[104px]">
            <Knob
              :model-value="resDepth" @update:model-value="syncDepth"
              :min="0" :max="1" :step="0.01"
              label="Depth" :accent="ACCENT" :format-value="percent"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[104px]">
            <Knob
              :model-value="resSelectivity" @update:model-value="syncSelectivity"
              :min="3" :max="24" :step="0.5"
              label="Selectivity" :accent="ACCENT" :format-value="oneDp"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[104px]">
            <Knob
              :model-value="resSharpness" @update:model-value="syncSharpness"
              :min="0" :max="1" :step="0.01"
              label="Sharpness" :accent="ACCENT" :format-value="percent"
              :disabled="!resPreview"
            />
          </div>
        </div>

        <LevelMeter :levels="resOutputLevels" label="OUT" :height="104" />
      </div>

      <!-- Timing + ceiling -->
      <div class="flex items-center justify-between mt-[14px] pt-[13px]"
           style="border-top:1px solid rgba(255,255,255,.06)">
        <SegmentedSwitch
          :model-value="resMode"
          @update:model-value="syncMode"
          :options="MODE_OPTIONS"
          :accent="ACCENT"
          :disabled="!resPreview"
          :caption="modeCaption"
        />

        <div class="flex gap-[20px]">
          <div class="w-[66px]">
            <Knob
              :model-value="resAttack" @update:model-value="syncAttack"
              :min="1" :max="100" :step="1" :value-font-px="13"
              label="Attack ms" :accent="ACCENT" :format-value="ms"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[66px]">
            <Knob
              :model-value="resRelease" @update:model-value="syncRelease"
              :min="10" :max="500" :step="5" :value-font-px="13"
              label="Release ms" :accent="ACCENT" :format-value="ms"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[66px]">
            <Knob
              :model-value="resMaxReduction" @update:model-value="syncMaxReduction"
              :min="3" :max="48" :step="1" :value-font-px="13"
              label="Max Cut dB" :accent="ACCENT" :format-value="db"
              :disabled="!resPreview"
            />
          </div>
        </div>
      </div>

      <!-- Range + harmonic protection.
           One line, and it has to be: this panel outgrew the viewport when the
           spectrum display went in, and a section that stacked a two-line
           button over a switch over a caption was the tallest thing here that
           was not a control. Everything in it is now on the baseline the range
           fader sets. -->
      <div class="flex items-end gap-[20px] mt-[14px] pt-[13px]"
           style="border-top:1px solid rgba(255,255,255,.06)">
        <div class="flex-1">
          <DeviceRangeSlider
            :low="resFreqFloor" :high="resFreqCeil"
            @update:low="syncFreqFloor" @update:high="syncFreqCeil"
            :min="20" :max="20000"
            :snap="snapHz"
            label="Range" :accent="ACCENT" :format-value="hz"
            :disabled="!resPreview"
          />
        </div>

        <!-- Harmonic protection is the safety mechanism, not a flavour
             control: without it the cepstral reference sits at the
             inter-harmonic floor and the suppressor eats the harmonics of
             whatever is playing. The range picker sits with it because it
             feeds it — protection is only as good as the pitch it is handed,
             and a source outside the range reports an octave artefact rather
             than nothing, which puts the mask on the wrong bins.

             The sentence that used to sit under the label is now only in the
             tooltip. It explained the state well and cost 30 px of a panel
             that had none to spare, and the label already says which state it
             is in — the amber, which is what actually carries the warning,
             is unchanged. -->
        <button
          class="shrink-0 px-3 py-[9px] rounded-lg cursor-pointer transition-all text-left disabled:cursor-default"
          :style="{
            background: resPreserveHarmonics ? 'rgba(141,224,168,.14)' : 'rgba(255,178,122,.12)',
            border: `1px solid ${resPreserveHarmonics ? 'rgba(141,224,168,.4)' : 'rgba(255,178,122,.45)'}`,
            opacity: resPreview ? 1 : 0.4,
          }"
          :disabled="!resPreview"
          :title="resPreserveHarmonics
            ? 'Preserves the harmonics of the pitched source in the recording, so they are not treated as resonances. Turning it off is a diagnostic aid — it will thin the material.'
            : 'Full suppression. The harmonics of the pitched source are treated as resonances like anything else, which will thin the material. A diagnostic aid — turn it back on for normal use.'"
          @click="togglePreserveHarmonics"
        >
          <span
            class="block whitespace-nowrap"
            :style="{
              font: `700 8.5px 'JetBrains Mono',monospace`,
              letterSpacing: '.12em',
              color: resPreserveHarmonics ? '#8de0a8' : '#ffb27a',
            }"
          >{{ resPreserveHarmonics ? 'PRESERVE HARMONICS' : 'PROTECTION OFF' }}</span>
        </button>

        <SegmentedSwitch
          class="shrink-0"
          :model-value="resPitchRange"
          @update:model-value="syncPitchRange"
          :options="PITCH_RANGE_OPTIONS"
          :accent="ACCENT"
          :disabled="!resPreview || !resPreserveHarmonics"
          :caption="`Protect ${pitchRangeCaption}`"
        />
      </div>

      <div class="mt-[14px]">
        <ApplyAction
          size="md"
          show-preview
          previewable
          :previewing="state.isPlaying"
          :accent="ACCENT"
          text-color="#0c1f14"
          :met="hasSelection"
          message="Make a selection to tame resonances"
          label="Apply Resonance Suppression"
          :disabled="!resPreview"
          disabled-hint="Turn ResoTame on to apply it"
          @toggle-preview="togglePlayback"
          @apply="applyAndClose"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
