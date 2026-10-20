<script setup>
import { computed, onMounted, ref } from 'vue'
import { useSoftClipper } from '../../composables/useSoftClipper.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { readTimelineEnvelope } from '../../audio/timelineEnvelope.js'
import { SCOPE_SECONDS } from '../../audio/effects/softClipper.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import ModulaChip from '../modula/ModulaChip.vue'
import ModulaLedPill from '../modula/ModulaLedPill.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import ClipperScope from '../meters/ClipperScope.vue'
import { lampFraction } from '../meters/ballistics.js'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  headroomDb, outputTrimDb, thresholdMode, fixedThresholdDb, shape, limiter,
  limiterMode, LIMITER_MODES, setLimiterMode, limiterLatencyMs,
  emphasisDb, tuningOn,
  clipperPreview, clipperReductionHeld, clipperReductionReadout,
  clipperEngagedReadout, clipperLiftDb,
  clipperResidualDbc, clipperDelta,
  clipperInputLevels, clipperOutputLevels, getScope, hasSelection,
  togglePreview, toggleDelta, syncHeadroom, syncLimiter, syncEmphasis,
  syncOutputTrim,
  autoMakeup, toggleAutoMakeup,
  SOFT_CLIPPER_MAKEUP_MIN_DB, SOFT_CLIPPER_MAKEUP_MAX_DB,
  syncFixedThreshold,
  setShape, apply, teardown, closeModal,
  ceilingBusy, CEILING_PRESETS, 
  ceilingChoices, setCeilingFromPreset,
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
  // The chain's copy keeps its ON/BYPASS: opening its editor from the chain
  // must not un-bypass its slot.
  if (!clipperPreview.value && currentPluginCopy() === 'solo') togglePreview()
})

// The kit's amber, like every Modula panel. The admin tuning panel keeps its
// own warning amber so an override still reads as one.
const ACCENT = '#e8a33d'
const TUNING = '#ffb020'

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

/**
 * The one thing that decides between the two positions.
 *
 * ⚠ THE CAPTION COMES FROM THE MODE TABLE, not from a branch here. Two places
 * describing the same switch drift, and the one on the faceplate is the one a
 * user reads. The latency each costs is in the buttons' titles — see
 * LIMITER_MODES for why it is disclosed there rather than on the faceplate.
 */
