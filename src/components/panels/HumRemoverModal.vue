<script setup>
/**
 * Hum Remover.
 *
 * Analyse finds mains hum and its harmonics on the selection; each harmonic is
 * a row the user can tick, and every ticked one gets a narrow notch. Width and
 * depth are live.
 *
 * Modula layout: the mains choice, the Analyse row and the harmonic table sit
 * in the centre well between the IN and OUT ladders, the two notch controls in
 * a panel below.
 */
import { computed, onMounted } from 'vue'
import { useHumRemover } from '../../composables/useHumRemover.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { HUM_NOTCH_DEFAULTS } from '../../audio/effects/humNotch.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaButton from '../modula/ModulaButton.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  humFundamental, humQ, humDepth, humHarmonics, humAnalysis, humAnalyzing,
  humPreview, humInputLevels, humOutputLevels, isStale, hasEnabledNotches, hasSelection,
  togglePreview, analyze, toggleHarmonic, setFundamental, syncQ, syncDepth,
  apply, teardown, closeModal,
} = useHumRemover()

const { state } = useEditorState()

onMounted(() => {
  // The chain's copy keeps its ON/BYPASS: opening its editor from the chain
  // must not un-bypass its slot.
  if (!humPreview.value && currentPluginCopy() === 'solo') togglePreview()
})

const ACCENT = '#e8a33d'
const METER_H = 214
const D = HUM_NOTCH_DEFAULTS

const MAINS_OPTIONS = [
  { value: 60, label: '60 Hz', title: 'US, Canada, Japan (east)' },
  { value: 50, label: '50 Hz', title: 'Europe, UK, Australia, Asia' },
]

const enabledCount = computed(() => humHarmonics.value.filter(h => h.enabled).length)

const statusLine = computed(() => {
  if (humAnalyzing.value) return 'Analysing…'
  if (!humAnalysis.value) return 'Analyse the selection to find mains hum.'
  if (humAnalysis.value.tooShort) {
    return 'Selection too short — analyse at least one second.'
  }
  if (isStale.value) return 'Audio changed since analysis — analyse again.'
  const a = humAnalysis.value
  const vetoed = a.detectionDetail.filter(d => d.flagged && d.matchesPitchedSource)
  if (!a.triggered && enabledCount.value === 0) {
    if (vetoed.length > 0) {
      const list = vetoed.map(d => `${d.frequency} Hz`).join(', ')
      return `Energy at ${list} follows a ${a.pitchedSourceHz} Hz source in the recording, not mains hum.`
    }
    return `No hum found. Anchor ${a.anchorFrequency} Hz was ${a.anchorDeltaDb} dB above the floor.`
  }
  const suffix = vetoed.length > 0
    ? ` ${vetoed.length} left out as part of the recording.`
    : ''
  return `${enabledCount.value} notch${enabledCount.value === 1 ? '' : 'es'} active.${suffix}`
})

function formatQ(v) {
  return `Q ${Math.round(v)}`
}

function formatDepth(v) {
  return `−${v.toFixed(0)} dB`
}

/**
 * Bar width for a harmonic's prominence. Full scale is 48 dB: real hum sits
 * roughly 20–50 dB above the local noise floor, so a narrower scale pins every
 * detection to the end of the track and stops conveying anything.
 */
const DELTA_FULL_SCALE_DB = 48

function deltaWidth(deltaDb) {
  if (deltaDb === null) return 0
  return Math.max(0, Math.min(100, (deltaDb / DELTA_FULL_SCALE_DB) * 100))
}

/**
 * Accessible name for a harmonic's toggle. The visible row is a bar and a
 * number, so the label has to carry the frequency, how prominent it is, and
 * whether the pitch check attributed it to the recording — everything a
 * sighted user reads off the row before deciding.
 */
function harmonicToggleLabel(h) {
  if (h.deltaDb === null) return `${h.frequency} Hz — not analysed`
  const prominence = `${h.deltaDb.toFixed(1)} dB above the surrounding floor`
  if (h.matchesPitchedSource) {
    return `${h.frequency} Hz, ${prominence}, matches a pitched source in the recording`
  }
  return `${h.frequency} Hz, ${prominence}`
}

