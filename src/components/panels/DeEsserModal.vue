<script setup>
/**
 * Clip-Gain De-Esser.
 *
 * Two-speed by construction. Analyse runs sibilance detection on the server
 * once and freezes the result; every control on this panel is a pure function
 * of two per-event measurements it returns, so they recompute the envelope in
 * milliseconds without touching the server again. Detection parameters live
 * behind the dev panel because changing them changes which events exist.
 */
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import { useDeEsser } from '../../composables/useDeEsser.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { DEV_TUNING_PANELS } from '../../devFlags.js'
import Knob from '../knobs/Knob.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  params, preview, analysis, analyzing, measuredEvents,
  treatedCount, maxReductionDb, reductionDb, inputLevels, outputLevels,
  tuning, syncTuning, resetTuning,
  hasAnalysis, hasSelection, isStale, envelopeValid, analyzedRegion,
  togglePreview, syncParam, analyze, apply, teardown, closeModal,
} = useDeEsser()

const { state } = useEditorState()

onMounted(() => {
  if (!preview.value) togglePreview()
})

const ACCENT = '#7ec8ff'

/**
 * Loaded only when the flag is on. A static import plus `v-if` would have kept
 * the module — and every detection parameter name in it — in the production
 * bundle; with the flag folded to a literal false this whole branch is dead
 * code and goes away.
 */
const TuningPanel = DEV_TUNING_PANELS
  ? defineAsyncComponent(() => import('./SibilanceTuningPanel.vue'))
  : null

/** Detection settings changed since the last Analyse. */
const tuningDirty = ref(false)

/**
 * Tuning grid collapsed by default, and the window narrows to match. Left open
 * it is most of the panel, and it is not what you are looking at while
 * sweeping — the event count in the status line is.
 */
const tuningOpen = ref(false)

function onTuningUpdate(key, value) {
  syncTuning(key, value)
  tuningDirty.value = true
}

function onTuningReset() {
  resetTuning()
  tuningDirty.value = true
}

async function runAnalyze() {
  await analyze()
  tuningDirty.value = false
}

const oneDp = v => v.toFixed(1)
const pct = v => `${Math.round(v * 100)}`
const db = v => v.toFixed(1)
const ms = v => v.toFixed(1)

