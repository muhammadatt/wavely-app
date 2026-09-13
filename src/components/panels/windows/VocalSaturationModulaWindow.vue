<script setup>
/**
 * Tube Saturation in the "Modula" faceplate — a UI evaluation duplicate.
 *
 * Composed from the shared primitives in `src/components/modula/`, the way the
 * FET Punch duplicate is, and driven by the same `useVocalSaturation()`
 * singleton as `VocalSaturationWindow.vue` — so the two windows are one plugin
 * behind two faces and can be compared on the same audio.
 *
 * How the shipping panel's controls land on the design's vocabulary:
 *
 *   big LED knob      DRIVE — the one knob you reach for first
 *   big tick knob     HARDNESS — the knee order; its ring is a scale, not
 *                     detents, and it goes dark on CUBIC because the cubic has
 *                     no knee to set
 *   small knobs       ASYMMETRY · AUTO DRIVE · TAME · SOFTEN · EMPHASIS, with
 *                     the panel's one-line hints as captions; TAME and SOFTEN
 *                     dim outside SERIES, as on the shipping face
 *   segments          TOPOLOGY in the header (it is the most global choice on
 *                     the unit), CURVE and ASYM MODE in the switch bay
 *   slides            WET / DRY and HF LOSS beside the meters; the two
 *                     crossovers under BAND SHAPING
 *   small knobs       the per-band drive multipliers
 *
 * The chassis's power button IS the engage control, so the harness lamp is
 * turned off rather than duplicated.
 */
import { computed, onMounted } from 'vue'
import { useVocalSaturation } from '../../../composables/useVocalSaturation.js'
import { useEditorState } from '../../../composables/useEditorState.js'
import { useWindows } from '../../../composables/useWindows.js'
// Bound rather than retyped: HARDNESS_MIN is an aliasing measurement, and a
// panel that drifted from it would hand the curve an n the kernel then clamps.
import { HARDNESS_MIN, HARDNESS_MAX } from '../../../audio/vocalSatProcessor.js'
import FloatingWindow from '../FloatingWindow.vue'
import ModulaChassis from '../../modula/ModulaChassis.vue'
import ModulaCard from '../../modula/ModulaCard.vue'
import ModulaKnob from '../../modula/ModulaKnob.vue'
import ModulaSegment from '../../modula/ModulaSegment.vue'
import ModulaSlide from '../../modula/ModulaSlide.vue'
import ModulaLadder from '../../modula/ModulaLadder.vue'
import ModulaStatus from '../../modula/ModulaStatus.vue'

defineProps({ z: { type: Number, default: 500 } })

// Registry id of this window. Must match the entry in src/ui/registry.js and
// the literal `window-id` on the harness below (a test reads that literal).
const WINDOW_ID = 'vocal-saturation-modula'

const {
  vsDrive, vsWetDry, vsAsymmetry, vsHardness, vsCurve, VOCAL_SAT_CURVES, vsAsymMode, VOCAL_SAT_ASYM_MODES,
  vsMode, vsEmphasis, vsSoften, vsTame, vsAutoDrive, VOCAL_SAT_MODES,
  vsLowCrossover, vsMidCrossover,
  vsLowDriveMult, vsMidDriveMult, vsHighDriveMult, vsHfLoss,
  vsPreview, vsInputLevels, vsOutputLevels,
  togglePreview,
  syncDrive, syncWetDry, syncAsymmetry, syncHardness, syncCurve, syncAsymMode, syncMode, syncEmphasis, syncSoften, syncTame, syncAutoDrive,
  syncLowCrossover, syncMidCrossover,
  syncLowDriveMult, syncMidDriveMult, syncHighDriveMult, syncHfLoss,
  apply, teardown,
} = useVocalSaturation()

const { state } = useEditorState()
const { closeWindow } = useWindows()

onMounted(() => {
  if (!vsPreview.value) togglePreview()
})

// Tube Sat's own warm accent, from its shipping faceplate, so the two windows
// for this plugin agree on hue; gold rather than the compressor's ice-blue
// for the secondary, so the two Modula windows do not read as one plugin.
const ACCENT = '#ff8a5b'
const SECOND = '#ffd166'

const toOptions = (list) => list.map(o => ({ value: o.id, label: o.label, title: o.title }))
const CURVE_OPTIONS = toOptions(VOCAL_SAT_CURVES)
const ASYM_OPTIONS = toOptions(VOCAL_SAT_ASYM_MODES)
const MODE_OPTIONS = toOptions(VOCAL_SAT_MODES)

const isCubic = computed(() => vsCurve.value === 'cubic')
const isSeries = computed(() => vsMode.value === 'series')

// The shipping panel's one-line hints, kept verbatim so the two faces say the
// same thing about the same control.
const curveCaption = computed(() => isCubic.value
  ? 'third harmonic only — needs low Drive to stay in range'
  : 'rational knee, Hardness sets its order')
