<script setup>
import { computed, ref, onBeforeUnmount } from 'vue'
import EqPlot from './EqPlot.vue'
import Knob from '../../knobs/Knob.vue'
import { bandForRole, isBandActive } from '../../../audio/eqBands.js'

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

const analysis = computed(() => (props.eq.hasAnalysis.value ? props.eq.analysis.value : null))

/** Handles are shown for role bands only; general bands have no VoiceRx control. */
const roleHandleIds = computed(() =>
  props.eq.bands.value.filter(b => b.role !== null).map(b => b.id))

const voiceLabel = computed(() => {
  const a = analysis.value
  if (!a) return ''
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
    : 'drag to adjust, double-click to reset'
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
  const role = previewedRole.value
  if (!role) return activeSummary.value
  return `${role.label} — ${role.description}`
})
</script>

<template>
  <div>
    <!-- ── Before analysis ─────────────────────────────────────────────── -->
    <div
      v-if="!analysis"
      class="rounded-[3px] flex flex-col items-center justify-center gap-[12px] px-[24px]"
      style="height:200px;background:rgba(0,0,0,.28)"
    >
      <p
        v-if="errorMessage"
        class="text-center max-w-[380px]"
        style="font:500 11px/1.6 'Inter';color:rgba(255,190,120,.75)"
      >{{ errorMessage }}</p>
      <p
        v-else
        class="text-center max-w-[360px]"
        style="font:500 11px/1.6 'Inter';color:rgba(255,255,255,.4)"
      >
        VoiceRx listens to your selection and tells you what it hears —
        what is muddy, boxy, harsh or dull, and by how much.
      </p>

      <button
        type="button"
        class="flex items-center gap-[8px] px-[20px] py-[8px] rounded-[3px] transition-opacity"
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
    </div>

    <!-- ── After analysis ──────────────────────────────────────────────── -->
    <template v-else>
      <!-- What the picture is. Without this the plot is three unlabelled
           shapes, and a reader has no way in. -->
      <div class="flex items-baseline justify-start mb-[6px] gap-[10px]">
        <span style="font:700 9px/1 'Inter';letter-spacing:.12em;color:rgba(255,255,255,.45)">
          VOICE TONE
        </span>
        <p style="font:500 9px/1.4 'Inter';color:rgba(255,255,255,.32)">
          {{ voiceLabel }}
          <span v-if="eq.analysisWidened.value"> · analysed from surrounding audio</span>
        </p>
      <!-- Legend. Three marks, three sentences. -->
      <div class="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] mt-[7px]">
        <span class="flex items-center gap-[6px]" style="font:500 9px/1 'Inter';color:rgba(255,255,255,.42)">
          <svg width="16" height="8" aria-hidden="true"><path d="M0 6 Q4 1 8 4 T16 2" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="1.5"/></svg>
          your voice
        </span>
        <span class="flex items-center gap-[6px]" style="font:500 9px/1 'Inter';color:rgba(255,255,255,.42)">
          <svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="3.5" fill="rgba(255,180,120,.9)"/></svg>
          area to fix
        </span>
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
          :interactive="false"
          :analysis="analysis"
          :highlight-region="hoveredRegion"
        />
      </div>

      <!-- RE-ANALYZE lives in the faceplate's button row, with SEND TO EQ and
           RESET — the three things you do to a whole diagnosis rather than to
           one finding. -->

      <!-- Suggestions -->
      <div v-if="eq.suggestions.value.length > 0" class="mt-[14px]">
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
            class="flex flex-col items-center w-[62px] transition-opacity"
            :style="{ opacity: roleMuted(role.id) ? 0.4 : 1 }"
            :title="roleTitle(role)"
            @pointerenter="previewedRole = role"
            @pointerleave="previewedRole = null"
            @focusin="previewedRole = role"
            @focusout="previewedRole = null"
            @dblclick="eq.setRoleGain(role.id, 0)"
          >
            <div class="relative w-full">
              <Knob
                :model-value="gainFor(role.id)"
                :min="-12" :max="12" :step="0.1"
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
            <span
              class="uppercase mt-[5px] text-center"
              style="font:600 8px/1 'Inter';letter-spacing:.1em;color:rgba(255,255,255,.5)"
            >{{ role.label }}</span>
            <button
              v-if="roleBand(role.id)?.qModified"
              type="button"
              class="underline underline-offset-2 mt-[3px]"
              style="font:500 8px/1 'Inter';color:rgba(255,255,255,.3)"
              title="This band's width came from the measurement rather than the default — click to restore the default width"
              @click.stop="eq.resetQ(roleBand(role.id).id)"
            >width: measured</button>
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
