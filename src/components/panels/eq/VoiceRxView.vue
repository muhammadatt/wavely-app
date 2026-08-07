<script setup>
import { computed, ref, onBeforeUnmount } from 'vue'
import EqPlot from './EqPlot.vue'
import Knob from '../../knobs/Knob.vue'
import {
  bandForRole, isBandActive, bandwidthOctaves, qRangeFor,
} from '../../../audio/eqBands.js'
import { REGION_SPAN_HZ } from '../../../audio/voicerx/regions.js'

/**
 * VoiceRx — the voice-specific corrective view.
 *
 * The picture is the tonal shape of the voice with the problems marked on it,
 * and the list underneath says what each mark means in words. The two are
 * linked by hover, so neither has to be read alone.
 *
 * An earlier version plotted the detector's deviation-from-baseline instead.
 * That was the quantity the thresholds apply to, which made it feel like the
 * right thing to show, but it is an internal intermediate: it came out as
 * disconnected sawtooth fragments that told a reader nothing. The lesson is
 * worth keeping — what a detector computes and what a person can read are
 * different questions, and the display answers the second one.
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
 * first, which is the property an earlier version lost by putting the plot and
 * the palette inside the branch that only rendered after a diagnosis.
 */

const props = defineProps({
  eq: { type: Object, required: true },
  accent: { type: String, required: true },
  sampleRate: { type: Number, default: 44100 },
})

/**
 * Region under the pointer, so hovering a suggestion lights its marker on the
 * plot. This is what ties the sentence to the picture — without it the two are
 * separate claims the reader has to match up by frequency, which is exactly the
 * work the mode exists to remove.
 */
const hoveredRegion = ref(null)

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

/**
 * What the plot is showing, in the header.
 *
 * Says so explicitly when nothing has been measured. The panel is usable
 * unanalysed — that is the point of ungating it — but the plot is then only the
 * user's own changes, and a header that stayed silent about it would let the
 * grid read as a picture of their voice.
 */
const toneLabel = computed(() => {
  const a = analysis.value
  if (!a) return 'not yet analysed — the curve below is your changes only'
  const type = { male: 'lower-pitched', female: 'higher-pitched', ambiguous: 'mid-range' }[a.voiceType]
  return `${type} voice · ${Math.round(a.medianF0Hz)} Hz`
})

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

const allOn = computed(() =>
  props.eq.suggestions.value.length > 0
  && props.eq.activeSuggestionCount.value === props.eq.suggestions.value.length)

function gainFor(roleId) {
  return props.eq.roleGain(roleId)
}

/** A role whose band exists but is switched off is shown, but shown as inert. */
function roleMuted(roleId) {
  const band = bandForRole(props.eq.bands.value, roleId)
  return !!band && !band.enabled
}

function fmtGain(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

function roleBand(roleId) {
  return bandForRole(props.eq.bands.value, roleId)
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
 * Is this row's correction audible?
 *
 * The switch answers "is anything happening", not "is the enabled flag set" —
 * a band at 0 dB is silent whatever the flag says, and showing it as on while
 * the header counts it as off is the mismatch this replaced.
 */
function isOn(row) {
  return !!row.band && isBandActive(row.band)
}

/**
 * The plain-language read-out for every role that is doing something.
 *
 * The sliders carried one of these per control. Knobs are too narrow to sit a
 * sentence under, and most of them say nothing at rest anyway — collected into
 * one line, the panel says what the EQ is doing in a single sentence instead of
 * nine mostly-empty ones.
 */
const activeSummary = computed(() => props.eq.paletteRoles
  .filter(r => gainFor(r.id) !== 0)
  .map(r => r.describe(gainFor(r.id)))
  .join(' · '))

/** The role under the pointer or holding focus, if any. */
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
  hoveredRegion.value = role?.region ?? null
}

/**
 * The hover tooltip: what this control does, and what state it is in.
 *
 * What the role *means* is not in here — that goes on the shared caption line,
 * where it is readable without hovering and cannot be missed by anyone who
 * never discovers that these have tooltips.
 */
function roleTitle(role) {
  const flagged = props.eq.detectedRoles.value.has(role.id)
    ? ' The analysis flagged this one.'
    : ''
  const how = roleMuted(role.id)
    ? 'switched off; move the knob to switch it back on'
    : 'drag to adjust, double-click to reset it to flat and its default width'
  return `${role.label} — ${how}.${flagged}`
}

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

  // The reach came off the detail strip when the width knob moved under its own
  // gain knob. It belongs with the definition anyway: both answer "what is this
  // control", one in words and one in hertz.
  const reach = role === focusedRole.value ? ` · acts on ${focusedReach.value}` : ''
  // The nudge toward opening a role, until one has been opened. The width knob
  // is the only thing a click reveals now, and a name that looks like a label
  // will not advertise it.
  const hint = focusedRole.value ? '' : ' · click for width'
  return `${role.label} — ${role.description}${reach}${hint}`
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

/** Scrolling a dot narrows or widens it — the third dimension a drag cannot reach. */
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
  hoveredRegion.value = role?.region ?? null
}

