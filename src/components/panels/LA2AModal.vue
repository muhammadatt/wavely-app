<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { useLA2A } from '../../composables/useLA2A.js'
import { useEditorState } from '../../composables/useEditorState.js'
import Knob from '../knobs/Knob.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'
import BaseButton from '../ui/BaseButton.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  la2aMode, la2aPeakReduction, la2aGain, la2aTubeDrive, la2aEmphasis,
  la2aAutoMakeup, la2aAutoMakeupBusy,
  la2aPreview, la2aReduction, la2aInputDb, la2aOutputDb, hasSelection,
  togglePreview, syncMode, syncPeakReduction, syncGain, syncTubeDrive,
  syncEmphasis, toggleAutoMakeup, refreshAutoMakeup, apply, teardown, closeModal,
} = useLA2A()

const { state } = useEditorState()

// Default to engaged when the panel opens
onMounted(() => {
  if (!la2aPreview.value) togglePreview()
})

// The makeup is measured from the selected region, so a new selection needs
// a fresh measurement.
watch(() => state.selection, () => refreshAutoMakeup(), { deep: true })

const autoMakeupLabel = computed(() =>
  la2aAutoMakeup.value && la2aAutoMakeupBusy.value ? 'AUTO' : 'AUTO'
)

const ACCENT = '#f5a623'

const MODE_OPTIONS = [
  { value: 'compress', label: 'COMP' },
  { value: 'limit', label: 'LIMIT' },
]

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
function formatPercent(v) {
  return String(Math.round(v * 100))
}

// Preset dropdown — visual mockup only. No presets are defined for this
// effect yet, so selecting an option doesn't change anything.
const MOCK_PRESETS = ['Drum Glue', 'Vocal Bus', 'Master Bus', 'Podcast Voice']
const selectedMockPreset = ref(MOCK_PRESETS[0])
const presetMenuOpen = ref(false)

function togglePresetMenu() {
  presetMenuOpen.value = !presetMenuOpen.value
}

function selectMockPreset(name) {
  selectedMockPreset.value = name
  presetMenuOpen.value = false
}
</script>

<template>
  <FloatingWindow
    window-id="opto-smooth"
    variant="device"
    :z="z"
    :width="640"
    :accent="ACCENT"
    brand-lead="OPTO"
    brand-tail="SMOOTH"
    :engaged="la2aPreview"
    @toggle-engaged="togglePreview"
    @close="close"
  >
    <!-- Preset selector — visual mockup only, not yet wired to real presets -->
    <template #header-center>
      <div class="relative" @pointerdown.stop>
        <button
          class="cursor-pointer"
          style="padding:6px 16px;border-radius:6px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);font:600 10.5px 'Inter';letter-spacing:.05em;color:#e8d4b4"
          @click="togglePresetMenu"
        >
          {{ selectedMockPreset }} ▾
        </button>
        <div v-if="presetMenuOpen"
             class="absolute top-[calc(100%+6px)] left-1/2 -translate-x-1/2 min-w-[150px] rounded-lg overflow-hidden z-10"
             style="background:#221f1a;border:1px solid rgba(255,255,255,.08);box-shadow:0 12px 30px rgba(0,0,0,.5)"
        >
          <button
            v-for="name in MOCK_PRESETS" :key="name"
            class="w-full text-left px-3.5 py-2 border-none cursor-pointer transition-colors"
            :style="{ background: name === selectedMockPreset ? 'rgba(245,166,35,.14)' : 'transparent' }"
            style="font:600 11px 'Inter';color:#e8d4b4"
            @click="selectMockPreset(name)"
          >
            {{ name }}
          </button>
        </div>
      </div>
    </template>

    <div class="px-[26px] pt-[22px] pb-[28px]">
      <GainReductionBar :reduction-db="la2aReduction" :accent="ACCENT" />

      <!-- IN meter · knobs · OUT meter -->
      <div class="flex items-center justify-between gap-[22px] mt-[24px]">
        <LevelMeter :db="la2aInputDb" label="IN" />

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
                :readonly="la2aAutoMakeup"
              />
              <span
                v-if="la2aAutoMakeup"
                class="absolute top-[2px] right-[4px] px-1.5 py-[2px] rounded-full pointer-events-none"
                style="background:rgba(245,166,35,.2);border:1px solid rgba(245,166,35,.4);font:700 7px/1 'JetBrains Mono',monospace;letter-spacing:.09em;color:#f7c877"
              >AUTO</span>
            </div>
            <!-- Auto makeup drives the Gain knob above to whatever keeps
                 the output level-matched to the input, so bypass A/B isn't
                 decided by loudness. Switching it off leaves the knob where
                 it stands and hands control back to the user. -->
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

        <LevelMeter :db="la2aOutputDb" label="OUT" />
      </div>

      <!-- Secondary row: Comp/Limit mode + small knobs (tube drive, R37 emphasis) -->
      <div class="flex items-center justify-between mt-[20px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <!-- Compress / Limit — the hardware's rear-panel switch -->
        <SegmentedSwitch
          :model-value="la2aMode"
          @update:model-value="syncMode"
          :options="MODE_OPTIONS"
          :accent="ACCENT"
          :disabled="!la2aPreview"
          :caption="la2aMode === 'compress' ? '~3:1 leveling' : 'hard ceiling'"
        />

        <div class="flex gap-[26px]">
          <div class="w-[78px]">
            <Knob
              :model-value="la2aTubeDrive"
              @update:model-value="syncTubeDrive"
              :min="0" :max="1" :step="0.01" :value-font-px="13"
              label="Tube Drive" :accent="ACCENT" :format-value="formatPercent"
              :disabled="!la2aPreview"
            />
          </div>
          <div class="w-[78px]">
            <Knob
              :model-value="la2aEmphasis"
              @update:model-value="syncEmphasis"
              :min="0" :max="1" :step="0.01" :value-font-px="13"
              label="R37 Emphasis" :accent="ACCENT" :format-value="formatPercent"
              :disabled="!la2aPreview"
            />
          </div>
        </div>
      </div>

      <BaseButton
        class="mt-3" size="md" block
        color="accent" :accent="ACCENT" text-color="#1a1310"
        :disabled="!hasSelection || !la2aPreview"
        @click="applyAndClose"
      >
        {{ !la2aPreview ? 'Turn on OptoSmooth to apply' : hasSelection ? 'Apply compression' : 'Make a selection on the waveform to apply' }}
      </BaseButton>
    </div>
  </FloatingWindow>
</template>
