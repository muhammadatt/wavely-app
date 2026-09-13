<script setup>
import { computed } from 'vue'
import { useAutoLevel } from '../../../composables/useAutoLevel.js'
import { useEditorState } from '../../../composables/useEditorState.js'
import FloatingWindow from '../FloatingWindow.vue'
import Knob from '../../knobs/Knob.vue'
import DeviceChoiceRocker from '../../knobs/DeviceChoiceRocker.vue'
import LevelMeter from '../../meters/LevelMeter.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  config, analyzing, preview, gainDb, inputLevels, outputLevels,
  isStale, hasAnalysis, envelopeValid, summary, hasSelection,
  analyze, syncConfig, togglePreview, apply, teardown, closeModal,
} = useAutoLevel()

const { state } = useEditorState()

/**
 * The transport, the way every other faceplate reaches it: a window event, not
 * a composable call. `useEditorState` deliberately does not expose playback —
 * the harness owns it — and destructuring a `togglePlayback` from it silently
 * produced `undefined`, which the preview button would have called on click.
 * `test/ui/composableDestructure.test.js` is what caught that.
 */
function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}


const ACCENT = '#6ee7b7'

const formatDb = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
const formatDbfs = (v) => v.toFixed(0)

/**
 * ⚠ THE READOUT IS SIGNED AND IS NOT A GAIN-REDUCTION BAR. Every other plugin
 * here meters attenuation, because every other plugin only attenuates. A
 * leveller's whole job is to lift quiet passages as well as pull loud ones
 * down, and the lift is the half a user most needs to see — it is what risks
 * bringing the room tone up with it.
 */
const gainText = computed(() => `${gainDb.value >= 0 ? '+' : ''}${gainDb.value.toFixed(1)} dB`)

const statusText = computed(() => {
  if (analyzing.value) return 'Analysing the whole file…'
  const s = summary.value
  if (!s) return 'Analyse to find the phrases and measure their levels.'
  if (!s.applied) {
    return s.reason === 'file_already_leveled'
      ? 'Already level — every phrase is inside the deadband, so nothing is changed.'
      : `Nothing to do (${String(s.reason).replace(/_/g, ' ')}).`
  }
  if (isStale.value) return 'The file changed — analyse again.'
  const parts = [
    `${s.clips} phrase${s.clips === 1 ? '' : 's'}`,
    `spread ${s.clipStdDb.toFixed(1)} dB`,
    `applying ${formatDb(s.minGainDb)} to ${formatDb(s.maxGainDb)} dB`,
  ]
  if (s.merges > 0) parts.push(`${s.merges} merged`)
  return parts.join(' · ')
})

/**
 * Surfaced rather than left implicit: when the noise floor is what caps the
 * lift, the knob is not the thing deciding, and a user turning it further will
 * see nothing happen.
 */
const noiseFloorNote = computed(() => {
  const s = summary.value
  if (!s?.applied || !s.noiseFloorCapped) return null
  return `Lift capped at ${s.maxUpDbEffective.toFixed(1)} dB by the noise floor `
    + `(${s.noiseFloorDbfs.toFixed(0)} dBFS) — raising quiet phrases raises their room tone too.`
})

const applyHint = computed(() => {
  if (!preview.value) return 'Turn Auto Level on to apply it'
  if (!hasAnalysis.value) return 'Analyse the file first'
  if (isStale.value) return 'The file changed — analyse again'
  if (!hasSelection.value) return 'Select the part of the file to write back'
  return ''
})

async function applyAndClose() {
  await apply()
  close()
}