// ── The focused role ────────────────────────────────────────────────────────

/**
 * The role the detail strip is about.
 *
 * Two levels, not two competing ideas of "current": hovering glances at a
 * control and updates the caption line; clicking commits to one and opens the
 * strip, which is where the controls that do not earn a permanent place in a
 * nine-wide row live. Nine width knobs and nine solo buttons would be a mixing
 * console, which is the thing this plugin exists not to be.
 */
const focusedRoleId = ref(null)

const focusedRole = computed(() =>
  props.eq.paletteRoles.find(r => r.id === focusedRoleId.value) ?? null)

function focusRole(role) {
  focusedRoleId.value = focusedRoleId.value === role.id ? null : role.id
}

/** A shelf reaches to the end of the spectrum; only a bell has a width. */
const focusedIsShelf = computed(() =>
  focusedRole.value?.type === 'lowshelf' || focusedRole.value?.type === 'highshelf')

function fmtHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`
}

/**
 * What the focused role reaches, in hertz.
 *
 * The honest answer to "how wide is this" — a span in the user's own recording
 * rather than a Q, which is a fact about a filter and means nothing to anyone
 * who did not come here already knowing it.
 */
const focusedReach = computed(() => {
  const role = focusedRole.value
  if (!role) return ''
  const centre = props.eq.roleCentreHz(role.id)
  if (role.type === 'lowshelf') return `everything below ${fmtHz(centre)}`
  if (role.type === 'highshelf') return `everything above ${fmtHz(centre)}`
  const bw = bandwidthOctaves(props.eq.roleQ(role.id))
  return `${fmtHz(centre * 2 ** (-bw / 2))} to ${fmtHz(centre * 2 ** (bw / 2))}`
})

/**
 * Width as a word.
 *
 * The knob moves Q, but Q is not what anyone is thinking about — they are
 * thinking "does this grab a sliver or a swathe". The precise answer is next to
 * it in hertz, which is more use than either number.
 */
function fmtWidth(q) {
  const oct = bandwidthOctaves(q)
  if (oct >= 2) return 'Wide'
  if (oct >= 1) return 'Medium'
  if (oct >= 0.5) return 'Narrow'
  return 'Tight'
}
</script>

<template>
  <div>
    <!--
      The introduction: one thing to read and one thing to press.

      VoiceRx opens on the diagnosis alone because that is what a first-time
      user can act on with none of the vocabulary — press once, hear the voice
      fixed, then read what was wrong in the findings. Meeting nine knobs, a
      plot and a findings list at the same moment asks them to understand the
      panel before anything in it means anything.

      It is a door, not a toll gate. Skipping goes straight to the controls and
      the compact ANALYZE strip is waiting there, so nothing is behind it that
      cannot be reached without it, and once past it the panel never comes back
      to it. That is the difference between this and what it replaced, which
      made the diagnosis the only route in.
    -->
    <div
      v-if="showIntro"
      class="rounded-[3px] flex flex-col items-center justify-center gap-[12px] px-[24px] py-[22px]"
      style="min-height:200px;background:rgba(0,0,0,.28)"
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
        VoiceRx listens to your selection and corrects what it finds — what is
        muddy, boxy, harsh or dull, and by how much. You will hear the result
        before you have to decide anything about it.
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
      >Make a selection first</p>

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
    <!--
      Nothing here is gated on having analysed.

      The plot and the palette used to live behind the ANALYZE prompt, which
      made shaping by ear — reach for a characteristic, hear what it does —
      reachable only by first running a diagnosis you may not want. They are
      two capabilities, not one flow, and the region table falls back to the
      male ranges until a voice type is measured (see useVoiceRx.regions), so
      the controls have always been able to work unanalysed. The diagnosis
      adds to this panel; it is not the door to it.
    -->

    <!-- What the picture is. Without this the plot is unlabelled shapes and a
         reader has no way in. -->
    <div class="mb-[6px]">
      <div class="flex items-baseline justify-start gap-[10px]">
        <span style="font:700 9px/1 'Inter';letter-spacing:.12em;color:rgba(255,255,255,.45)">
          VOICE TONE
        </span>
        <p style="font:500 9px/1.4 'Inter';color:rgba(255,255,255,.32)">
          {{ toneLabel }}
          <span v-if="analysis && eq.analysisWidened.value"> · analysed from surrounding audio</span>
        </p>
      </div>

      <!-- Legend. Only the marks that are actually on the plot: before an
           analysis there is no envelope and there are no findings, and naming
           them would send the reader looking for something that is not there. -->
      <div class="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] mt-[7px]">
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
        :handle-ids="roleHandleIds"
        :solo-id="eq.soloBandId.value"
        :solo-probe="eq.soloProbe.value"
        :min-hz="REGION_SPAN_HZ[0]"
        :max-hz="REGION_SPAN_HZ[1]"
        interaction="bands"
        :analysis="analysis"
        :highlight-region="hoveredRegion"
        :region-ribbon="eq.regions.value"
        @move-band="onMoveBand"
        @q-band="onQBand"
        @select-band="onSelectBand"
        @hover-band="onHoverBand"
        @hover-region="previewRegion"
      />
    </div>

    <!-- RE-ANALYZE lives in the faceplate's button row, with SEND TO EQ and
         RESET — the three things you do to a whole diagnosis rather than to
         one finding. -->

    <!--
      The offer to diagnose, sitting where the findings will land.

      It was a 200 px empty box owning the whole panel, which made the
      diagnosis the price of entry. As a strip it is still the first thing
      under the plot and still the only accented button on screen, so it reads
      as the recommended next step rather than a toll gate.
    -->
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

    <!-- Suggestions -->
    <div v-else-if="eq.suggestions.value.length > 0" class="mt-[14px]">
      <div class="flex items-center justify-between mb-[7px]">
        <span style="font:700 9px/1 'Inter';letter-spacing:.12em;color:rgba(255,255,255,.4)">
          WHAT I HEAR
        </span>
        <div class="flex items-center gap-[10px]">
          <span style="font:500 9px/1 'Inter';color:rgba(255,255,255,.3)">
            {{ eq.activeSuggestionCount.value }} of {{ eq.suggestions.value.length }} on
          </span>
          <button
            type="button"
            class="px-[8px] py-[4px] rounded-[3px]"
            :style="{
              font: '600 9px/1 Inter', letterSpacing: '.06em',
              border: `1px solid color-mix(in srgb, ${accent} 45%, transparent)`,
              color: accent,
            }"
            @click="eq.setAllSuggestions(!allOn)"
          >{{ allOn ? 'ALL OFF' : 'ALL ON' }}</button>
        </div>
      </div>

      <!-- The corrections run in the live chain, so they are inaudible while
           the plugin is bypassed. Saying so beats a silent panel. -->
      <p
        v-if="!eq.eqPreview.value"
        class="mb-[7px]"
        style="font:500 9px/1.4 'Inter';color:rgba(255,190,120,.7)"
      >
        VoiceRx is switched off — turn it on to hear these.
      </p>

      <!-- Applied on arrival, listed so they can be switched back off. The row
           is a live control, not a proposal: the note explains what was heard,
           the switch says whether anything is being done about it. -->
      <div
        v-for="row in eq.suggestionRows.value"
        :key="row.suggestion.id"
        class="flex items-center gap-[10px] py-[6px] rounded-[2px] transition-colors"
        style="border-top:1px solid rgba(255,255,255,.05)"
        :style="{
          background: hoveredRegion === row.suggestion.region
            ? 'rgba(255,180,120,.07)' : 'transparent',
          opacity: isOn(row) ? 1 : 0.45,
        }"
        @pointerenter="hoveredRegion = row.suggestion.region"
        @pointerleave="hoveredRegion = null"
      >
        <button
          type="button"
          role="switch"
          :aria-checked="isOn(row)"
          class="shrink-0 rounded-full transition-colors"
          style="width:26px;height:15px;padding:2px"
          :style="{
            background: isOn(row) ? accent : 'rgba(255,255,255,.14)',
          }"
          :title="isOn(row) ? 'Switch this correction off' : 'Switch this correction on'"
          @click="eq.toggleSuggestion(row.suggestion)"
        >
          <span
            class="block rounded-full transition-transform"
            style="width:11px;height:11px;background:#0d1216"
            :style="{ transform: isOn(row) ? 'translateX(11px)' : 'none' }"
          />
        </button>

        <p class="flex-1" style="font:500 11px/1.4 'Inter';color:rgba(255,255,255,.75)">
          {{ row.suggestion.symptom }}
        </p>
        <span
          class="shrink-0 text-right"
          style="font:600 10px/1 'JetBrains Mono',monospace;color:rgba(255,255,255,.45);min-width:96px"
        >{{ row.suggestion.roleLabel }} · {{ fmtGain(row.band?.gainDb ?? row.suggestion.gainDb) }} dB</span>
        <button
          type="button"
          class="shrink-0 px-[8px] py-[4px] rounded-[3px]"
          style="font:600 9px/1 'Inter';letter-spacing:.06em;border:1px solid rgba(255,255,255,.12)"
          :style="{
            color: eq.soloBandId.value === row.band?.id ? accent : 'rgba(255,255,255,.5)',
            background: eq.soloBandId.value === row.band?.id
              ? `color-mix(in srgb, ${accent} 22%, transparent)` : 'transparent',
            opacity: row.band ? 1 : 0.35,
          }"
          :disabled="!row.band"
          title="Hear this correction on its own"
          @click="eq.toggleSolo(row.band)"
        >SOLO</button>
      </div>
    </div>

    <p
      v-else
      class="mt-[14px] text-center"
      style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.35)"
    >
      Nothing stands out — no part of this recording is far enough out of
      line to be worth correcting. You can still shape it by hand below.
    </p>

    <!-- Role controls -->
    <div class="mt-[16px] pt-[12px]" style="border-top:1px solid rgba(255,255,255,.06)">
      <div class="flex items-baseline justify-between mb-[9px]">
        <span style="font:700 9px/1 'Inter';letter-spacing:.12em;color:rgba(255,255,255,.4)">
          SHAPE BY EAR
        </span>
        <span style="font:500 9px/1 'Inter';color:rgba(255,255,255,.28)">
          low to high
        </span>
      </div>

      <!-- Every role, in frequency order, one row. The set is fixed: which of
           them the analysis flagged is a mark on the control, not a decision
           about whether the control exists. See useVoiceRx.paletteRoles. -->
      <div class="flex flex-wrap gap-x-[14px] gap-y-[12px]">
        <div
          v-for="role in eq.paletteRoles"
          :key="role.id"
          class="flex flex-col items-center w-[62px] cursor-pointer transition-opacity"
          :style="{ opacity: roleMuted(role.id) ? 0.4 : 1 }"
          :title="roleTitle(role)"
          @pointerenter="previewRole(role)"
          @pointerleave="previewRole(null)"
          @focusin="previewRole(role)"
          @focusout="previewRole(null)"
          @click="focusedRoleId = role.id"
          @dblclick="eq.resetRole(role.id)"
        >
          <div class="relative w-full">
            <Knob
              :model-value="gainFor(role.id)"
              :min="-GAIN_LIMIT_DB" :max="GAIN_LIMIT_DB" :step="0.1"
              label=""
              bipolar
              :accent="accent"
              :value-font-px="11"
              :format-value="fmtGain"
              @update:model-value="eq.setRoleGain(role.id, $event)"
            />
            <!-- The finding mark, in the plot's amber because it means what
                 the plot's markers mean. It sits on the knob rather than
                 beside the label so that adding it to some controls and not
                 others does not knock the labels out of line — the corner is
                 clear of the knob's ring at every value. -->
            <span
              v-if="eq.detectedRoles.value.has(role.id)"
              class="absolute rounded-full"
              style="top:-1px;right:1px;width:5px;height:5px;background:rgba(255,180,120,.9)"
              aria-hidden="true"
            />
          </div>
          <!-- The label is the focus control. A real button so the strip is
               reachable by keyboard, since the knob above it is not. -->
          <button
            type="button"
            class="vrx-role-label uppercase mt-[5px] text-center rounded-[2px] px-[3px] py-[2px] transition-colors"
            :aria-pressed="focusedRoleId === role.id"
            :title="focusedRoleId === role.id
              ? `Close ${role.label}`
              : `Open ${role.label} to set its width`"
            :style="{
              font: `600 8px/1 'Inter'`,
              letterSpacing: '.1em',
              color: focusedRoleId === role.id ? accent : 'rgba(255,255,255,.5)',
              background: focusedRoleId === role.id
                ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'transparent',
            }"
            @click.stop="focusRole(role)"
            @dblclick.stop
          >{{ role.label }}</button>
          <!-- S and ON, permanent, in the general EQ's own shapes and words.
               Two plugins that both hold a pool of bands should not each invent
               their own vocabulary for switching one off and hearing it alone. -->
          <div class="flex items-center gap-[3px] mt-[4px]">
            <button
              type="button"
              class="px-[4px] py-[2px] rounded-[2px] transition-colors"
              style="font:600 8px/1 'Inter';border:1px solid rgba(255,255,255,.12)"
              :style="{
                color: eq.isRoleSoloed(role.id) ? accent : 'rgba(255,255,255,.35)',
                background: eq.isRoleSoloed(role.id)
                  ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'transparent',
              }"
              :title="roleBand(role.id)
                ? `Hear the ${role.label} correction alone`
                : `Hear the part of the recording ${role.label} acts on`"
              @click.stop="eq.toggleRoleSolo(role.id)"
              @dblclick.stop
            >S</button>
            <button
              type="button"
              class="px-[4px] py-[2px] rounded-[2px] transition-colors"
              style="font:600 8px/1 'Inter';border:1px solid rgba(255,255,255,.12)"
              :style="{
                color: eq.roleOnState(role.id) === 'on' ? accent : 'rgba(255,255,255,.35)',
                background: eq.roleOnState(role.id) === 'on'
                  ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'transparent',
                opacity: eq.roleOnState(role.id) === 'on'
                  || eq.roleOnState(role.id) === 'off' ? 1 : 0.4,
              }"
              :disabled="eq.roleOnState(role.id) === 'absent'
                || eq.roleOnState(role.id) === 'flat'"
              :title="{
                on: `Switch the ${role.label} correction off`,
                off: `Switch the ${role.label} correction back on`,
                flat: `${role.label} is at zero — turn the knob to switch it on`,
                absent: `${role.label} is doing nothing yet — turn the knob to start`,
              }[eq.roleOnState(role.id)]"
              @click.stop="eq.toggleRoleEnabled(role.id)"
              @dblclick.stop
            >{{ eq.roleOnState(role.id) === 'on' ? 'ON' : 'OFF' }}</button>
          </div>

          <!--
            Width, under the knob it belongs to.

            It was a row of its own across the panel, which put the control a
            long way from the thing it widens and gave a single knob the visual
            weight of a section. Here it is plainly a second dimension of the
            control above it, and it costs the palette a little height only
            while a role is open.

            No width on a shelf: Rumble and Air reach to the end of the
            spectrum, so their Q is knee resonance rather than reach and a knob
            called WIDTH would not do what its label says. The caption line
            reports what they act on instead.
          -->
          <template v-if="focusedRoleId === role.id && !focusedIsShelf">
            <div class="w-[40px] mt-[7px]">
              <Knob
                :model-value="eq.roleQ(role.id)"
                :min="qRangeFor(role.type)[0]"
                :max="qRangeFor(role.type)[1]"
                scale="log"
                label=""
                :accent="accent"
                :value-font-px="8"
                :format-value="fmtWidth"
                :disabled="!roleBand(role.id)"
                @update:model-value="eq.setRoleQ(role.id, $event)"
              />
            </div>
            <span
              class="uppercase mt-[4px]"
              style="font:600 8px/1 'Inter';letter-spacing:.1em;color:rgba(255,255,255,.4)"
            >Width</span>
            <button
              v-if="roleBand(role.id)?.qModified"
              type="button"
              class="underline underline-offset-2 mt-[3px]"
              style="font:500 8px/1 'Inter';color:rgba(255,255,255,.3)"
              title="This width came from the measurement rather than the default — click to restore the default"
              @click.stop="eq.resetQ(roleBand(role.id).id)"
            >measured</button>
          </template>
        </div>
      </div>

      <!-- Fixed height: this line swaps between the running summary and the
           definition of whichever control is under the pointer, and nothing
           below it should move as that happens. -->
      <p
        class="mt-[10px]"
        style="font:500 9px/1.4 'Inter';color:rgba(255,255,255,.32);min-height:13px"
      >{{ paletteCaption }}</p>

    </div>
    </template>
  </div>
</template>

<style scoped>
/*
 * The role name is the detail strip's opener, so it has to read as something
 * that can be pressed. It is 8px of uppercase text in a row of eight others,
 * which gives it no shape of its own to signal with — the tint on hover is the
 * signal.
 */
.vrx-role-label:not([aria-pressed="true"]):hover {
  background: rgba(255, 255, 255, 0.09);
  color: rgba(255, 255, 255, 0.85) !important;
}

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