/**
 * Why a harmonic was attributed to the recording rather than to the mains.
 *
 * Deliberately says "source" rather than "voice": the check is an F0 contour,
 * and a bass, a cello or a held synth note trips it exactly as a narrator does.
 */
function pitchedTooltip(h) {
  const pitch = humAnalysis.value?.pitchedSourceHz
  if (!pitch) return 'This looks like part of the recording rather than hum.'
  const which = h.pitchHarmonic === 1
    ? `the pitch of a sustained source in this selection (${pitch} Hz)`
    : `harmonic ${h.pitchHarmonic} of a sustained source in this selection (${pitch} Hz)`
  return `${h.frequency} Hz is ${which}, so this energy is probably content, not hum. Notching it will thin the recording. Tick it anyway if you can hear hum here.`
}

function rejectionLabel(h) {
  if (h.flagged) return null
  switch (h.rejectionReason) {
    case 'anchor-failed': return 'no hum signature'
    case 'below-absolute-floor': return 'too quiet'
    case 'below-threshold': return 'not prominent enough'
    case 'anchor-coherence': return 'louder than the hum pattern'
    case 'selection-too-short': return '—'
    default: return null
  }
}

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
    window-id="hum-remover"
    :z="z"
    :width="700"
    :accent="ACCENT"
    design="modula"
    brand-lead="HUM REMOVER"
    :engaged="humPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!humPreview || !hasEnabledNotches"
    :apply-disabled-hint="!humPreview
      ? 'Turn Hum Remover on to apply it'
      : 'Analyse and select at least one frequency to notch'"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="hr-grid">
      <div class="hr-meter">
        <LevelMeter variant="modula" scale-side="left" :levels="humInputLevels" label="IN" :height="METER_H" />
      </div>

      <div class="hr-display">
        <!-- Mains frequency + analyse -->
        <div class="hr-top">
          <div class="hr-mains">
            <span class="m-caption">Mains frequency</span>
            <ModulaSegmented
              :model-value="humFundamental" :options="MAINS_OPTIONS"
              aria-label="Mains frequency" :disabled="humAnalyzing"
              @update:model-value="setFundamental"
            />
          </div>
          <ModulaButton
            variant="accent" :disabled="humAnalyzing || !hasSelection"
            @click="analyze"
          >{{ humAnalyzing ? 'Analysing…' : 'Analyse' }}</ModulaButton>
        </div>

        <!-- Harmonic table -->
        <div class="hr-table">
          <div class="hr-row hr-head">
            <span></span><span>Freq</span><span>Above floor</span><span class="hr-right">Δ dB</span>
          </div>

          <div v-if="humHarmonics.length === 0" class="hr-empty">No analysis yet.</div>

          <div v-for="h in humHarmonics" :key="h.frequency" class="hr-row hr-item">
            <!-- Reads as a checkbox to assistive tech: the visual tick and
                 the accent fill are the only other cue that a row is on. -->
            <button
              class="hr-check m-focusable" :class="{ 'is-on': h.enabled }"
              role="checkbox"
              :aria-checked="h.enabled"
              :aria-label="harmonicToggleLabel(h)"
              :title="h.enabled ? 'Notching this frequency' : 'Leave this frequency alone'"
              :disabled="h.deltaDb === null"
              @click="toggleHarmonic(h.frequency)"
            >
              <svg
                v-if="h.enabled" viewBox="0 0 24 24" class="hr-tick"
                fill="none" stroke="currentColor" stroke-width="4"
                stroke-linecap="round" stroke-linejoin="round"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>

            <span class="hr-freq">{{ h.frequency }}</span>

            <!-- Prominence bar, plus why a harmonic was left unticked -->
            <div class="hr-bar-cell">
              <div class="hr-track">
                <div
                  class="hr-fill" :class="{ 'is-flagged': h.flagged }"
                  :style="{ width: `${deltaWidth(h.deltaDb)}%` }"
                />
              </div>
              <span v-if="h.matchesPitchedSource" class="hr-tag is-warn" :title="pitchedTooltip(h)">IN SOURCE</span>
              <span v-else-if="rejectionLabel(h)" class="hr-tag">{{ rejectionLabel(h) }}</span>
            </div>

            <span class="hr-right hr-delta">{{ h.deltaDb === null ? '—' : h.deltaDb.toFixed(1) }}</span>
          </div>
        </div>

        <p class="hr-status" :class="{ 'is-warn': isStale }">{{ statusLine }}</p>
      </div>

      <div class="hr-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="humOutputLevels" label="OUT" :height="METER_H" />
      </div>
    </div>

    <!-- Notch shape -->
    <div class="hr-shape">
      <p class="hr-hint">
        Narrow cuts at the mains frequency and its harmonics. Deeper and wider
        removes more hum but takes more of the recording with it.
      </p>
      <div class="hr-knobs">
        <ModulaKnob
          variant="small" :size="52" show-value editable
          :model-value="humQ" :min="5" :max="60" :step="1"
          :default-value="D.q" label="Width" :color="ACCENT" :format-value="formatQ"
          :disabled="!humPreview"
          title="How narrow each notch is: higher Q cuts less around the hum. Double-click to reset"
          @update:model-value="syncQ"
        />
        <ModulaKnob
          variant="small" :size="52" show-value editable :parse-value="t => Math.abs(parseFloat(t))"
          :model-value="humDepth" :min="0" :max="40" :step="1"
          :default-value="D.depth" label="Depth" :color="ACCENT" :format-value="formatDepth"
          :disabled="!humPreview"
          title="How far each notch cuts. Double-click to reset"
          @update:model-value="syncDepth"
        />
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.hr-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}
.hr-meter { display: flex; justify-content: center; padding: 12px 4px; }
.hr-display {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.hr-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.hr-mains { display: flex; flex-direction: column; gap: 8px; }
.hr-table {
  padding: 8px 10px 4px;
  border-radius: 10px;
  background: #0b0e13;
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, .85), 0 0 0 1px #1c222c, 0 1px 0 rgba(255, 255, 255, .05);
}
.hr-row {
  display: grid;
  grid-template-columns: 26px 62px 1fr 58px;
  align-items: center;
  column-gap: 10px;
}
.hr-head {
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, .08);
  font: 700 8.5px/1 var(--m-font-mono);
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--m-ink-4);
}
.hr-item { padding: 7px 0; border-bottom: 1px solid rgba(255, 255, 255, .05); }
.hr-item:last-child { border-bottom: none; }
.hr-right { text-align: right; }
.hr-empty {
  padding: 22px 0;
  text-align: center;
  font: 500 10.5px var(--m-font-ui);
  color: var(--m-ink-4);
}
.hr-check {
  width: 16px;
  height: 16px;
  padding: 0;
  border-radius: 4px;
  cursor: pointer;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, .3);
  color: #1b1408;
}
.hr-check.is-on { background: var(--m-accent); border-color: var(--m-accent); }
.hr-check:disabled { opacity: .4; cursor: default; }
.hr-tick { display: block; width: 100%; height: 100%; }
.hr-freq { font: 600 11px var(--m-font-mono); color: var(--m-ink-2); }
.hr-bar-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
.hr-track {
  flex: 1;
  height: 5px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(255, 255, 255, .08);
}
.hr-fill {
  height: 100%;
  border-radius: 999px;
  background: rgba(255, 255, 255, .28);
  transition: width .15s ease;
}
.hr-fill.is-flagged { background: var(--m-accent); }
.hr-tag {
  font: 500 8.5px var(--m-font-ui);
  color: var(--m-ink-4);
  white-space: nowrap;
}
.hr-tag.is-warn { font: 700 7.5px var(--m-font-mono); letter-spacing: .08em; color: #ffb27a; }
.hr-delta { font: 600 11px var(--m-font-mono); color: var(--m-ink-3); }
.hr-status { margin: 0; font: 500 10px/1.5 var(--m-font-ui); color: var(--m-ink-3); }
.hr-status.is-warn { color: #ffb27a; }
.hr-shape {
  margin-top: 12px;
  padding: 14px 16px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.hr-hint { margin: 0; max-width: 300px; font: 500 10px/1.5 var(--m-font-ui); color: var(--m-ink-4); }
.hr-knobs { display: flex; gap: 26px; }
</style>
