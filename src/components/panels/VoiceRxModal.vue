<script setup>
import { computed, onMounted, ref } from 'vue'
import { useVoiceRx } from '../../composables/useVoiceRx.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { isBandActive } from '../../audio/eqBands.js'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'
import VoiceRxView from './eq/VoiceRxView.vue'

/**
 * The VoiceRx faceplate — voice diagnosis, in its own window.
 *
 * A different accent from the EQ on purpose. The two plugins do adjacent jobs
 * to the same signal and can both be engaged at once, so the one thing the
 * faceplate has to make instant is which of them you are looking at.
 */

defineProps({ z: { type: Number, default: 500 } })

const vox = useVoiceRx()
const { state } = useEditorState()

const ACCENT = '#7fb8e8'
const hoveredSuggestionRegion = ref(null)

onMounted(() => {
  if (!vox.eqPreview.value) vox.togglePreview()
})

const sampleRate = computed(() => state.currentFile?.sampleRate ?? 44100)

const activeBandCount = computed(() => vox.activeBands.value.length)

const atRecommendedCount = computed(() =>
  vox.suggestionRows.value.filter(r => r.atRecommended).length)

/** Nothing left for APPLY ALL to change. */
const allAtRecommended = computed(() =>
  vox.suggestions.value.length > 0
  && atRecommendedCount.value === vox.suggestions.value.length)