const limiterCaption = computed(() => {
  const mode = LIMITER_MODES.find(m => m.id === limiterMode.value)
  if (mode) return mode.caption
  // The admin knob has been put between the two. Say where, rather than
  // lighting a position it is not at.
  const sr = state.currentFile?.sampleRate ?? 44100
  return `limiter ${limiter} · ${limiterLatencyMs(sr).toFixed(1)} ms`
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
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
}

function formatDb(v) {
  return `${v.toFixed(1)} dBFS`
}

const LIMITER_OPTIONS = LIMITER_MODES.map(m => ({ value: m.id, label: m.label, title: m.title }))

/**
 * Display height — where it opens, and the only thing a resize spends.
 *
 * 250 px, from the design. The waveform is the instrument and the ceiling is
 * set by dragging a line on it, so the display's height IS the resolution of
 * the primary control — at 236 a dB was about four pixels of travel. Which is
 * also the argument for making the window resizable at all: a taller display is
 * a finer ceiling control, not just a bigger picture.
 *
 * ⚠ THE DISPLAY SPENDS THE EXTRA PIXELS AND NOTHING ELSE DOES, the same rule
 * ResonanceModal follows. The meters, the knobs, the setter bank and the mode
 * switch stay exactly the size they were designed at: they are read at a
 * glance and none of them gets better for being larger, so growing them would
 * spend a drag on the parts nobody dragged for.
 *
 * WIDTH NEEDS NO WIRING. The scope is the flex child that grows, and
 * FloatingWindow's `minWidth` defaults to `width` — so the handle is
 * expand-only and the design's 1040 is the floor rather than something a drag
 * can collapse.
 */
const SCOPE_H = 250
const heightDelta = ref(0)
const scopeHeight = computed(() => SCOPE_H + heightDelta.value)

/**
 * Faceplate width — the opening size, and the floor.
 *
 * The design draws it at 1040. What actually SETS a minimum is the control
 * band, whose two knobs, two dividers, padding and gaps are fixed cost and
 * whose middle holds four setter buttons beside a two-position switch:
 *
 *   fixed chrome (body + band padding, 2 knobs, 2 rules, 5 gaps)   372 px
 *   setter bank (4 buttons at 69 px + three 8 px gaps)             300
 *   mode switch (CLIP | LIMIT)                                     124
 *   gap between the two middle groups                               28
 *                                                                  ---
 *                                                                  824
 *
 * 900 leaves about 76 px of slack over that, which is the margin for the one
 * thing this arithmetic cannot do: it is computed from nominal font advances
 * (0.6em mono, 0.5em Inter) rather than measured in a browser, so it is right
 * to within a fitting error, not exactly right.
 *
 * ⚠ THE LAYOUT FAILS LOUDLY RATHER THAN SILENTLY IF THAT ESTIMATE IS OFF. Every
 * fixed-size child in the band carries `flex-shrink:0`, so a band that does not
 * fit OVERFLOWS — visibly, off the edge — instead of compressing the knobs and
 * the buttons into each other, which is the failure that is easy to miss in a
 * screenshot and impossible to miss in use.
 *
 * `minWidth` is not set, so FloatingWindow uses this as the floor too: the grip
 * only ever expands, and the size is remembered per window.
 */
const PANEL_W = 900

/**
 * ⚠ THE STRIP'S TWO LIVE READINGS ARE DAMPED IN THE COMPOSABLE, beside the loop
 * that reads them off the kernel — see `clipperReductionHeld`. The first
 * attempt damped them here, in a second rAF loop owned by this component, and
 * when that loop was not running the lamp and the numeral simply froze. One
 * loop, one place, no way for a value to be live in one and stale in the other.
 *
 * What is left here is presentation: the held dB becomes a brightness through
 * `lampFraction`, and the throttled dB becomes text. Both read the SAME held
 * value, so the light and the number can never say different things.
 */

/**
 * Reduction that lights the lamp fully — MAX_REDUCTION_DB's usable half.
 * Matches what ClipLamp was given, so the light means the same thing it did.
 */
const LAMP_FULL_SCALE_DB = 3

const lampBrightness = computed(() =>
  lampFraction(clipperReductionHeld.value, LAMP_FULL_SCALE_DB))
/**
 * The line under the bank: which preset the ceiling is currently sitting on.
 *
 * ⚠ IT DESCRIBES THE ACTIVE SETTER ONLY, and reads empty the rest of the time.
 * Two earlier states were removed deliberately:
 *
 *   - a HOVER preview, which answered "what would this one do" before a press;
 *   - the DISABLED REASON, which said why the bank was dead.
 *
 * Both put text under the bank that was about something other than the current
 * setting, so the line changed identity as the pointer moved and could not be
 * read as a statement about the panel's state. It is now one thing: the preset
 * the ceiling is on, or nothing.
 *
 * ⚠ WHAT THAT GIVES UP, stated plainly because a test used to pin it: the dBFS
 * a setter would write is no longer visible BEFORE it is pressed. The button's
 * `title` still carries it on hover, and pressing is cheap and reversible, but
 * the bank no longer previews. That is a deliberate trade of preview for a
 * quieter faceplate.
 *
 * ⚠ AND THE DISABLED REASON NOW HAS NO VISIBLE HOME. The buttons still grey out
 * and still carry the reason in their `title`, but nothing on the faceplate
 * says why in words any more. If "the presets do nothing and I cannot tell
 * why" comes back as a report, this is where it went.
 */
const setterCaption = computed(() => {
  const active = ceilingSetters.value.find(x => x.active && x.ready)
  return active ? `${active.title}  (${active.db} dB)` : ''
})

/**
 * ⚠ THE CEILING STOPS DESCRIBING THE OUTPUT PEAK ONCE AUTO IS LIT, and saying
 * otherwise would be a readout that is false on the shipped default patch.
 *
 * With AUTO off the old reading is exact: peaks stop at this number. With AUTO
 * on the ceiling is where peaks stop *inside* the stage, and the makeup then
 * hands the removed peak back as gain — so the output peak lands back on the
 * source's and the number here is a threshold rather than an output spec. That
 * is the whole point of a clipper's makeup, and it is worth one clause rather
 * than leaving the panel promising something it no longer does.
 */
const ceilingTitle = computed(() => (autoMakeup.value
  ? 'Where peaks stop inside the stage, in dBFS. AUTO hands what it takes off the peaks back as output gain, so the output peak lands where the source\u2019s was. Set it from the buttons, by dragging the line, or here.'
  : 'Where peaks stop, in dBFS. Set it from the buttons, by dragging the line, or here.'))

const peakOverText = computed(() =>
  (clipperReductionReadout.value < 0.05 ? '—' : clipperReductionReadout.value.toFixed(1)))
const engagedText = computed(() => `${clipperEngagedReadout.value.toFixed(0)}%`)

/**
 * Length of the horizontal IN/OUT ladders.
 *
 * 396 in the design, against its 1040 faceplate — a little under half the body
 * width, so the pair spans it with the two readouts between them. At 900 that
 * same proportion is 336; a fixed 396 would have the two meters and their
 * readouts filling the row edge to edge with nothing between them. Modula's
 * readout well and caption sit beside each ladder, so it is 300 here: at 336
 * the OUT caption ran past the body's edge.
 *
 * The ladder rounds this down to whole segments internally (see LevelMeter's
 * `rows`), so a few pixels either way costs a segment at most.
 */
const METER_LEN = 300

/**
 * How close the ceiling has to be to a setter's value to count as "this is what
 * the ceiling is holding", in dB.
 *
 * Tight enough that one detent of the knob clears it — the knob's step is 0.5 —
 * and loose enough to survive the float round trip through the worker and the
 * kernel. It is a tolerance on equality, not a range.
 */
const SETTER_MATCH_DB = 0.05

/**
 * The four ceiling setters, each carrying the dBFS it would write and whether
 * the ceiling is currently sitting on it.
 *
 * ⚠ THE HIGHLIGHT IS DERIVED, NOT REMEMBERED, and that is the whole of why it
 * is safe. A stored "last clicked" flag is a claim about the past that stops
 * being true the moment the knob or the line moves — the readout-goes-stale
 * failure this panel has already shipped once, as a latching preset lamp.
 * Comparing the setter's own number against the live ceiling asks a question
 * about the PRESENT instead: it lights when they agree and goes out when they
 * do not, with nothing to clear and no way to be wrong.
 *
 * It is therefore not a selection. Land on a preset's value by dragging the
 * line and its button lights, which is correct — the button describes a value,
 * and that value is what the ceiling holds.
 *
 * ⚠ A BUTTON WITH NO NUMBER IS DISABLED RATHER THAN OPTIMISTIC. Until the
 * region has been measured there is nothing to promise, and a setter that
 * writes an unknown value on click is the failure the printed number exists to
 * remove.
 */
const ceilingSetters = computed(() => CEILING_PRESETS.map(p => {
  const db = ceilingChoices.value[p.id]
  const ready = Number.isFinite(db)
  return {
    ...p,
    db: ready ? `${db.toFixed(1)}` : '—',
    ready,
    active: ready && Math.abs(db - fixedThresholdDb.value) <= SETTER_MATCH_DB,
  }
}))

</script>

<template>
  <FloatingWindow
    window-id="soft-clipper"
    :z="z"
    :width="PANEL_W"
    :top="72"
    :accent="ACCENT"
    design="modula"
    brand-lead="SOFT CLIPPER"
    :engaged="clipperPreview"
    show-delta
    :delta="clipperDelta"
    :delta-disabled="!clipperPreview"
    delta-title="Hear only what is being removed — the harmonics the clipper is generating, on their own. Monitoring only: Apply always renders the processed audio."
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!clipperPreview"
    apply-disabled-hint="Turn Soft Clipper on to apply it"
    resizable
    @update:height-delta="heightDelta = $event"
    @toggle-engaged="togglePreview"
    @toggle-delta="toggleDelta"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="sc-face">
      <!-- ── Readout strip ────────────────────────────────────────────────
           Right-aligned above the display: three readings about the stage, in
           the order they answer questions about it — is it clipping, how hard,
           how often.

           ⚠ RESIDUAL IS NOT HERE. It is on the tuning panel instead: it is the
           reading that separates two settings the other two agree on, which is
           a research question rather than a working one. -->
      <div class="sc-strip">
        <div class="sc-strip-item">
          <span
            class="sc-lamp"
            :style="{
              background: `color-mix(in srgb, ${ACCENT} ${(lampBrightness * 100).toFixed(1)}%, var(--m-led-off))`,
              boxShadow: lampBrightness > 0.02
                ? `0 0 ${(4 + lampBrightness * 12).toFixed(1)}px color-mix(in srgb, ${ACCENT} ${(lampBrightness * 70).toFixed(0)}%, transparent)`
                : 'none',
            }"
          ></span>
          <span class="m-caption">Clip</span>
        </div>
        <span class="sc-strip-rule"></span>
        <!-- ⚠ FIXED WIDTH AND TABULAR FIGURES: these change every tenth of a
             second, and a proportional numeral re-flows the row on every digit. -->
        <div class="sc-strip-item">
          <span class="sc-num" style="font-variant-numeric:tabular-nums;min-width:30px;text-align:right">{{ peakOverText }}</span>
          <span class="m-caption"><span style="text-transform:none">dB</span> peak</span>
        </div>
        <span class="sc-strip-rule"></span>
        <div class="sc-strip-item">
          <span class="sc-num" style="font-variant-numeric:tabular-nums;min-width:34px;text-align:right" :style="{ color: ACCENT }">{{ engagedText }}</span>
          <span class="m-caption">Engaged</span>
        </div>
      </div>

      <!-- ── The instrument ───────────────────────────────────────────────
           THIS IS THE CONTROL SURFACE, not an illustration of one. The ceiling
           line is the primary control: drag it and the whole picture re-shades
           live. The knob below is the precise way to reach the same number. -->
      <div class="sc-well">
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
          :height="scopeHeight"
          title="Clipper scope: input envelope against the ceiling, playhead at the centre — played audio to its left, audio about to play to its right. Drag the line to set the ceiling."
        />
      </div>

      <!-- ── Level ladders ────────────────────────────────────────────────
           HORIZONTAL AND SIDE BY SIDE: IN and OUT are a comparison, and a
           comparison wants the two scales parallel and adjacent. -->
      <div class="sc-meters">
        <LevelMeter
          variant="modula" label="IN" orientation="horizontal"
          :levels="clipperInputLevels" :height="METER_LEN" :show-scale="false"
        />
        <LevelMeter
          variant="modula" label="OUT" orientation="horizontal"
          :levels="clipperOutputLevels" :height="METER_LEN" :show-scale="false"
        />
      </div>

      <!-- ── Control band ─────────────────────────────────────────────────
           The two knobs at its ends, the two decisions in the middle. The
           ceiling knob sits beside the setters that write it and the line
           that drags it, so the three controls for one number are adjacent. -->
      <div class="sc-band">
        <ModulaKnob
          variant="ticks" :size="126" show-value editable
          :model-value="fixedThresholdDb" :min="-24" :max="-1" :step="0.5"
          label="Ceiling" :color="ACCENT" :format-value="formatDb"
          :disabled="!clipperPreview" :title="ceilingTitle"
          @update:model-value="syncFixedThreshold"
        />

        <span class="sc-rule" aria-hidden="true"></span>

        <div class="sc-middle">
          <!-- ── The setters ─────────────────────────────────────────────
               ⚠ THESE DO NOT LATCH. Each lamp is DERIVED from the live
               ceiling, so it lights when the ceiling sits on that preset's
               value and goes out by itself the moment the knob or the line
               moves it — nothing remembered, nothing to go stale. -->
          <div class="sc-group">
            <span class="m-caption">Set ceiling</span>
            <div class="sc-setters">
              <ModulaChip
                v-for="p in ceilingSetters"
                :key="p.id"
                lamp
                :model-value="p.active"
                :label="p.label"
                :color="ACCENT"
                :title="ceilingDisabledReason ?? p.title"
                :disabled="!!ceilingDisabledReason || !p.ready"
                @click="setCeilingFromPreset(p.id)"
              />
            </div>
            <!-- ⚠ RESERVED HEIGHT, NOT A CONDITIONAL: an element that came and
                 went would jump the display every time the ceiling left a preset. -->
            <span class="m-note sc-note">{{ setterCaption }}</span>
          </div>

          <!-- ── Peak control ───────────────────────────────────────────── -->
          <div class="sc-group">
            <span class="m-caption">Peak control</span>
            <ModulaSegmented
              :model-value="limiterMode" :options="LIMITER_OPTIONS"
              aria-label="Peak control" :disabled="!clipperPreview"
              @update:model-value="setLimiterMode"
            />
            <span class="m-note sc-note">{{ limiterCaption }}</span>
          </div>
        </div>

        <span class="sc-rule" aria-hidden="true"></span>

        <!-- ── Output ───────────────────────────────────────────────────
             ⚠ THE TRAVEL IS 0..+24 AND UNIPOLAR: as makeup it must reach the
             +9 to +10 dB the ceiling presets ask for, and nothing in this
             stage raises the peak, so a negative makeup is travel AUTO could
             never reach. The knob stays draggable while AUTO is lit: touching
             it takes over and drops AUTO. -->
        <div class="sc-output">
          <div :style="{ opacity: autoMakeup ? 0.78 : 1 }">
            <ModulaKnob
              variant="ticks" :size="126" show-value editable
              :model-value="outputTrimDb"
              :min="SOFT_CLIPPER_MAKEUP_MIN_DB" :max="SOFT_CLIPPER_MAKEUP_MAX_DB" :step="0.1"
              label="Output" :color="ACCENT" :format-value="formatGain"
              :disabled="!clipperPreview"
              title="Makeup gain. AUTO hands back what the ceiling took off the peaks, so the output peak lands where the source's was."
              @update:model-value="syncOutputTrim"
            />
          </div>
          <ModulaLedPill
            size="sm" label="AUTO" :color="ACCENT"
            :model-value="autoMakeup" :disabled="!clipperPreview"
            :title="autoMakeup
              ? 'Auto makeup on. Click to take manual control.'
              : 'Auto makeup off. Click to hand the removed peak back as gain.'"
            @update:model-value="toggleAutoMakeup"
          />
        </div>
      </div>

      <!-- ⚠ HIDDEN ADMIN TUNING PANEL — see softClipperTuning.js. Off unless
           ?softClipperTuning=1 (or the localStorage key) is set. The amber
           badge is the same signal VoiceRx's baseline override uses: an
           override that is not visibly an override is how a measurement gets
           taken against the wrong build.

           Limiter, Knee and HF Emphasis are SHIPPED kernel behaviour whose
           knobs are hidden because they are research controls — turning one
           here changes only this session. -->
      <div v-if="tuningOn" class="sc-tuning">
        <div class="sc-tuning-head">
          <span>⚠ ADMIN TUNING — NOT SHIPPED</span>
          <!-- ⚠ RESIDUAL LIVES HERE, not on the faceplate: it separates two
               settings the lamp and ENGAGED agree on, a research reading. -->
          <span class="m-note">
            {{ clipperResidualDbc <= -120 ? '—' : clipperResidualDbc.toFixed(1) }} dBc RESIDUAL
          </span>
        </div>

        <div class="sc-tuning-row">
          <!-- THE HYBRID PEAK PATH: a lookahead limiter ahead of the curve. A
               BALANCE, not an amount — the ceiling still sets that. ⚠ Off the
               faceplate because it changes the stage's latency while engaged
               (50 samples -> 242). See LIMITER_MAX_ABOVE_DB. -->
          <div class="sc-group">
            <ModulaKnob
              variant="small" :size="44" show-value
              :model-value="limiter" :min="0" :max="100" :step="1"
              label="Limiter" :color="TUNING" :format-value="v => v.toFixed(0)"
              :disabled="!clipperPreview"
              @update:model-value="syncLimiter"
            />
            <span class="m-note">{{ limiterMode ? limiterMode.toUpperCase() : 'between modes' }}</span>
          </div>
          <!-- AIMING, not cleanliness: decides WHICH transients get worked on.
               The caption reads back the lift the compensation gives the
               threshold on THIS material. -->
          <div class="sc-group">
            <ModulaKnob
              variant="small" :size="44" show-value
              :model-value="emphasisDb" :min="0" :max="12" :step="0.5"
              label="HF Emph" :color="TUNING" :format-value="v => v.toFixed(1)"
              :disabled="!clipperPreview"
              @update:model-value="syncEmphasis"
            />
            <span class="m-note">aiming · lift {{ clipperLiftDb.toFixed(2) }} dB</span>
          </div>
          <!-- The knee. Depth-matched at the anchor, so this moves character
               and not amount. -->
          <div class="sc-group">
            <span class="m-caption">Knee</span>
            <ModulaSegmented
              :model-value="shape" :options="SHAPE_OPTIONS" :color="TUNING"
              aria-label="Knee" :disabled="!clipperPreview"
              @update:model-value="setShape"
            />
            <span class="m-note">{{ SHAPE_CAPTION[shape] }}</span>
          </div>
        </div>
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.sc-face {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sc-strip {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 18px;
  padding: 0 4px;
}
.sc-strip-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sc-strip-rule {
  width: 1px;
  height: 12px;
  background: rgba(0, 0, 0, .35);
  box-shadow: 1px 0 0 rgba(255, 255, 255, .05);
}
.sc-lamp {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, .6);
}
.sc-num {
  font: 700 12px/1 var(--m-font-mono);
  color: var(--m-ink);
}
.sc-well {
  padding: 3px;
  border-radius: 9px;
  background: #0b0e13;
  box-shadow: var(--m-shadow-well), 0 0 0 1px #1c222c;
}
.sc-meters {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 0 4px;
}
.sc-band {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 14px 20px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.sc-band > * { flex-shrink: 0; }
.sc-rule {
  align-self: stretch;
  width: 1px;
  background: rgba(0, 0, 0, .35);
  box-shadow: 1px 0 0 rgba(255, 255, 255, .04);
}
.sc-middle {
  flex: 1 0 auto;
  display: flex;
  align-items: flex-start;
  justify-content: space-evenly;
  gap: 28px;
}
.sc-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
}
.sc-setters {
  display: flex;
  gap: 8px;
}
.sc-note {
  min-height: 9px;
  font-variant-numeric: tabular-nums;
}
.sc-output {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.sc-tuning {
  padding-top: 12px;
  border-top: 1px dashed rgba(255, 176, 32, .35);
}
.sc-tuning-head {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-bottom: 10px;
  font: 700 8px var(--m-font-ui);
  letter-spacing: .08em;
  color: rgba(255, 176, 32, .9);
}
.sc-tuning-row {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  gap: 28px;
}
</style>
