<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useSoftClipper } from '../../composables/useSoftClipper.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { readTimelineEnvelope } from '../../audio/timelineEnvelope.js'
import { SCOPE_SECONDS } from '../../audio/effects/softClipper.js'
import Knob from '../knobs/Knob.vue'
import DeviceChoiceRocker from '../knobs/DeviceChoiceRocker.vue'
import DeviceTravelSlide from '../knobs/DeviceTravelSlide.vue'
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
  syncFixedThreshold,
  setShape, apply, teardown, closeModal,
  ceilingBusy, CEILING_PRESETS, scheduleCeilingPreset,
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
 * ⚠ THE FACEPLATE IS LIT SO THE WELLS READ AS RECESSED. It was
 * `#1a1613 -> #0d0a08`, which is darker than the control band's own
 * `rgba(0,0,0,.28)` wash and barely lighter than the display's `#07090b` — so
 * the two sunken areas, which are most of the panel, had almost no edge against
 * the surface they are sunk into. The layout reads as depth or it reads as
 * nothing, and it was reading as nothing.
 *
 * Warm, because the accent is, and still dark enough that the display is
 * plainly the brightest thing on the panel — which it should be, since it is
 * the instrument.
 */
const FACEPLATE = 'linear-gradient(155deg,#2b2320,#191310 62%)'

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

const peakOverText = computed(() =>
  (clipperReductionReadout.value < 0.05 ? '—' : clipperReductionReadout.value.toFixed(1)))
const engagedText = computed(() => `${clipperEngagedReadout.value.toFixed(0)}%`)



/**
 * Length of the horizontal IN/OUT ladders.
 *
 * 396 in the design, against its 1040 faceplate — a little under half the body
 * width, so the pair spans it with the two readouts between them. At 900 that
 * same proportion is 336; a fixed 396 would have the two meters and their
 * readouts filling the row edge to edge with nothing between them.
 *
 * The ladder rounds this down to whole segments internally (see LevelMeter's
 * `rows`), so a few pixels either way costs a segment at most.
 */
