<script setup>
/**
 * Sibilance Editor (the clip-gain de-esser).
 *
 * Two-speed by construction. Analyse runs sibilance detection on the server
 * once and freezes the result; every control on this panel is a pure function
 * of two per-event measurements it returns, so they recompute the envelope in
 * milliseconds without touching the server again. Detection parameters live
 * behind the dev panel because changing them changes which events exist.
 *
 * Modula layout: the reduction bar and the analysis sit in the centre well
 * between the IN and OUT ladders, the four attenuation controls under them,
 * and the four fade timings in a second row.
 */
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import { useSibilanceEditor } from '../../composables/useSibilanceEditor.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { DEV_TUNING_PANELS } from '../../devFlags.js'
import { DEESSER_DEFAULTS } from '../../audio/effects/sibilanceEditor.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaButton from '../modula/ModulaButton.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  params, preview, analysis, analyzing, measuredEvents,
  treatedCount, maxReductionDb, reductionDb, inputLevels, outputLevels,
  tuning, syncTuning, resetTuning,
  hasAnalysis, hasSelection, isStale, envelopeValid, analyzedRegion,
  togglePreview, syncParam, analyze, apply, teardown, closeModal,
} = useSibilanceEditor()

const { state } = useEditorState()

onMounted(() => {
  // The chain's copy keeps its ON/BYPASS: opening its editor from the chain
  // must not un-bypass its slot.
  if (!preview.value && currentPluginCopy() === 'solo') togglePreview()
})

const ACCENT = '#e8a33d'
const METER_H = 178
const D = DEESSER_DEFAULTS

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

const fmtDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
const fmtCut = v => `−${v.toFixed(1)} dB`
const fmtPct = v => `${Math.round(v * 100)}%`
const fmtMs = v => `${v.toFixed(1)} ms`

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

