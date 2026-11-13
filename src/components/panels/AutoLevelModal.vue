<script setup>
/**
 * Auto Leveler — the 4b face the Noise Reduction window uses
 * (offlineFace.css), mapped onto the leveler's controls.
 *
 * An OFFLINE process (see useAutoLevel.js): set it up, press Apply, listen in
 * the editor, Undo if it is wrong. One button runs speech detection on the
 * server, the phrase analysis and gain solve here, and commits the result.
 * Pro only — the footer button carries the PRO tag for anyone else.
 *
 *   MODE TILES  the TARGET each phrase is levelled towards: WHOLE SELECTION
 *               (one level) or ROLLING (a moving median), with a line on the
 *               chosen one.
 *   CARDS       PHRASES — Deadband, Knee and the rolling Window (dimmed under
 *               Whole selection) — and LIMITS — Max boost, Max cut and the
 *               room-tone Floor. Every setting is a drag readout: drag, type,
 *               or double-click to reset.
 *   WIDE CARD   the LAST RUN: phrases levelled, spread before → after and the
 *               gain range, measured on the render; the reason when the
 *               leveler declined; the floor note when room tone capped the
 *               boost.
 *
 * The controls keep the preset's own parameter names rather than an "amount"
 * macro: this plugin is for the user checking the result against ACX, and a
 * leveler whose caps and deadband are hidden cannot be reasoned about against
 * a compliance report.
 */
import { computed } from 'vue'
import { useAutoLevel, skipReasonText } from '../../composables/useAutoLevel.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { AUTOLEVEL_DEFAULTS } from '../../audio/dsp/autoLevel.js'
import ModulaField from '../modula/ModulaField.vue'
import FloatingWindow from './FloatingWindow.vue'
import { radioArrowKey, radioTabStop } from '../../ui/radioKeys.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  params, processing, lastResult,
  syncParam, apply, closeModal,
} = useAutoLevel()

const { state } = useEditorState()

const ACCENT = '#e8a33d'
const D = AUTOLEVEL_DEFAULTS

const MODES = [
  { value: 'global', label: 'Whole selection', sub: 'One level throughout' },
  { value: 'running_median', label: 'Rolling', sub: 'Follows the delivery' },
]

const MODE_ABOUT = {
  global: 'Every phrase is levelled towards one level held across the whole selection.',
  running_median: 'Phrases follow a moving median, so a deliberate change in delivery survives.',
}

const rolling = computed(() => params.value.target_mode === 'running_median')

const fmtDb2 = v => `${v.toFixed(2)} dB`
const fmtDb1 = v => `${v.toFixed(1)} dB`
const fmtSecs = v => `${Math.round(v)} s`
const fmtFloor = v => `${Math.round(v)} dBFS`
const parseNum = t => parseFloat(t)

const measurements = computed(() => lastResult.value?.measurements ?? null)
const declined = computed(() => (lastResult.value?.reason ? skipReasonText(lastResult.value.reason) : null))

const resultPhrases = computed(() => (measurements.value ? String(measurements.value.clip_count_after_merge) : '—'))
const resultSpread = computed(() => {
  const m = measurements.value
  return m ? `${m.input_clip_lufs_std_db.toFixed(1)} → ${m.output_clip_lufs_std_db.toFixed(1)} dB` : '—'
})
const resultGain = computed(() => {
  const m = measurements.value
  if (!m) return '—'
  // gain_max_down_db is the solve's signed MINIMUM gain (−3.2 for a 3.2 dB
  // cut, 0 when nothing was cut), so the cut is its magnitude; neither side
  // prints a sign it does not have.
  const cut = Math.max(0, -m.gain_max_down_db)
  const boost = Math.max(0, m.gain_max_up_db)
  return `−${cut.toFixed(1)} / +${boost.toFixed(1)} dB`
})

const modeStop = computed(() => radioTabStop(MODES, m => m.value === params.value.target_mode))

function pickMode(m) {
  if (!processing.value) syncParam('target_mode', m.value)
}

/**
 * The headroom cap is the one thing that silently changes what the controls
 * can do, so it says so rather than leaving Max boost looking broken.
 */
const capNote = computed(() => {
  const m = measurements.value
  if (!m?.noise_floor_cap_active) return null
  return m.max_up_effective_db <= 0.01
    ? 'Room tone was too close to the floor to lift anything — only cuts were made.'
    : `Boost was capped at ${m.max_up_effective_db.toFixed(1)} dB to keep room tone under the floor.`
})

