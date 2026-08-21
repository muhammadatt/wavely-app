<script setup>
import { computed, onMounted, ref } from 'vue'
import { useResonance } from '../../composables/useResonance.js'
import {
  PITCH_RANGES,
  effectivePitchRange,
  RESONANCE_ATTACK_MIN_MS,
  RESONANCE_RELEASE_MIN_MS,
} from '../../audio/resonanceParams.js'
import { useEditorState } from '../../composables/useEditorState.js'
import Knob from '../knobs/Knob.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'
import DeviceRangeSlider from '../knobs/DeviceRangeSlider.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import ResonanceSpectrum from '../meters/ResonanceSpectrum.vue'
import ResonanceZoneStrip from '../meters/ResonanceZoneStrip.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  resDepth, resSharpness, resSelectivity, resAttack, resRelease,
  resMaxReduction, resFreqFloor, resFreqCeil, resMode, resPreserveHarmonics,
  resPitchRange, resMix, resTrim, resZones, resSelectedZone, resRefMode,
  resPreview, resDelta, resReduction, resInputLevels, resOutputLevels,
  resDisplayFn, hasSelection,
  togglePreview, toggleDelta, syncDepth, syncSharpness, syncSelectivity, syncAttack,
  syncRelease, syncMaxReduction, syncMix, syncTrim, syncZones,
  syncFreqFloor, syncFreqCeil,
  syncMode, syncPitchRange, togglePreserveHarmonics, apply, teardown, closeModal,
} = useResonance()

const { state } = useEditorState()

onMounted(() => {
  if (!resPreview.value) togglePreview()
})

const ACCENT = '#8de0a8'

/**
 * The spectrum display's height — opens at 140, and grows from there. See
 * FloatingWindow's `resizable`: the corner grip reports how many extra
 * pixels the user has dragged in, and this is the only thing here that
 * spends them; the meters, the knobs and the range fader stay exactly the
 * size they were designed at.
 */
/**
 * THE DISPLAY IS THE PANEL, and 140 px was the number a cramped layout could
 * spare rather than the number it needs. Three curves, a reduction lane and now
 * a zone lane were sharing the height of two rows of knobs. The knobs below it
 * moved onto one row to pay for this — see the note there.
 */
const PLOT_H = 208
const heightDelta = ref(0)
const plotHeight = computed(() => PLOT_H + heightDelta.value)

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
const signedDb = v => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))

/**
 * Frequency for the range readout. Carries its unit, because the two ends of
 * the band now share one readout and "40 – 20k" reads as a pair of unrelated
 * numbers where "40 Hz – 20 kHz" reads as a span.
 */
