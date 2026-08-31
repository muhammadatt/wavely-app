<script setup>
import { computed, onMounted, watch } from 'vue'
import { useFET1176 } from '../../composables/useFET1176.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { attackSecondsForDial, releaseSecondsForDial } from '../../audio/fet1176Processor.js'
import Knob from '../knobs/Knob.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'
import PresetMenu from './PresetMenu.vue'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import { FET_PUNCH_PRESET_PLUGIN } from '../../audio/pluginPresets/index.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  fetInput, fetOutput, fetAttack, fetRelease, fetRatio, fetDrive, fetScHpf, fetMix,
  fetAutoMakeup, fetPreview, fetReduction, fetInputLevels, fetOutputLevels,
  togglePreview, syncInput, syncOutput, syncAttack, syncRelease, syncRatio,
  syncDrive, syncScHpf, syncMix, toggleAutoMakeup, refreshAutoMakeup,
  apply, teardown, closeModal,
} = useFET1176()

/**
 * Presets. Same two functions and the same ordering constraint as OptoSmooth:
 * Output goes last and through the AUTO decision, because `syncOutput` is a
 * take-over that drops AUTO and accepts the value.
 */
const presets = usePluginPresets(FET_PUNCH_PRESET_PLUGIN, {
  read: () => ({
    inputDrive: fetInput.value,
    output: fetOutput.value,
    attack: fetAttack.value,
    release: fetRelease.value,
    ratio: fetRatio.value,
    fetDrive: fetDrive.value,
    scHpf: fetScHpf.value,
    mix: fetMix.value,
    autoMakeup: fetAutoMakeup.value,
  }),
  write: (p) => {
    syncInput(p.inputDrive)
    syncAttack(p.attack)
    syncRelease(p.release)
    syncRatio(p.ratio)
    syncDrive(p.fetDrive)
    syncScHpf(p.scHpf)
    syncMix(p.mix)
    if (p.autoMakeup) {
      if (!fetAutoMakeup.value) toggleAutoMakeup()
    } else {
      if (fetAutoMakeup.value) toggleAutoMakeup()
      syncOutput(p.output)
    }
  },
})

const { state } = useEditorState()

// Default to engaged when the panel opens
onMounted(() => {
  if (!fetPreview.value) togglePreview()
})

// The makeup is measured from the selected region, so a new selection needs
// a fresh measurement.
watch(() => state.selection, () => refreshAutoMakeup(), { deep: true })

// Steel blue rather than the OptoSmooth's amber — at a glance you can tell
// which of the two is on screen.
const ACCENT = '#79b8ff'

const RATIO_OPTIONS = [
  { value: '4', label: '4:1', title: 'Gentle enough to leave on a whole take' },
  { value: '8', label: '8:1', title: 'Firm control' },
  { value: '12', label: '12:1', title: 'Peak taming' },
  { value: '20', label: '20:1', title: 'Effectively limiting' },
  { value: 'all', label: 'ALL', title: 'All buttons in — the "British mode" trick' },
]

const RATIO_CAPTIONS = {
  4: 'gentle — safe on a whole take',
  8: 'firm control',
  12: 'peak taming',
  20: 'effectively limiting',
  all: 'all buttons in — crushed, lagging, loud',
}

const SC_HPF_OPTIONS = [
  { value: 0, label: 'OFF', title: 'Stock broadband detector' },
  { value: 90, label: '90', title: 'Stops plosives and rumble from ducking the take' },
  { value: 150, label: '150', title: 'Keeps chest weight out of the detector entirely' },
]

const ratioCaption = computed(() => RATIO_CAPTIONS[fetRatio.value] ?? '')

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

function formatInteger(v) {
  return String(Math.round(v))
}
function formatGain(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}
function formatPercent(v) {
  return String(Math.round(v * 100))
}

