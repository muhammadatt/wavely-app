<script setup>
import { computed, ref, onBeforeUnmount } from 'vue'
import EqPlot from './EqPlot.vue'
import DeviceSlider from '../../knobs/DeviceSlider.vue'
import { bandForRole } from '../../../audio/eqBands.js'

/**
 * VoxDoc — the voice-specific corrective view.
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
 * If the name promises a diagnosis, the tool has to deliver one. A mode called
 * VoxDoc that only handed over labelled sliders would be a broken promise, which
 * is why the suggestion list, not the sliders, is the top of this panel.
 */

const props = defineProps({
  eq: { type: Object, required: true },
  accent: { type: String, required: true },
  sampleRate: { type: Number, default: 44100 },
})

const auditioning = ref(null)
let stopAudition = null

/**
 * Region under the pointer, so hovering a suggestion lights its marker on the
 * plot. This is what ties the sentence to the picture — without it the two are
 * separate claims the reader has to match up by frequency, which is exactly the
 * work the mode exists to remove.
 */
const hoveredRegion = ref(null)

const analysis = computed(() => (props.eq.hasAnalysis.value ? props.eq.analysis.value : null))

/** Handles are shown for role bands only; general bands have no VoxDoc control. */
const roleHandleIds = computed(() =>
  props.eq.bands.value.filter(b => b.role !== null).map(b => b.id))

const untaggedCount = computed(() => props.eq.untagged.value.length)

const voiceLabel = computed(() => {
  const a = analysis.value
  if (!a) return ''
  const type = { male: 'lower-pitched', female: 'higher-pitched', ambiguous: 'mid-range' }[a.voiceType]
  return `${type} voice · ${Math.round(a.medianF0Hz)} Hz`
})

const errorMessage = computed(() => {
  switch (props.eq.analysisError.value) {
    case 'no_voiced_frames':
      return 'No speech found here. VoxDoc reads voices — for other material, General mode has the full EQ.'
    case 'insufficient_voiced':
      return 'This selection is too short, or has too little speech, to analyse. Try a longer stretch, or use General mode.'
    case 'failed':
      return 'Analysis failed. Try again, or use General mode.'
    default:
      return null
  }
})

function startAudition(suggestion) {
  stopAudition?.()
  auditioning.value = suggestion.id
  stopAudition = props.eq.auditionSuggestion(suggestion)
}

function endAudition() {
  stopAudition?.()
  stopAudition = null
  auditioning.value = null
}

onBeforeUnmount(endAudition)

function gainFor(roleId) {
  return props.eq.roleGain(roleId)
}

