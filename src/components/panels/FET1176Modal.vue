<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { useFET1176 } from '../../composables/useFET1176.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { attackSecondsForDial, releaseSecondsForDial } from '../../audio/fet1176Processor.js'
import Knob from '../knobs/Knob.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import VuMeter from '../meters/VuMeter.vue'
import FloatingPluginPanel from './FloatingPluginPanel.vue'

const {
  fetInput, fetOutput, fetAttack, fetRelease, fetRatio, fetDrive, fetScHpf, fetMix,
  fetAutoMakeup, fetPreview, fetReduction, fetInputDb, fetOutputDb, hasSelection,
  togglePreview, syncInput, syncOutput, syncAttack, syncRelease, syncRatio,
  syncDrive, syncScHpf, syncMix, toggleAutoMakeup, refreshAutoMakeup,
  apply, teardown, closeModal,
} = useFET1176()

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

const METER_OPTIONS = [
  { value: 'gr', label: 'GR', title: 'Gain reduction' },
  { value: 'vu4', label: '+4', title: 'Output level, 0 VU = -18 dBFS' },
  { value: 'vu8', label: '+8', title: 'Output level, 0 VU = -14 dBFS' },
]

const meterMode = ref('gr')
const vuReference = computed(() => (meterMode.value === 'vu8' ? -14 : -18))

const ratioCaption = computed(() => RATIO_CAPTIONS[fetRatio.value] ?? '')

function close() {
  teardown()
  closeModal()
}

async function applyAndClose() {
  await apply()
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
  <FloatingPluginPanel
    :width="700"
    :top="130"
    :accent="ACCENT"
    brand-lead="FET"
    brand-tail="PUNCH"
    background="linear-gradient(155deg,#171a1f,#0b0d10 60%)"
    header-background="linear-gradient(#1e2229,#13161a)"
    :engaged="fetPreview"
    @toggle-engaged="togglePreview"
    @close="close"
  >
    <template #header-center>
      <span style="font:600 9.5px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.32)">
        FET LIMITING AMPLIFIER
      </span>
    </template>

    <div class="px-[26px] pt-[20px] pb-[26px]">
      <!-- Meter bay: VU movement on the left, gain staging on the right -->
      <div class="flex items-start gap-[26px]">
        <div class="w-[248px] shrink-0 flex flex-col items-center gap-[10px]">
          <VuMeter
            class="w-full"
            :mode="meterMode === 'gr' ? 'gr' : 'vu'"
            :reduction-db="Math.abs(fetReduction)"
            :level-db="fetOutputDb"
            :reference-dbfs="vuReference"
            :accent="ACCENT"
          />
          <SegmentedSwitch
            v-model="meterMode"
            :options="METER_OPTIONS"
            :accent="ACCENT"
            :padding-x="16"
          />
        </div>

        <div class="flex-1 flex items-center justify-between gap-[14px]">
          <LevelMeter :db="fetInputDb" label="IN" :height="132" />

          <div class="flex-1 flex justify-center gap-[26px]">
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
                  :readonly="fetAutoMakeup"
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
                   plugin keeps Output level-matched to the input so pushing
                   Input is a change of character, not of loudness. -->
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

          <LevelMeter :db="fetOutputDb" label="OUT" :height="132" />
        </div>
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

      <button
        class="w-full flex items-center justify-center gap-1.5 mt-4 py-2.5 rounded-full border-none cursor-pointer transition-opacity disabled:opacity-60 disabled:cursor-default"
        style="background:linear-gradient(90deg,#79b8ff,#4f8fd6);color:#0c1218;font:800 13px 'Inter';letter-spacing:.02em"
        :disabled="!hasSelection || !fetPreview"
        @click="applyAndClose"
      >
        {{ !fetPreview ? 'Turn on FET Punch to apply' : hasSelection ? 'Apply compression' : 'Make a selection on the waveform to apply' }}
      </button>
    </div>
  </FloatingPluginPanel>
</template>
