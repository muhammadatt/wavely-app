<script setup>
import { computed, onMounted, ref } from 'vue'
import { useResonance } from '../../composables/useResonance.js'
import {
  PITCH_RANGES,
  zoneSettings,
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
  resMode,
  resPitchRange, resMix, resTrim, resZones, resSelectedZone, resSoloZone, resRefMode,
  resPreview, resDelta, resReduction, resOutputLevels,
  resDisplayFn, hasSelection,
  togglePreview, toggleDelta, syncAttack,
  syncRelease, syncMix, syncTrim, syncZones, toggleSolo,
  syncMode, syncPitchRange, apply, teardown, closeModal,
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
 * Harmonic protection is per zone, so the panel-level statement about it is a
 * summary rather than a control: which zones, if any, are running unmasked.
 *
 * Kept because this is the one setting here that can quietly wreck the
 * material. It used to be a caption under a global button; with the control
 * distributed to the zones the warning has to be too, and naming the zones is
 * what makes it actionable rather than ominous.
 */
const unprotectedZones = computed(() => resZones.value
  .map((z, i) => (zoneSettings(z).protect ? null : `Z${i + 1}`))
  .filter(Boolean))

const anyProtected = computed(() =>
  resZones.value.some(z => zoneSettings(z).protect))

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
        <!-- TRIM SITS WITH THE METER because it is the same subject: the meter
             says what the output level is and this is the control that moves
             it. It was among the timing knobs, which put the reading and the
             adjustment two rows apart. -->
        <div class="flex flex-col items-center gap-[8px]">
          <LevelMeter :levels="resOutputLevels" label="OUT" :height="plotHeight - 96" />
          <DeviceField
            :model-value="resTrim" @update:model-value="syncTrim"
            :min="-12" :max="12" :step="0.5" :width="48"
            label="Trim" unit="dB" :accent="ACCENT"
            :format-value="signedDb" :disabled="!resPreview"
          />
        </div>
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

      <!-- ONE GLOBAL ROW, and there is very little left in it.
           Depth, Sharpness, Selectivity, Max Cut and harmonic protection are
           all per zone now, with no global value for a zone to be an offset
           from. What remains describes the effect as a whole: how fast the
           detector moves, how much of its work reaches the output, the shape of
           its knee, and which pitches the protection mask should look for —
           that last one stays global because there is one tracker and one
           signal, however many zones read its answer. -->
      <div class="flex items-end gap-[12px] mt-[13px]">
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

          <SegmentedSwitch
            class="shrink-0 mb-[3px]"
            :padding-x="9"
            :model-value="resMode"
            @update:model-value="syncMode"
            :options="MODE_OPTIONS"
            :accent="ACCENT"
            :disabled="!resPreview"
          />
          <SegmentedSwitch
            class="shrink-0 mb-[3px]"
            :padding-x="9"
            :model-value="resPitchRange"
            @update:model-value="syncPitchRange"
            :options="PITCH_RANGE_OPTIONS"
            :accent="ACCENT"
            :disabled="!resPreview || !anyProtected"
          />

          <!-- THE WARNING SURVIVED THE CONTROL MOVING.
               Protection is a per-zone toggle now, so there is no global button
               left to carry a caption — but this is still the one setting on
               the panel that can quietly wreck the material, and a per-zone
               lamp is a small thing to notice. The sentence appears here
               whenever ANY zone has it off, names the zones, and is absent the
               rest of the time. -->
          <span
            v-if="unprotectedZones.length"
            class="flex-1 min-w-0 self-center"
            style="font:500 9px/1.3 'Inter';color:rgba(255,178,122,.8)"
          >Full suppression in {{ unprotectedZones.join(', ') }} — risks thinning
            harmonic frequencies there.</span>
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