function fmtGain(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

function roleBand(roleId) {
  return bandForRole(props.eq.bands.value, roleId)
}
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
        VoxDoc listens to your selection and tells you what it hears —
        what is muddy, boxy, harsh or dull, and by how much.
      </p>

      <button
        type="button"
        class="px-[20px] py-[8px] rounded-[3px] transition-opacity"
        :style="{
          background: accent,
          color: '#0a1410',
          font: '700 11px/1 Inter',
          letterSpacing: '.08em',
          opacity: eq.analyzing.value || !eq.hasSelection.value ? 0.45 : 1,
        }"
        :disabled="eq.analyzing.value || !eq.hasSelection.value"
        @click="eq.analyze()"
      >{{ eq.analyzing.value ? 'ANALYSING…' : 'ANALYZE' }}</button>

      <p
        v-if="!eq.hasSelection.value"
        style="font:500 9px/1 'Inter';color:rgba(255,255,255,.3)"
      >Make a selection first</p>
    </div>

    <!-- ── After analysis ──────────────────────────────────────────────── -->
    <template v-else>
      <!-- What the picture is. Without this the plot is three unlabelled
           shapes, and a reader has no way in. -->
      <div class="flex items-baseline justify-between mb-[6px] gap-[10px]">
        <span style="font:700 9px/1 'Inter';letter-spacing:.12em;color:rgba(255,255,255,.45)">
          THE TONE OF YOUR VOICE
        </span>
        <span style="font:500 9px/1.3 'Inter';color:rgba(255,255,255,.3)">
          low notes on the left, high on the right
        </span>
      </div>

      <EqPlot
        :bands="eq.bands.value"
        :sample-rate="sampleRate"
        :accent="accent"
        :handle-ids="roleHandleIds"
        :interactive="false"
        :analysis="analysis"
        :highlight-region="hoveredRegion"
      />

      <!-- Legend. Three marks, three sentences. -->
      <div class="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] mt-[7px]">
        <span class="flex items-center gap-[6px]" style="font:500 9px/1 'Inter';color:rgba(255,255,255,.42)">
          <svg width="16" height="8" aria-hidden="true"><path d="M0 6 Q4 1 8 4 T16 2" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="1.5"/></svg>
          your voice
        </span>
        <span class="flex items-center gap-[6px]" style="font:500 9px/1 'Inter';color:rgba(255,255,255,.42)">
          <svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="3.5" fill="rgba(255,180,120,.9)"/></svg>
          something to fix
        </span>
        <span class="flex items-center gap-[6px]" style="font:500 9px/1 'Inter';color:rgba(255,255,255,.42)">
          <svg width="16" height="8" aria-hidden="true"><path d="M0 4 Q8 8 16 2" fill="none" :stroke="accent" stroke-width="2"/></svg>
          your changes
        </span>
      </div>

      <div class="flex items-center justify-between mt-[8px] gap-[10px]">
        <p style="font:500 9px/1.4 'Inter';color:rgba(255,255,255,.32)">
          {{ voiceLabel }}
          <span v-if="eq.analysisWidened.value"> · analysed from surrounding audio</span>
          <span v-if="untaggedCount > 0">
            · {{ untaggedCount }} general band{{ untaggedCount === 1 ? '' : 's' }} active
          </span>
        </p>
        <button
          type="button"
          class="shrink-0 px-[8px] py-[4px] rounded-[3px]"
          style="font:600 9px/1 'Inter';letter-spacing:.06em;border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.5)"
          @click="eq.analyze()"
        >RE-ANALYZE</button>
      </div>

      <p
        v-if="eq.isStale.value"
        class="mt-[6px]"
        style="font:500 9px/1.4 'Inter';color:rgba(255,190,120,.7)"
      >
        The selection changed since this was measured.
      </p>

      <!-- Suggestions -->
      <div v-if="eq.suggestions.value.length > 0" class="mt-[14px]">
        <div class="flex items-center justify-between mb-[7px]">
          <span style="font:700 9px/1 'Inter';letter-spacing:.12em;color:rgba(255,255,255,.4)">
            WHAT I HEAR
          </span>
          <button
            type="button"
            class="px-[8px] py-[4px] rounded-[3px]"
            :style="{
              font: '600 9px/1 Inter', letterSpacing: '.06em',
              border: `1px solid color-mix(in srgb, ${accent} 45%, transparent)`,
              color: accent,
            }"
            @click="eq.applyAllSuggestions()"
          >APPLY ALL</button>
        </div>

        <div
          v-for="s in eq.suggestions.value"
          :key="s.id"
          class="flex items-center gap-[10px] py-[6px] rounded-[2px] transition-colors"
          style="border-top:1px solid rgba(255,255,255,.05)"
          :style="{
            background: hoveredRegion === s.region
              ? 'rgba(255,180,120,.07)' : 'transparent',
          }"
          @pointerenter="hoveredRegion = s.region"
          @pointerleave="hoveredRegion = null"
        >
          <p class="flex-1" style="font:500 11px/1.4 'Inter';color:rgba(255,255,255,.75)">
            {{ s.symptom }}
          </p>
          <span
            class="shrink-0 text-right"
            style="font:600 10px/1 'JetBrains Mono',monospace;color:rgba(255,255,255,.45);min-width:96px"
          >{{ s.roleLabel }} · {{ fmtGain(s.gainDb) }} dB</span>
          <button
            type="button"
            class="shrink-0 px-[8px] py-[4px] rounded-[3px]"
            style="font:600 9px/1 'Inter';letter-spacing:.06em;border:1px solid rgba(255,255,255,.12)"
            :style="{
              color: auditioning === s.id ? accent : 'rgba(255,255,255,.55)',
              background: auditioning === s.id
                ? `color-mix(in srgb, ${accent} 22%, transparent)` : 'transparent',
            }"
            @pointerdown="startAudition(s)"
            @pointerup="endAudition"
            @pointerleave="endAudition"
            @pointercancel="endAudition"
          >HEAR IT</button>
          <button
            type="button"
            class="shrink-0 px-[10px] py-[4px] rounded-[3px]"
            :style="{ background: accent, color: '#0a1410', font: '700 9px/1 Inter', letterSpacing: '.06em' }"
            @click="eq.applySuggestion(s)"
          >APPLY</button>
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
        <div class="grid grid-cols-2 gap-x-[20px] gap-y-[10px]">
          <div v-for="role in eq.visibleRoles.value" :key="role.id">
            <DeviceSlider
              :model-value="gainFor(role.id)"
              :min="-12" :max="12" :step="0.1"
              :label="role.label"
              :accent="accent"
              :format-value="fmtGain"
              @update:model-value="eq.setRoleGain(role.id, $event)"
            />
            <div class="flex items-center gap-[8px] mt-[2px] h-[11px]">
              <span
                v-if="gainFor(role.id) !== 0"
                style="font:500 9px/1 'Inter';color:rgba(255,255,255,.32)"
              >{{ role.describe(gainFor(role.id)) }}</span>
              <button
                v-if="roleBand(role.id)?.qModified"
                type="button"
                class="underline underline-offset-2"
                style="font:500 9px/1 'Inter';color:rgba(255,255,255,.3)"
                title="This band's width came from the measurement rather than the default"
                @click="eq.resetQ(roleBand(role.id).id)"
              >width: measured — reset</button>
            </div>
          </div>
        </div>

        <div v-if="eq.hiddenRoles.value.length > 0" class="mt-[12px] flex flex-wrap gap-[6px]">
          <button
            v-for="role in eq.hiddenRoles.value"
            :key="role.id"
            type="button"
            class="px-[8px] py-[4px] rounded-[3px]"
            style="font:600 9px/1 'Inter';letter-spacing:.05em;border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.4)"
            @click="eq.revealRole(role.id)"
          >+ {{ role.label }}</button>
        </div>

        <p
          v-if="eq.visibleRoles.value.some(r => r.id === 'sibilance')"
          class="mt-[10px]"
          style="font:500 9px/1.5 'Inter';color:rgba(255,255,255,.3)"
        >
          Sibilance here is a fixed cut across the whole selection. For harsh
          S sounds on individual words, the De-Esser handles them one at a time —
          the two solve different problems.
        </p>
      </div>
    </template>
  </div>
</template>
