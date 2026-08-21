<script setup>
import { computed, ref, onBeforeUnmount } from 'vue'
import EqPlot from './EqPlot.vue'
import Knob from '../../knobs/Knob.vue'
import {
  bandForRole, bandwidthOctaves, qRangeFor, quantizeQ,
} from '../../../audio/eqBands.js'
import { REGION_SPAN_HZ } from '../../../audio/voicerx/regions.js'

/**
 * VoiceRx — the voice-specific corrective view.
 *
 * The picture is the tonal shape of the voice with the problems marked on it,
 * and the findings list in the faceplate says what each mark means in words.
 * The two are linked by hover, so neither has to be read alone.
 *
 * If the name promises a diagnosis, the tool has to deliver one. A plugin
 * called VoiceRx that only handed over labelled knobs would be a broken promise,
 * which is why the findings list, not the knobs, is the top of this panel — and
 * why the corrections are applied on arrival rather than offered for approval.
 *
 * There are two capabilities here: being told what is wrong, and being able to
 * reach for a characteristic — nasal, boxy, muddy — without knowing what
 * frequency it lives at. The panel opens on the first, alone, because it is the
 * one a newcomer can act on with none of the vocabulary, and because meeting
 * nine knobs and a plot at the same moment asks them to understand the panel
 * before any of it means anything.
 *
 * That opening is a door and not a toll gate, which is the whole distinction.
 * It can be skipped in one click; the compact ANALYZE strip is waiting on the
 * other side; and once past it — by skipping or by analysing — it never
 * returns. Nothing about the second capability depends on having used the
 * first: the plot and the palette live outside the intro branch, not inside it.
 */

const props = defineProps({
  eq: { type: Object, required: true },
  accent: { type: String, required: true },
  sampleRate: { type: Number, default: 44100 },
  /**
   * Region of the findings row under the pointer, if any.
   *
   * Comes in only to light that region's detection marker — the drawing of the
   * measurement the row's sentence is about. It is not merged with this
   * component's own hover, and that separation is the point: see hoveredRegion.
   */
  markedRegion: { type: String, default: null },
  /**
   * Height of the plot, in pixels. Forwarded straight to EqPlot — the
   * faceplate is what makes this a fixed 200 by default and a bigger number
   * once FloatingWindow's corner grip has been dragged; this view has no
   * opinion of its own about it. The role columns underneath sit at their own
   * fixed height (COLUMN_H) regardless, so only the picture itself grows.
   */
  plotHeight: { type: Number, default: 200 },
})

const emit = defineEmits(['update:hoveredRegion'])

/**
 * Region under the pointer *in here* — a role's controls, its axis label, or its
 * dot on the plot.
 *
 * TWO CHANNELS, NOT ONE. Kept strictly apart from the incoming markedRegion:
 * each gesture answers with the object it is actually about. Pointing at a
 * control lights live state — the dot it moves, its ribbon span, its name.
 * Pointing at a findings row lights the measurement — its marker, via
 * markedRegion. Nothing lights both, so neither can be mistaken for the other.
 *
 * Merging them is not an option even in principle: the faceplate echoes this
 * component's emit straight back in as markedRegion, so a merged signal would
 * lose all record of where a hover came from.
 */
const hoveredRegion = ref(null)

function setHoveredRegion(region) {
  hoveredRegion.value = region
  emit('update:hoveredRegion', region)
}

/**
 * How far a role knob travels.
 *
 * Narrower than the band model's ±18: these are corrections to a voice, not
 * tone-shaping moves, and a range that reaches further than anything sensible
 * makes every useful setting live in the middle third of the sweep.
 */
const GAIN_LIMIT_DB = 12

const analysis = computed(() => (props.eq.hasAnalysis.value ? props.eq.analysis.value : null))

/** Handles are shown for role bands only; general bands have no VoiceRx control. */
const roleHandleIds = computed(() =>
  props.eq.bands.value.filter(b => b.role !== null).map(b => b.id))