const asymCaption = computed(() => {
  if (isCubic.value) return 'offset only — a cubic has no knee to split'
  return vsAsymMode.value === 'split'
    ? 'subtle warmth, keeps the onset softening'
    : 'louder warmth, pushes onsets forward'
})
const modeCaption = computed(() => isSeries.value
  ? 'curve in the path — absorbs, and Wet / Dry crossfades'
  : 'dry passes at unity, saturated copy added under it')
const hardnessCaption = computed(() => isCubic.value ? 'n/a for cubic'
  : vsHardness.value > 5.5 ? 'spiky' : vsHardness.value >= 3 ? 'close-in' : 'dense')
const tameCaption = computed(() => !isSeries.value ? 'series only'
  : vsTame.value === 0 ? 'off' : vsTame.value < 50 ? 'peaks trimmed' : 'held in domain')

const twoDp = v => v.toFixed(2)
const oneDp = v => v.toFixed(1)
const whole = v => String(Math.round(v))
const percent = v => `${Math.round(v * 100)}%`
const hertz = v => `${Math.round(v)} Hz`
const multiplier = v => `${v.toFixed(2)}×`

function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

function close() {
  teardown()
}

async function applyAndClose() {
  await apply()
  teardown()
  closeWindow(WINDOW_ID)
}
</script>