async function applyAndClose() {
  if (await apply()) closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="auto-leveler"
    :z="z"
    :width="560"
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
    <!-- Target mode tiles -->
    <div class="of-tiles" data-help="target" role="radiogroup" aria-label="Level towards">
      <button
        v-for="(m, i) in MODES" :key="m.value"
        type="button" class="of-tile m-focusable" role="radio"
        :class="{ 'is-on': params.target_mode === m.value }"
        :aria-checked="String(params.target_mode === m.value)"
        :tabindex="i === modeStop ? 0 : -1"
        :disabled="processing"
        @click="pickMode(m)" @keydown="radioArrowKey($event, i, MODES, pickMode)"
      >
        <span class="of-tile-label">{{ m.label }}</span>
        <span class="of-tile-sub">{{ m.sub }}</span>
      </button>
    </div>
    <p class="of-mode-about">{{ MODE_ABOUT[params.target_mode] ?? '' }}</p>

    <div class="of-cards">
      <section class="of-card of-col">
        <header class="of-card-head">
          <span class="of-card-name">Phrases</span>
        </header>
        <div class="of-rule"></div>
        <div class="of-card-body">
          <div class="of-row" data-help="deadband" title="How far a phrase may sit from the target before it is touched at all">
            <span class="of-setting">DEADBAND</span>
            <ModulaField
              :model-value="params.deadband_db" :min="0" :max="6" :step="0.05"
              :width="64" :default-value="D.deadband_db" :format-value="fmtDb2" :parse="parseNum"
              :disabled="processing" aria-label="Deadband"
              @update:model-value="v => syncParam('deadband_db', v)"
            />
          </div>
          <div class="of-row" data-help="knee" title="How gently the correction fades in past the deadband">
            <span class="of-setting">KNEE</span>
            <ModulaField
              :model-value="params.knee_db" :min="0.1" :max="6" :step="0.1"
              :width="64" :default-value="D.knee_db" :format-value="fmtDb1" :parse="parseNum"
              :disabled="processing" aria-label="Knee"
              @update:model-value="v => syncParam('knee_db', v)"
            />
          </div>
          <div class="of-row" data-help="window" :class="{ 'is-dim': !rolling }" title="How much recent speech the rolling median looks at — Rolling only">
            <span class="of-setting">WINDOW</span>
            <ModulaField
              :model-value="params.target_window_s" :min="10" :max="120" :step="5"
              :width="64" :default-value="D.target_window_s" :format-value="fmtSecs" :parse="parseNum"
              :disabled="processing || !rolling" aria-label="Rolling window"
              @update:model-value="v => syncParam('target_window_s', v)"
            />
          </div>
        </div>
      </section>

      <section class="of-card of-col">
        <header class="of-card-head">
          <span class="of-card-name">Limits</span>
        </header>
        <div class="of-rule"></div>
        <div class="of-card-body">
          <div class="of-row" data-help="max-boost" title="The most any phrase is lifted">
            <span class="of-setting">MAX BOOST</span>
            <ModulaField
              :model-value="params.max_up_db" :min="0" :max="18" :step="0.5"
              :width="64" :default-value="D.max_up_db" :format-value="fmtDb1" :parse="parseNum"
              :disabled="processing" aria-label="Max boost"
              @update:model-value="v => syncParam('max_up_db', v)"
            />
          </div>
          <div class="of-row" data-help="max-cut" title="The most any phrase is turned down">
            <span class="of-setting">MAX CUT</span>
            <ModulaField
              :model-value="params.max_down_db" :min="0" :max="18" :step="0.5"
              :width="64" :default-value="D.max_down_db" :format-value="fmtDb1" :parse="parseNum"
              :disabled="processing" aria-label="Max cut"
              @update:model-value="v => syncParam('max_down_db', v)"
            />
          </div>
          <div class="of-row" data-help="floor" title="The room-tone level boosts are not allowed to push past">
            <span class="of-setting">FLOOR</span>
            <ModulaField
              :model-value="params.noise_floor_target_dbfs" :min="-80" :max="-40" :step="1"
              :width="64" :default-value="D.noise_floor_target_dbfs" :format-value="fmtFloor" :parse="parseNum"
              :disabled="processing" aria-label="Room tone floor"
              @update:model-value="v => syncParam('noise_floor_target_dbfs', v)"
            />
          </div>
        </div>
      </section>
    </div>

    <!-- Last run -->
    <section class="of-card of-wide al-result" data-help="last-run">
      <div class="of-wide-text">
        <span class="of-card-name">Last run</span>
        <span v-if="declined" class="of-about of-warn">{{ declined }}</span>
        <span v-else-if="capNote" class="of-about of-warn">{{ capNote }}</span>
        <span v-else-if="measurements" class="of-about">Measured on the levelled audio. Undo puts the original back.</span>
        <span v-else class="of-about">Nothing levelled yet in this session.</span>
      </div>
      <div class="al-result-figures">
        <div class="al-figure">
          <span class="of-setting">PHRASES</span>
          <span class="of-readout" :class="{ 'is-empty': !measurements }">{{ resultPhrases }}</span>
        </div>
        <div class="al-figure">
          <span class="of-setting">SPREAD</span>
          <span class="of-readout" :class="{ 'is-empty': !measurements }">{{ resultSpread }}</span>
        </div>
        <div class="al-figure">
          <span class="of-setting">GAIN</span>
          <span class="of-readout" :class="{ 'is-empty': !measurements }">{{ resultGain }}</span>
        </div>
      </div>
    </section>

    <template #offline-note>
      <span v-if="processing" class="of-running">
        <span class="of-running-lamp"></span>
        <span class="of-running-text">{{ state.processingMessage || 'Levelling…' }}</span>
      </span>
      <span v-else class="of-note">No preview - Renders the selection.</span>
    </template>
  </FloatingWindow>
</template>

<style scoped src="./offlineFace.css"></style>
<style scoped>
.of-row.is-dim { opacity: .4; transition: opacity .15s ease; }
.al-result { grid-template-columns: minmax(0, 1fr) auto; }
.al-result-figures { display: flex; gap: 10px; }
.al-figure { display: flex; flex-direction: column; align-items: center; gap: 6px; }
</style>