const errorMessage = computed(() => {
  switch (props.eq.analysisError.value) {
    case 'no_voiced_frames':
      return 'No speech found here. VoiceRx reads voices — for other material, the EQ plugin has the full set of controls.'
    case 'insufficient_voiced':
      return 'This selection is too short, or has too little speech, to analyse. Try a longer stretch, or use the EQ plugin.'
    case 'failed':
      return 'Analysis failed. Try again, or use the EQ plugin.'
    default:
      return null
  }
})

// Solo latches, the way the EQ's per-band S button does. It replaced a
// press-and-hold "hear it": holding gave a cleaner A/B in principle, but it
// could not be combined with turning a knob, and two different ways to listen
// to one band across two plugins was one too many.
onBeforeUnmount(() => props.eq.clearSolo())

function gainFor(roleId) {
  return props.eq.roleGain(roleId)
}

/**
 * How brightly a role's knob is painted.
 *
 * Contrast, not availability. Nine knob bodies at equal brightness is a busy
 * surface with no answer to "which of these is doing anything", and the
 * temptation is to grey the idle ones out — but they are not disabled. Turning
 * a knob that sits at zero with no band is precisely how that band comes into
 * existence, so painting it as unavailable would deny the one gesture that
 * works, and would put most of the vocabulary behind a state again.
 *
 * So idle roles are quiet and live, and a switched-off one is quieter still,
 * because suppressing something is a stronger statement than never having
 * touched it.
 */
function roleBrightness(roleId) {
  switch (props.eq.roleOnState(roleId)) {
    case 'on': return 1
    case 'off': return 0.32
    default: return 0.5
  }
}