const METER_LEN = 336

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
    brand-lead="SOFT"
    brand-tail="CLIPPER"
    :background="FACEPLATE"
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
    <div style="padding:20px 26px 24px;display:flex;flex-direction:column;gap:16px">
      <!-- ── Readout strip ────────────────────────────────────────────────
           Right-aligned above the display: three readings about the stage, in
           the order they answer questions about it — is it clipping, how hard,
           how often.

           ⚠ RESIDUAL IS NOT HERE. It is on the tuning panel instead: it is the
           reading that separates two settings the other two agree on, which is
           a research question rather than a working one, and the design gives
           this strip three slots. -->
      <div style="display:flex;align-items:center;justify-content:flex-end;gap:20px;padding:0 4px">
        <div style="display:flex;align-items:center;gap:8px">
          <span
            style="width:15px;height:15px;border-radius:50%;border:1px solid rgba(255,255,255,.12)"
            :style="{
              background: `color-mix(in srgb, ${ACCENT} ${(lampBrightness * 100).toFixed(1)}%, #1a1512)`,
              boxShadow: lampBrightness > 0.02
                ? `0 0 ${(4 + lampBrightness * 12).toFixed(1)}px color-mix(in srgb, ${ACCENT} ${(lampBrightness * 70).toFixed(0)}%, transparent)`
                : 'none',
            }"
          ></span>
          <span style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.14em;color:rgba(255,255,255,.35)">CLIP LAMP</span>
        </div>
        <span style="width:1px;height:12px;background:rgba(255,255,255,.09)"></span>
        <!-- ⚠ FIXED WIDTH AND TABULAR FIGURES. These change every tenth of a
             second, and a proportional numeral set re-flows the row on every
             digit change — "3.2" and "0.4" are different widths, and so are
             "9%" and "100%". The label after them then slides, which reads as
             the whole strip twitching. Right-aligned inside the fixed box so
             the decimal point stays put as the integer digit comes and goes. -->
        <div style="display:flex;align-items:baseline;gap:7px">
          <span style="font:700 11px 'JetBrains Mono',monospace;color:rgba(255,255,255,.72);font-variant-numeric:tabular-nums;min-width:30px;text-align:right">{{ peakOverText }}</span>
          <span style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.14em;color:rgba(255,255,255,.35)">dB PEAK</span>
        </div>
        <span style="width:1px;height:12px;background:rgba(255,255,255,.09)"></span>
        <div style="display:flex;align-items:baseline;gap:7px">
          <span style="font:700 11px 'JetBrains Mono',monospace;color:#ffb094;font-variant-numeric:tabular-nums;min-width:34px;text-align:right">{{ engagedText }}</span>
          <span style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.14em;color:rgba(255,255,255,.35)">ENGAGED</span>
        </div>
      </div>

      <!-- ── The instrument ───────────────────────────────────────────────
           THIS IS THE CONTROL SURFACE, not an illustration of one. The ceiling
           line is the primary control: drag it and the whole picture re-shades
           live, because the shading is computed against the current threshold
           rather than the one each point was recorded under. The knob below is
           the precise way to reach the same number, not the primary way. -->
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

      <!-- ── Level ladders ────────────────────────────────────────────────
           HORIZONTAL AND SIDE BY SIDE, which is the design's reading of what
           these are for: IN and OUT are a comparison, and a comparison wants
           the two scales parallel and adjacent rather than at opposite edges of
           the faceplate with the display between them.

           Rotated rather than reimplemented — the ladder, its zones and its
           clip lamp are the same instrument every other plugin uses, and a
           second horizontal variant would be the same thing twice. -->
      <div style="display:flex;align-items:center;justify-content:space-between;gap:24px">
        <LevelMeter
          label="IN"
          orientation="horizontal"
          :levels="clipperInputLevels"
          :height="METER_LEN"
          :show-scale="false"
        />
        <LevelMeter
          label="OUT"
          orientation="horizontal"
          :levels="clipperOutputLevels"
          :height="METER_LEN"
          :show-scale="false"
        />
      </div>

      <!-- ── Control band ─────────────────────────────────────────────────
           One strip: the two knobs at its ends, the two decisions in the
           middle. The ceiling knob sits beside the setters that write it and
           the line that drags it, so the three controls for one number are
           finally adjacent and in reading order — press a setter, see the
           number, nudge it. -->
      <div style="display:flex;align-items:center;gap:18px;padding:16px 22px;border-radius:12px;background:rgba(0,0,0,.28);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)">
        <div style="width:92px;flex-shrink:0">
          <Knob
            :model-value="fixedThresholdDb"
            @update:model-value="syncFixedThreshold"
            :min="-24" :max="-1" :step="0.5"
            label="Ceiling" :accent="ACCENT" :format-value="formatDb"
            :value-font-px="15"
            :disabled="!clipperPreview"
            title="Where peaks stop, in dBFS. Set it from the buttons, by dragging the line, or here."
          />
        </div>

        <div style="width:1px;align-self:stretch;background:rgba(255,255,255,.07);flex-shrink:0"></div>

        <div style="flex:1;display:flex;align-items:flex-start;justify-content:space-evenly;gap:28px">
          <!-- ── The setters ─────────────────────────────────────────────
               ⚠ THESE DO NOT LATCH, AND THAT IS THE DESIGN'S POINT. A latching
               bank claims to own the value, which stops being true the moment
               the knob or the line is touched — the readout-that-goes-stale
               failure this panel has hit before. The line under the bank
               reports which preset the ceiling is CURRENTLY sitting on, derived
               live rather than remembered — so it goes out by itself the moment
               the knob or the line moves the value elsewhere. -->
          <div style="display:flex;flex-direction:column;align-items:center;gap:9px;flex-shrink:0">
            <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4);white-space:nowrap">SET CEILING</span>
            <div style="display:flex;align-items:stretch;gap:8px">
              <button
                v-for="p in ceilingSetters"
                :key="p.id"
                type="button"
                :title="ceilingDisabledReason ?? p.title"
                :disabled="!!ceilingDisabledReason || !p.ready"
                @click="setCeilingFromPreset(p.id)"
                class="cursor-pointer disabled:cursor-not-allowed"
                :style="[
                  {
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: '9px 14px', borderRadius: '10px',
                    transition: 'background-color .15s ease, border-color .15s ease',
                  },
                  p.active
                    ? {
                      background: `color-mix(in srgb, ${ACCENT} 20%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${ACCENT} 55%, transparent)`,
                    }
                    : { background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.08)' },
                  (!!ceilingDisabledReason || !p.ready)
                    ? { opacity: .3, filter: 'grayscale(1)' }
                    : { opacity: 1 },
                ]"
              >
                <span
                  style="font:700 9px 'JetBrains Mono',monospace;letter-spacing:.12em"
                  :style="{ color: p.active ? '#ffb094' : 'rgba(255,255,255,.75)' }"
                >{{ p.label }}</span>
              </button>
            </div>

            <!-- ⚠ RESERVED HEIGHT, NOT A CONDITIONAL. The line is empty
                 whenever the ceiling is not sitting on a preset, which is most
                 of the time — and an element that disappears would change the
                 band's height every time the ceiling was nudged off a preset
                 value, jumping the display above it. Always present, always one
                 line, sometimes blank. -->
            <span
              style="font:600 8.5px 'Inter',system-ui;letter-spacing:.08em;white-space:nowrap;color:rgba(255,255,255,.35);min-height:11px;font-variant-numeric:tabular-nums"
            >{{ setterCaption }}</span>
          </div>

          <!-- ── Peak control ───────────────────────────────────────────── -->
          <div style="display:flex;flex-direction:column;align-items:center;gap:9px;flex-shrink:0">
            <span style="font:600 9px 'Inter',system-ui;letter-spacing:.14em;color:rgba(255,255,255,.4);white-space:nowrap">PEAK CONTROL</span>
            <DeviceChoiceRocker
              :model-value="limiterMode"
              @update:model-value="setLimiterMode"
              :options="LIMITER_MODES.map(m => ({ value: m.id, label: m.label, title: m.title }))"
              :accent="ACCENT"
              :caption="limiterCaption"
              :disabled="!clipperPreview"
              label="Peak control"
            />
          </div>
        </div>

        <div style="width:1px;align-self:stretch;background:rgba(255,255,255,.07);flex-shrink:0"></div>

        <div style="width:92px;flex-shrink:0">
          <Knob
            :model-value="outputTrimDb"
            @update:model-value="syncOutputTrim"
            :min="-6" :max="6" :step="0.1"
            label="Trim" :accent="ACCENT" :format-value="formatGain"
            :value-font-px="15"
            :disabled="!clipperPreview" bipolar
            title="Post-stage gain match, for an honest A/B."
          />
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
          <!-- ⚠ RESIDUAL LIVES HERE NOW, not on the faceplate. It is the
               reading that separates two settings the lamp and ENGAGED agree
               on — measured, peak reduction can move 0.1 dB across a knob
               while the residual moves 2.5 — which makes it a research
               instrument rather than a working one. The design gives the
               readout strip three slots; this is the one that came off. -->
          <span style="font:600 8px ui-monospace,monospace;color:rgba(255,255,255,.45)">
            {{ clipperResidualDbc <= -120 ? '—' : clipperResidualDbc.toFixed(1) }} dBc RESIDUAL
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
              {{ limiterMode ? limiterMode.toUpperCase() : 'between modes' }}
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
          <DeviceTravelSlide
            :model-value="shape"
            @update:model-value="setShape"
            :options="SHAPE_OPTIONS"
            accent="#ffb020"
            :disabled="!clipperPreview"
            :width="120"
            label="Knee"
          />
          <span style="font:600 7.5px 'Inter',system-ui;color:rgba(255,255,255,.28)">
            {{ SHAPE_CAPTION[shape] }}
          </span>
        </div>

      </div>
    </div>
  </FloatingWindow>
</template>