function fmtGain(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

function isOn(row) {
  return !!row.band && isBandActive(row.band)
}

/**
 * What is in force in this region right now, if it is not the recommendation.
 *
 * Empty when the row is at its recommended values — there is nothing to
 * contrast with — and empty is rendered as transparent text rather than as no
 * element, so the buttons stay aligned down the list.
 *
 * The three ways a row can have drifted get three different notes, because
 * "off" and "−2.0 dB instead of −4.5" and "not in the pool at all" are answered
 * by different next actions, and only the last is a case where APPLY is adding
 * something rather than replacing it.
 */
function currentNote(row) {
  if (row.atRecommended) return ''
  if (!row.band) return 'not set'
  if (!row.band.enabled) return 'off'
  return `now ${fmtGain(row.band.gainDb)}`
}

/** Says what the press will do, in the two numbers it will do it to. */
function applyTitle(row) {
  const want = `${fmtGain(row.suggestion.gainDb)} dB`
  if (row.atRecommended) return `${row.suggestion.roleLabel} is at the recommended ${want}`
  if (!row.band) return `Add the recommended ${row.suggestion.roleLabel} correction, ${want}`
  return `Override ${row.suggestion.roleLabel} — currently `
    + `${fmtGain(row.band.gainDb)} dB — with the recommended ${want}`
}

function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

function close() {
  vox.teardown()
}

async function applyAndClose() {
  await vox.apply()
  vox.teardown()
  vox.closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="voicerx"
    :z="z"
    :width="820"
    :accent="ACCENT"
    brand-lead="VOICE"
    brand-tail="RX"
    :engaged="vox.eqPreview.value"
    @toggle-engaged="vox.togglePreview()"
    @close="close"
  >
    <div class="px-[22px] pt-[18px] pb-[22px]">


      <!-- Findings are above the meter/plot row so the plot baseline stays
           aligned with the IN/OUT bars regardless of list length. -->
      <div v-if="vox.suggestions.value.length > 0" class="mb-[14px]">
        <div class="flex items-center justify-between mb-[7px]">
          <span
            style="font:700 9px/1 'Inter';letter-spacing:.12em;color: rgba(255,255,255,.5)"
          >
            ISSUES IDENTIFIED:
          </span>
          <div class="flex items-center gap-[10px]">
            <!-- Only once there is something to re-do. Keyed on the raw analysis
             rather than hasAnalysis, which goes false the moment the selection
             changes — precisely when re-analyzing is the thing you want. -->
        <button
          v-if="vox.analysis.value?.ok"
          type="button"
          class="flex items-center gap-[6px] px-[8px] py-[4px] rounded-[3px] cursor-pointer"
          style="font:600 9px/1 'Inter';letter-spacing:.06em;border:1px solid rgba(255,255,255,.22);color:rgba(255,255,255,.5)"
          :style="{ opacity: vox.analyzing.value || !vox.hasSelection.value ? 0.55 : 1 }"
          :disabled="vox.analyzing.value || !vox.hasSelection.value"
          :title="vox.hasSelection.value
            ? 'Measure the current selection again'
            : 'Select some audio to measure'"
          @click="vox.analyze()"
        >
          <span v-if="vox.analyzing.value" class="vrx-spin" aria-hidden="true" />
          {{ vox.analyzing.value ? 'ANALYSING…' : 'RE-ANALYZE' }}
        </button>  
          <button
          v-if="vox.bands.value.length > 0"
          type="button"
          class="px-[8px] py-[4px] rounded-[3px] cursor-pointer"
          style="font:600 9px/1 'Inter';letter-spacing:.06em;border:1px solid rgba(255,255,255,.22);color:rgba(255,255,255,.5)"
          @click="vox.clearBands()"
        >CLEAR</button>
            <!-- The same one-way write as a row's APPLY, over every row.
                 Disabled once nothing would change, so it reports whether the
                 diagnosis is in force rather than being a button that always
                 looks live and sometimes does nothing. -->
            <button
              type="button"
              class="px-[8px] py-[4px] rounded-[3px] transition-colors"
              :style="{
                font: '600 9px/1 Inter', letterSpacing: '.06em',
                border: allAtRecommended
                  ? '1px solid rgba(255,255,255,.08)'
                  : `1px solid color-mix(in srgb, ${ACCENT} 45%, transparent)`,
                color: allAtRecommended ? 'rgba(255,255,255,.3)' : ACCENT,
                cursor: allAtRecommended ? 'default' : 'pointer',
              }"
              :disabled="allAtRecommended"
              :title="allAtRecommended
                ? 'Every correction is at its recommended value'
                : 'Override every correction with the recommended values'"
              @click="vox.applyAllSuggestions()"
            >APPLY ALL</button>
          </div>
        </div>

        <p
          v-if="!vox.eqPreview.value"
          class="mb-[7px]"
          style="font:500 9px/1.4 'Inter';color:rgba(255,190,120,.7)"
        >
          VoiceRx is switched off — turn it on to hear these.
        </p>

        <div
          v-for="row in vox.suggestionRows.value"
          :key="row.suggestion.id"
          class="flex items-center gap-[10px] py-[6px] rounded-[2px] transition-colors"
          style="border-top:1px solid rgba(255,255,255,.05)"
          :style="{
            background: hoveredSuggestionRegion === row.suggestion.region
              ? 'rgba(255,180,120,.07)' : 'transparent',
          }"
          @pointerenter="hoveredSuggestionRegion = row.suggestion.region"
          @pointerleave="hoveredSuggestionRegion = null"
        >
          <p
            class="flex-1 transition-opacity"
            style="font:500 11px/1.4 'Inter';color:rgba(255,255,255,.8)"
          >
            {{ row.suggestion.symptom }}
          </p>
          <!-- The measured recommendation, and only that. It used to fall back
               to the band's live gain, which meant turning the knob rewrote the
               diagnosis on screen and left no record of what was actually
               measured. This number never changes while the analysis stands. -->
          <span
            class="shrink-0 text-right transition-opacity"
            style="font:600 10px/1 'JetBrains Mono',monospace;color:rgba(255,255,255,.45);min-width:96px"
            :style="{ opacity: isOn(row) ? 1 : 0.45 }"
          >{{ row.suggestion.roleLabel }} · {{ fmtGain(row.suggestion.gainDb) }} dB</span>

          <!-- What is actually in force, when it is not what was recommended.
               This is the half the row could not show before, and it is what
               makes the button's "override" legible: you can see both numbers
               and what pressing it would do. Fixed width so the buttons stay in
               a column whether or not a row has drifted. -->
          <span
            class="shrink-0 text-right"
            style="font:600 9px/1 'JetBrains Mono',monospace;min-width:62px"
            :style="{ color: currentNote(row) ? 'rgba(255,190,120,.7)' : 'transparent' }"
          >{{ currentNote(row) }}</span>

          <button
            type="button"
            class="shrink-0 px-[8px] py-[4px] rounded-[3px] transition-colors"
            style="font:600 9px/1 'Inter';letter-spacing:.06em"
            :style="{
              border: row.atRecommended
                ? '1px solid rgba(255,255,255,.08)'
                : `1px solid color-mix(in srgb, ${ACCENT} 45%, transparent)`,
              color: row.atRecommended ? 'rgba(255,255,255,.3)' : ACCENT,
              background: 'transparent',
              cursor: row.atRecommended ? 'default' : 'pointer',
            }"
            :disabled="row.atRecommended"
            :title="applyTitle(row)"
            @click="vox.applySuggestion(row.suggestion)"
          >{{ row.atRecommended ? 'APPLIED' : 'APPLY' }}</button>
        </div>
      </div>

      <!--
        A clean bill of health, which only a completed analysis can give.

        This was a plain v-else on the findings list, so it also covered the
        state before anything had been measured — the panel opened by asserting
        that nothing in the recording was worth correcting, having not listened
        to it. An empty findings list means two entirely different things
        depending on whether a diagnosis has run, and only one of them is news.

        Keyed on hasAnalysis rather than on freshness on purpose: a measurement
        that found nothing does not stop having found nothing because the
        selection moved. VoiceRxView's own banner reports the staleness.
      -->
      <p
        v-else-if="vox.hasAnalysis.value"
        class="mb-[14px] text-center"
        style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.35)"
      >
        Nothing stands out — no part of this recording is far enough out of
        line to be worth correcting. You can still shape it by hand below.
      </p>

      <div class="flex gap-[16px]">
        <LevelMeter :db="vox.inputDb.value" label="IN" :height="200" />

        <div class="flex-1 min-w-0">
          <VoiceRxView
            :eq="vox"
            :accent="ACCENT"
            :sample-rate="sampleRate"
            :hovered-region="hoveredSuggestionRegion"
            @update:hovered-region="hoveredSuggestionRegion = $event"
          />
        </div>

        <LevelMeter :db="vox.outputDb.value" label="OUT" :height="200" />
      </div>

            <div class="flex items-center justify-end mb-[14px] gap-[14px]">
        <span
          v-if="activeBandCount > 0"
          style="font:600 9px/1 'JetBrains Mono',monospace;color:rgba(255,255,255,.3)"
        >{{ activeBandCount }} change{{ activeBandCount === 1 ? '' : 's' }}</span>

        <button
          v-if="vox.canSendToEq.value"
          type="button"
          class="px-[8px] py-[4px] rounded-[3px]"
          :style="{
            font: '600 9px/1 Inter', letterSpacing: '.06em',
            border: `1px solid color-mix(in srgb, ${ACCENT} 45%, transparent)`,
            color: ACCENT,
          }"
          title="Move these corrections into the EQ, where you can shape them further"
          @click="vox.sendToEq()"
        >TRANSFER TO EQ →</button>
      </div>

      <div class="mt-[16px] pt-[14px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <ApplyAction
          size="md"
          show-preview
          previewable
          :previewing="state.isPlaying"
          :accent="ACCENT"
          text-color="#0a1410"
          :met="vox.hasSelection.value"
          message="Make a selection to apply these to"
          label="Apply corrections"
          :disabled="!vox.eqPreview.value || activeBandCount === 0"
          :disabled-hint="activeBandCount === 0
            ? 'Apply a suggestion, or move a knob, before applying'
            : 'Turn VoiceRx on to apply it'"
          @toggle-preview="togglePlayback"
          @apply="applyAndClose"
        />
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
/*
 * The analysis blocks the main thread while it runs, so the busy indicator has
 * to be something the compositor can animate on its own. A transform keyframe
 * qualifies; anything driven by JS would sit frozen for exactly the seconds it
 * is meant to cover.
 *
 * Duplicated from VoiceRxView rather than shared: scoped styles do not cross
 * component boundaries, and a two-rule spinner is not worth a global class.
 */
.vrx-spin {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  border: 1.5px solid rgba(255, 255, 255, 0.25);
  border-top-color: rgba(255, 255, 255, 0.6);
  animation: vrx-spin 0.7s linear infinite;
  will-change: transform;
}

@keyframes vrx-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .vrx-spin { animation-duration: 2.4s; }
}
</style>
