<script setup>
import { computed, onMounted } from 'vue'
import { useSoftClipper } from '../../composables/useSoftClipper.js'
import { useEditorState } from '../../composables/useEditorState.js'
import Knob from '../knobs/Knob.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import ClipperScope from '../meters/ClipperScope.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  headroomDb, emphasisDb, outputTrimDb, thresholdMode, fixedThresholdDb,
  clipperPreview, clipperReduction, clipperEngagedPct, clipperDelta,
  clipperInputLevels, clipperOutputLevels, getScope, hasSelection,
  togglePreview, toggleDelta, syncHeadroom, syncEmphasis, syncOutputTrim, syncFixedThreshold,
  setThresholdMode, apply, teardown, closeModal,
} = useSoftClipper()

const { state } = useEditorState()

// Default to engaged when the panel opens
onMounted(() => {
  if (!clipperPreview.value) togglePreview()
})

// A colour of its own, distinct from the two compressors it typically
// precedes (OptoSmooth's amber, FET Punch's steel blue) — this is a
// transient-taming stage, not a compressor, and the panel should read
// differently at a glance.
const ACCENT = '#ff8f6b'

const MODE_OPTIONS = [
  { value: 'adaptive', label: 'ADAPTIVE', title: "Threshold rides the speaker's own level" },
  { value: 'fixed', label: 'FIXED', title: 'Threshold is a stated dBFS ceiling' },
]