function formatMs(seconds) {
  const ms = seconds * 1000
  if (ms < 1) return `${Math.round(ms * 1000)} µs`
  if (ms < 100) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

const attackTime = computed(() => formatMs(attackSecondsForDial(fetAttack.value)))
const releaseTime = computed(() => formatMs(releaseSecondsForDial(fetRelease.value)))
</script>

<template>
  <FloatingWindow
    window-id="fet-punch"
    :z="z"
    :width="700"
    :top="130"
    :accent="ACCENT"
    brand-lead="FET"
    brand-tail="PUNCH"
    :engaged="fetPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!fetPreview"
    apply-disabled-hint="Turn FET Punch on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <template #header-center>
      <PresetMenu
        :presets="presets"
        :accent="ACCENT"
        :disabled="!fetPreview"
        disabled-hint="Turn FET Punch on to use presets"
      />
    </template>

    <div class="px-[26px] pt-[20px] pb-[26px]">
      <!-- Gain reduction across the full width, then the gain staging under it.
           Same meter and same layout as the OptoSmooth panel: the two
           compressors are meant to be compared, and they cannot be compared
           through two different instruments. -->
      <GainReductionBar :reduction-db="fetReduction" :accent="ACCENT" />

      <div class="flex items-center justify-between gap-[14px] mt-[24px]">
        <LevelMeter :levels="fetInputLevels" label="IN" :height="132" />

        <div class="flex-1 flex justify-center gap-[40px]">
          <div class="w-[118px]">
            <!-- Input is the only threshold control there is: it drives the
                 audio path and the detector together, exactly as the
                 hardware attenuator does. -->
            <Knob
              :model-value="fetInput"
              @update:model-value="syncInput"
              :min="0" :max="100" :step="1"
              label="Input" :accent="ACCENT" :format-value="formatInteger"
              :disabled="!fetPreview"
            />
          </div>
          <div class="w-[118px] flex flex-col items-center">
            <div class="relative w-full" :style="{ opacity: fetAutoMakeup ? 0.78 : 1 }">
              <Knob
                :model-value="fetOutput"
                @update:model-value="syncOutput"
                :min="-36" :max="24" :step="0.1"
                label="Output" :accent="ACCENT" :format-value="formatGain"
                :disabled="!fetPreview"
              />
              <span
                v-if="fetAutoMakeup"
                class="absolute top-[2px] right-[4px] px-1.5 py-[2px] rounded-full pointer-events-none"
                :style="{
                  background: `color-mix(in srgb, ${ACCENT} 20%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${ACCENT} 40%, transparent)`,
                  font: `700 7px/1 'JetBrains Mono',monospace`,
                  letterSpacing: '.09em',
                  color: `color-mix(in srgb, ${ACCENT} 65%, #ffffff)`,
                }"
              >AUTO</span>
            </div>
            <!-- Auto makeup matters more here than on the OptoSmooth:
                 Input feeds the audio path too, so driving the unit harder
                 swings the output level by tens of dB. With AUTO on, the
                 plugin restores the input's PEAK level, so pushing Input
                 raises the quiet parts rather than the whole signal. The knob
                 stays draggable while AUTO is lit: touching it takes over and
                 drops AUTO, so a gain the user sets actually sticks. -->
            <button
              class="mt-[7px] px-2.5 py-[4px] rounded-full cursor-pointer transition-all disabled:cursor-default"
              :style="{
                background: fetAutoMakeup ? `color-mix(in srgb, ${ACCENT} 16%, transparent)` : 'rgba(255,255,255,.05)',
                border: `1px solid ${fetAutoMakeup ? `color-mix(in srgb, ${ACCENT} 42%, transparent)` : 'rgba(255,255,255,.09)'}`,
                color: fetAutoMakeup ? `color-mix(in srgb, ${ACCENT} 65%, #ffffff)` : 'rgba(255,255,255,.4)',
                font: `700 8.5px 'JetBrains Mono',monospace`,
                letterSpacing: '.1em',
                opacity: fetPreview ? 1 : 0.4,
              }"
              :disabled="!fetPreview"
              :title="fetAutoMakeup
                ? 'Auto makeup on. Click to take manual control of Output.'
                : 'Auto makeup off. Click to let the plugin match Output to the input level.'"
            @click="toggleAutoMakeup"
            >AUTO</button>
          </div>
        </div>

        <LevelMeter :levels="fetOutputLevels" label="OUT" :height="132" />
      </div>

      <!-- Ratio buttons + sidechain filter, and the ballistics -->
      <div class="flex items-start justify-between gap-[20px] mt-[18px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <div class="flex flex-col gap-[12px] pt-[6px]">
          <div class="flex items-center gap-[10px]">
            <span class="w-[46px]" style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.4)">RATIO</span>
            <SegmentedSwitch
              :model-value="fetRatio"
              @update:model-value="syncRatio"
              :options="RATIO_OPTIONS"
              :accent="ACCENT"
              :disabled="!fetPreview"
              :padding-x="11"
              :caption="ratioCaption"
            />
          </div>
          <div class="flex items-center gap-[10px]">
            <span class="w-[46px]" style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.4)">SC HPF</span>
            <!-- Not on the original: the 1176's detector is broadband, which
                 lets plosives duck a whole phrase. Off is the stock path. -->
            <SegmentedSwitch
              :model-value="fetScHpf"
              @update:model-value="syncScHpf"
              :options="SC_HPF_OPTIONS"
              :accent="ACCENT"
              :disabled="!fetPreview"
              :padding-x="13"
            />
          </div>
        </div>

        <div class="flex gap-[18px]">
          <div class="w-[72px] flex flex-col items-center">
            <!-- Dial numbering follows the panel: 7 is the FASTEST position,
                 not the slowest. -->
            <Knob
              :model-value="fetAttack"
              @update:model-value="syncAttack"
              :min="1" :max="7" :step="1" :value-font-px="13"
              label="Attack" :accent="ACCENT" :format-value="formatInteger"
              :disabled="!fetPreview"
            />
            <span class="mt-[3px]" style="font:600 8px 'JetBrains Mono',monospace;color:rgba(255,255,255,.32)">{{ attackTime }}</span>
          </div>
          <div class="w-[72px] flex flex-col items-center">
            <Knob
              :model-value="fetRelease"
              @update:model-value="syncRelease"
              :min="1" :max="7" :step="1" :value-font-px="13"
              label="Release" :accent="ACCENT" :format-value="formatInteger"
              :disabled="!fetPreview"
            />
            <span class="mt-[3px]" style="font:600 8px 'JetBrains Mono',monospace;color:rgba(255,255,255,.32)">{{ releaseTime }}</span>
          </div>
          <div class="w-[72px]">
            <Knob
              :model-value="fetDrive"
              @update:model-value="syncDrive"
              :min="0" :max="1" :step="0.01" :value-font-px="13"
              label="FET Drive" :accent="ACCENT" :format-value="formatPercent"
              :disabled="!fetPreview"
            />
          </div>
          <div class="w-[72px]">
            <!-- Blends the untouched input back in — parallel compression
                 without a second track. -->
            <Knob
              :model-value="fetMix"
              @update:model-value="syncMix"
              :min="0" :max="1" :step="0.01" :value-font-px="13"
              label="Mix" :accent="ACCENT" :format-value="formatPercent"
              :disabled="!fetPreview"
            />
          </div>
        </div>
      </div>
    </div>
  </FloatingWindow>
</template>
