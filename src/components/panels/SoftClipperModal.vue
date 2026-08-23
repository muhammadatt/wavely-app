<script setup>
import { computed, onMounted } from 'vue'
import { useSoftClipper } from '../../composables/useSoftClipper.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { readTimelineEnvelope } from '../../audio/timelineEnvelope.js'
import { SCOPE_SECONDS } from '../../audio/effects/softClipper.js'
import Knob from '../knobs/Knob.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import ClipLamp from '../meters/ClipLamp.vue'
import ClipperScope from '../meters/ClipperScope.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  headroomDb, emphasisDb, outputTrimDb, thresholdMode, fixedThresholdDb, shape, asymmetry, hfLoss, soften,
  clipperPreview, clipperReduction, clipperEngagedPct, clipperLiftDb,
  clipperResidualDbc, clipperDelta,
  clipperInputLevels, clipperOutputLevels, getScope, hasSelection,
  togglePreview, toggleDelta, syncHeadroom, syncEmphasis, syncAsymmetry, syncHfLoss, syncSoften, syncOutputTrim,
  syncFixedThreshold,
  setThresholdMode, setShape, apply, teardown, closeModal,
} = useSoftClipper()

const { state } = useEditorState()

/**
 * The scope's view of the timeline around the playhead.
 *
 * It comes from here rather than from the effect because the effect has not
 * seen it — the kernel's ring only ever holds audio it has already processed,
 * which is nothing at all when the stage is bypassed and nothing ahead of the
 * playhead ever. The scope asks for the half ahead always, and for the half
 * behind whenever its ring is not live, so that bypassing the stage leaves one
 * waveform still travelling past the playhead rather than half a frozen one.
 *
 * Read live from `state.playhead`, which the transport advances every frame, so
 * the picture slides under a stationary playhead. It also works with the
 * transport stopped: park the playhead before a loud passage and the scope
 * shows what the current setting would do to it before anything is heard.
 *
 * ONE SCRATCH PER SIDE. Both are alive in the same frame, so a single shared
 * buffer would have the second call overwrite the first — the two halves would
 * show the same audio.
 */
const envelopeScratch = { ahead: null, behind: null }
function envelope(offsetSeconds, seconds, columns) {
  if (!state.segments?.length) return null
  const side = offsetSeconds < 0 ? 'behind' : 'ahead'
  if (envelopeScratch[side]?.length !== columns) envelopeScratch[side] = new Float32Array(columns)
  return readTimelineEnvelope(
    state.segments, state.playhead + offsetSeconds, seconds, columns, envelopeScratch[side],
  )
}

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

/**
 * The knee: how sharply reduction ramps in with how far over the threshold a
 * peak sits.
 *
 * NAMED "KNEE" AND NOT "SELECTIVITY", and the captions give numbers, because
 * the first attempt at both was wrong in a way worth not repeating. BROAD /
 * FOCUSED / SURGICAL implies a width — as if the effect covered more or less
 * of something — and the side note "every peak over the line" was flatly
 * untrue: at a given threshold ALL three positions act on exactly the same
 * samples, because the threshold is what decides that. What changes is how
 * much each of those samples gets, weighted by its overshoot.
 *
 * THE CAPTIONS SHOW A CROSSOVER, AND THAT IS THE WHOLE CONTROL. Each position
 * carries its own knee, set so a peak SHAPE_ANCHOR_DB (8 dB) over the
 * threshold loses the same 3.3 dB whichever is selected — so the switch moves
 * character, not depth. Below the anchor EARLY does more (0.69 / 0.40 / 0.24
 * dB at +3), above it LATE does (4.73 / 4.94 / 5.07 at +12). Both numbers are
 * shown, with the anchor between them, because reading the three as one line is
 * what stops the control being taken for a second volume knob.
 *
 * It used to be one: at a shared knee every position was strictly quieter than
 * the one before it, so LATE "sounded cleaner" mostly because it was doing
 * less, and comparing two positions by ear compared two amounts. See
 * SHAPE_ANCHOR_DB in the kernel for the measurement, and SHAPE_EXPONENT for
 * the monotonicity bounds and why the smoothstep family is not offered.
 */