<template>
  <FloatingWindow
    window-id="vocal-saturation-modula"
    :z="z"
    :width="1040"
    :top="60"
    :accent="ACCENT"
    background="#1a1c20"
    brand-lead="TUBE"
    brand-tail="SAT · MODULA"
    :show-engage="false"
    :engaged="vsPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!vsPreview"
    apply-disabled-hint="Turn TubeSat on to apply it"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <ModulaChassis
      brand="TUBE SAT"
      sub="3-BAND SATURATOR"
      :engaged="vsPreview"
      :accent="ACCENT"
      @toggle-power="togglePreview"
    >
      <template #center>
        <!-- TOPOLOGY. Parallel is an ADD, so the dry transient is at unity at
             every knob position; series is a real crossfade that can absorb
             one. The most global choice on the unit, hence the header. -->
        <ModulaSegment
          :model-value="vsMode" @update:model-value="syncMode"
          :options="MODE_OPTIONS" :color="SECOND"
        />
      </template>

      <div class="grid gap-[20px]" style="grid-template-columns: minmax(280px, 1fr) minmax(300px, 1.15fr)">

        <div class="min-w-0 flex flex-col gap-[20px]">
        <!-- Meter bay + the two output-side blends -->
        <ModulaCard inset class="flex flex-col gap-[20px]">
          <div class="flex gap-[22px] items-end">
            <ModulaLadder :levels="vsPreview ? vsInputLevels : []" label="IN" :cool="SECOND" :warm="ACCENT" />
            <ModulaLadder :levels="vsPreview ? vsOutputLevels : []" label="OUT" :cool="SECOND" :warm="ACCENT" />
            <div class="flex-1 min-w-0 flex flex-col gap-[22px] pb-[26px]">
              <ModulaSlide
                :model-value="vsWetDry" @update:model-value="syncWetDry"
                :min="0" :max="1" :step="0.01" :color="SECOND"
                label="WET / DRY" :format-value="percent"
              />
              <!-- THE MEDIUM'S OWN BANDWIDTH, not the saturation's: it acts on
                   the finished output, so it is the one control here that is
                   not bypassed at Wet/Dry 0. -->
              <ModulaSlide
                :model-value="vsHfLoss" @update:model-value="syncHfLoss"
                :min="0" :max="100" :step="1" :color="ACCENT"
                label="HF LOSS" :format-value="v => vsHfLoss > 0 ? `${whole(v)} · shelf > 4 kHz` : 'OFF'"
              />
            </div>
          </div>
          <ModulaStatus :text="modeCaption" :active="isSeries" :color="SECOND" />
        </ModulaCard>

        <!-- Band shaping: wide numeric ranges you read rather than feel. -->
        <ModulaCard title="BAND SHAPING" class="flex flex-col gap-[22px]">
          <ModulaSlide
            :model-value="vsLowCrossover" @update:model-value="syncLowCrossover"
            :min="100" :max="2000" :step="10" :color="ACCENT"
            label="LOW CROSSOVER" :format-value="hertz" foot-left="100 Hz" foot-right="2 kHz"
          />
          <ModulaSlide
            :model-value="vsMidCrossover" @update:model-value="syncMidCrossover"
            :min="1000" :max="8000" :step="50" :color="ACCENT"
            label="MID CROSSOVER" :format-value="hertz" foot-left="1 kHz" foot-right="8 kHz"
          />
          <!-- Per-band drive. In SERIES these become a tilt into one shared
               curve rather than three separate ones. -->
          <div class="flex flex-wrap gap-[26px] justify-center pt-[22px]" style="border-top:1px solid rgba(0,0,0,.45)">
            <ModulaKnob
              :model-value="vsLowDriveMult" @update:model-value="syncLowDriveMult"
              :min="0" :max="10" :step="0.05" :color="ACCENT" label="LOW DRIVE" :format-value="multiplier"
            />
            <ModulaKnob
              :model-value="vsMidDriveMult" @update:model-value="syncMidDriveMult"
              :min="0" :max="10" :step="0.05" :color="ACCENT" label="MID DRIVE" :format-value="multiplier"
            />
            <ModulaKnob
              :model-value="vsHighDriveMult" @update:model-value="syncHighDriveMult"
              :min="0" :max="10" :step="0.05" :color="ACCENT" label="HIGH DRIVE" :format-value="multiplier"
            />
          </div>
        </ModulaCard>
        </div>

        <div class="min-w-0 flex flex-col gap-[20px]">
          <ModulaCard>
            <div class="flex flex-wrap gap-[30px] justify-center">
              <ModulaKnob
                size="big" :model-value="vsDrive" @update:model-value="syncDrive"
                :min="0" :max="5" :step="0.05" :color="ACCENT"
                label="DRIVE" :format-value="twoDp"
              />
              <!-- HARDNESS is the knee ORDER: it tilts the harmonic series
                   rather than changing how much of it there is. Lower is NOT
                   cleaner — the range floor is set by aliasing (HARDNESS_MIN). -->
              <ModulaKnob
                size="big" ring="ticks" :model-value="vsHardness" @update:model-value="syncHardness"
                :min="HARDNESS_MIN" :max="HARDNESS_MAX" :step="0.1" :color="SECOND"
                label="HARDNESS" :format-value="oneDp" :caption="hardnessCaption"
                :disabled="isCubic"
              />
            </div>
            <div class="flex flex-wrap gap-[16px] justify-center mt-[26px] pt-[24px]" style="border-top:1px solid rgba(0,0,0,.45)">
              <!-- ASYMMETRY: even-order content, with the SIGN measured from
                   the material rather than always positive. -->
              <ModulaKnob
                :model-value="vsAsymmetry" @update:model-value="syncAsymmetry"
                :min="0" :max="100" :step="1" :color="ACCENT" label="ASYMMETRY" :format-value="whole"
                :caption="vsAsymmetry > 0 ? 'even harmonics' : 'off'"
              />
              <!-- AUTO-DRIVE normalises programme level before the drive, so
                   Drive means the same thing on a quiet file as a loud one. -->
              <ModulaKnob
                :model-value="vsAutoDrive" @update:model-value="syncAutoDrive"
                :min="0" :max="100" :step="1" :color="ACCENT" label="AUTO DRIVE" :format-value="whole"
                :caption="vsAutoDrive > 0 ? 'levels the source' : 'off'"
              />
              <!-- TAME: lookahead peak control ahead of the curve, paid for
                   out of the oversampler's existing group delay. Series only. -->
              <ModulaKnob
                :model-value="vsTame" @update:model-value="syncTame"
                :min="0" :max="100" :step="1" :color="SECOND" label="TAME" :format-value="whole"
                :caption="tameCaption" :disabled="!isSeries"
              />
              <ModulaKnob
                :model-value="vsSoften" @update:model-value="syncSoften"
                :min="0" :max="100" :step="1" :color="SECOND" label="SOFTEN" :format-value="whole"
                :caption="!isSeries ? 'series only' : vsSoften > 0 ? 'limits slew rate' : 'off'"
                :disabled="!isSeries"
              />
              <ModulaKnob
                :model-value="vsEmphasis" @update:model-value="syncEmphasis"
                :min="0" :max="100" :step="1" :color="SECOND" label="EMPHASIS" :format-value="whole"
                :caption="vsEmphasis > 0 ? 'absorbs onset edge' : 'off'"
              />
            </div>
          </ModulaCard>

          <ModulaCard class="flex-1 flex flex-wrap gap-[18px] items-center justify-between !py-[18px]">
            <!-- CURVE FAMILY. A degree-3 polynomial makes exactly the third
                 harmonic — while Drive keeps the signal inside its domain. -->
            <ModulaSegment
              :model-value="vsCurve" @update:model-value="syncCurve"
              :options="CURVE_OPTIONS" :color="SECOND" label="CURVE"
            />
            <!-- ASYMMETRY MECHANISM. OFFSET runs the curve off centre; SPLIT
                 gives each polarity a different knee order. Needs SHAPE. -->
            <ModulaSegment
              :model-value="vsAsymMode" @update:model-value="syncAsymMode"
              :options="ASYM_OPTIONS" :color="ACCENT" label="ASYM MODE"
              :disabled="isCubic"
            />
            <div class="flex-1 min-w-[200px] flex flex-col gap-[8px]">
              <ModulaStatus :text="curveCaption" :show-led="false" />
              <ModulaStatus :text="asymCaption" :show-led="false" />
            </div>
          </ModulaCard>
        </div>
      </div>

    </ModulaChassis>
  </FloatingWindow>
</template>
