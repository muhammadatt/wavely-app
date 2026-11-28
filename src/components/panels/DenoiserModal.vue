<script setup>
/**
 * Spectral Denoise (prototype) — a browser-only noise-profile denoiser.
 *
 * The display shows the learned noise (dashed), the live input and the live
 * output; under it the profile's source and a Learn-from-selection button,
 * then the three knobs. Everything it measures or renders is the composable's
 * (useDenoiser.js); this file draws.
 */
import { computed } from 'vue'
import { useDenoiser } from '../../composables/useDenoiser.js'
import { DENOISER_DEFAULTS } from '../../audio/effects/denoiser.js'
import { useEditorState } from '../../composables/useEditorState.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaButton from '../modula/ModulaButton.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'
import DenoiseSpectrum from './denoiser/DenoiseSpectrum.vue'
import { usePluginWindow } from '../../composables/usePluginWindow.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  reduction, threshold, smoothing, engaged, delta, learning,
  profile, profileStatus, profileBandsDb,
  inputLevels, outputLevels, reductionDb, inBandsDb, outBandsDb, hasSelection,
  toggleEngaged, toggleDelta, setReduction, setThreshold, setSmoothing,
  learn, apply, teardown, closeModal,
} = useDenoiser()
const { state } = useEditorState()

const { isPlaying, togglePlayback, close, applyAndClose } = usePluginWindow({
  engaged,
  toggle: toggleEngaged,
  apply,
  teardown,
  closeModal,
})

const ACCENT = '#e8a33d'
const METER_H = 214
const D = DENOISER_DEFAULTS

const sampleRate = computed(() => state.currentFile?.sampleRate ?? 44100)

const statusLine = computed(() => {
  const st = profileStatus.value
  const db = v => `${Math.round(v)} dBFS`
  // Where the profile was heard: through the slots ahead of this one, in the chain.
  const through = labels => (labels?.length ? `, after ${labels.join(' → ')}` : '')
  switch (st.kind) {
    case 'learning': return st.step ? `Learning the noise — rendering ${st.step}…` : 'Learning the noise…'
    case 'none': return 'Turn the plugin on to learn the noise from the file’s pauses, or select room tone and press Learn.'
    case 'stale':
      return 'The plugins before this one have changed since the noise was learned. Press Auto or Learn to learn it again.'
    case 'weak':
      return `Noise ${db(st.noiseDb)}${through(st.upstreamLabels)}, only ${Math.round(st.gapDb)} dB under the speech: the file may have few clean pauses. Select a stretch of room tone and press Learn.`
    default: {
      const from = st.source === 'selection' ? 'the selection' : 'the file’s pauses'
      return `Noise learned from ${from}${through(st.upstreamLabels)}: ${db(st.noiseDb)}, ${Math.round(st.gapDb)} dB under the speech.`
    }
  }
})

const readout = computed(() => engaged.value && isPlaying.value
  ? `−${reductionDb.value.toFixed(1)} dB`
  : '—')

const fmtDb = v => `${v.toFixed(0)} dB`
const fmtSignedDb = v => `${v > 0 ? '+' : ''}${v.toFixed(0)} dB`
const fmtPct = v => `${Math.round(v)}`
</script>

