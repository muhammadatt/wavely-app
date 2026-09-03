<script setup>
import { computed, onMounted, watch } from 'vue'
import { useLA2A } from '../../composables/useLA2A.js'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import { OPTO_SMOOTH_PRESET_PLUGIN } from '../../audio/pluginPresets/index.js'
import PresetMenu from './PresetMenu.vue'
import { useEditorState } from '../../composables/useEditorState.js'
import Knob from '../knobs/Knob.vue'
import DeviceChoiceRocker from '../knobs/DeviceChoiceRocker.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  la2aMode, la2aPeakReduction, la2aGain, la2aR37,
  la2aAutoMakeup, la2aAutoMakeupBusy, toggleAutoMakeup: toggleAuto,
  la2aPreview, la2aReduction, la2aInputLevels, la2aOutputLevels,
  togglePreview, syncMode, syncPeakReduction, syncGain,
  syncR37, toggleAutoMakeup, refreshAutoMakeup, resetLiveMakeup, apply, teardown, closeModal,
} = useLA2A()

const { state } = useEditorState()

// Default to engaged when the panel opens
onMounted(() => {
  if (!la2aPreview.value) togglePreview()
})

// The makeup is measured from the selected region, so a new selection needs
// a fresh measurement.
// A new selection is new material: the live tracker's extrema describe the old
// region, so they are cleared before the offline measurement re-runs.
watch(() => state.selection, () => { resetLiveMakeup(); refreshAutoMakeup() }, { deep: true })

const autoMakeupLabel = computed(() =>
  la2aAutoMakeup.value && la2aAutoMakeupBusy.value ? 'AUTO' : 'AUTO'
)

const ACCENT = '#f5a623'

const MODE_OPTIONS = [
  { value: 'compress', label: 'COMP' },
  { value: 'limit', label: 'LIMIT' },
]

// Preview is just transport playback: the worklet is already in the chain, so
// what makes this effect "live" is that the audio is running while you turn the
// knobs. Reuses the existing toggle-play bus rather than a second play path.
function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

// The shell removes itself from the window manager; this only has to stop the
// preview chain and the meter loop.
function close() {
  teardown()
}

async function applyAndClose() {
  await apply()
  // apply() already disables the preview, but the meter loop is still running.
  teardown()
  closeModal()
}

