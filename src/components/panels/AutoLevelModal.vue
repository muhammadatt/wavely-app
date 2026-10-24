<script setup>
/**
 * Auto Leveler.
 *
 * Three-speed, and the panel says so: Analyse runs voice-activity detection on
 * the server once, the clip analysis that follows is local, and every control
 * below re-solves from it in milliseconds. Nothing here can trigger a round
 * trip except the Analyse button.
 *
 * The controls are deliberately the preset's own parameter names rather than a
 * simplified "amount" knob. This plugin exists for the user who is going to
 * check the result against ACX, and a leveler whose caps and deadband are
 * hidden cannot be reasoned about against a compliance report.
 *
 * Modula layout: the gain bar and the analysis sit in the centre well between
 * the IN and OUT ladders, the four live controls under them, and the target
 * mode with its two knobs in a second row.
 */
import { computed, onMounted } from 'vue'
import { useAutoLevel } from '../../composables/useAutoLevel.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { AUTOLEVEL_DEFAULTS } from '../../audio/dsp/autoLevel.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaButton from '../modula/ModulaButton.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainRideBar from '../meters/GainRideBar.vue'
import FloatingWindow from './FloatingWindow.vue'
import { useEntitlements } from '../../composables/useEntitlements.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  params, preview, analyzing, prepared, solved,
  gainDb, inputLevels, outputLevels,
  hasAnalysis, hasSelection, isStale, curveValid, analyzedRegion, skipReason,
  togglePreview, syncParam, resetParams, analyze, apply, teardown, closeModal,
} = useAutoLevel()

const { state } = useEditorState()

onMounted(() => {
  // The chain's copy keeps its ON/BYPASS: opening its editor from the chain
  // must not un-bypass its slot.
  if (!preview.value && currentPluginCopy() === 'solo') togglePreview()
})

const ACCENT = '#e8a33d'
const METER_H = 190
const D = AUTOLEVEL_DEFAULTS

const fmtDb = v => `${v.toFixed(2)} dB`
const fmtDb1 = v => `${v.toFixed(1)} dB`
const fmtSecs = v => `${Math.round(v)} s`
const fmtFloor = v => `${v.toFixed(0)} dBFS`

const TARGET_OPTIONS = [
  { value: 'global', label: 'WHOLE SELECTION', title: 'One level held throughout the selection' },
  { value: 'running_median', label: 'ROLLING', title: 'Follows a moving median, so a deliberate change in delivery survives' },
]