/** The live controls need the editor on and an envelope to reshape. */
const controlsOff = computed(() => !preview.value || !envelopeValid.value)

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
    :width="TuningPanel && tuningOpen ? 800 : 700"
    :accent="ACCENT"
    design="modula"
    brand-lead="SIBILANCE EDITOR"
    :engaged="preview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    apply-feature="sibilanceEditor"
    :apply-disabled="!preview || !envelopeValid || treatedCount === 0"
    :apply-disabled-hint="!preview
      ? 'Turn the Sibilance Editor on to apply it'
      : !hasAnalysis
        ? 'Analyse the selection first'
        : isStale
          ? 'Selection moved outside the analysed region — analyse again'
          : 'No events are above their ceiling — lower it to treat some'"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="se-grid">
      <div class="se-meter">
        <LevelMeter variant="modula" scale-side="left" :levels="inputLevels" label="IN" :height="METER_H" />
      </div>

      <div class="se-display">
        <!-- Live reduction at the playhead, matching every other effect's meter.
             The envelope's planned maximum is a different quantity and lives in
             the status line, where it does not look like a meter.
             12 dB full scale, not the shared 24: de-essing lives in the 3–8 dB
             range, and even on the voltage-law scale a shallower face gives
             those few dB more of the bar. The composable already holds the peak
             of each event and releases slowly, so the bar's own damping is off —
             two stages of smoothing would put the reading behind the audio. -->
        <GainReductionBar
          :reduction-db="reductionDb" :accent="ACCENT"
          :full-scale-db="12" ballistics="none"
        />

        <!-- Analyse: the frozen half -->
        <div class="se-analyse">
          <div class="se-analyse-text">
            <span class="m-caption">Sibilance detection</span>
            <p class="se-hint">
              Runs once on the server. The controls below re-shape the result
              without re-detecting.
            </p>
          </div>
          <ModulaButton
            variant="accent" :disabled="analyzing || !hasSelection"
            @click="runAnalyze"
          >{{ analyzing ? 'Analysing…' : 'Analyse' }}</ModulaButton>
        </div>

        <p class="se-status" :class="{ 'is-warn': isStale }">{{ statusLine }}</p>
      </div>

      <div class="se-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="outputLevels" label="OUT" :height="METER_H" />
      </div>
    </div>

    <!-- Attenuation: the live half -->
    <div class="se-knobs">
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="params.stridentCeilingDb" :min="-12" :max="18" :step="0.5"
        :default-value="D.stridentCeilingDb" label="/s/ Ceiling" :color="ACCENT" :format-value="fmtDb"
        :disabled="controlsOff"
        title="How far above the voice a strident sibilant (s, sh, z) may rise before it is turned down. Double-click to reset"
        @update:model-value="v => syncParam('stridentCeilingDb', v)"
      />
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="params.nonStridentCeilingDb" :min="-18" :max="12" :step="0.5"
        :default-value="D.nonStridentCeilingDb" label="/f/ Ceiling" :color="ACCENT" :format-value="fmtDb"
        :disabled="controlsOff"
        title="The same ceiling for the softer non-strident sounds (f, th), which sit lower. Double-click to reset"
        @update:model-value="v => syncParam('nonStridentCeilingDb', v)"
      />
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="params.reductionRatio" :min="0" :max="1" :step="0.01"
        :default-value="D.reductionRatio" label="Amount" :color="ACCENT" :format-value="fmtPct"
        :disabled="controlsOff"
        title="How much of the excess above the ceiling is taken off. Double-click to reset"
        @update:model-value="v => syncParam('reductionRatio', v)"
      />
      <ModulaKnob
        variant="small" :size="52" show-value editable :parse-value="t => Math.abs(parseFloat(t))"
        :model-value="params.maxReductionDb" :min="0" :max="24" :step="0.5"
        :default-value="D.maxReductionDb" label="Max Cut" :color="ACCENT" :format-value="fmtCut"
        :disabled="controlsOff"
        title="The deepest any one event is turned down. Double-click to reset"
        @update:model-value="v => syncParam('maxReductionDb', v)"
      />
    </div>

    <!-- Fade shaping -->
    <div class="se-fades">
      <p class="se-hint se-fades-text">
        How quickly each cut arrives and leaves. Affricates get their own
        timing so the reduction lands before the burst.
      </p>
      <div class="se-fades-knobs">
        <ModulaKnob
          variant="small" :size="44" show-value editable
          :model-value="params.fricativeInMs" :min="0.5" :max="20" :step="0.5"
          :default-value="D.fricativeInMs" label="Fric In" :color="ACCENT" :format-value="fmtMs"
          :disabled="controlsOff"
          title="How fast a fricative's cut arrives. Double-click to reset"
          @update:model-value="v => syncParam('fricativeInMs', v)"
        />
        <ModulaKnob
          variant="small" :size="44" show-value editable
          :model-value="params.fricativeOutMs" :min="0.5" :max="20" :step="0.5"
          :default-value="D.fricativeOutMs" label="Fric Out" :color="ACCENT" :format-value="fmtMs"
          :disabled="controlsOff"
          title="How fast a fricative's cut lets go. Double-click to reset"
          @update:model-value="v => syncParam('fricativeOutMs', v)"
        />
        <ModulaKnob
          variant="small" :size="44" show-value editable
          :model-value="params.affricateInMs" :min="0.5" :max="20" :step="0.5"
          :default-value="D.affricateInMs" label="Affr In" :color="ACCENT" :format-value="fmtMs"
          :disabled="controlsOff"
          title="How fast an affricate's cut arrives. Double-click to reset"
          @update:model-value="v => syncParam('affricateInMs', v)"
        />
        <ModulaKnob
          variant="small" :size="44" show-value editable
          :model-value="params.affricateOutMs" :min="0.5" :max="20" :step="0.5"
          :default-value="D.affricateOutMs" label="Affr Out" :color="ACCENT" :format-value="fmtMs"
          :disabled="controlsOff"
          title="How fast an affricate's cut lets go. Double-click to reset"
          @update:model-value="v => syncParam('affricateOutMs', v)"
        />
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
  </FloatingWindow>
</template>

<style scoped>
.se-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}
.se-meter {
  display: flex;
  justify-content: center;
  padding: 12px 4px;
}
.se-display {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.se-analyse {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(0, 0, 0, .35);
  box-shadow: 0 -1px 0 rgba(255, 255, 255, .04);
}
.se-analyse-text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.se-hint {
  margin: 0;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-4);
}
.se-status {
  margin: 0;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-3);
}
.se-status.is-warn { color: #ffb27a; }
.se-knobs,
.se-fades {
  margin-top: 12px;
  padding: 14px 12px 12px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.se-knobs {
  display: flex;
  align-items: flex-start;
  justify-content: space-around;
  gap: 8px;
}
.se-fades {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.se-fades-text { max-width: 230px; }
.se-fades-knobs { display: flex; gap: 14px; }
</style>