function formatPeakReduction(v) {
  return String(Math.round(v))
}
function formatGain(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

/**
 * Presets. This replaced a mock dropdown that displayed four names and changed
 * nothing — the placeholder that made this plugin the one asking for a real
 * preset architecture.
 *
 * Reading the params is just the knobs. Writing them has one ordering
 * constraint worth stating: the Gain knob goes LAST and goes through the AUTO
 * decision, because `syncGain` is a take-over — it drops AUTO and accepts the
 * value. Setting the gain before deciding the AUTO state would therefore leave
 * AUTO off whatever the preset asked for.
 */
const presets = usePluginPresets(OPTO_SMOOTH_PRESET_PLUGIN, {
  read: () => ({
    mode: la2aMode.value,
    peakReduction: la2aPeakReduction.value,
    gain: la2aGain.value,
    r37: la2aR37.value,
    autoMakeup: la2aAutoMakeup.value,
  }),
  write: (p) => {
    syncMode(p.mode)
    syncPeakReduction(p.peakReduction)
    syncR37(p.r37)
    if (p.autoMakeup) {
      // Already on: the syncs above have each scheduled a re-measure, so the
      // knob lands on the new settings without a second toggle.
      if (!la2aAutoMakeup.value) toggleAuto()
    } else {
      if (la2aAutoMakeup.value) toggleAuto()
      syncGain(p.gain)
    }
  },
})
</script>

<template>
  <FloatingWindow
    window-id="opto-smooth"
    :z="z"
    :width="640"
    :accent="ACCENT"
    brand-lead="OPTO"
    brand-tail="SMOOTH"
    :engaged="la2aPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!la2aPreview"
    apply-disabled-hint="Turn OptoSmooth on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <template #header-center>
      <PresetMenu
        :presets="presets"
        :accent="ACCENT"
        :disabled="!la2aPreview"
        disabled-hint="Turn OptoSmooth on to use presets"
      />
    </template>

    <div class="px-[26px] pt-[22px] pb-[28px]">
      <GainReductionBar :reduction-db="la2aReduction" :accent="ACCENT" />

      <!-- IN meter · knobs · OUT meter -->
      <div class="flex items-center justify-between gap-[22px] mt-[24px]">
        <LevelMeter :levels="la2aInputLevels" label="IN" />

        <div class="flex-1 flex justify-center gap-[40px]">
          <div class="w-[130px]">
            <Knob
              :model-value="la2aPeakReduction"
              @update:model-value="syncPeakReduction"
              :min="0" :max="100" :step="1"
              label="Peak Reduction" :accent="ACCENT" :format-value="formatPeakReduction"
              :disabled="!la2aPreview"
            />
          </div>
          <div class="w-[130px] flex flex-col items-center">
            <div class="relative w-full" :style="{ opacity: la2aAutoMakeup ? 0.78 : 1 }">
              <Knob
                :model-value="la2aGain"
                @update:model-value="syncGain"
                :min="-12" :max="24" :step="0.1"
                label="Gain" :accent="ACCENT" :format-value="formatGain"
                :disabled="!la2aPreview"
              />
              <span
                v-if="la2aAutoMakeup"
                class="absolute top-[2px] right-[4px] px-1.5 py-[2px] rounded-full pointer-events-none"
                style="background:rgba(245,166,35,.2);border:1px solid rgba(245,166,35,.4);font:700 7px/1 'JetBrains Mono',monospace;letter-spacing:.09em;color:#f7c877"
              >AUTO</span>
            </div>
            <!-- Auto makeup drives the Gain knob above to whatever restores
                 the input's PEAK level — classic makeup, so the quiet parts
                 come up while the peaks land where they started. The knob stays
                 draggable while AUTO is lit: touching it takes over and drops
                 AUTO, which is the only way a user can set a gain and have it
                 stick. Discarding the drag instead reads as a broken knob. -->
            <button
              class="mt-[7px] px-2.5 py-[4px] rounded-full cursor-pointer transition-all disabled:cursor-default"
              :style="{
                background: la2aAutoMakeup ? 'rgba(245,166,35,.16)' : 'rgba(255,255,255,.05)',
                border: `1px solid ${la2aAutoMakeup ? 'rgba(245,166,35,.42)' : 'rgba(255,255,255,.09)'}`,
                color: la2aAutoMakeup ? '#f7c877' : 'rgba(255,255,255,.4)',
                font: `700 8.5px 'JetBrains Mono',monospace`,
                letterSpacing: '.1em',
                opacity: la2aPreview ? 1 : 0.4,
              }"
              :disabled="!la2aPreview"
              :title="la2aAutoMakeup
                ? 'Auto makeup on. Click to take manual control.'
                : 'Auto makeup off. Click to let the plugin automatically set the output gain.'"
              @click="toggleAutoMakeup"
            >{{ autoMakeupLabel }}</button>
          </div>
        </div>

        <LevelMeter :levels="la2aOutputLevels" label="OUT" />
      </div>

      <!-- Secondary row: Comp/Limit mode + the R37 side-chain trimmer.
           ⚠ THERE IS NO SATURATION CONTROL, AND THAT IS THE HARDWARE. A Tube
           Drive knob used to sit beside R37; an LA-2A has no such thing, and
           the knob was really moving the level at which the output valves
           saturate. Gain drives them now, as it does on the unit — see
           TUBE_DRIVE_LIN in la2aProcessor.js. -->
      <div class="flex items-center justify-between mt-[20px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <!-- Compress / Limit — the hardware's rear-panel switch -->
        <DeviceChoiceRocker
          :model-value="la2aMode"
          @update:model-value="syncMode"
          :options="MODE_OPTIONS"
          :accent="ACCENT"
          :disabled="!la2aPreview"
          label="Mode"
          :caption="la2aMode === 'compress' ? '~3:1 leveling' : 'hard ceiling'"
        />

        <div class="flex gap-[26px]">
          <!-- R37 filters the SIDE-CHAIN, not the audio, and it reads as knob
               rotation like the hardware trimmer: 100 is fully clockwise and
               flat, which is the factory position and where it sits by default.
               Winding it DOWN attenuates the side-chain below 1 kHz by up to
               10 dB, so the cell stops reacting to plosives and rides the
               presence band instead. Nothing here is audible on its own — it
               changes what the compressor listens to. -->
          <div class="w-[78px]">
            <Knob
              :model-value="la2aR37"
              @update:model-value="syncR37"
              :min="0" :max="100" :step="1" :value-font-px="13"
              label="R37" :accent="ACCENT"
              :disabled="!la2aPreview"
            />
          </div>
        </div>
      </div>
    </div>
  </FloatingWindow>
</template>
