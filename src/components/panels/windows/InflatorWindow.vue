<script setup>
import { onMounted } from 'vue'
import { useInflator } from '../../../composables/useInflator.js'
import { useEditorState } from '../../../composables/useEditorState.js'
import FloatingWindow from '../FloatingWindow.vue'
import Knob from '../../knobs/Knob.vue'
import SegmentedSwitch from '../../knobs/SegmentedSwitch.vue'
import LevelMeter from '../../meters/LevelMeter.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  inInputDb, inEffect, inCurve, inOutputDb, inClip, inBandSplit,
  inPreview, inInputLevels, inOutputLevels,
  togglePreview,
  syncInputDb, syncEffect, syncCurve, syncOutputDb, syncClip, syncBandSplit,
  apply, teardown, closeModal,
} = useInflator()

const { state } = useEditorState()

// Default to engaged when the panel opens, matching the other plugin windows.
onMounted(() => {
  if (!inPreview.value) togglePreview()
})

const ACCENT = '#ffc861'

const decibels = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`
const percent = v => `${Math.round(v * 100)}`
const signedPct = v => `${v > 0 ? '+' : ''}${Math.round(v)}`

// The one number on this panel that is not a knob position: how much the curve
// lifts small signals, which is the whole effect and is otherwise invisible.
// f'(0) = 1.5 + Curve/100, in dB. See dsp/inflator.js.
function liftDb() {
  return (20 * Math.log10(1.5 + inCurve.value / 100)).toFixed(2)
}

const BOOL_OPTIONS = [
  { value: 'off', label: 'OFF' },
  { value: 'on', label: 'ON' },
]

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
  <!-- ONE-WORD BRAND MARK, so brand-lead carries all of it and there is no
       tail. FloatingWindow puts an unconditional &nbsp; between lead and tail,
       which is right for the two-word marks (OPTO SMOOTH, TUBE SAT) and wrong
       for a single word: "IN" + "FLATOR" rendered as "IN FLATOR". Caught by
       screenshotting the panel, which is the only way it could have been. -->
  <FloatingWindow
    window-id="inflator"
    :z="z"
    :width="600"
    :accent="ACCENT"
    brand-lead="INFLATOR"
    :engaged="inPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!inPreview"
    apply-disabled-hint="Turn Inflator on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="px-[22px] pt-[22px] pb-[24px]">
      <div class="flex items-center gap-[14px]">
        <LevelMeter :levels="inInputLevels" label="IN" :height="132" />

        <!-- The four continuous controls, in signal order: Input drives the
             curve, Curve shapes it, Effect blends it, Output takes back the
             level it added. -->
        <div class="flex-1 min-w-0 flex items-start justify-center gap-[16px]">
          <div class="w-[86px]">
            <Knob :model-value="inInputDb" @update:model-value="syncInputDb"
                  :min="-12" :max="12" :step="0.1" bipolar
                  :value-font-px="15"
                  label="Input" :accent="ACCENT" :format-value="decibels"
                  :disabled="!inPreview" />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              dB
            </p>
          </div>

          <!-- CURVE IS SHAPE, NOT DEPTH — f(1) = 1 at every setting, so this
               knob cannot move the ceiling. What it does move is the
               small-signal lift, which is why that figure is printed under it
               rather than left for the ear to find. -->
          <div class="w-[100px]">
            <Knob :model-value="inCurve" @update:model-value="syncCurve"
                  :min="-50" :max="50" :step="1" bipolar
                  label="Curve" :accent="ACCENT" :format-value="signedPct"
                  :disabled="!inPreview" />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              lifts quiet by {{ liftDb() }} dB
            </p>
          </div>

          <div class="w-[100px]">
            <Knob :model-value="inEffect" @update:model-value="syncEffect"
                  :min="0" :max="1" :step="0.01"
                  label="Effect" :accent="ACCENT" :format-value="percent"
                  :disabled="!inPreview" />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              {{ inEffect > 0 ? '% wet' : 'bypassed' }}
            </p>
          </div>

          <!-- Output only ever CUTS, matching the reference. The curve already
               raises the level; an output stage that could raise it further
               would make every A/B against bypass a loudness comparison. -->
          <div class="w-[86px]">
            <Knob :model-value="inOutputDb" @update:model-value="syncOutputDb"
                  :min="-12" :max="0" :step="0.1"
                  :value-font-px="15"
                  label="Output" :accent="ACCENT" :format-value="decibels"
                  :disabled="!inPreview" />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              dB, cut only
            </p>
          </div>
        </div>

        <LevelMeter :levels="inOutputLevels" label="OUT" :height="132" />
      </div>

      <!-- The two switches. Both change WHAT THE CURVE SEES rather than how
           much of it there is, which is why they are grouped away from the
           knobs above. -->
      <div class="mt-[22px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <div class="flex items-start justify-center gap-[46px]">
          <div class="flex flex-col items-center gap-[7px]">
            <div
              class="uppercase"
              style="font:700 9px/1 'JetBrains Mono',monospace;letter-spacing:.2em;color:rgba(255,255,255,.32)"
            >
              Band Split
            </div>
            <SegmentedSwitch
              :model-value="inBandSplit ? 'on' : 'off'"
              @update:model-value="v => syncBandSplit(v === 'on')"
              :options="BOOL_OPTIONS"
              :accent="ACCENT"
              :disabled="!inPreview"
              :caption="inBandSplit
                ? 'curve runs on 240 Hz / 2.4 kHz bands'
                : 'curve runs on the whole signal'"
            />
          </div>

          <div class="flex flex-col items-center gap-[7px]">
            <div
              class="uppercase"
              style="font:700 9px/1 'JetBrains Mono',monospace;letter-spacing:.2em;color:rgba(255,255,255,.32)"
            >
              Clip
            </div>
            <SegmentedSwitch
              :model-value="inClip ? 'on' : 'off'"
              @update:model-value="v => syncClip(v === 'on')"
              :options="BOOL_OPTIONS"
              :accent="ACCENT"
              :disabled="!inPreview"
              :caption="inClip
                ? 'holds peaks at full scale'
                : 'peaks past full scale fold back'"
            />
          </div>
        </div>

        <!-- ⚠ THE ONE COMBINATION THAT BREAKS THE PLUGIN'S HEADLINE PROMISE.
             Broadband, f(s) <= 1 bounds the output at full scale whatever the
             settings. Band Split sums THREE curve outputs, each bounded by 1,
             so the sum is not — measured at +2.8 dB over on hot material. Clip
             is the remedy, and saying so on the panel is cheaper than letting
             someone find it on an export. -->
        <p
          v-if="inBandSplit && !inClip"
          class="mt-[14px] text-center"
          style="font:600 9px/1.5 'Inter',system-ui;color:#ffc861"
        >
          Band Split can exceed full scale — three bands sum after the curve.
          Turn Clip on to hold the ceiling.
        </p>
      </div>
    </div>
  </FloatingWindow>
</template>
