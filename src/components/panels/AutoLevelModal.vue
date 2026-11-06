<script setup>
/**
 * Auto Leveler.
 *
 * An OFFLINE process (see useAutoLevel.js): set the controls, press Apply,
 * listen in the editor, Undo if it is wrong. One button runs speech detection
 * on the server, the phrase analysis and gain solve here, and commits the
 * result. Pro only — the footer button carries the PRO tag and opens the
 * upgrade prompt for anyone else.
 *
 * The controls are deliberately the preset's own parameter names rather than a
 * simplified "amount" knob. This plugin exists for the user who is going to
 * check the result against ACX, and a leveler whose caps and deadband are
 * hidden cannot be reasoned about against a compliance report.
 *
 * Modula layout: what Apply will do (and what the last run did) in the top
 * well, the four limits under it, and the target mode with its two knobs in a
 * second row.
 */
import { computed } from 'vue'
import { useAutoLevel, skipReasonText } from '../../composables/useAutoLevel.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { AUTOLEVEL_DEFAULTS } from '../../audio/dsp/autoLevel.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaButton from '../modula/ModulaButton.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  params, processing, lastResult, hasSelection,
  syncParam, resetParams, apply, closeModal,
} = useAutoLevel()

const { state } = useEditorState()

const ACCENT = '#e8a33d'
const D = AUTOLEVEL_DEFAULTS

const fmtDb = v => `${v.toFixed(2)} dB`
const fmtDb1 = v => `${v.toFixed(1)} dB`
const fmtSecs = v => `${Math.round(v)} s`
const fmtFloor = v => `${v.toFixed(0)} dBFS`

const TARGET_OPTIONS = [
  { value: 'global', label: 'WHOLE SELECTION', title: 'One level held throughout the selection' },
  { value: 'running_median', label: 'ROLLING', title: 'Follows a moving median, so a deliberate change in delivery survives' },
]

function duration(sec) {
  if (sec < 60) return `${sec.toFixed(1)} s`
  const m = Math.floor(sec / 60)
  return `${m} min ${String(Math.round(sec - m * 60)).padStart(2, '0')} s`
}

const statusLine = computed(() => {
  if (processing.value) return 'Detecting speech and levelling…'
  if (!hasSelection.value) return 'Select the audio to level, or Select all.'
  const { start, end } = state.selection
  return `Level finds the phrases in the ${duration(end - start)} selection and evens them out; listen to the result in the editor afterwards.`
})

/** What the last run did — a past action, labelled as one. */
const lastLine = computed(() => {
  const r = lastResult.value
  if (!r) return null
  if (r.reason) return `Last run: ${skipReasonText(r.reason)}`
  const m = r.measurements
  return `Last run: ${m.clip_count_after_merge} phrases levelled — ` +
    `spread ${m.input_clip_lufs_std_db.toFixed(1)} → ` +
    `${m.output_clip_lufs_std_db.toFixed(1)} dB, ` +
    `${m.gain_max_down_db.toFixed(1)} to +${m.gain_max_up_db.toFixed(1)} dB applied.`
})

/**
 * The headroom cap is the one thing that silently changes what the controls
 * can do, so it says so rather than leaving Max Boost looking broken.
 */
const capNote = computed(() => {
  const m = lastResult.value?.measurements
  if (!m?.noise_floor_cap_active) return null
  return m.max_up_effective_db <= 0.01
    ? 'Room tone was too close to the floor target to lift anything — only cuts were made.'
    : `Boost was capped at ${m.max_up_effective_db.toFixed(1)} dB to keep room tone under the floor target.`
})

async function applyAndClose() {
  if (await apply()) closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="auto-leveler"
    :z="z"
    :width="660"
    :accent="ACCENT"
    design="modula"
    brand-lead="AUTO LEVELER"
    :show-engage="false"
    offline
    show-apply
    apply-feature="autoLevel"
    :apply-disabled="processing"
    apply-disabled-hint="Auto Leveler is running"
    @apply="applyAndClose"
  >
    <div class="al-display">
      <span class="m-caption">Phrase levelling</span>
      <p class="al-status">{{ statusLine }}</p>
      <p v-if="lastLine" class="al-status al-last">{{ lastLine }}</p>
      <p v-if="capNote" class="al-status is-warn">{{ capNote }}</p>
    </div>

    <!-- Limits: how far any phrase may move -->
    <div class="al-knobs">
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="params.deadband_db" :min="0" :max="6" :step="0.05"
        :default-value="D.deadband_db" label="Deadband" :color="ACCENT" :format-value="fmtDb"
        :disabled="processing"
        title="How far a phrase may sit from the target before it is touched at all. Double-click to reset"
        @update:model-value="v => syncParam('deadband_db', v)"
      />
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="params.knee_db" :min="0.1" :max="6" :step="0.1"
        :default-value="D.knee_db" label="Knee" :color="ACCENT" :format-value="fmtDb1"
        :disabled="processing"
        title="How gently the correction fades in past the deadband. Double-click to reset"
        @update:model-value="v => syncParam('knee_db', v)"
      />
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="params.max_up_db" :min="0" :max="18" :step="0.5"
        :default-value="D.max_up_db" label="Max Boost" :color="ACCENT" :format-value="fmtDb1"
        :disabled="processing"
        title="The most any phrase is lifted. Double-click to reset"
        @update:model-value="v => syncParam('max_up_db', v)"
      />
      <ModulaKnob
        variant="small" :size="52" show-value editable
        :model-value="params.max_down_db" :min="0" :max="18" :step="0.5"
        :default-value="D.max_down_db" label="Max Cut" :color="ACCENT" :format-value="fmtDb1"
        :disabled="processing"
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
        <ModulaButton variant="ghost" size="sm" :disabled="processing" @click="resetParams">Reset</ModulaButton>
      </div>

      <div class="al-target-controls">
        <ModulaSegmented
          :model-value="params.target_mode" :options="TARGET_OPTIONS"
          aria-label="Target" :disabled="processing"
          @update:model-value="v => syncParam('target_mode', v)"
        />
        <ModulaKnob
          variant="small" :size="44" show-value editable
          :model-value="params.target_window_s" :min="10" :max="120" :step="5"
          :default-value="D.target_window_s" label="Window" :color="ACCENT" :format-value="fmtSecs"
          :disabled="processing || params.target_mode !== 'running_median'"
          title="How much recent speech the rolling median looks at. Double-click to reset"
          @update:model-value="v => syncParam('target_window_s', v)"
        />
        <ModulaKnob
          variant="small" :size="44" show-value editable
          :model-value="params.noise_floor_target_dbfs" :min="-80" :max="-40" :step="1"
          :default-value="D.noise_floor_target_dbfs" label="Floor" :color="ACCENT" :format-value="fmtFloor"
          :disabled="processing"
          title="The room-tone level boosts are not allowed to push past. Double-click to reset"
          @update:model-value="v => syncParam('noise_floor_target_dbfs', v)"
        />
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.al-display {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.al-hint {
  margin: 0;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-4);
}
.al-hint b { font-weight: 700; color: var(--m-ink-3); }
.al-status {
  margin: 0;
  font: 500 10px/1.5 var(--m-font-ui);
  color: var(--m-ink-3);
}
.al-status.is-warn { color: #ffb27a; }
.al-status.al-last { color: var(--m-ink-2, #d6dbe0); }
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
