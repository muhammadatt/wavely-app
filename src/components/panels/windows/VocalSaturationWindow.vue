<script setup>
import { computed, onMounted } from 'vue'
import { useVocalSaturation } from '../../../composables/useVocalSaturation.js'
// Bound rather than retyped: HARDNESS_MIN is an aliasing measurement, and a
// panel that drifted from it would hand the curve an n the kernel then clamps,
// leaving a knob whose last stretch of travel does nothing.
import { HARDNESS_MIN, HARDNESS_MAX } from '../../../audio/vocalSatProcessor.js'
import { useEditorState } from '../../../composables/useEditorState.js'
import FloatingWindow from '../FloatingWindow.vue'
import Knob from '../../knobs/Knob.vue'
import DeviceSlider from '../../knobs/DeviceSlider.vue'
import DeviceChoiceRocker from '../../knobs/DeviceChoiceRocker.vue'
import LevelMeter from '../../meters/LevelMeter.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  vsDrive, vsWetDry, vsAsymmetry, vsHardness, vsCurve, VOCAL_SAT_CURVES, vsAsymMode, VOCAL_SAT_ASYM_MODES, vsMode, vsEmphasis, vsSoften, vsTame, vsAutoDrive, VOCAL_SAT_MODES,
  vsLowCrossover, vsMidCrossover,
  vsLowDriveMult, vsMidDriveMult, vsHighDriveMult, vsHfLoss,
  vsPreview, vsInputLevels, vsOutputLevels,
  togglePreview,
  syncDrive, syncWetDry, syncAsymmetry, syncHardness, syncCurve, syncAsymMode, syncMode, syncEmphasis, syncSoften, syncTame, syncAutoDrive,
  syncLowCrossover, syncMidCrossover,
  syncLowDriveMult, syncMidDriveMult, syncHighDriveMult, syncHfLoss,
  apply, teardown, closeModal,
} = useVocalSaturation()

const { state } = useEditorState()

// Default to engaged when the panel opens, matching the other plugin windows.
onMounted(() => {
  if (!vsPreview.value) togglePreview()
})

const ACCENT = '#ff8a5b'

const curveCaption = computed(() => (
  vsCurve.value === 'cubic'
    ? 'third harmonic only — needs low Drive to stay in range'
    : 'rational knee, Hardness sets its order'
))

const asymCaption = computed(() => {
  if (vsCurve.value === 'cubic') return 'offset only — a cubic has no knee to split'
  return vsAsymMode.value === 'split'
    ? 'subtle warmth, keeps the onset softening'
    : 'louder warmth, pushes onsets forward'
})

const modeCaption = computed(() => (
  vsMode.value === 'series'
    ? 'curve in the path — absorbs, and Wet / Dry crossfades'
    : 'dry passes at unity, saturated copy added under it'
))

