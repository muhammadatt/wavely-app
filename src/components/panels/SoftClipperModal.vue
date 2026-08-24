<script setup>
import { computed, onMounted, watch } from 'vue'
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
  headroomDb, outputTrimDb, thresholdMode, fixedThresholdDb, shape, drive, limiter,
  emphasisDb, tuningOn, driveRatios,
  clipperPreview, clipperReduction, clipperEngagedPct, clipperLiftDb,
  clipperResidualDbc, clipperDelta,
  clipperInputLevels, clipperOutputLevels, getScope, hasSelection,
  togglePreview, toggleDelta, syncHeadroom, syncDrive, syncLimiter, syncEmphasis, syncRatio,
  syncOutputTrim,
  syncFixedThreshold,
  setShape, apply, teardown, closeModal,
  ceilingPreset, ceilingBusy, CEILING_PRESETS, applyCeilingPreset, scheduleCeilingPreset,
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

// The THRESHOLD mode switch is gone: the panel is fixed-ceiling only. See
// useSoftClipper's thresholdMode note for why adaptive stopped being offered.
/**
 * The knee: how sharply reduction ramps in with how far over the threshold a
 * peak sits.
 *
 * ⚠ IT IS ON THE HIDDEN TUNING PANEL NOW, not the faceplate. Peak-matched it
 * is worth at most 0.7 dB of residual against HF Emphasis's 3.4 — the smaller
 * lever by a factor of five — and a two-knob panel cannot afford a control
 * that small. The default is LATE; see SHAPE_KNEE_ANCHOR_SHAPE for why moving
 * which position opens by default no longer moves the curves themselves.
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
  { value: 'tanh3', label: 'MID', title: 'Even-handed between shallow crossings and deep ones' },
  { value: 'tanh4', label: 'LATE', title: 'Holds off on shallow crossings and hits the deepest overshoots harder (default)' },
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


/**
 * Why the ceiling presets cannot be clicked, or null when they can.
 *
 * ⚠ THEY NEEDED A REASON, NOT JUST A DISABLED ATTRIBUTE. Reported from use: the
 * buttons do nothing with no selection made, and nothing on the panel says so.
 * Two separate bugs behind that. `applyCeilingPreset` bails on a missing
 * selection but the button was never marked disabled for it, so the click was
 * accepted and silently dropped — the worst of the three states. And the
 * disabled styling that did exist covered only the bypassed case, so a busy or
 * unclickable button looked exactly like a clickable one.
 *
 * A preset MEASURES THE SELECTED REGION, so a selection is not incidental to it
 * — it is the input. Saying which of the three reasons applies is what turns a
 * dead button into an instruction.
 */