const MODE_CAPTION = {
  adaptive: 'the ceiling rides the voice',
  fixed: 'the ceiling is a stated dBFS value',
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

function formatGain(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

function formatDb(v) {
  return v.toFixed(1)
}

const isFixed = computed(() => thresholdMode.value === 'fixed')

/**
 * Headroom and Fixed dBFS are ONE control, and used to be two.
 *
 * They express the same idea — where the ceiling sits — in two units, and only
 * ever one of them is live: in adaptive mode the threshold is speechLevel +
 * Headroom and the dBFS value is not read at all, and in fixed mode the
 * reverse. As two knobs that meant one of them was always dimmed to 35%,
 * costing a knob position and a whole footer row to display a control that
 * does nothing. A permanently ghosted knob is the quieter version of the
 * failure this codebase has already learned twice — on the OptoSmooth's Gain
 * knob and on ResoTame's range limits — that a control which looks like a
 * control and is not one reads as broken.
 *
 * One slot, swapping label, range, formatter and caption with the mode. The
 * panel is a row shorter for it, and there is never a question about which of
 * the two the user is supposed to touch.
 */
const thresholdKnob = computed(() => (isFixed.value
  ? {
      value: fixedThresholdDb.value,
      sync: syncFixedThreshold,
      min: -24, max: -1, step: 0.5,
      label: 'Ceiling',
      format: formatDb,
      caption: 'peaks stop here',
    }
  : {
      value: headroomDb.value,
      sync: syncHeadroom,
      min: 4, max: 16, step: 0.5,
      label: 'Headroom',
      format: formatGain,
      caption: 'lower = more clipping',
    }))

// A share-of-blocks figure, not a dB one, because dB is the wrong instrument
// for "is this doing anything": the blocks that clip take a median of 0.3-0.4
// dB, which on a 12 dB face reads as an idle needle while the stage is audibly
// colouring the passage. See the kernel's ENGAGED_TAU_S.
const engagedReadout = computed(() => `${clipperEngagedPct.value.toFixed(1)}%`)

// Reads as "how hard you are pushing it" per spec §7.1: 3-6 dB is the usable
// range on speech, past that it starts reading as grit rather than control.
// 12 dB full scale (rather than the compressors' 24) keeps that band visually
// legible instead of crammed into the first quarter of the bar.
const METER_FULL_SCALE_DB = 12
</script>

<template>
  <FloatingWindow
    window-id="soft-clipper"
    :z="z"
    :width="620"
    :top="96"
    :accent="ACCENT"
    brand-lead="SOFT"
    brand-tail="CLIPPER"
    background="linear-gradient(155deg,#1a1613,#0d0a08 60%)"
    header-background="linear-gradient(#241d18,#15100d)"
    :engaged="clipperPreview"
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
          background: clipperDelta ? `color-mix(in srgb, ${ACCENT} 26%, transparent)` : 'transparent',
          borderColor: clipperDelta
            ? `color-mix(in srgb, ${ACCENT} 55%, transparent)`
            : 'rgba(255,255,255,.14)',
          opacity: clipperPreview ? 1 : 0.4,
        }"
        :disabled="!clipperPreview"
        :aria-pressed="String(clipperDelta)"
        title="Hear only what is being removed — the harmonics the clipper is generating, on their own. Monitoring only: Apply always renders the processed audio."
        @pointerdown.stop
        @click="toggleDelta"
      >
        <span
          :style="{
            font: `700 9px 'JetBrains Mono',monospace`,
            letterSpacing: '.14em',
            color: clipperDelta
              ? `color-mix(in srgb, ${ACCENT} 55%, #ffffff)`
              : 'rgba(255,255,255,.45)',
          }"
        >DELTA</span>
      </button>
    </template>

    <div class="px-[26px] pt-[16px] pb-[22px]">
      <!-- THE MODE SWITCH SITS ABOVE THE SCOPE BECAUSE IT GOVERNS IT. It
           decides what the threshold curve means, whether that curve is
           draggable, and what the knob below is measuring — and it used to be
           in the footer, so all three were discovered after the confusion
           rather than before it. -->
      <div class="flex items-center justify-center gap-[10px] mb-[12px]">
        <span style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.4)">THRESHOLD</span>
        <SegmentedSwitch
          :model-value="thresholdMode"
          @update:model-value="setThresholdMode"
          :options="MODE_OPTIONS"
          :accent="ACCENT"
          :disabled="!clipperPreview"
          :caption="MODE_CAPTION[thresholdMode]"
          :padding-x="12"
        />
      </div>

      <!-- The scope answers "on what", which the bar below cannot: at the
           default the blocks that clip take a median of 0.3-0.4 dB, so a
           working stage reads as an idle needle. Seeing the crossings is what
           makes Headroom settable by eye. In fixed mode the threshold curve is
           also the control — drag it. -->
      <ClipperScope
        :data-fn="getScope"
        :mode="thresholdMode"
        :fixed-threshold-db="fixedThresholdDb"
        @update:fixed-threshold-db="syncFixedThreshold"
        @request-play="togglePlayback"
        :accent="ACCENT"
        :height="132"
        title="Clipper scope: input envelope against the threshold"
      />

      <!-- Peak reduction: what the stage is actually doing, in the same
           instrument the compressors use, with the 3-6 dB usable range
           shaded so a user can find their Headroom setting by eye rather
           than by ear alone (spec §7.2). -->
      <div class="mt-[14px]">
        <GainReductionBar
          :reduction-db="clipperReduction"
          :accent="ACCENT"
          title="PEAK REDUCTION"
          :full-scale-db="METER_FULL_SCALE_DB"
          :zone-min-db="3"
          :zone-max-db="6"
        />
        <!-- HOW OFTEN, beside HOW MUCH. The bar above cannot distinguish "idle"
             from "working quietly", because working quietly is what this stage
             does: 0.3-0.4 dB on the blocks it touches. This number moves over a
             legible range and is the one that answers the question. -->
        <div class="flex justify-end items-baseline gap-[7px] mt-[5px]">
          <span style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.32)">ENGAGED</span>
          <span :style="{ font: `700 10px 'JetBrains Mono',monospace`, color: ACCENT }">{{ engagedReadout }}</span>
          <span style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.1em;color:rgba(255,255,255,.28)">OF VOICED BLOCKS</span>
        </div>
      </div>

      <div class="flex items-center justify-between gap-[12px] mt-[18px]">
        <LevelMeter :levels="clipperInputLevels" label="IN" :height="132" />

        <div class="flex-1 flex justify-center gap-[22px]">
          <!-- One slot for the threshold, whichever unit the mode expresses it
               in — see thresholdKnob. Keyed on the mode so the Knob remounts
               rather than carrying drag state across a range change. -->
          <div class="w-[118px]">
            <Knob
              :key="thresholdMode"
              :model-value="thresholdKnob.value"
              @update:model-value="thresholdKnob.sync"
              :min="thresholdKnob.min" :max="thresholdKnob.max" :step="thresholdKnob.step"
              :label="thresholdKnob.label" :accent="ACCENT" :format-value="thresholdKnob.format"
              :disabled="!clipperPreview"
            />
            <p class="mt-[5px] text-center" style="font:600 8px 'Inter',system-ui;letter-spacing:.04em;color:rgba(255,255,255,.3)">
              {{ thresholdKnob.caption }}
            </p>
          </div>
          <div class="w-[118px]">
            <!-- Harshness-reduction mechanism, not a tone control: it shaves
                 HF first (where clipping's odd harmonics land) and pulls the
                 generated harmonics back down with it. The caption is there
                 because the label alone reads as an EQ. -->
            <Knob
              :model-value="emphasisDb"
              @update:model-value="syncEmphasis"
              :min="0" :max="12" :step="0.5"
              label="HF Emphasis" :accent="ACCENT" :format-value="formatGain"
              :disabled="!clipperPreview"
            />
            <p class="mt-[5px] text-center" style="font:600 8px 'Inter',system-ui;letter-spacing:.04em;color:rgba(255,255,255,.3)">
              harshness, not tone
            </p>
          </div>
          <div class="w-[118px]">
            <Knob
              :model-value="outputTrimDb"
              @update:model-value="syncOutputTrim"
              :min="-6" :max="6" :step="0.1"
              label="Output Trim" :accent="ACCENT" :format-value="formatGain"
              :disabled="!clipperPreview" bipolar
            />
            <p class="mt-[5px] text-center" style="font:600 8px 'Inter',system-ui;letter-spacing:.04em;color:rgba(255,255,255,.3)">
              gain match for A/B
            </p>
          </div>
        </div>

        <LevelMeter :levels="clipperOutputLevels" label="OUT" :height="132" />
      </div>

      <p
        class="mt-[14px] text-center"
        style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.35)"
      >
        Trims the handful of transients that stick out — plosives, hard
        consonants, a struck desk — so the compressor after it can work on the
        voice instead of chasing them. The ceiling tracks how loudly this
        speaker is talking, so the same setting holds across a quiet passage
        and a loud one.
      </p>

      <div class="mt-[14px] pt-[14px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <ApplyAction
          size="md"
          show-preview
          previewable
          :previewing="state.isPlaying"
          :accent="ACCENT"
          text-color="#0c1218"
          :met="hasSelection"
          message="Make a selection to process"
          label="Apply soft clipper"
          :disabled="!clipperPreview"
          disabled-hint="Turn Soft Clipper on to apply it"
          @toggle-preview="togglePlayback"
          @apply="applyAndClose"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