const hz = v => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`)

/**
 * Round a frequency off the range track to something printable.
 *
 * The track steps in constant octaves, so its raw values are things like
 * 8347.2 Hz. Snapping by decade keeps the readout to three figures at every
 * point on the scale, and keeps a handle nudged with the arrow keys landing on
 * round numbers rather than drifting through the decimals.
 *
 * Every step here is finer than one step of the track, which is ~1.4% of the
 * frequency wherever you are on it. A coarser snap would quantise the drag
 * itself — the thumb would sit still through several steps and then jump —
 * because the accepted value is written back to the element on every event.
 */
function snapHz(v) {
  if (v < 100) return Math.round(v)
  if (v < 1000) return Math.round(v / 5) * 5
  if (v < 10000) return Math.round(v / 25) * 25
  return Math.round(v / 100) * 100
}

/**
 * The protection control means different things under the two references, and
 * the warning has to follow it.
 *
 * Under the cepstral reference the mask is the safety mechanism: it sits at the
 * inter-harmonic floor, so harmonics protrude and read as resonances, and
 * turning protection off really will thin the material. The peak-envelope
 * reference is drawn THROUGH the harmonic peaks, so a harmonic is not a
 * resonance by construction and the mask has nothing to do — leaving an amber
 * "risks thinning harmonic frequencies" there would be warning about the one
 * thing that mode exists to make safe.
 */
/**
 * The same switch does two different things under the two references, so it is
 * labelled for the one in use rather than carrying one name over both.
 *
 * Under the cepstral reference it is PROTECTION: that reference sits at the
 * inter-harmonic floor, so harmonics protrude and read as resonances, and
 * turning the mask off really will thin the material — hence the amber warning.
 *
 * Under the peak reference nothing protrudes at a harmonic, so there is nothing
 * to protect against and the warning would be false. What the mask does there
 * is invert the cut — the partials are held and the floor between them is
 * attenuated. That is a different process, not a broken one, so the control
 * stays live; it just must not claim to be protecting anything.
 */
const protectionIsProtection = computed(() => resRefMode === 'cepstral')

const protectionIsRisky = computed(
  () => protectionIsProtection.value && !resPreserveHarmonics.value,
)

const protectionCaption = computed(() => {
  if (!protectionIsProtection.value) {
    return resPreserveHarmonics.value
      ? 'Cuts between the partials, not on them.'
      : 'Cuts evenly across the spectrum.'
  }
  return resPreserveHarmonics.value
    ? 'Preserves harmonic frequencies.'
    : 'Full suppression — risks thinning harmonic frequencies.'
})

const protectionTitle = computed(() =>
  protectionIsProtection.value
    ? 'Protects the harmonics of the pitched source in the recording from being treated as resonances. Turning it off is a diagnostic aid — it will thin the material.'
    : 'Under the peak-envelope reference a harmonic cannot read as a resonance, so this is not protection. It inverts where the cut lands: the partials are held and the floor between them is attenuated. Measured on real narration it does not improve the harmonic-to-noise ratio — it is quieter, not cleaner.',
)

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
    resizable
    @update:height-delta="heightDelta = $event"
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
      <!-- An override is a thing you forget you turned on. The two references
           disagree by an order of magnitude about what Selectivity measures, so
           a panel running the non-shipping one and not saying so is a panel
           whose numbers mean something other than they appear to. -->
      <span
        v-if="resRefMode !== 'cepstral'"
        class="px-2 py-1 rounded-full"
        style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.12em;
               color:#ffb27a;background:rgba(255,178,122,.12);
               border:1px solid rgba(255,178,122,.45)"
        title="Non-shipping reference, selected by ?resoRef. Its knob calibration differs from the default mode's."
      >{{ resRefMode.toUpperCase() }} REF</span>
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
        :height="plotHeight"
        :delta="resDelta"
        :zones="resZones"
        :selected-zone="resSelectedZone"
        @update:zones="syncZones"
        @update:selected-zone="resSelectedZone = $event"
      />

      <!-- The zone strip belongs directly under the plot because the two are
           one control split by what they edit: the plot owns where a zone IS
           (boundaries are horizontal extents and the axis is horizontal), this
           owns what it DOES. Selection lights both, so the cell and the span
           read as the same object. -->
      <div class="mt-[10px]">
        <ResonanceZoneStrip
          :zones="resZones"
          :selected="resSelectedZone"
          :freq-floor-hz="resFreqFloor"
          :freq-ceil-hz="resFreqCeil"
          :accent="ACCENT"
          :disabled="!resPreview"
          @update:zones="syncZones"
          @update:selected="resSelectedZone = $event"
        />
      </div>

      <!-- ONE ROW OF KNOBS, and it used to be two.
           Everything here is a global setting — what counts as a resonance,
           how fast the detector moves, how much of the result reaches the
           file. They were split across two rows with the level meters beside
           the first, which cost a divider, a set of labels and about 120 px
           for no grouping the labels do not already carry. That height went to
           the display, which is the thing in this panel with something to say.
           The meters shrank with it: they read peak and average, and neither
           needs 104 px to be legible. -->
      <div class="flex items-center justify-between gap-[14px] mt-[14px]">
        <LevelMeter :levels="resInputLevels" label="IN" :height="92" />

        <div class="flex-1 flex justify-center gap-[11px]">
          <div class="w-[62px]">
            <Knob
              :model-value="resDepth" @update:model-value="syncDepth"
              :min="0" :max="1" :step="0.01" :value-font-px="13"
              label="Depth" :accent="ACCENT" :format-value="percent"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[62px]">
            <Knob
              :model-value="resSelectivity" @update:model-value="syncSelectivity"
              :min="3" :max="24" :step="0.5" :value-font-px="13"
              label="Selectivity" :accent="ACCENT" :format-value="oneDp"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[62px]">
            <Knob
              :model-value="resSharpness" @update:model-value="syncSharpness"
              :min="0" :max="1" :step="0.01" :value-font-px="13"
              label="Sharpness" :accent="ACCENT" :format-value="percent"
              :disabled="!resPreview"
            />
          </div>
        <!-- The ballistic minima are the STFT hop, not 0. A time constant
             shorter than one hop leaves the IIR coefficient at zero, so every
             setting below it is the same instantaneous jump — the bottom of
             both knobs used to be travel that could not be heard. See
             RESONANCE_ATTACK_MIN_MS. -->
        <!-- The TOPS were inherited from the shipping panel and were never
             measured. Swept past them on real narration (cepstral reference,
             PROTECTION OFF), and the two knobs turn out not to be the same
             lever. At fixed selectivity, longer attack looks like it cleans
             up but is only refusing to act — jitter per dB removed gets
             WORSE, 0.351 at 12 ms to 0.417 at 800 ms, and at 800 ms it
             removes 0.87 dB, barely more than the mask-on config's 0.20.
             Longer release genuinely improves per dB, 0.416 to 0.299.
             Matched at 3.0 dB of cut (selectivity solved per cell) the whole
             effect is modest and saturates: jitter 0.96/1.29 at 12/80 to
             0.80/1.02 at 200/500 and then flat out to 200/4000. What keeps
             improving past there is p90 depth, 8.5 to 5.2 dB — same average
             cut spread more evenly instead of concentrated in momentary
             deep notches, which is the plausible mechanism for the pitch
             artefacts being audible at all. 400/2000 captures nearly all of
             it (0.77/0.95, p90 5.3); 800/4000 is marginally better still
             (0.73/0.90) but needs selectivity dropped to 13.5 to hold the
             same cut, and an attack near a second no longer tracks a
             phrase. Pause bleed FALLS at matched cut, -2.47 to -1.19 dB,
             because the higher selectivity more than pays for the longer
             tail. -->
          <div class="w-[62px]">
            <Knob
              :model-value="resAttack" @update:model-value="syncAttack"
              :min="RESONANCE_ATTACK_MIN_MS" :max="400" :step="5" :value-font-px="13"
              label="Attack ms" :accent="ACCENT" :format-value="ms"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[62px]">
            <Knob
              :model-value="resRelease" @update:model-value="syncRelease"
              :min="RESONANCE_RELEASE_MIN_MS" :max="2000" :step="10" :value-font-px="13"
              label="Release ms" :accent="ACCENT" :format-value="ms"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[62px]">
            <Knob
              :model-value="resMaxReduction" @update:model-value="syncMaxReduction"
              :min="3" :max="48" :step="1" :value-font-px="13"
              label="Max Cut dB" :accent="ACCENT" :format-value="db"
              :disabled="!resPreview"
            />
          </div>
          <!-- Mix and Trim end the row because they are the output stage: the
               knobs to their left decide what gets cut, these two decide how
               much of that cut reaches the file and at what level. -->
          <div class="w-[62px]">
            <Knob
              :model-value="resMix" @update:model-value="syncMix"
              :min="0" :max="1" :step="0.01" :value-font-px="13"
              label="Mix" :accent="ACCENT" :format-value="percent"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[62px]">
            <Knob
              :model-value="resTrim" @update:model-value="syncTrim"
              :min="-12" :max="12" :step="0.5" :value-font-px="13"
              label="Trim dB" :accent="ACCENT" :format-value="signedDb"
              :disabled="!resPreview"
            />
          </div>
        </div>

        <LevelMeter :levels="resOutputLevels" label="OUT" :height="92" />
      </div>

      <!-- Range + harmonic protection.
           One line, and it has to be: this panel outgrew the viewport when the
           spectrum display went in, and a section that stacked a two-line
           button over a switch over a caption was the tallest thing here that
           was not a control. Everything in it is now on the baseline the range
           fader sets. -->
      <div class="flex items-end gap-[14px] mt-[14px] pt-[13px]"
           style="border-top:1px solid rgba(255,255,255,.06)">
        <!-- The knee switch lost its own row when the knobs merged and lands
             here, beside the other two settings that decide how the DETECTOR
             behaves rather than how much it does. -->
        <SegmentedSwitch
          class="shrink-0"
          :model-value="resMode"
          @update:model-value="syncMode"
          :options="MODE_OPTIONS"
          :accent="ACCENT"
          :disabled="!resPreview"
          :caption="modeCaption"
        />
        <div class="flex-1 min-w-[110px]">
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

             The state sentence under the label is not decoration and does not
             belong in a tooltip. This is the one control here that can quietly
             wreck the material, its two states are not opposites of one name,
             and a tooltip is invisible to anyone who has not already decided
             the control is worth hovering — which is exactly the person about
             to turn protection off without knowing what it protects. It was
             moved to the title attribute to buy 30 px and has been put back;
             the height came out of the plot instead. -->
        <button
          class="shrink-0 px-3 py-[9px] rounded-lg cursor-pointer transition-all text-left disabled:cursor-default"
          style="width:186px"
          :style="{
            background: protectionIsRisky ? 'rgba(255,178,122,.12)' : 'rgba(141,224,168,.14)',
            border: `1px solid ${protectionIsRisky ? 'rgba(255,178,122,.45)' : 'rgba(141,224,168,.4)'}`,
            opacity: resPreview ? 1 : 0.4,
          }"
          :disabled="!resPreview"
          :title="protectionTitle"
          @click="togglePreserveHarmonics"
        >
          <span
            class="block"
            :style="{
              font: `700 8.5px 'JetBrains Mono',monospace`,
              letterSpacing: '.12em',
              color: protectionIsRisky ? '#ffb27a' : '#8de0a8',
            }"
          >{{ protectionIsProtection
            ? (resPreserveHarmonics ? 'PRESERVE HARMONICS' : 'PROTECTION OFF')
            : (resPreserveHarmonics ? 'BETWEEN PARTIALS' : 'ACROSS SPECTRUM') }}</span>
          <span
            class="block mt-[3px]"
            style="font:500 9px/1.4 'Inter';color:rgba(255,255,255,.35)"
          >{{ protectionCaption }}</span>
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