const ceilingDisabledReason = computed(() => {
  if (!clipperPreview.value) return 'Turn Soft Clipper on to measure a ceiling'
  if (!hasSelection.value) return 'Select a region — the preset measures its peaks'
  if (ceilingBusy.value) return 'Measuring…'
  return null
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

function formatGain(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

function formatDb(v) {
  return v.toFixed(1)
}

// A preset re-runs for a changed region, but only while one is active — once
// the ceiling has been turned by hand it is the user's number. Debounced,
// because dragging a selection edge is a stream of these.
watch(() => state.selection, () => scheduleCeilingPreset(), { deep: true })


/**
 * ONE THRESHOLD CONTROL: the ceiling, in dBFS.
 *
 * This slot used to swap between Headroom (adaptive) and Ceiling (fixed) with
 * the mode, which was already an improvement on having two knobs with one of
 * them permanently ghosted. The mode switch is gone now — the panel is
 * fixed-only — so the slot is simply the ceiling, and the preset buttons below
 * are what put it in the right place for the material.
 */
const thresholdKnob = computed(() => ({
  value: fixedThresholdDb.value,
  sync: syncFixedThreshold,
  min: -24, max: -1, step: 0.5,
  label: 'Ceiling',
  format: formatDb,
  caption: ceilingPreset.value ? `${ceilingPreset.value} — peaks stop here` : 'peaks stop here',
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
           Presets on the left because they move the threshold line drawn on
           the display below; the lamp on the right because it reports on the
           same display. One line, so the scope starts as high on the faceplate
           as it can.

           These are BUTTONS, not a mode switch: each one measures the region
           and writes the ceiling, after which the ceiling is an ordinary number
           the user can turn. The lit one says where the current value came
           from, and goes out the moment the knob is touched. -->
      <div class="flex items-center justify-between gap-[16px] mb-[10px]">
        <div class="flex items-center gap-[9px]">
          <span style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.35)">CEILING</span>
          <div class="flex items-center gap-[3px]">
            <button
              v-for="p in CEILING_PRESETS"
              :key="p.id"
              type="button"
              :title="ceilingDisabledReason ?? p.title"
              :disabled="!!ceilingDisabledReason"
              @click="applyCeilingPreset(p.id)"
              class="px-[8px] py-[3px] rounded-[3px] transition-colors cursor-pointer disabled:cursor-not-allowed"
              style="font:700 7.5px 'JetBrains Mono',monospace;letter-spacing:.12em"
              :style="[
                ceilingPreset === p.id
                  ? { background: ACCENT, color: '#12100e' }
                  : { background: 'rgba(255,255,255,.05)', color: 'rgba(255,255,255,.45)' },
                ceilingDisabledReason ? { opacity: .3, filter: 'grayscale(1)' } : { opacity: 1 },
              ]"
            >{{ p.label }}</button>
          </div>
          <!-- SAYS WHY, not just that. A row of greyed buttons with nothing
               beside them is legible as "off" and illegible as "off because
               you have not selected anything yet", which is the one state the
               user can do something about. -->
          <span
            v-if="ceilingDisabledReason"
            style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.3)"
          >{{ ceilingDisabledReason }}</span>
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
            mode="fixed"
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
        <!-- One slot for the threshold — see thresholdKnob. -->
        <div class="w-[74px]">
          <Knob
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
          <!-- ONE KNOB FOR THE WHOLE CHARACTER GROUP — asymmetry, HF Loss and
               Soften at fixed internal ratios, see DRIVE_ASYM_RATIO. They were
               four separate colour controls defaulting to 0 on a panel whose
               identity is transparency, and nobody sets them independently on
               purpose. 0 bypasses all three, so the stock patch is exactly the
               clipper and nothing else. -->
          <Knob
            :model-value="drive"
            @update:model-value="syncDrive"
            :min="0" :max="100" :step="1"
            label="Drive" :accent="ACCENT" :format-value="v => v.toFixed(0)"
            :value-font-px="13"
            :disabled="!clipperPreview"
          />
          <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
            tape character
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

      <!-- ⚠ HIDDEN ADMIN TUNING PANEL — see softClipperTuning.js. Off unless
           ?softClipperTuning=1 (or the localStorage key) is set, so the shipped
           panel stays a ceiling, two knobs and the presets. The amber badge is
           the same signal VoiceRx's baseline override uses, for the same
           reason: an override that is not visibly an override is how a
           measurement gets taken against the wrong build.

           TWO KINDS OF CONTROL LIVE HERE and the difference matters. Limiter,
           Knee and HF Emphasis are SHIPPED kernel behaviour whose knobs are
           hidden because they are research controls — the kernel's defaults
           are what a user gets either way, and turning one here changes only
           this session. The Drive ratios are SCAFFOLDING: they override fixed
           constants, and they come out once the ratios are chosen. -->
      <div v-if="tuningOn" class="mt-[16px] pt-[12px]" style="border-top:1px dashed rgba(255,176,32,.35)">
        <div class="flex items-center justify-center mb-[10px]">
          <span style="font:700 8px 'Inter',system-ui;letter-spacing:.08em;color:rgba(255,176,32,.9)">
            ⚠ ADMIN TUNING — NOT SHIPPED
          </span>
        </div>

        <!-- Shipped behaviour, hidden controls. -->
        <div class="flex justify-center items-start gap-[16px]">
          <div class="w-[74px]">
            <!-- THE HYBRID PEAK PATH. A lookahead limiter ahead of the curve,
                 taking peaks down with a smooth gain envelope instead of by
                 reshaping samples — so its error is intermodulation and
                 slight pumping rather than the harmonic series the curve
                 makes. The knob is a BALANCE: it decides how the peak control
                 is shared, not how much of it there is. The ceiling still sets
                 that.
                 ⚠ OFF THE FACEPLATE BECAUSE IT CHANGES THE STAGE'S LATENCY
                 while engaged (50 samples -> 242): toggling it under a running
                 preview shifts the timeline by that much, which is a research
                 control's business and not a user's. See LIMITER_MAX_ABOVE_DB. -->
            <Knob
              :model-value="limiter"
              @update:model-value="syncLimiter"
              :min="0" :max="100" :step="1"
              label="Limiter" accent="#ffb020" :format-value="v => v.toFixed(0)"
              :value-font-px="13"
              :disabled="!clipperPreview"
            />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              {{ limiter > 0 ? 'gain, not shaping (+4 ms)' : 'gain, not shaping' }}
            </p>
          </div>
          <div class="w-[74px]">
            <!-- AIMING, not cleanliness. The detector reads the unfiltered
                 downmix while the curve sees the pre-emphasised one, so this
                 decides WHICH transients get worked on. Peak-matched, 0 is the
                 cleanest setting by 2.2-3.4 dB and there is no interior
                 optimum — so there is nothing here for a user to find by
                 turning it, and the pinned value is a judgement rather than a
                 measurement. That is exactly why the knob is here: the aiming
                 has never been measured, and this is how it gets measured.
                 The caption reads back the lift the compensation is giving the
                 threshold, which is the most direct evidence of what the knob
                 is doing on THIS material — near zero means this passage has
                 nothing above the corner to aim at. -->
            <Knob
              :model-value="emphasisDb"
              @update:model-value="syncEmphasis"
              :min="0" :max="12" :step="0.5"
              label="HF Emph" accent="#ffb020" :format-value="v => v.toFixed(1)"
              :value-font-px="13"
              :disabled="!clipperPreview"
            />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              aiming · lift {{ clipperLiftDb.toFixed(2) }} dB
            </p>
          </div>
        </div>

        <!-- The knee. Depth-matched at the anchor, so this moves character and
             not amount — and peak-matched it is worth at most 0.7 dB against
             HF Emphasis's 3.4, which is why it is the one that came off the
             faceplate rather than Drive. -->
        <div class="flex items-center justify-center gap-[9px] mt-[12px]">
          <span style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.35)">KNEE</span>
          <SegmentedSwitch
            :model-value="shape"
            @update:model-value="setShape"
            :options="SHAPE_OPTIONS"
            accent="#ffb020"
            :disabled="!clipperPreview"
            :padding-x="11"
          />
          <span style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
            {{ SHAPE_CAPTION[shape] }}
          </span>
        </div>

        <!-- ⚠ SCAFFOLDING, unlike everything above it: these three override
             fixed kernel constants and come out once the ratios are chosen. -->
        <div class="flex items-center justify-center gap-[8px] mt-[14px] mb-[8px]">
          <span style="font:700 8px 'Inter',system-ui;letter-spacing:.08em;color:rgba(255,176,32,.65)">
            DRIVE SPLIT
          </span>
          <span style="font:600 8px ui-monospace,monospace;color:rgba(255,255,255,.45)">
            {{ driveRatios.asymmetry.toFixed(2) }} / {{ driveRatios.hfLoss.toFixed(2) }} / {{ driveRatios.soften.toFixed(2) }}
          </span>
        </div>
        <div class="flex justify-center gap-[16px]">
          <div class="w-[74px]" v-for="r in [
            { key: 'asymmetry', label: 'Asym x', caption: 'even harmonics' },
            { key: 'hfLoss', label: 'HF Loss x', caption: 'fixed shelf' },
            { key: 'soften', label: 'Soften x', caption: 'least predictable' },
          ]" :key="r.key">
            <Knob
              :model-value="driveRatios[r.key]"
              @update:model-value="v => syncRatio(r.key, v)"
              :min="0" :max="1.5" :step="0.05"
              :label="r.label" accent="#ffb020" :format-value="v => v.toFixed(2)"
              :value-font-px="13"
              :disabled="!clipperPreview"
            />
            <p class="mt-[3px] text-center" style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
              {{ r.caption }}
            </p>
          </div>
        </div>
      </div>

      <p
        class="mt-[12px] text-center"
        style="font:500 9.5px/1.45 'Inter';color:rgba(255,255,255,.32)"
      >
        The ceiling is a stated dBFS value — trims the few transients that stick
        out, so the compressor after it works on the voice instead of chasing
        plosives. The presets put it where this recording's own peaks say it
        should go.
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
