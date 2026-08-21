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
import DeviceField from '../knobs/DeviceField.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import ResonanceSpectrum from '../meters/ResonanceSpectrum.vue'
import ResonanceZoneControls from './ResonanceZoneControls.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  resAttack, resRelease,
  resMaxReduction, resMode, resPreserveHarmonics,
  resPitchRange, resMix, resTrim, resZones, resSelectedZone, resSoloZone, resRefMode,
  resPreview, resDelta, resReduction, resOutputLevels,
  resDisplayFn, hasSelection,
  togglePreview, toggleDelta, syncAttack,
  syncRelease, syncMaxReduction, syncMix, syncTrim, syncZones, toggleSolo,
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
 * THE DISPLAY IS THE PANEL. 140 px was the number a cramped layout could spare
 * rather than the number it needs; every step since has been the controls
 * giving height back to it. What paid for this one: the two rows of global
 * knobs became one, the input meter went, Max Cut and Trim became fields
 * instead of dials, and the protection button lost a permanent caption it only
 * ever needed in one of its two states. See the notes on that row.
 */
const PLOT_H = 280
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
const ms = v => `${Math.round(v)}`
const db = v => `${Math.round(v)}`
const signedDb = v => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))

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
      <!-- THE OUTPUT METER LIVES BESIDE THE DISPLAY, not in a control row.
           A vertical meter is 54 px of scale and labels around whatever bar
           height it is given, so in a row of 76 px knobs it was the tallest
           thing there and set the row height for everything else. Beside the
           plot it gets the plot's full height for free and costs no row at all.
           The INPUT meter is gone entirely: two meters answer "how much did
           this change the level", and an effect that cuts a few narrow bands
           always answers "barely" — the pair spent width to show two columns at
           the same height. -->
      <div class="flex items-end gap-[10px]">
      <div class="flex-1 min-w-0">
      <ResonanceSpectrum
        :data-fn="resDisplayFn"
        :reduction-db="resReduction"
        :accent="ACCENT"
        :height="plotHeight"
        :delta="resDelta"
        :zones="resZones"
        :selected-zone="resSelectedZone"
        :solo-zone="resSoloZone"
        @update:zones="syncZones"
        @update:selected-zone="resSelectedZone = $event"
      />
      </div>
        <LevelMeter :levels="resOutputLevels" label="OUT" :height="plotHeight - 46" />
      </div>

      <!-- Directly under the plot because the two are one control split by what
           they edit: the plot owns where a zone IS — boundaries are horizontal
           extents and the axis is horizontal — and this owns what it DOES.
           Selection lights both, so the column and the row read as the same
           object. -->
      <div class="mt-[11px]">
        <ResonanceZoneControls
          :zones="resZones"
          :selected="resSelectedZone"
          :solo="resSoloZone"
          :accent="ACCENT"
          :disabled="!resPreview"
          @update:zones="syncZones"
          @update:selected="resSelectedZone = $event"
          @solo="toggleSolo"
        />
      </div>

      <!-- ONE GLOBAL ROW, and everything in it earned its width rather than
           being given a knob by default.
           Depth, Sharpness and Selectivity are per zone and live above. What is
           left describes the effect as a whole, and it used to occupy two rows
           plus an input meter — about 150 px for eight settings, all of it taken
           from the display, which is the thing in this panel with something to
           say.
           THE INPUT METER IS GONE. Two meters answer "how much did this change
           the level", and this effect cuts a few narrow bands: the answer is
           always "barely", so the pair spent 60 px of width to show two columns
           at the same height. The output meter stays because clipping after
           Trim is a real thing to watch for.
           MAX CUT AND TRIM ARE FIELDS, NOT KNOBS. A dial costs 70 px of height
           to express one number and earns it when the number is swept by ear;
           a ceiling and an output trim are set once and read often. Soothe puts
           its own max cut and wet trim in the same shape. -->
      <div class="flex items-end gap-[10px] mt-[13px]">
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
        <div class="w-[64px] shrink-0">
            <Knob
              :model-value="resAttack" @update:model-value="syncAttack"
              :min="RESONANCE_ATTACK_MIN_MS" :max="400" :step="5" :value-font-px="12"
              label="Attack" :accent="ACCENT" :format-value="ms"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[64px] shrink-0">
            <Knob
              :model-value="resRelease" @update:model-value="syncRelease"
              :min="RESONANCE_RELEASE_MIN_MS" :max="2000" :step="10" :value-font-px="12"
              label="Release" :accent="ACCENT" :format-value="ms"
              :disabled="!resPreview"
            />
          </div>
          <div class="w-[64px] shrink-0">
            <Knob
              :model-value="resMix" @update:model-value="syncMix"
              :min="0" :max="1" :step="0.01" :value-font-px="12"
              label="Mix" :accent="ACCENT" :format-value="percent"
              :disabled="!resPreview"
            />
          </div>

          <DeviceField
            :model-value="resMaxReduction" @update:model-value="syncMaxReduction"
            :min="3" :max="48" :step="1" :width="54"
            label="Max Cut" unit="dB" :accent="ACCENT"
            :format-value="db" :disabled="!resPreview"
          />
          <DeviceField
            :model-value="resTrim" @update:model-value="syncTrim"
            :min="-12" :max="12" :step="0.5" :width="54"
            label="Trim" unit="dB" :accent="ACCENT"
            :format-value="signedDb" :disabled="!resPreview"
          />

      </div>

      <!-- The knee, the protection mask and the pitch range decide how the
           DETECTOR behaves rather than how much of it there is, so they sit
           together on one short line. None of them carries a caption any more:
           each is two states of one idea and the label already names the state.
           26 px for three settings, against the 60 this cost as a row of
           captioned controls with a two-line button in the middle. -->
      <div class="flex items-start gap-[10px] mt-[11px]">
          <SegmentedSwitch
            class="shrink-0"
            :padding-x="9"
            :model-value="resMode"
            @update:model-value="syncMode"
            :options="MODE_OPTIONS"
            :accent="ACCENT"
            :disabled="!resPreview"
          />

          <!-- THE WARNING IS NOW CONDITIONAL RATHER THAN PERMANENT, which is
               what let this shrink from 186 px and two lines to a lamp.
               The sentence under the label was there because this is the one
               control on the panel that can quietly wreck the material and a
               tooltip is invisible to anyone who has not already decided the
               control is worth hovering. That argument only ever applied to the
               dangerous state: "Preserves harmonic frequencies." explains a
               setting that needs no explaining. So the caption appears when
               protection is OFF, in amber, and the safe state is a lamp. -->
          <button
            class="shrink-0 px-[9px] py-[6px] rounded-md cursor-pointer transition-all text-left disabled:cursor-default"
            :style="{
              background: protectionIsRisky ? 'rgba(255,178,122,.14)' : 'rgba(141,224,168,.13)',
              border: `1px solid ${protectionIsRisky ? 'rgba(255,178,122,.5)' : 'rgba(141,224,168,.35)'}`,
              opacity: resPreview ? 1 : 0.4,
            }"
            :disabled="!resPreview"
            :title="protectionTitle"
            @click="togglePreserveHarmonics"
          >
            <span
              class="block whitespace-nowrap"
              :style="{
                font: `700 8.5px 'JetBrains Mono',monospace`,
                letterSpacing: '.1em',
                color: protectionIsRisky ? '#ffb27a' : '#8de0a8',
              }"
            >{{ protectionIsProtection
              ? (resPreserveHarmonics ? 'HARMONICS ON' : 'HARMONICS OFF')
              : (resPreserveHarmonics ? 'BETWEEN PARTIALS' : 'ACROSS SPECTRUM') }}</span>
            <span
              v-if="protectionIsRisky"
              class="block mt-[2px] whitespace-nowrap"
              style="font:500 8.5px/1.2 'Inter';color:rgba(255,178,122,.7)"
            >{{ protectionCaption }}</span>
          </button>

          <SegmentedSwitch
            class="shrink-0"
            :padding-x="9"
            :model-value="resPitchRange"
            @update:model-value="syncPitchRange"
            :options="PITCH_RANGE_OPTIONS"
            :accent="ACCENT"
            :disabled="!resPreview || !resPreserveHarmonics"
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