function fmtGain(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

function roleBand(roleId) {
  return bandForRole(props.eq.bands.value, roleId)
}

/**
 * Can this role be auditioned?
 *
 * A role with no band can: "what does this word even sound like" is asked
 * before anything has been turned up, and useVoiceRx.toggleRoleSolo answers it
 * with a probe at the role's own centre and width. Gating that on a band would
 * have shut off the one case the probe exists for.
 *
 * A band that is switched off or sitting at 0 dB cannot, because there is
 * nothing being done to hear alone — the ON button beside it is the way back.
 */
function canSolo(roleId) {
  const state = props.eq.roleOnState(roleId)
  return state === 'on' || state === 'absent'
}

/**
 * The column's tooltip: how to work this control.
 *
 * What the role *means* is not in here — that goes on the shared caption line,
 * where it is readable without hovering and cannot be missed by anyone who
 * never discovers that these have tooltips. The buttons and the width knob
 * carry their own titles, which override this one where they sit.
 */
function roleTitle(r) {
  return props.eq.roleOnState(r.id) === 'off'
    ? `${r.label} is switched off — move the knob to switch it back on.`
    : `${r.label} — drag to adjust, double-click to reset it to flat and its `
      + 'default width.'
}

function soloTitle(r) {
  if (!canSolo(r.id)) return `Switch ${r.label} on to solo it`
  return roleBand(r.id)
    ? `Hear the ${r.label} correction alone`
    : `Hear the part of the recording ${r.label} acts on`
}

/**
 * Back to the role's canonical Q, leaving its gain where it is.
 *
 * Named for the parameter rather than for the control, because the same reset
 * serves both names that parameter goes under — a bell's width and a shelf's
 * slope.
 */
function resetRoleQ(roleId) {
  const band = roleBand(roleId)
  if (band) props.eq.resetQ(band.id)
}

/**
 * Why the result on screen no longer describes what is selected.
 *
 * A cleared selection is stale too — selectionKey() has nothing to match — and
 * it needs its own wording, because the fix is to select something rather than
 * to press RE-ANALYZE at a selection that is not there.
 */
const staleMessage = computed(() => (props.eq.hasSelection.value
  ? 'The selection has changed — this is the earlier measurement. The corrections '
    + 'below are still running; RE-ANALYZE to measure what is selected now.'
  : 'Nothing is selected — this is the earlier measurement. The corrections below '
    + 'are still running; select some audio and RE-ANALYZE to measure it.'))

/**
 * The plain-language read-out for every role that is doing something.
 *
 * One line for the whole palette rather than one per control: a knob is too
 * narrow to sit a sentence under, and most of them say nothing at rest anyway.
 *
 * Keyed on roleOnState rather than on the gain, so a correction that has been
 * switched off drops out of the sentence. Reading "less mud" off a band nobody
 * can hear is the same mismatch isBandActive exists to prevent elsewhere.
 */
const activeSummary = computed(() => props.eq.paletteRoles
  .filter(r => props.eq.roleOnState(r.id) === 'on')
  .map(r => r.describe(gainFor(r.id)))
  .join(' · '))

/** The role under the pointer, if any. */
const previewedRole = ref(null)

/**
 * Glancing at a role lights its span on the plot's ribbon.
 *
 * This is the half of the mapping that makes the ribbon worth drawing: the
 * palette says what the characteristic is, the ribbon says where in the voice
 * it lives, and pointing at either one answers for both. Nobody has to be told
 * that Nasality means 650-1200 Hz, and nobody has to know it either.
 */
function previewRole(role) {
  previewedRole.value = role
  setHoveredRegion(role?.region ?? null)
}

/**
 * The dot to emphasise on the plot, from whichever role is under the pointer.
 *
 * This is the general EQ's own gesture, which VoiceRx did not have: over there a
 * band's strip and its dot are the same object seen twice, and pointing at
 * either one enlarges the dot (see hoveredId in GeneralView). It is the cheapest
 * available lesson in what the dots are, and it was missing here precisely where
 * the connection is least obvious — the column is under an axis label, not
 * beside the curve.
 *
 * Keyed on the hovered region rather than on previewedRole, because the region
 * is the channel every source already writes to: a column, an axis label, a dot
 * on the plot, and a findings row in the faceplate — which arrives as a prop and
 * never touches previewedRole at all. One derivation off the shared signal means
 * all four light the same dot without four call sites agreeing to.
 *
 * Null for a role with no band, which is honest — there is no dot to point at.
 */
const hoveredBandId = computed(() => {
  const region = hoveredRegion.value
  if (!region) return null
  const role = props.eq.paletteRoles.find(r => r.region === region)
  return role ? roleBand(role.id)?.id ?? null : null
})

/**
 * One line, two jobs.
 *
 * At rest it reports what the corrections are doing; while a control is under
 * the pointer it defines that control instead. A palette whose whole promise is
 * that you can reach for a characteristic without knowing its frequency has to
 * say what the characteristic *is*, and nine sentences printed at once is not a
 * palette, it is a glossary. Sharing the line keeps the height fixed either way,
 * so nothing below it moves as the pointer crosses the row.
 */
const paletteCaption = computed(() => {
  // Hovering wins over the open role, because the pointer is the more recent
  // question. Nothing hovered falls back to whatever is open, so opening a role
  // leaves its definition on screen rather than only flashing it past.
  const role = previewedRole.value ?? focusedRole.value
  if (!role) return activeSummary.value

  // Definition plus reach: what the characteristic is, and where in the voice
  // this control acts, both in terms that need no frequency vocabulary.
  return `${role.label} — ${role.description} ~ ${roleReach(role)}`
})

/**
 * The opening offer to analyse, shown alone.
 *
 * Gone once there is a result or the user has stepped past it. The panel behind
 * it is unchanged — the compact ANALYZE strip is still there, so skipping is
 * skipping the introduction rather than giving up the diagnosis.
 */
const showIntro = computed(() => !analysis.value && !props.eq.introDismissed.value)

/** Hovering an axis label reads exactly as hovering that role's knob. */
function previewRegion(regionName) {
  previewRole(regionName
    ? props.eq.paletteRoles.find(r => r.region === regionName) ?? null
    : null)
}

// ── Handles on the plot ─────────────────────────────────────────────────────

/**
 * Dragging a dot moves the correction within its role, and nowhere else.
 *
 * The gain half of the drag is the same edit the role knob makes; the frequency
 * half is the one thing the palette cannot express, because a knob per role has
 * no second axis. The band cannot leave its range — the pool is on the clamping
 * policy — so a drag can nudge where Mud sits inside 200-420 Hz but can never
 * turn Mud into something with no control.
 *
 * Gain is held to the palette's own limit rather than the band model's wider
 * one: the two controls edit the same number, and a drag that took it past
 * where the knob can follow would leave the knob pinned and wrong.
 */
function onMoveBand({ id, frequencyHz, gainDb }) {
  props.eq.setFrequency(id, frequencyHz)
  props.eq.setGain(id, Math.max(-GAIN_LIMIT_DB, Math.min(GAIN_LIMIT_DB, gainDb)))
}

/**
 * A press on empty plot puts that role there, and goes on to drag it.
 *
 * `adopt` hands the band's id back to the plot synchronously, so the same press
 * carries straight into dragging what it just placed. A role that already has a
 * band gets it moved rather than doubled — see setRoleAt.
 */
function onCreateBand({ frequencyHz, gainDb, adopt }) {
  const gain = Math.max(-GAIN_LIMIT_DB, Math.min(GAIN_LIMIT_DB, gainDb))
  adopt?.(props.eq.setRoleAt(frequencyHz, gain))
}

/**
 * Scrolling the mouse wheel over a dot moves its Q — the third dimension a drag
 * cannot reach. Narrows or widens a bell; steepens or softens a shelf's knee.
 * Either way it is a shortcut to the knob in the role's column, not a control
 * that exists only here.
 */
function onQBand({ id, delta }) {
  const band = props.eq.findBand(id)
  if (!band) return
  // Multiplicative, so the step feels the same at Q 0.5 and Q 8.
  props.eq.setQ(id, band.q * (delta > 0 ? 1.15 : 1 / 1.15))
}

/** Touching a dot focuses its role, so the strip follows the plot. */
function onSelectBand(id) {
  const band = props.eq.findBand(id)
  if (band?.role) focusedRoleId.value = band.role
}

/**
 * Hovering a dot lights its region on the ribbon and its row in the findings.
 *
 * The link ran one way — a findings row lit the plot, never the reverse — so
 * the picture could not be used to ask what something was.
 */
function onHoverBand(id) {
  const band = id ? props.eq.findBand(id) : null
  const role = band?.role ? props.eq.paletteRoles.find(r => r.id === band.role) : null
  // Through previewRole rather than straight to hoveredRegion, so a dot under
  // the pointer answers with everything a column does: the ribbon segment, the
  // axis label, the caption line's definition, and the dot's own emphasis.
  previewRole(role)
}

// ── The focused role ────────────────────────────────────────────────────────

/**
 * The role the panel is currently talking about.
 *
 * Two levels, not two competing ideas of "current": hovering an axis label
 * glances at a role and updates the caption line for as long as the pointer is
 * there; pressing it commits, so the definition stays on screen and the label
 * and its ribbon segment hold the accent while the knobs are being turned.
 *
 * It does not gate anything. Every column is on screen at all times (see
 * COLUMN_H) — this only says which one is being attended to, which is why
 * nothing breaks when it is null.
 */
const focusedRoleId = ref(null)

const focusedRole = computed(() =>
  props.eq.paletteRoles.find(r => r.id === focusedRoleId.value) ?? null)

/** Pressing the open role's own axis label closes it again. */
function toggleRoleById(roleId) {
  focusedRoleId.value = focusedRoleId.value === roleId ? null : roleId
}

// ── The role columns, hung under their axis labels ───────────────────────────

/**
 * How wide a role's column of controls is.
 *
 * Set by the axis, not by taste. The region centres are 58 px apart at their
 * tightest — Body at 142 px and Mud at 200 px on the 708 px plot — so a column
 * centred on each label has 58 px to live in before its neighbour is touched,
 * and the pair is a common one to have open at once (a dip and a hump, adjacent,
 * both routinely flagged). 48 leaves a 10 px gutter there, and clears both ends:
 * Rumble sits 49 px from the left edge and Air 37 px from the right.
 */
const COLUMN_W = 48

/**
 * Height of the row of columns. Fixed, and always occupied.
 *
 * EVERY COLUMN IS ALWAYS SHOWN. They were revealed a role at a time by pressing
 * its axis label, which read as tidy and played as a dead end: the panel a user
 * arrives at by pressing "skip — go straight to the controls" had nine names on
 * an axis and nothing underneath them, so the link's promise was answered with
 * an empty surface and a gesture nobody had been told about. The palette is not
 * a disclosure — it is the half of this plugin that works without a diagnosis,
 * and hiding it behind a click it does not advertise is the same mistake as
 * putting it behind ANALYZE, one step further in.
 *
 * So the axis label is not a reveal. It focuses a role, which tints the label,
 * lights its ribbon segment and holds its definition on the caption line.
 *
 * Tall enough for the tallest column — S/ON, gain, its label, width, its label,
 * and the knob's own drop shadow under that — so a role gaining or losing its
 * width knob never moves the panel underneath.
 *
 * THE COLUMN'S VERTICAL RHYTHM. Two gaps only, and the small one has to be
 * clearly smaller or the labels stop belonging to anything:
 *
 *   3 px   a label to the knob it names, directly above it
 *   10-13  one group to the next, and the S/ON row to the knobs
 *
 * It used to run 5 px above each label and 7 px below it, which put GAIN almost
 * exactly between two knobs — near enough to equidistant that it read as the
 * caption for the wrong one. The ratio matters more than either number.
 */
const COLUMN_H = 156

/**
 * Which of the two names this role's Q knob goes under.
 *
 * A shelf reaches to the end of the spectrum, so only a bell has a width; on a
 * shelf the same parameter is the slope of the knee. See the Q knob in the
 * template.
 */
function isShelfRole(role) {
  return role.type === 'lowshelf' || role.type === 'highshelf'
}

function fmtHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`
}

/**
 * What a role reaches, in hertz.
 *
 * The honest answer to "how wide is this" — a span in the user's own recording
 * rather than a Q, which is a fact about a filter and means nothing to anyone
 * who did not come here already knowing it.
 */
function roleReach(role) {
  const centre = props.eq.roleCentreHz(role.id)
  if (role.type === 'lowshelf') return `everything below ${fmtHz(centre)}`
  if (role.type === 'highshelf') return `everything above ${fmtHz(centre)}`
  const bw = bandwidthOctaves(props.eq.roleQ(role.id))
  return `${fmtHz(centre * 2 ** (-bw / 2))} to ${fmtHz(centre * 2 ** (bw / 2))}`
}

/** Display width as the underlying Q value. */
function fmtWidth(q) {
  return q.toFixed(2).replace(/\.?0+$/, '')
}
</script>

<template>
  <div>
    <!--
      The introduction: one thing to read and one thing to press.

      VoiceRx opens on the diagnosis alone because that is what a first-time
      user can act on with none of the vocabulary — press once, hear the voice
      fixed, then read what was wrong in the findings.

      Skipping goes straight to the controls, where the compact ANALYZE strip is
      waiting, so nothing is behind this that cannot be reached without it. Once
      past it the panel never comes back to it.
    -->
    <div
      v-if="showIntro"
      class="rounded-[3px] flex flex-col items-center justify-center gap-[12px] px-[24px] py-[22px]"
      :style="{ minHeight: `${plotHeight}px`, background: 'rgba(0,0,0,.28)' }"
    >
      <p
        v-if="errorMessage"
        class="text-center max-w-[420px]"
        style="font:500 11px/1.6 'Inter';color:rgba(255,190,120,.75)"
      >{{ errorMessage }}</p>
      <p
        v-else
        class="text-center max-w-[420px]"
        style="font:500 11px/1.6 'Inter';color:rgba(255,255,255,.45)"
      >
        VoiceRx analyzes your voice and recommends subtle EQ adjustments to fix trouble spots.
      </p>

      <button
        type="button"
        class="flex items-center gap-[8px] px-[22px] py-[9px] rounded-[3px] transition-opacity"
        :style="{
          background: accent,
          color: '#0a1410',
          font: '700 11px/1 Inter',
          letterSpacing: '.08em',
          opacity: eq.analyzing.value || !eq.hasSelection.value ? 0.55 : 1,
        }"
        :disabled="eq.analyzing.value || !eq.hasSelection.value"
        @click="eq.analyze()"
      >
        <span v-if="eq.analyzing.value" class="vd-spin" style="--spin-color:#0a1410" aria-hidden="true" />
        {{ eq.analyzing.value ? 'ANALYSING…' : 'ANALYZE' }}
      </button>

      <p
        v-if="eq.analyzing.value"
        style="font:500 9px/1 'Inter';color:rgba(255,255,255,.35)"
      >Reading the whole selection — a long one takes a few seconds.</p>
      <p
        v-else-if="!eq.hasSelection.value"
        style="font:500 9px/1 'Inter';color:rgba(255,255,255,.3)"
      >Make a selection first.</p>

      <!-- Quiet on purpose. It is the right door for anyone who already knows
           the tool and the wrong one for anyone who does not, so it should be
           findable without competing with the thing worth pressing first. -->
      <button
        v-if="!eq.analyzing.value"
        type="button"
        class="underline underline-offset-2 transition-colors"
        style="font:500 9px/1 'Inter';color:rgba(255,255,255,.3)"
        @click="eq.dismissIntro()"
      >Skip — go straight to the controls</button>
    </div>

    <template v-else>

    <!-- What the picture is. Without this the plot is unlabelled shapes and a
         reader has no way in.

         Only the marks that are actually on the plot: before an analysis there
         is no envelope and there are no findings, and naming them would send
         the reader looking for something that is not there. -->
    <div class="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] mb-[6px]">
      <template v-if="analysis">
        <span class="flex items-center gap-[6px]" style="font:500 9px/1 'Inter';color:rgba(255,255,255,.42)">
          <svg width="16" height="8" aria-hidden="true"><path d="M0 6 Q4 1 8 4 T16 2" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="1.5"/></svg>
          your voice
        </span>
        <span class="flex items-center gap-[6px]" style="font:500 9px/1 'Inter';color:rgba(255,255,255,.42)">
          <svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="3.5" fill="rgba(255,180,120,.9)"/></svg>
          area to fix
        </span>
      </template>
      <span class="flex items-center gap-[6px]" style="font:500 9px/1 'Inter';color:rgba(255,255,255,.42)">
        <svg width="16" height="8" aria-hidden="true"><path d="M0 4 Q8 8 16 2" fill="none" :stroke="accent" stroke-width="2"/></svg>
        your changes
      </span>
    </div>

    <!-- Above the picture, not below it: this is the caption that says what
         the picture is of, and a reader who meets it afterwards has already
         read the plot as a description of the current selection. The findings
         stay live while stale — they describe corrections that are still in
         the chain and still audible, so they remain switchable. -->
    <p
      v-if="eq.isStale.value"
      class="mb-[6px]"
      style="font:500 9px/1.4 'Inter';color:rgba(255,190,120,.7)"
    >{{ staleMessage }}</p>

    <div
      class="transition-opacity"
      :style="{ opacity: eq.isStale.value ? 0.55 : 1 }"
    >
      <EqPlot
        :bands="eq.bands.value"
        :sample-rate="sampleRate"
        :accent="accent"
        :height="plotHeight"
        :handle-ids="roleHandleIds"
        :selected-id="hoveredBandId"
        :solo-id="eq.soloBandId.value"
        :solo-probe="eq.soloProbe.value"
        :min-hz="REGION_SPAN_HZ[0]"
        :max-hz="REGION_SPAN_HZ[1]"
        @create-band="onCreateBand"
        @remove-band="eq.removeBand"
        :analysis="analysis"
        :highlight-region="hoveredRegion"
        :mark-region="markedRegion"
        :region-ribbon="eq.regions.value"
        @move-band="onMoveBand"
        @q-band="onQBand"
        @select-band="onSelectBand"
        @hover-band="onHoverBand"
        @hover-region="previewRegion"
        :open-role="focusedRoleId"
        @select-role="toggleRoleById"
      >
        <!--
          Every role's controls, directly under the name on the axis that
          opens them.

          Position comes from the plot, which owns the axis mapping (see the
          role-controls slot in EqPlot). The row keeps a fixed height while
          anything is open so that opening or closing one column does not shift
          what is under it.
        -->
        <template #role-controls="{ roles }">
          <div
            class="relative w-full"
            :style="{ height: `${COLUMN_H}px` }"
          >
            <div
              v-for="r in roles"
              :key="r.id"
              class="absolute top-[4px] flex flex-col items-center cursor-pointer"
              :style="{
                left: `${r.leftPct}%`,
                width: `${COLUMN_W}px`,
                transform: 'translateX(-50%)',
              }"
              :title="roleTitle(r)"
              @pointerenter="previewRole(r.role)"
              @pointerleave="previewRole(null)"
              @focusin="previewRole(r.role)"
              @focusout="previewRole(null)"
              @click="focusedRoleId = r.id"
              @dblclick="eq.resetRole(r.id)"
            >
              <!-- S and ON, in the general EQ's own shapes and words. Two
                   plugins that both hold a pool of bands should not each invent
                   their own vocabulary for switching one off and hearing it
                   alone. -->
              <div class="flex items-center gap-[3px] mb-[10px]">
                <button
                  type="button"
                  class="px-[4px] py-[2px] rounded-[2px] transition-colors"
                  style="font:600 8px/1 'Inter';border:1px solid rgba(255,255,255,.12)"
                  :style="{
                    color: eq.isRoleSoloed(r.id) ? accent : 'rgba(255,255,255,.35)',
                    background: eq.isRoleSoloed(r.id)
                      ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'transparent',
                    opacity: canSolo(r.id) ? 1 : 0.4,
                  }"
                  :disabled="!canSolo(r.id)"
                  :title="soloTitle(r)"
                  @click.stop="eq.toggleRoleSolo(r.id)"
                  @dblclick.stop
                >S</button>
                <button
                  type="button"
                  class="px-[4px] py-[2px] rounded-[2px] transition-colors"
                  style="font:600 8px/1 'Inter';border:1px solid rgba(255,255,255,.12)"
                  :style="{
                    color: eq.roleOnState(r.id) === 'on' ? accent : 'rgba(255,255,255,.35)',
                    background: eq.roleOnState(r.id) === 'on'
                      ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'transparent',
                    opacity: eq.roleOnState(r.id) === 'on'
                      || eq.roleOnState(r.id) === 'off' ? 1 : 0.4,
                  }"
                  :disabled="eq.roleOnState(r.id) === 'absent'
                    || eq.roleOnState(r.id) === 'flat'"
                  :title="{
                    on: `Switch the ${r.label} correction off`,
                    off: `Switch the ${r.label} correction back on`,
                    flat: `${r.label} is at zero — turn the knob to switch it on`,
                    absent: `${r.label} is doing nothing yet — turn the knob to start`,
                  }[eq.roleOnState(r.id)]"
                  @click.stop="eq.toggleRoleEnabled(r.id)"
                  @dblclick.stop
                >{{ eq.roleOnState(r.id) === 'on' ? 'ON' : 'OFF' }}</button>
              </div>

              <div
                class="relative w-[50px] transition-opacity"
                :style="{ opacity: roleBrightness(r.id) }"
              >
                <Knob
                  :model-value="gainFor(r.id)"
                  :min="-GAIN_LIMIT_DB" :max="GAIN_LIMIT_DB" :step="0.1"
                  label=""
                  bipolar
                  :accent="accent"
                  :value-font-px="11"
                  :format-value="fmtGain"
                  @update:model-value="eq.setRoleGain(r.id, $event)"
                />
              </div>
              <span
                class="uppercase mt-[3px]"
                style="font:600 8px/1 'Inter';letter-spacing:.1em;color:rgba(255,255,255,.4)"
              >Gain</span>

              <!--
                Width for a bell, slope for a shelf: one Q, under whichever name
                describes what it does to that shape.

                Rumble and Air reach to the end of the spectrum, so their Q
                cannot widen anything — it sets how steeply the shelf climbs
                through its corner frequency, and past about 1.4 it starts to
                overshoot into an audible bump or dip at the corner rather than
                just steepening. What a shelf acts on is still the caption
                line's answer, since slope does not change it.

                Only rendered while the role is on, so the knob always has a
                band behind it to move. Double-click resets it alone — stopped
                here so it does not reach the column, where the same gesture
                resets the whole role.
              -->
              <template v-if="eq.roleOnState(r.id) === 'on'">
                <div
                  class="w-[40px] mt-[13px]"
                  :title="isShelfRole(r.role)
                    ? `Slope — drag to steepen or soften the ${r.label} knee. `
                      + `Past 1.4 it may add resonance at the corner.`
                    : `Width — drag to narrow or widen`"
                  @dblclick.stop="resetRoleQ(r.id)"
                >
                  <Knob
                    :model-value="eq.roleQ(r.id)"
                    :min="qRangeFor(r.role.type)[0]"
                    :max="qRangeFor(r.role.type)[1]"
                    scale="log"
                    :quantize="quantizeQ"
                    label=""
                    :accent="accent"
                    :value-font-px="9"
                    :format-value="fmtWidth"
                    @update:model-value="eq.setRoleQ(r.id, $event)"
                  />
                </div>
                <span
                  class="uppercase mt-[3px]"
                  style="font:600 8px/1 'Inter';letter-spacing:.1em;color:rgba(255,255,255,.4)"
                >{{ isShelfRole(r.role) ? 'Slope' : 'Width' }}</span>
              </template>
            </div>
          </div>
        </template>
      </EqPlot>

      <!-- Fixed height: this line swaps between the running summary and the
           definition of whichever control is under the pointer, and nothing
           below it should move as that happens. -->
      <p
        class="mt-[10px] mb-[9px] text-center"
        style="font:500 9px/1.4 'Inter';color:rgba(255,255,255,.32);min-height:13px"
      >{{ paletteCaption }}</p>
    </div>

    <div
      v-if="!analysis"
      class="mt-[14px] flex items-center gap-[16px] rounded-[3px] px-[14px] py-[12px]"
      style="background:rgba(0,0,0,.28)"
    >
      <div class="flex-1 min-w-0">
        <p
          v-if="errorMessage"
          style="font:500 11px/1.5 'Inter';color:rgba(255,190,120,.75)"
        >{{ errorMessage }}</p>
        <p
          v-else
          style="font:500 11px/1.5 'Inter';color:rgba(255,255,255,.45)"
        >
          VoiceRx can listen to your selection and correct what it finds —
          what is muddy, boxy, harsh or dull, and by how much.
        </p>
        <p
          v-if="eq.analyzing.value"
          class="mt-[5px]"
          style="font:500 9px/1 'Inter';color:rgba(255,255,255,.35)"
        >Reading the whole selection — a long one takes a few seconds.</p>
        <p
          v-else-if="!eq.hasSelection.value"
          class="mt-[5px]"
          style="font:500 9px/1 'Inter';color:rgba(255,255,255,.3)"
        >Make a selection first.</p>
      </div>

      <button
        type="button"
        class="shrink-0 flex items-center gap-[8px] px-[20px] py-[8px] rounded-[3px] transition-opacity"
        :style="{
          background: accent,
          color: '#0a1410',
          font: '700 11px/1 Inter',
          letterSpacing: '.08em',
          opacity: eq.analyzing.value || !eq.hasSelection.value ? 0.55 : 1,
        }"
        :disabled="eq.analyzing.value || !eq.hasSelection.value"
        @click="eq.analyze()"
      >
        <span v-if="eq.analyzing.value" class="vd-spin" style="--spin-color:#0a1410" aria-hidden="true" />
        {{ eq.analyzing.value ? 'ANALYSING…' : 'ANALYZE' }}
      </button>
    </div>

    </template>
  </div>
</template>

<style scoped>
/*
 * The analysis blocks the main thread while it runs, so the busy indicator has
 * to be something the compositor can animate on its own. A transform keyframe
 * qualifies; anything driven by JS or by a layout-affecting property would sit
 * frozen for exactly the seconds it is meant to cover.
 */
.vd-spin {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  border: 1.5px solid color-mix(in srgb, var(--spin-color, rgba(255, 255, 255, 0.55)) 25%, transparent);
  border-top-color: var(--spin-color, rgba(255, 255, 255, 0.55));
  animation: vd-spin 0.7s linear infinite;
  will-change: transform;
}

@keyframes vd-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .vd-spin { animation-duration: 2.4s; }
}
</style>