function fmtTime(sec) {
  const m = Math.floor(sec / 60)
  const s = (sec - m * 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}

const measurements = computed(() => solved.value?.measurements ?? null)

const statusLine = computed(() => {
  if (analyzing.value) return 'Detecting speech…'
  if (!prepared.value) return 'Analyse the selection to find its phrases.'
  if (isStale.value) {
    const r = analyzedRegion.value
    return r
      ? `Selection is outside the analysed ${fmtTime(r.start)}–${fmtTime(r.end)} — analyse again.`
      : 'Audio changed since analysis — analyse again.'
  }
  if (skipReason.value) return skipReason.value

  const m = measurements.value
  if (!m) return 'Analysed.'
  return `${m.clip_count_after_merge} phrases levelled — ` +
    `spread ${m.input_clip_lufs_std_db.toFixed(1)} → ` +
    `${m.output_clip_lufs_std_db.toFixed(1)} dB, ` +
    `${m.gain_max_down_db.toFixed(1)} to +${m.gain_max_up_db.toFixed(1)} dB applied.`
})

/**
 * The headroom cap is the one thing that silently changes what the controls
 * can do, so it says so rather than leaving Max Boost looking broken.
 */
const capNote = computed(() => {
  const m = measurements.value
  if (!m?.noise_floor_cap_active) return null
  return m.max_up_effective_db <= 0.01
    ? `Room tone is too close to the ${params.value.noise_floor_target_dbfs} dBFS ` +
      `target to lift anything — cuts only.`
    : `Boost capped at ${m.max_up_effective_db.toFixed(1)} dB to keep room tone ` +
      `under ${params.value.noise_floor_target_dbfs} dBFS.`
})

const applyHint = computed(() => {
  if (!preview.value) return 'Turn the leveler on to apply it'
  if (!hasAnalysis.value) return 'Analyse the selection first'
  if (isStale.value) return 'Selection moved outside the analysed region — analyse again'
  return skipReason.value ?? 'Nothing to level'
})

/** The live controls work only on a fresh analysis with the leveler on. */
const controlsOff = computed(() => !preview.value || !hasAnalysis.value)

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

// Longest stretch the server will analyse for this user (Infinity with Pro).
const entitlements = useEntitlements()
const previewLimit = computed(() => entitlements.previewLimit('autoLevel'))
</script>

<template>
  <FloatingWindow
    window-id="auto-leveler"
    :z="z"
    :width="700"
    :accent="ACCENT"
    design="modula"
    brand-lead="AUTO LEVELER"
    :engaged="preview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    apply-feature="autoLevel"
    :apply-disabled="!preview || !curveValid"
    :apply-disabled-hint="applyHint"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="al-grid">
      <div class="al-meter">
        <LevelMeter variant="modula" scale-side="left" :levels="inputLevels" label="IN" :height="METER_H" />
      </div>

      <div class="al-display">
        <!-- Signed, because the boosts are the point. 12 dB half-scale matches
             the default caps: a bar whose ends are unreachable wastes its width. -->
        <GainRideBar :gain-db="gainDb" :accent="ACCENT" :full-scale-db="12" />

        <!-- Analyse: the frozen half -->
        <div class="al-analyse">
          <div class="al-analyse-text">
            <span class="m-caption">Speech detection</span>
            <p class="al-hint">
              Runs once on the server. Phrase segmentation and every control
              below are computed here from the result.
            </p>
            <p v-if="previewLimit !== Infinity" class="al-warn">
              Free preview: analyses the first {{ previewLimit }} s. Pro analyses the whole selection.
            </p>
          </div>
          <ModulaButton
            variant="accent" :disabled="analyzing || !hasSelection"
            @click="analyze"
          >{{ analyzing ? 'Analysing…' : 'Analyse' }}</ModulaButton>
        </div>

        <p class="al-status" :class="{ 'is-warn': isStale || skipReason }">{{ statusLine }}</p>
        <p v-if="capNote" class="al-status is-warn">{{ capNote }}</p>
      </div>

      <div class="al-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="outputLevels" label="OUT" :height="METER_H" />
      </div>
    </div>

    <!-- Targeting: the live half -->
    <div class="al-knobs">
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="params.deadband_db" :min="0" :max="6" :step="0.05"
        :default-value="D.deadband_db" label="Deadband" :color="ACCENT" :format-value="fmtDb"
        :disabled="controlsOff"
        title="How far a phrase may sit from the target before it is touched at all. Double-click to reset"
        @update:model-value="v => syncParam('deadband_db', v)"
      />
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="params.knee_db" :min="0.1" :max="6" :step="0.1"
        :default-value="D.knee_db" label="Knee" :color="ACCENT" :format-value="fmtDb1"
        :disabled="controlsOff"
        title="How gently the correction fades in past the deadband. Double-click to reset"
        @update:model-value="v => syncParam('knee_db', v)"
      />
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="params.max_up_db" :min="0" :max="18" :step="0.5"
        :default-value="D.max_up_db" label="Max Boost" :color="ACCENT" :format-value="fmtDb1"
        :disabled="controlsOff"
        title="The most any phrase is lifted. Double-click to reset"
        @update:model-value="v => syncParam('max_up_db', v)"
      />
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="params.max_down_db" :min="0" :max="18" :step="0.5"
        :default-value="D.max_down_db" label="Max Cut" :color="ACCENT" :format-value="fmtDb1"
        :disabled="controlsOff"
        title="The most any phrase is turned down. Double-click to reset"
        @update:model-value="v => syncParam('max_down_db', v)"
      />
    </div>

    <!-- Target: what each phrase is levelled towards -->
    <div class="al-target">
      <div class="al-target-text">
        <p class="al-hint">
          What each phrase is levelled towards. <b>Whole selection</b> holds one
          level throughout; <b>rolling</b> follows a moving median, so a
          deliberate change in delivery survives.
        </p>
        <ModulaButton variant="ghost" size="sm" @click="resetParams">Reset</ModulaButton>
      </div>

      <div class="al-target-controls">
        <ModulaSegmented
          :model-value="params.target_mode" :options="TARGET_OPTIONS"
          aria-label="Target" :disabled="controlsOff"
          @update:model-value="v => syncParam('target_mode', v)"
        />
        <ModulaKnob
          variant="small" :size="44" show-value editable
          :model-value="params.target_window_s" :min="10" :max="120" :step="5"
          :default-value="D.target_window_s" label="Window" :color="ACCENT" :format-value="fmtSecs"
          :disabled="controlsOff || params.target_mode !== 'running_median'"
          title="How much recent speech the rolling median looks at. Double-click to reset"
          @update:model-value="v => syncParam('target_window_s', v)"
        />
        <ModulaKnob
          variant="small" :size="44" show-value editable
          :model-value="params.noise_floor_target_dbfs" :min="-80" :max="-40" :step="1"
          :default-value="D.noise_floor_target_dbfs" label="Floor" :color="ACCENT" :format-value="fmtFloor"
          :disabled="controlsOff"
          title="The room-tone level boosts are not allowed to push past. Double-click to reset"
          @update:model-value="v => syncParam('noise_floor_target_dbfs', v)"
        />
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.al-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}
.al-meter {
  display: flex;
  justify-content: center;
  padding: 12px 4px;
}
.al-display {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.al-analyse {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(0, 0, 0, .35);
  box-shadow: 0 -1px 0 rgba(255, 255, 255, .04);
}
.al-analyse-text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.al-hint {
  margin: 0;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-4);
}
.al-hint b { font-weight: 700; color: var(--m-ink-3); }
.al-warn {
  margin: 0;
  font: 600 10px/1.45 var(--m-font-ui);
  color: var(--m-accent);
}
.al-status {
  margin: 0;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-3);
}
.al-status.is-warn { color: #ffb27a; }
.al-knobs,
.al-target {
  margin-top: 12px;
  padding: 14px 12px 12px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.al-knobs {
  display: flex;
  align-items: flex-start;
  justify-content: space-around;
  gap: 8px;
}
.al-target {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.al-target-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  max-width: 250px;
}
.al-target-controls {
  display: flex;
  align-items: center;
  gap: 18px;
}
</style>