const SHAPE_OPTIONS = [
  { value: 'tanh2', label: 'EARLY', title: 'Spends the reduction on peaks that only just cross the threshold' },
  { value: 'tanh3', label: 'MID', title: 'Even-handed between shallow crossings and deep ones (default)' },
  { value: 'tanh4', label: 'LATE', title: 'Holds off on shallow crossings and hits the deepest overshoots harder' },
]

// THREE POINTS, NOT TWO, and the middle one is the reason. It is the anchor,
// so it reads −3.3 in all three positions — the caption therefore shows the
// pivot happening rather than asserting it, and a user switching positions can
// see at a glance that the depth is held and only the ends move. Two points
// would have left "does LATE just do less?" open, which is the question the
// whole normalisation exists to close.
const SHAPE_CAPTION = {
  tanh2: '3 dB over → −0.7 · 8 → −3.3 · 12 → −4.7 dB',
  tanh3: '3 dB over → −0.4 · 8 → −3.3 · 12 → −4.9 dB',
  tanh4: '3 dB over → −0.2 · 8 → −3.3 · 12 → −5.1 dB',
}

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
 * What HF Emphasis is doing right now, in one line under the knob.
 *
 * Two readings rather than a fixed caption, because the knob's effect is a
 * property of the MATERIAL and a static caption cannot say so. At 0, or on a
 * passage with nothing above the corner, there is nothing to aim at and the
 * panel says so instead of implying the control is live.
 */
const emphasisCaption = computed(() => {
  if (emphasisDb.value <= 0) return 'aims at consonants'
  if (clipperLiftDb.value < 0.15) return 'nothing up there to aim at'
  return `aiming — ceiling +${clipperLiftDb.value.toFixed(1)} dB`
})

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

/**
 * Reduction that lights the lamp fully.
 *
 * 6 dB, not the 12 the bar used to run: 6 is MAX_REDUCTION_DB, the kernel's own
 * hard ceiling and spec §7.1's stated limit, so no setting can drive the lamp
 * past its top and full brightness means "at the bound" rather than "somewhere
 * in the upper half". The bar needed the extra headroom to keep its engraved
 * scale honest; a lamp has no scale to be honest about, only a range to spend,
 * and spending half of it on readings the kernel cannot produce was the same
 * mistake at a smaller size.
 */
const METER_FULL_SCALE_DB = 3

/**
 * Display height. The panel's one instrument, so it gets the space the gain
 * reduction bar and the oversized knob row used to hold between them.
 */
const SCOPE_H = 236
</script>