const twoDp = v => v.toFixed(2)
const oneDp = v => v.toFixed(1)
const percent = v => `${Math.round(v * 100)}`
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
  closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="vocal-saturation"
    :z="z"
    :width="620"
    :accent="ACCENT"
    brand-lead="TUBE"
    brand-tail="SAT"
    :engaged="vsPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!vsPreview"
    apply-disabled-hint="Turn TubeSat on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="px-[22px] pt-[22px] pb-[24px]">
      <div class="flex items-center gap-[14px]">
        <LevelMeter :levels="vsInputLevels" label="IN" :height="132" />

        <!-- Primary voicing controls in the center strip. -->
        <div class="flex-1 min-w-0 flex items-start justify-center gap-[18px]">
          <div class="w-[100px]">
            <Knob :model-value="vsDrive" @update:model-value="syncDrive"
                  :min="0" :max="5" :step="0.05"
                  label="Drive" :accent="ACCENT" :format-value="twoDp"
                  :disabled="!vsPreview" />
          </div>
          <!-- ASYMMETRY, not Bias. Same offset the Bias knob wrote — the
               reference is 1, so this reads as the old number x 100 — but the
               SIGN is now measured from the material rather than always
               positive. Even-order content is identical either way; what the
               sign buys is up to 7.9 dB LESS of everything else. -->
          <div class="w-[100px]">
            <Knob :model-value="vsAsymmetry" @update:model-value="syncAsymmetry"
                  :min="0" :max="100" :step="1"
                  label="Asymmetry" :accent="ACCENT" :format-value="v => v.toFixed(0)"
                  :disabled="!vsPreview" />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              {{ vsAsymmetry > 0 ? 'even harmonics' : 'off' }}
            </p>
          </div>
          <!-- HARDNESS replaces Softness, which crossfaded tanh against arctan
               — two curves that measure the same once the amount of distortion
               is matched. This is the knee ORDER: it tilts the harmonic
               series rather than changing how much of it there is. Lower is
               NOT cleaner — the range floor is set by aliasing, see
               HARDNESS_MIN. ⚠ Its authority falls away once Drive has squared
               the wave off, and the default patch sits past that point; see
               the tilt table on `shape`. -->
          <div class="w-[100px]">
            <Knob :model-value="vsHardness" @update:model-value="syncHardness"
                  :min="HARDNESS_MIN" :max="HARDNESS_MAX" :step="0.1"
                  label="Hardness" :accent="ACCENT" :format-value="oneDp"
                  :disabled="!vsPreview || vsCurve === 'cubic'" />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              {{ vsCurve === 'cubic' ? 'n/a for cubic'
                 : vsHardness > 5.5 ? 'spiky' : vsHardness >= 3 ? 'close-in' : 'dense' }}
            </p>
          </div>
          <div class="w-[72px] pt-[8px]">
            <Knob :model-value="vsWetDry" @update:model-value="syncWetDry"
                  :min="0" :max="1" :step="0.01"
                  :value-font-px="13"
                  label="Wet / Dry" :accent="ACCENT" :format-value="percent"
                  :disabled="!vsPreview" />
          </div>
          <!-- THE MEDIUM'S OWN BANDWIDTH, not the saturation's — which is why
               it is the one control here that acts on the finished output
               rather than on the wet path, and therefore the one that is not
               bypassed at Wet/Dry 0. Measured: on the output it takes 3.77 dB
               out above 4 kHz at the default blend, where a wet-path version
               manages 0.79. A tape machine does not roll off only the part of
               the signal that saturated. -->
          <div class="w-[72px] pt-[8px]">
            <Knob :model-value="vsHfLoss" @update:model-value="syncHfLoss"
                  :min="0" :max="100" :step="1"
                  :value-font-px="13"
                  label="HF Loss" :accent="ACCENT" :format-value="v => v.toFixed(0)"
                  :disabled="!vsPreview" />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              {{ vsHfLoss > 0 ? 'shelf above 4 kHz' : 'off' }}
            </p>
          </div>
        </div>

        <LevelMeter :levels="vsOutputLevels" label="OUT" :height="132" />
      </div>

      <!-- Band shaping: wide numeric ranges you read rather than feel, so
           faders beat knobs here. Laid out as a labelled sub-section the way a
           real faceplate separates its secondary controls. -->
      <div class="mt-[22px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <div
          class="mb-[14px] uppercase"
          style="font:700 9px/1 'JetBrains Mono',monospace;letter-spacing:.2em;color:rgba(255,255,255,.32)"
        >
          Band Shaping
        </div>

        <!-- TOPOLOGY. Parallel is `x + wetDry*wet` — an ADD, so the dry
             transient is at unity at every knob position and the stage cannot
             absorb a transient at any setting (measured: crest flat within
             0.3 dB across the whole Wet/Dry range). Series is a real
             crossfade. Emphasis is the pair that makes the curve bite high
             frequencies hardest, which is what rounds an onset rather than
             sharpening it. See MODE_SERIES and EMPHASIS_MAX_DB. -->
        <div class="mb-[16px] flex items-start justify-center gap-[26px]">
          <!-- CURVE FAMILY. A degree-3 polynomial makes exactly the third
               harmonic and nothing above it — 0% of its distortion energy sits
               above the 5th, against ~10% for SHAPE at matched THD — and at 2x
               it is essentially alias-free (-151 vs -79 dBc). Both properties
               hold ONLY while Drive keeps the signal inside the polynomial's
               domain; past it the clamp is a hard clipper and CUBIC measures
               grittier than SHAPE. See cubicShape. -->
          <div>
            <DeviceChoiceRocker
              :model-value="vsCurve"
              @update:model-value="syncCurve"
              :options="VOCAL_SAT_CURVES.map(c => ({ value: c.id, label: c.label, title: c.title }))"
              :accent="ACCENT"
              :caption="curveCaption"
              label="Curve"
              :disabled="!vsPreview"
            />
          </div>
          <!-- ASYMMETRY MECHANISM. OFFSET runs the curve off centre, which
               makes its two bounds unequal — 17.2 dB apart at Asymmetry 100 —
               and that imbalance, not the even harmonics, is what pushes
               onsets forward. SPLIT gives each polarity a different knee order
               instead: both halves keep unity slope at the origin and the same
               asymptote, so the bounds stay matched. Measured crest at
               Asymmetry 100: +6.87 dB for offset, -5.06 for split, against
               -5.01 symmetric. See ASYM_MODE_SPLIT. -->
          <div>
            <DeviceChoiceRocker
              :model-value="vsAsymMode"
              @update:model-value="syncAsymMode"
              :options="VOCAL_SAT_ASYM_MODES.map(m => ({ value: m.id, label: m.label, title: m.title }))"
              :accent="ACCENT"
              :caption="asymCaption"
              label="Asymmetry mode"
              :disabled="!vsPreview || vsCurve === 'cubic'"
            />
          </div>
          <div>
            <DeviceChoiceRocker
              :model-value="vsMode"
              @update:model-value="syncMode"
              :options="VOCAL_SAT_MODES.map(m => ({ value: m.id, label: m.label, title: m.title }))"
              :accent="ACCENT"
              :caption="modeCaption"
              label="Topology"
              :disabled="!vsPreview"
            />
          </div>
        </div>

        <!-- Structural controls. Split onto their own row: five items plus two
             rockers overflows the 620 px faceplate. -->
        <div class="mb-[16px] flex items-start justify-center gap-[20px]">
          <!-- AUTO-DRIVE. The only one of these four that works in BOTH
               topologies. It normalises programme level before the drive, so
               Drive means the same thing on a quiet file as a loud one:
               measured THD 0.3 / 1.3 / 9.1% across 30 dB of input level at 0,
               and 1.7 / 1.7 / 1.7% at 100. Gated on voice so a pause does not
               drive room tone — see AutoDrive. -->
          <div class="w-[82px]">
            <Knob :model-value="vsAutoDrive" @update:model-value="syncAutoDrive"
                  :min="0" :max="100" :step="1" :value-font-px="13"
                  label="Auto Drive" :accent="ACCENT" :format-value="v => v.toFixed(0)"
                  :disabled="!vsPreview" />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              {{ vsAutoDrive > 0 ? 'levels the source' : 'off' }}
            </p>
          </div>
          <!-- TAME. Lookahead peak control ahead of the curve, paid for out
               of the oversampler's existing 31-sample group delay, so it adds
               NO latency. It is what makes CUBIC worth having: it keeps the
               signal inside the polynomial's domain, where the curve makes
               only a third harmonic. Measured at Drive 2, share of distortion
               above the 5th: 12.7% at 0, 2.2% at 50. Above 50 the amount of
               saturation stops depending on Drive at all. See TAME_LOOKAHEAD_L. -->
          <div class="w-[82px]">
            <Knob :model-value="vsTame" @update:model-value="syncTame"
                  :min="0" :max="100" :step="1" :value-font-px="13"
                  label="Tame" :accent="ACCENT" :format-value="v => v.toFixed(0)"
                  :disabled="!vsPreview || vsMode !== 'series'" />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              {{ vsMode !== 'series' ? 'series only'
                 : vsTame === 0 ? 'off' : vsTame < 50 ? 'peaks trimmed' : 'held in domain' }}
            </p>
          </div>
          <!-- SOFTEN is disabled outside SERIES, and the kernel ignores it
               there regardless. tapeCharacter measured this placement in a
               band-split topology at +0.66 and +1.38 dB of tilt — HF RISING,
               on a control that provably cannot boost — because slew-limiting
               an already-saturated LF-dominated sum makes it triangular, and a
               triangle is harmonics. See SOFTEN_REFERENCE. -->
          <div class="w-[82px]">
            <Knob :model-value="vsSoften" @update:model-value="syncSoften"
                  :min="0" :max="100" :step="1" :value-font-px="13"
                  label="Soften" :accent="ACCENT" :format-value="v => v.toFixed(0)"
                  :disabled="!vsPreview || vsMode !== 'series'" />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              {{ vsMode !== 'series' ? 'series only' : vsSoften > 0 ? 'limits slew rate' : 'off' }}
            </p>
          </div>
          <div class="w-[82px]">
            <Knob :model-value="vsEmphasis" @update:model-value="syncEmphasis"
                  :min="0" :max="100" :step="1" :value-font-px="13"
                  label="Emphasis" :accent="ACCENT" :format-value="v => v.toFixed(0)"
                  :disabled="!vsPreview" />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              {{ vsEmphasis > 0 ? 'absorbs onset edge' : 'off' }}
            </p>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-x-[30px] gap-y-[15px]">
          <DeviceSlider :model-value="vsLowCrossover" @update:model-value="syncLowCrossover"
                        :min="100" :max="2000" :step="10"
                        label="Low Crossover" :accent="ACCENT" :format-value="hertz"
                        :disabled="!vsPreview" />
          <DeviceSlider :model-value="vsMidCrossover" @update:model-value="syncMidCrossover"
                        :min="1000" :max="8000" :step="50"
                        label="Mid Crossover" :accent="ACCENT" :format-value="hertz"
                        :disabled="!vsPreview" />
        </div>

        <div class="mt-[16px] flex items-start justify-center gap-[20px]">
          <div class="w-[82px]">
            <Knob :model-value="vsLowDriveMult" @update:model-value="syncLowDriveMult"
                  :min="0" :max="10" :step="0.05" :value-font-px="13"
                  label="Low Drive" :accent="ACCENT" :format-value="multiplier"
                  :disabled="!vsPreview" />
          </div>
          <div class="w-[82px]">
            <Knob :model-value="vsMidDriveMult" @update:model-value="syncMidDriveMult"
                  :min="0" :max="10" :step="0.05" :value-font-px="13"
                  label="Mid Drive" :accent="ACCENT" :format-value="multiplier"
                  :disabled="!vsPreview" />
          </div>
          <div class="w-[82px]">
            <Knob :model-value="vsHighDriveMult" @update:model-value="syncHighDriveMult"
                  :min="0" :max="10" :step="0.05" :value-font-px="13"
                  label="High Drive" :accent="ACCENT" :format-value="multiplier"
                  :disabled="!vsPreview" />
          </div>
        </div>
      </div>
    </div>
  </FloatingWindow>
</template>