function fmtTime(sec) {
  const m = Math.floor(sec / 60)
  const s = (sec - m * 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}

/** The analysed span, so "analyse again" says which bounds were left. */
function fmtRange(region) {
  return `${fmtTime(region.start)}–${fmtTime(region.end)}`
}

const statusLine = computed(() => {
  if (analyzing.value) return 'Detecting sibilants…'
  if (!hasAnalysis.value) {
    if (analysis.value) return 'No sibilant events found in this selection.'
    return 'Analyse the selection to find sibilants.'
  }
  if (isStale.value) {
    const region = analyzedRegion.value
    return region
      ? `Selection is outside the analysed ${fmtRange(region)} — analyse again.`
      : 'Audio changed since analysis — analyse again.'
  }
  const total = measuredEvents.value.length
  const untreated = total - treatedCount.value
  const tail = untreated > 0 ? ` ${untreated} under the ceiling.` : ''
  return `${treatedCount.value} of ${total} events attenuated, up to ${maxReductionDb.value.toFixed(1)} dB.${tail}`
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
</script>

<template>
  <FloatingWindow
    window-id="clip-gain-deesser"
    :z="z"
    :width="TuningPanel && tuningOpen ? 760 : 620"
    :accent="ACCENT"
    brand-lead="DE"
    brand-tail="ESSER"
    :engaged="preview"
    @toggle-engaged="togglePreview"
    @close="close"
  >
    <div class="px-[26px] pt-[22px] pb-[24px]">
      <!-- Live reduction at the playhead, matching every other effect's meter.
           The envelope's planned maximum is a different quantity and lives in
           the status line, where it does not look like a meter. -->
      <!-- 12 dB full scale, not the shared 24: de-essing lives in the 3–8 dB
           range, and even on the voltage-law scale a shallower face gives
           those few dB more of the bar. The composable already holds the peak
           of each event and releases slowly, so the bar's own damping is off —
           two stages of smoothing would put the reading behind the audio. -->
      <GainReductionBar
        :reduction-db="reductionDb" :accent="ACCENT"
        :full-scale-db="12" ballistics="none"
      />

      <div class="flex items-start justify-between gap-[20px] mt-[20px]">
        <LevelMeter :levels="inputLevels" label="IN" :height="164" />

        <div class="flex-1">
          <!-- Analyse: the frozen half -->
          <div class="flex items-center justify-between gap-[16px]">
            <div>
              <div
                style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.14em;
                       color:rgba(255,255,255,.42)"
              >SIBILANCE DETECTION</div>
              <div
                class="mt-[2px]"
                style="font:500 9.5px/1.4 'Inter';color:rgba(255,255,255,.3);max-width:280px"
              >Runs once on the server. The controls below re-shape the result
                without re-detecting.</div>
            </div>
            <button
              class="px-[18px] py-[9px] rounded-lg cursor-pointer transition-all disabled:cursor-default"
              :style="{
                background: analyzing ? 'rgba(255,255,255,.05)' : 'rgba(126,200,255,.16)',
                border: `1px solid ${analyzing ? 'rgba(255,255,255,.09)' : 'rgba(126,200,255,.42)'}`,
                color: analyzing ? 'rgba(255,255,255,.4)' : '#bfe3ff',
                font: `700 10px 'JetBrains Mono',monospace`,
                letterSpacing: '.1em',
                opacity: hasSelection ? 1 : 0.4,
              }"
              :disabled="analyzing || !hasSelection"
              @click="runAnalyze"
            >{{ analyzing ? 'ANALYSING…' : 'ANALYSE' }}</button>
          </div>

          <!-- Attenuation: the live half -->
          <div
            class="mt-[16px] pt-[14px] grid grid-cols-2 gap-x-[26px] gap-y-[14px]"
            style="border-top:1px solid rgba(255,255,255,.06)"
          >
            <div class="w-[104px]">
              <Knob
                :model-value="params.stridentCeilingDb"
                @update:model-value="v => syncParam('stridentCeilingDb', v)"
                :min="-12" :max="18" :step="0.5" :value-font-px="12"
                label="/s/ Ceiling dB" :accent="ACCENT" :format-value="oneDp"
                :disabled="!preview || !envelopeValid"
              />
            </div>
            <div class="w-[104px]">
              <Knob
                :model-value="params.nonStridentCeilingDb"
                @update:model-value="v => syncParam('nonStridentCeilingDb', v)"
                :min="-18" :max="12" :step="0.5" :value-font-px="12"
                label="/f/ Ceiling dB" :accent="ACCENT" :format-value="oneDp"
                :disabled="!preview || !envelopeValid"
              />
            </div>
            <div class="w-[104px]">
              <Knob
                :model-value="params.reductionRatio"
                @update:model-value="v => syncParam('reductionRatio', v)"
                :min="0" :max="1" :step="0.01" :value-font-px="12"
                label="Amount" :accent="ACCENT" :format-value="pct"
                :disabled="!preview || !envelopeValid"
              />
            </div>
            <div class="w-[104px]">
              <Knob
                :model-value="params.maxReductionDb"
                @update:model-value="v => syncParam('maxReductionDb', v)"
                :min="0" :max="24" :step="0.5" :value-font-px="12"
                label="Max Cut dB" :accent="ACCENT" :format-value="db"
                :disabled="!preview || !envelopeValid"
              />
            </div>
          </div>

          <p
            class="mt-[12px]"
            :style="{
              font: `500 10px/1.5 'Inter'`,
              color: isStale ? '#ffb27a' : 'rgba(255,255,255,.35)',
            }"
          >{{ statusLine }}</p>
        </div>

        <LevelMeter :levels="outputLevels" label="OUT" :height="164" />
      </div>

      <!-- Fade shaping -->
      <div
        class="flex items-center justify-between mt-[16px] pt-[14px]"
        style="border-top:1px solid rgba(255,255,255,.06)"
      >
        <p style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.3);max-width:250px">
          How quickly each cut arrives and leaves. Affricates get their own
          timing so the reduction lands before the burst.
        </p>
        <div class="flex gap-[18px]">
          <div class="w-[70px]">
            <Knob
              :model-value="params.fricativeInMs"
              @update:model-value="v => syncParam('fricativeInMs', v)"
              :min="0.5" :max="20" :step="0.5" :value-font-px="11"
              label="Fric In" :accent="ACCENT" :format-value="ms"
              :disabled="!preview || !envelopeValid"
            />
          </div>
          <div class="w-[70px]">
            <Knob
              :model-value="params.fricativeOutMs"
              @update:model-value="v => syncParam('fricativeOutMs', v)"
              :min="0.5" :max="20" :step="0.5" :value-font-px="11"
              label="Fric Out" :accent="ACCENT" :format-value="ms"
              :disabled="!preview || !envelopeValid"
            />
          </div>
          <div class="w-[70px]">
            <Knob
              :model-value="params.affricateInMs"
              @update:model-value="v => syncParam('affricateInMs', v)"
              :min="0.5" :max="20" :step="0.5" :value-font-px="11"
              label="Affr In" :accent="ACCENT" :format-value="ms"
              :disabled="!preview || !envelopeValid"
            />
          </div>
          <div class="w-[70px]">
            <Knob
              :model-value="params.affricateOutMs"
              @update:model-value="v => syncParam('affricateOutMs', v)"
              :min="0.5" :max="20" :step="0.5" :value-font-px="11"
              label="Affr Out" :accent="ACCENT" :format-value="ms"
              :disabled="!preview || !envelopeValid"
            />
          </div>
        </div>
      </div>

      <!-- Developer-only. Absent from production bundles, not merely hidden. -->
      <component
        :is="TuningPanel"
        v-if="TuningPanel"
        :tuning="tuning"
        :accent="ACCENT"
        :dirty="tuningDirty"
        :open="tuningOpen"
        @update="onTuningUpdate"
        @reset="onTuningReset"
        @reanalyze="runAnalyze"
        @toggle="tuningOpen = !tuningOpen"
      />

      <div class="mt-[16px]">
        <ApplyAction
          size="md"
          show-preview
          previewable
          :previewing="state.isPlaying"
          :accent="ACCENT"
          text-color="#0b1a26"
          :met="hasSelection"
          message="Make a selection to de-ess"
          label="Apply De-Essing"
          :disabled="!preview || !envelopeValid || treatedCount === 0"
          :disabled-hint="!preview
            ? 'Turn the de-esser on to apply it'
            : !hasAnalysis
              ? 'Analyse the selection first'
              : isStale
                ? 'Selection moved outside the analysed region — analyse again'
                : 'No events are above their ceiling — lower it to treat some'"
          @toggle-preview="togglePlayback"
          @apply="applyAndClose"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