<template>
  <FloatingWindow
    window-id="soft-clipper"
    :z="z"
    :width="700"
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

    <div class="px-[22px] pt-[14px] pb-[18px]">
      <!-- ── Instrument strip ──────────────────────────────────────────────
           Mode on the left because it governs the display below it; the lamp
           on the right because it reports on the same display. One line, so
           the scope starts as high on the faceplate as it can. -->
      <div class="flex items-center justify-between gap-[16px] mb-[10px]">
        <div class="flex items-center gap-[9px]">
          <span style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.35)">THRESHOLD</span>
          <SegmentedSwitch
            :model-value="thresholdMode"
            @update:model-value="setThresholdMode"
            :options="MODE_OPTIONS"
            :accent="ACCENT"
            :disabled="!clipperPreview"
            :padding-x="11"
          />
        </div>

        <!-- A lamp, not a bar — see ClipLamp for why a full-length GR meter
             was the wrong instrument for a stage that takes 0.3-0.4 dB off a
             plosive and nothing off anything else. -->
        <ClipLamp
          :reduction-db="clipperReduction"
          :engaged-pct="clipperEngagedPct"
          :residual-dbc="clipperResidualDbc"
          :accent="ACCENT"
          :full-scale-db="METER_FULL_SCALE_DB"
        />
      </div>

      <!-- ── The instrument ───────────────────────────────────────────────
           THIS IS THE CONTROL SURFACE, not an illustration of one. The
           threshold curve is a handle in both modes: in fixed mode the drag
           sets the ceiling outright, in adaptive it moves Headroom, which IS
           the curve's offset from the tracked level. The knobs below are the
           precise way to reach the same two numbers, not the primary way.
           Flanked by the level meters at full display height so the three
           read as one instrument. -->
      <div class="flex items-stretch gap-[10px]">
        <LevelMeter :levels="clipperInputLevels" label="IN" :height="SCOPE_H" />

        <div class="flex-1 min-w-0">
          <ClipperScope
            :data-fn="getScope"
            :envelope-fn="envelope"
            :window-seconds="SCOPE_SECONDS * 2"
            :mode="thresholdMode"
            :fixed-threshold-db="fixedThresholdDb"
            @update:fixed-threshold-db="syncFixedThreshold"
            :headroom-db="headroomDb"
            @update:headroom-db="syncHeadroom"
            @request-play="togglePlayback"
            :accent="ACCENT"
            :height="SCOPE_H"
            title="Clipper scope: input envelope against the threshold, playhead at the centre — played audio to its left, audio about to play to its right. Drag the threshold line to set it."
          />
        </div>

        <LevelMeter :levels="clipperOutputLevels" label="OUT" :height="SCOPE_H" />
      </div>

      <!-- ── Secondary controls ───────────────────────────────────────────
           Deliberately small. Everything here is reachable from the display
           or is a set-once refinement, so the knobs are sized as the fallback
           they now are rather than as the panel's centre of gravity. -->
      <div class="flex justify-center gap-[16px] mt-[14px]">
        <!-- One slot for the threshold, whichever unit the mode expresses it
             in — see thresholdKnob. Keyed on the mode so the Knob remounts
             rather than carrying drag state across a range change. -->
        <div class="w-[74px]">
          <Knob
            :key="thresholdMode"
            :model-value="thresholdKnob.value"
            @update:model-value="thresholdKnob.sync"
            :min="thresholdKnob.min" :max="thresholdKnob.max" :step="thresholdKnob.step"
            :label="thresholdKnob.label" :accent="ACCENT" :format-value="thresholdKnob.format"
            :value-font-px="13"
            :disabled="!clipperPreview"
          />
          <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
            {{ thresholdKnob.caption }}
          </p>
        </div>
        <div class="w-[74px]">
          <!-- AIMS the stage, and the caption names that rather than the
               mechanism. "harshness, not tone" shipped here and was the wrong
               shape of statement twice over: it described what the control is
               not, and the thing it was defending against was — as shipped —
               true. Uncompensated, raising this knob tripled peak reduction
               on any HF-rich passage, so "turn it up to add harshness" was a
               fair reading of the measurements rather than a misconception.
               With the lift compensation in place depth holds and what is
               left is pure aim: measured on two bursts of identical peak
               amplitude, 110 Hz stays at 1.88 dB of reduction across the
               whole knob while a fricative goes 3.00 -> 5.84.

               The live figure is the compensation itself, and it doubles as
               the honest answer to "is this knob doing anything here?" — on
               material with nothing above 3.5 kHz to aim at, it reads 0.0. -->
          <Knob
            :model-value="emphasisDb"
            @update:model-value="syncEmphasis"
            :min="0" :max="12" :step="0.5"
            label="HF Emphasis" :accent="ACCENT" :format-value="formatGain"
            :value-font-px="13"
            :disabled="!clipperPreview"
          />
          <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
            {{ emphasisCaption }}
          </p>
        </div>
        <div class="w-[74px]">
          <!-- THE ONLY CONTROL HERE THAT ADDS SOMETHING RATHER THAN REMOVING
               IT, and the caption says which harmonics because "warmth" alone
               is unfalsifiable — this panel has already shipped one caption
               that described what a control was not.

               The curve is odd symmetric, so it generates odd harmonics and
               NOTHING else: measured, H2 sits at -144 dB on a tone and the
               even-order energy on real narration is exactly zero. This offset
               is the only way to reach second and fourth order, which is what
               tube and tape warmth actually is. It is additive rather than a
               rebalancing — H3 moves by at most 1 dB across the whole sweep —
               so it colours without changing how hard the stage works. -->
          <Knob
            :model-value="asymmetry"
            @update:model-value="syncAsymmetry"
            :min="0" :max="100" :step="1"
            label="Asymmetry" :accent="ACCENT" :format-value="v => v.toFixed(0)"
            :value-font-px="13"
            :disabled="!clipperPreview"
          />
          <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
            even-order warmth
          </p>
        </div>
        <div class="w-[74px]">
          <!-- ⚠ NOT GAP LOSS, whatever the tape literature suggests. Gap loss
               is the reproduce head averaging flux across a finite gap —
               sinc(pi*g/lambda) — which depends on gap width, tape speed and
               frequency and NOT on level. Modelled faithfully it would be an
               always-on shelf, and an always-on shelf costs this stage its
               bit-transparency below the threshold.

               What makes tape actually lose top end when pushed is
               short-wavelength self-erasure, which is strongly level-dependent
               — and that is the version worth having here, because a colour
               that vanishes with level leaves quiet material untouched. -->
          <Knob
            :model-value="hfLoss"
            @update:model-value="syncHfLoss"
            :min="0" :max="100" :step="1"
            label="HF Loss" :accent="ACCENT" :format-value="v => v.toFixed(0)"
            :value-font-px="13"
            :disabled="!clipperPreview"
          />
          <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
            softens under level
          </p>
        </div>
        <div class="w-[74px]">
          <!-- THE TAPE EFFECT "Hysteresis" IS NAMED AFTER AND IS NOT: a limit
               on how fast the waveform may move, scaled to the threshold and
               applied just ahead of the curve. It softens the top end and cuts
               what the curve then has to do (measured at matched output peak:
               3.9 dB less curve distortion, 10 dB less above 8 kHz at the top
               of the knob) — and contributes no peak reduction at all, which
               is why it is captioned as tone.
               ⚠ The one control here that gives up bit-transparency below the
               threshold. It has to: everything a voice does is far under the
               bound that would preserve it. See SOFTEN_REF. -->
          <Knob
            :model-value="soften"
            @update:model-value="syncSoften"
            :min="0" :max="100" :step="1"
            label="Soften" :accent="ACCENT" :format-value="v => v.toFixed(0)"
            :value-font-px="13"
            :disabled="!clipperPreview"
          />
          <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
            rounds the fastest edges
          </p>
        </div>
        <div class="w-[74px]">
          <Knob
            :model-value="outputTrimDb"
            @update:model-value="syncOutputTrim"
            :min="-6" :max="6" :step="0.1"
            label="Output Trim" :accent="ACCENT" :format-value="formatGain"
            :value-font-px="13"
            :disabled="!clipperPreview" bipolar
          />
          <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
            gain match for A/B
          </p>
        </div>
      </div>

      <!-- How hard the shallow crossings get hit. Sits with the knobs rather
           than in the instrument strip because it refines what the display
           already shows, the way HF Emphasis does — the strip is for things
           that change how to READ the scope. -->
      <div class="flex items-center justify-center gap-[9px] mt-[14px]">
        <span style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.35)">KNEE</span>
        <SegmentedSwitch
          :model-value="shape"
          @update:model-value="setShape"
          :options="SHAPE_OPTIONS"
          :accent="ACCENT"
          :disabled="!clipperPreview"
          :padding-x="11"
        />
        <span style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
          {{ SHAPE_CAPTION[shape] }}
        </span>
      </div>

      <p
        class="mt-[12px] text-center"
        style="font:500 9.5px/1.45 'Inter';color:rgba(255,255,255,.32)"
      >
        {{ MODE_CAPTION[thresholdMode] }} — trims the few transients that stick
        out, so the compressor after it works on the voice instead of chasing
        plosives.
      </p>

      <div class="mt-[12px] pt-[12px]" style="border-top:1px solid rgba(255,255,255,.06)">
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