function close() {
  teardown()
  closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="auto-level"
    :z="z"
    :width="560"
    :accent="ACCENT"
    brand-lead="AUTO"
    brand-tail="LEVEL"
    :engaged="preview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!preview || !envelopeValid || !hasSelection"
    :apply-disabled-hint="applyHint"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="px-[26px] pt-[22px] pb-[24px]">
      <div class="flex items-center justify-between gap-[14px]">
        <LevelMeter :levels="inputLevels" label="IN" :height="104" />

        <div class="flex-1 flex flex-col items-center">
          <!-- Signed, and deliberately a number rather than a bar: this gain is
               piecewise constant for seconds at a time, so a meter face would
               sit still and read as broken. -->
          <div
            class="tabular-nums"
            :style="{
              font: `700 26px 'JetBrains Mono',monospace`,
              color: preview ? ACCENT : 'rgba(255,255,255,.25)',
              letterSpacing: '.02em',
            }"
          >{{ gainText }}</div>
          <div
            class="mt-[2px]"
            style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.32)"
          >GAIN AT PLAYHEAD</div>
        </div>

        <LevelMeter :levels="outputLevels" label="OUT" :height="104" />
      </div>

      <div
        class="mt-[20px] pt-[16px] flex items-start justify-center gap-[26px]"
        style="border-top:1px solid rgba(255,255,255,.06)"
      >
        <div class="w-[128px] flex flex-col items-center">
          <DeviceChoiceRocker
            :model-value="config.targetMode"
            :options="[
              { value: 'global', label: 'WHOLE', title: 'One target for the whole file' },
              { value: 'running_median', label: 'LOCAL', title: 'Track a rolling local median' },
            ]"
            :accent="ACCENT"
            label="Target"
            :caption="config.targetMode === 'global'
              ? 'removes whole-file drift'
              : 'follows a slow move'"
            @update:model-value="v => syncConfig('targetMode', v)"
          />
        </div>

        <div class="w-[96px]">
          <Knob
            :model-value="config.maxUpDb"
            @update:model-value="v => syncConfig('maxUpDb', v)"
            :min="0" :max="18" :step="0.5"
            label="Max Up" :accent="ACCENT" :format-value="formatDbfs"
            :value-font-px="15"
          />
        </div>
        <div class="w-[96px]">
          <Knob
            :model-value="config.maxDownDb"
            @update:model-value="v => syncConfig('maxDownDb', v)"
            :min="0" :max="18" :step="0.5"
            label="Max Down" :accent="ACCENT" :format-value="formatDbfs"
            :value-font-px="15"
          />
        </div>
        <div class="w-[96px]">
          <!-- Inside this band nothing is corrected AT ALL — not corrected
               gently. A file already level comes back bit-identical. -->
          <Knob
            :model-value="config.deadbandDb"
            @update:model-value="v => syncConfig('deadbandDb', v)"
            :min="0" :max="6" :step="0.1"
            label="Deadband" :accent="ACCENT" :format-value="v => v.toFixed(1)"
            :value-font-px="15"
          />
        </div>
      </div>

      <div class="mt-[18px] flex items-center gap-[12px]">
        <button
          class="px-3 py-[6px] rounded-full cursor-pointer transition-all disabled:cursor-default shrink-0"
          :style="{
            background: `color-mix(in srgb, ${ACCENT} 16%, transparent)`,
            border: `1px solid color-mix(in srgb, ${ACCENT} 42%, transparent)`,
            color: `color-mix(in srgb, ${ACCENT} 70%, #ffffff)`,
            font: `700 9px 'JetBrains Mono',monospace`,
            letterSpacing: '.12em',
            opacity: analyzing ? 0.5 : 1,
          }"
          :disabled="analyzing"
          title="Measure the whole file and find its phrases"
          @click="analyze"
        >{{ analyzing ? 'ANALYSING…' : (hasAnalysis ? 'RE-ANALYSE' : 'ANALYSE') }}</button>

        <p class="text-[10.5px] leading-[1.45] text-[rgba(255,255,255,.45)]">{{ statusText }}</p>
      </div>

      <p
        v-if="noiseFloorNote"
        class="mt-[10px] text-[10px] leading-[1.45] text-[rgba(255,255,255,.36)]"
      >{{ noiseFloorNote }}</p>

      <p class="mt-[14px] text-[10px] leading-[1.5] text-[rgba(255,255,255,.32)]">
        Auto Level gives each phrase one flat gain and crossfades between them in
        the gaps, so the dynamics inside a phrase are untouched. It measures the
        whole file — phrase targets compare against their neighbours — but writes
        back only the selection.
      </p>
    </div>
  </FloatingWindow>
</template>