<template>
  <FloatingWindow
    window-id="spectral-denoise"
    :z="z"
    :width="720"
    :accent="ACCENT"
    design="modula"
    brand-lead="SPECTRAL"
    brand-tail="DENOISE"
    :engaged="engaged"
    show-delta
    :delta="delta"
    :delta-disabled="!engaged"
    delta-title="Hear only the noise being removed"
    show-preview
    previewable
    :previewing="isPlaying"
    show-apply
    :apply-disabled="!engaged || learning"
    :apply-disabled-hint="learning ? 'Learning the noise…' : 'Turn Spectral Denoise on to apply it'"
    @toggle-engaged="toggleEngaged"
    @toggle-delta="toggleDelta"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="dn-grid">
      <div class="dn-meter" data-help="in-meter">
        <LevelMeter variant="modula" scale-side="left" :levels="inputLevels" label="IN" :height="METER_H" />
      </div>

      <div class="dn-display">
        <div class="dn-scope" data-help="spectrum">
          <DenoiseSpectrum
            :profile-db="profileBandsDb"
            :in-db="inBandsDb"
            :out-db="outBandsDb"
            :live="engaged && isPlaying"
            :sample-rate="sampleRate"
            :accent="ACCENT"
          />
          <div class="dn-legend">
            <span><i class="dn-key is-noise" />Noise × threshold</span>
            <span><i class="dn-key is-in" />In</span>
            <span><i class="dn-key is-out" />Out</span>
            <span class="dn-gr" data-help="removed">Removed {{ readout }}</span>
          </div>
        </div>

        <div class="dn-profile">
          <p class="dn-status" data-help="status" :class="{ 'is-warn': profileStatus.kind === 'weak' || profileStatus.kind === 'stale' }">{{ statusLine }}</p>
          <ModulaButton
            data-help="learn"
            variant="accent"
            :disabled="learning || !hasSelection"
            title="Learn the noise from the selection: select a stretch of room tone with no voice in it"
            @click="learn('selection')"
          >{{ learning ? 'Learning…' : 'Learn' }}</ModulaButton>
          <ModulaButton
            data-help="relearn"
            :disabled="learning || !state.currentFile"
            title="Learn the noise again from the quietest moments of the whole file"
            @click="learn('auto')"
          >Auto</ModulaButton>
        </div>
      </div>

      <div class="dn-meter" data-help="out-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="outputLevels" label="OUT" :height="METER_H" />
      </div>
    </div>

    <div class="dn-knobs-panel">
      <p class="dn-hint">
        Removes steady noise — hiss, fans, room tone. Noise that changes from moment to
        moment passes through. {{ profile ? '' : 'No profile yet.' }}
      </p>
      <div class="dn-knobs">
        <ModulaKnob
          data-help="reduction"
          variant="small" :size="52" show-value editable
          :parse-value="t => Math.abs(parseFloat(t))"
          :model-value="reduction" :min="0" :max="40" :step="1"
          :default-value="D.reduction" label="Reduction" :color="ACCENT" :format-value="fmtDb"
          :disabled="!engaged"
          title="How far the noise is turned down. Double-click to reset"
          @update:model-value="setReduction"
        />
        <ModulaKnob
          data-help="threshold"
          variant="small" :size="52" show-value editable bipolar
          :model-value="threshold" :min="-6" :max="12" :step="1"
          :default-value="D.threshold" label="Threshold" :color="ACCENT" :format-value="fmtSignedDb"
          :disabled="!engaged"
          title="How far above the learned noise a sound must be to be kept. Double-click to reset"
          @update:model-value="setThreshold"
        />
        <ModulaKnob
          data-help="smoothing"
          variant="small" :size="52" show-value editable
          :model-value="smoothing" :min="0" :max="100" :step="1"
          :default-value="D.smoothing" label="Smoothing" :color="ACCENT" :format-value="fmtPct"
          :disabled="!engaged"
          title="Smooths the leftover noise in the pauses. Double-click to reset"
          @update:model-value="setSmoothing"
        />
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.dn-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}
.dn-meter { display: flex; justify-content: center; padding: 12px 4px; }
.dn-display {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.dn-scope {
  padding: 8px;
  border-radius: 10px;
  background: #0b0e13;
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, .85), 0 0 0 1px #1c222c, 0 1px 0 rgba(255, 255, 255, .05);
}
.dn-legend {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 6px;
  font: 600 8.5px/1 var(--m-font-mono);
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--m-ink-4);
}
.dn-key { display: inline-block; width: 12px; height: 2px; margin-right: 5px; vertical-align: middle; }
.dn-key.is-noise { background: repeating-linear-gradient(90deg, rgba(140, 200, 255, .85) 0 3px, transparent 3px 5px); }
.dn-key.is-in { background: rgba(255, 255, 255, .35); }
.dn-key.is-out { background: var(--m-accent); }
.dn-gr { margin-left: auto; color: var(--m-ink-2); }
.dn-profile { display: flex; align-items: center; gap: 10px; }
.dn-status { flex: 1; margin: 0; font: 500 10px/1.5 var(--m-font-ui); color: var(--m-ink-3); }
.dn-status.is-warn { color: #ffb27a; }
.dn-knobs-panel {
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
.dn-hint { margin: 0; max-width: 280px; font: 500 10px/1.5 var(--m-font-ui); color: var(--m-ink-4); }
.dn-knobs { display: flex; gap: 26px; }
</style>
