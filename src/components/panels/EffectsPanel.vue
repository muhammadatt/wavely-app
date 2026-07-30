<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { normalizeRegion, computePeakCache } from '../../audio/processing.js'
import { getTimelineDuration } from '../../audio/operations.js'
import { applyVocalSaturation } from '../../api/spotEffects.js'
import { useLA2A } from '../../composables/useLA2A.js'
import { useFET1176 } from '../../composables/useFET1176.js'

const {
  state, hasSelection, getAudioContext, replaceRegion, setPeakCache,
  startProcessing, updateProcessingProgress, endProcessing, showToast, totalDuration,
} = useEditorState()

// Normalize params
const targetPeak = ref(-1)
// Noise Reduction params
const noiseStrength = ref(50)
const noiseSensitivity = ref(60)
// Remove Silence params
const silenceThreshold = ref(-40)
const silenceMinLength = ref(5)
// Vocal Saturation params (defaults match server-side script defaults)
const satDrive         = ref(2.0)
const satWetDry        = ref(0.3)
const satBias          = ref(0.5)
const satLowCrossover  = ref(500)
const satMidCrossover  = ref(3500)
const satSoftness      = ref(0.3)
const satLowDriveMult  = ref(5.0)
const satMidDriveMult  = ref(0.1)
const satHighDriveMult = ref(0.1)

const { openModal: openLA2AModal } = useLA2A()
const { openModal: openFET1176Modal } = useFET1176()

const openSection = ref('normalize')

function toggleSection(id) {
  openSection.value = openSection.value === id ? null : id
}

async function applyNormalize(useSelection) {
  const start = useSelection && state.selection ? state.selection.start : 0
  const end = useSelection && state.selection ? state.selection.end : totalDuration.value

  if (start >= end) return

  startProcessing('Normalizing...')
  try {
    const ctx = getAudioContext()
    const buffer = await normalizeRegion(
      state.segments, start, end, targetPeak.value,
      ctx, state.currentFile.sampleRate, state.currentFile.channels
    )
    const bufferId = replaceRegion(start, end, buffer)

    // Recompute peak cache for new buffer
    const cache = await computePeakCache(buffer, 256)
    setPeakCache(bufferId, cache)

    showToast('Normalization applied')
  } catch (err) {
    console.error('Normalize failed:', err)
    showToast('Normalization failed')
  } finally {
    endProcessing()
  }
}

async function applySaturation() {
  if (!state.selection) return
  const { start, end } = state.selection

  startProcessing('Saturating...')
  try {
    const blob = await applyVocalSaturation({
      segments:   state.segments,
      start, end,
      sampleRate: state.currentFile.sampleRate,
      channels:   state.currentFile.channels,
      params: {
        drive:         satDrive.value,
        wetDry:        satWetDry.value,
        bias:          satBias.value,
        lowCrossover:  satLowCrossover.value,
        midCrossover:  satMidCrossover.value,
        softness:      satSoftness.value,
        lowDriveMult:  satLowDriveMult.value,
        midDriveMult:  satMidDriveMult.value,
        highDriveMult: satHighDriveMult.value,
      },
    })

    const ctx = getAudioContext()
    const arrayBuffer = await blob.arrayBuffer()
    const buffer = await ctx.decodeAudioData(arrayBuffer)
    const bufferId = replaceRegion(start, end, buffer)

    const cache = await computePeakCache(buffer, 256)
    setPeakCache(bufferId, cache)

    showToast('Vocal saturation applied')
  } catch (err) {
    console.error('Vocal saturation failed:', err)
    showToast('Vocal saturation failed')
  } finally {
    endProcessing()
  }
}
</script>

<template>
  <div class="font-['Inter']">
    <div class="px-5 pt-5 pb-[14px] border-b border-[rgba(255,255,255,.06)]">
      <div class="text-[15px] font-bold text-[#eaf6f8]">Effects</div>
      <div class="mt-[4px] text-[11.5px] leading-[1.4] text-[rgba(255,255,255,.42)]">Apply to selection or full track</div>
    </div>

    <div class="p-4 flex flex-col gap-[10px]">
      <!-- Normalize -->
      <div class="rounded-[12px] overflow-hidden transition-all border"
           :style="openSection === 'normalize' ? 'border-color:rgba(53,211,230,.4)' : 'border-color:rgba(255,255,255,.07)'">
        <button
          class="w-full flex items-center gap-[10px] px-[13px] py-3 bg-transparent border-none cursor-pointer text-left select-none"
          @click="toggleSection('normalize')"
        >
          <div class="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center shrink-0 transition-colors"
               :style="openSection === 'normalize' ? 'background:rgba(53,211,230,.14)' : 'background:rgba(255,255,255,.04)'">
            <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none" :style="{ color: openSection === 'normalize' ? '#7fe9f6' : 'rgba(255,255,255,.5)' }" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
          <div class="flex-1">
            <div class="text-[13px] font-bold text-[#eaf6f8]">Normalize</div>
            <div class="text-[11px] font-medium mt-[1px] text-[rgba(255,255,255,.42)]">Balance volume levels</div>
          </div>
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none transition-transform shrink-0" stroke="rgba(255,255,255,.35)" stroke-width="2.5"
               :class="{ 'rotate-180': openSection === 'normalize' }">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        <div v-if="openSection === 'normalize'" class="px-[13px] pb-[13px] flex flex-col gap-[10px]">
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Target peak</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ targetPeak }} dBFS</span>
            </div>
            <input type="range" min="-12" max="0" v-model.number="targetPeak"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>

          <button
            class="w-full flex items-center justify-center gap-[7px] border-none rounded-full cursor-pointer py-[10px] text-[12.5px] font-bold tracking-[.02em] transition-opacity disabled:opacity-40 disabled:cursor-default"
            style="color:#08161a;background:linear-gradient(180deg,#4fe0f0,#22b6cf)"
            :disabled="!hasSelection"
            @click="applyNormalize(true)"
          >
            <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Apply Normalize
          </button>

        </div>
      </div>

      <!-- LA-2A Compressor -->
      <div class="rounded-[12px] overflow-hidden transition-all border" style="border-color:rgba(255,255,255,.07)">
        <button
          class="w-full flex items-center gap-[10px] px-[13px] py-3 bg-transparent border-none cursor-pointer text-left select-none"
          @click="openLA2AModal"
        >
          <div class="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center shrink-0" style="background:rgba(255,255,255,.04)">
            <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none" stroke="rgba(255,255,255,.5)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          </div>
          <div class="flex-1">
            <div class="text-[13px] font-bold text-[#eaf6f8]">Opto Smooth</div>
            <div class="text-[11px] font-medium mt-[1px] text-[rgba(255,255,255,.42)]">Subtle, transparent leveler/compressor</div>
          </div>
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none shrink-0" stroke="rgba(255,255,255,.35)" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>

      <!-- FET Punch Compressor -->
      <div class="rounded-[12px] overflow-hidden transition-all border" style="border-color:rgba(255,255,255,.07)">
        <button
          class="w-full flex items-center gap-[10px] px-[13px] py-3 bg-transparent border-none cursor-pointer text-left select-none"
          @click="openFET1176Modal"
        >
          <div class="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center shrink-0" style="background:rgba(255,255,255,.04)">
            <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none" stroke="rgba(255,255,255,.5)" stroke-width="2"><polyline points="13 2 4 14 11 14 10 22 20 10 13 10 13 2"/></svg>
          </div>
          <div class="flex-1">
            <div class="text-[13px] font-bold text-[#eaf6f8]">FET Punch</div>
            <div class="text-[11px] font-medium mt-[1px] text-[rgba(255,255,255,.42)]">Fast, forward, in-your-face compression</div>
          </div>
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none shrink-0" stroke="rgba(255,255,255,.35)" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>

      <!-- Vocal Saturation -->
      <div class="rounded-[12px] overflow-hidden transition-all border"
           :style="openSection === 'saturation' ? 'border-color:rgba(53,211,230,.4)' : 'border-color:rgba(255,255,255,.07)'">
        <button
          class="w-full flex items-center gap-[10px] px-[13px] py-3 bg-transparent border-none cursor-pointer text-left select-none"
          @click="toggleSection('saturation')"
        >
          <div class="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center shrink-0 transition-colors"
               :style="openSection === 'saturation' ? 'background:rgba(53,211,230,.14)' : 'background:rgba(255,255,255,.04)'">
            <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none" :style="{ color: openSection === 'saturation' ? '#7fe9f6' : 'rgba(255,255,255,.5)' }" stroke="currentColor" stroke-width="2"><path d="M3 12c3 0 3-6 6-6s3 12 6 12 3-6 6-6"/></svg>
          </div>
          <div class="flex-1">
            <div class="text-[13px] font-bold text-[#eaf6f8]">Vocal Saturation</div>
            <div class="text-[11px] font-medium mt-[1px] text-[rgba(255,255,255,.42)]">Parallel tube-style warmth</div>
          </div>
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none transition-transform shrink-0" stroke="rgba(255,255,255,.35)" stroke-width="2.5"
               :class="{ 'rotate-180': openSection === 'saturation' }">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        <div v-if="openSection === 'saturation'" class="px-[13px] pb-[13px] flex flex-col gap-[10px]">
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Drive</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ satDrive.toFixed(2) }}</span>
            </div>
            <input type="range" min="0" max="5" step="0.05" v-model.number="satDrive"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Wet / Dry</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ satWetDry.toFixed(2) }}</span>
            </div>
            <input type="range" min="0" max="1" step="0.01" v-model.number="satWetDry"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Bias</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ satBias.toFixed(2) }}</span>
            </div>
            <input type="range" min="0" max="1.5" step="0.01" v-model.number="satBias"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Low crossover</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ satLowCrossover }} Hz</span>
            </div>
            <input type="range" min="100" max="2000" step="10" v-model.number="satLowCrossover"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Mid crossover</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ satMidCrossover }} Hz</span>
            </div>
            <input type="range" min="1000" max="8000" step="50" v-model.number="satMidCrossover"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Softness</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ satSoftness.toFixed(2) }}</span>
            </div>
            <input type="range" min="0" max="1" step="0.01" v-model.number="satSoftness"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Low drive ×</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ satLowDriveMult.toFixed(2) }}</span>
            </div>
            <input type="range" min="0" max="10" step="0.05" v-model.number="satLowDriveMult"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Mid drive ×</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ satMidDriveMult.toFixed(2) }}</span>
            </div>
            <input type="range" min="0" max="10" step="0.05" v-model.number="satMidDriveMult"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">High drive ×</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ satHighDriveMult.toFixed(2) }}</span>
            </div>
            <input type="range" min="0" max="10" step="0.05" v-model.number="satHighDriveMult"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>

          <button
            class="w-full flex items-center justify-center gap-[7px] border-none rounded-full cursor-pointer py-[10px] text-[12.5px] font-bold tracking-[.02em] transition-opacity disabled:opacity-40 disabled:cursor-default"
            style="color:#08161a;background:linear-gradient(180deg,#4fe0f0,#22b6cf)"
            :disabled="!hasSelection"
            @click="applySaturation"
          >
            <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Apply Saturation
          </button>
        </div>
      </div>


      <!-- Noise Reduction -->
      <div class="rounded-[12px] overflow-hidden transition-all border"
           :style="openSection === 'noise' ? 'border-color:rgba(53,211,230,.4)' : 'border-color:rgba(255,255,255,.07)'">
        <button
          class="w-full flex items-center gap-[10px] px-[13px] py-3 bg-transparent border-none cursor-pointer text-left select-none"
          @click="toggleSection('noise')"
        >
          <div class="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center shrink-0 transition-colors"
               :style="openSection === 'noise' ? 'background:rgba(53,211,230,.14)' : 'background:rgba(255,255,255,.04)'">
            <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none" :style="{ color: openSection === 'noise' ? '#7fe9f6' : 'rgba(255,255,255,.5)' }" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 013 3v7a3 3 0 01-6 0V5a3 3 0 013-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3M8 23h8"/></svg>
          </div>
          <div class="flex-1">
            <div class="text-[13px] font-bold text-[#eaf6f8]">Noise Reduction</div>
            <div class="text-[11px] font-medium mt-[1px] text-[rgba(255,255,255,.42)]">Remove background noise</div>
          </div>
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none transition-transform shrink-0" stroke="rgba(255,255,255,.35)" stroke-width="2.5"
               :class="{ 'rotate-180': openSection === 'noise' }">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        <div v-if="openSection === 'noise'" class="px-[13px] pb-[13px] flex flex-col gap-[10px]">
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Strength</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ noiseStrength < 34 ? 'Low' : noiseStrength < 67 ? 'Medium' : 'High' }}</span>
            </div>
            <input type="range" min="0" max="100" v-model.number="noiseStrength"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Sensitivity</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ noiseSensitivity }}%</span>
            </div>
            <input type="range" min="0" max="100" v-model.number="noiseSensitivity"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>
          <button
            class="w-full flex items-center justify-center gap-[7px] border-none rounded-full cursor-pointer py-[10px] text-[12.5px] font-bold tracking-[.02em] transition-opacity disabled:opacity-40 disabled:cursor-default"
            style="color:#08161a;background:linear-gradient(180deg,#4fe0f0,#22b6cf)"
            :disabled="!hasSelection"
            @click="showToast('Spot noise reduction via DeepFilterNet3 — coming in Sprint 2')"
          >
            <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Apply Noise Reduction
          </button>
        </div>
      </div>

      <!-- Remove Silence -->
      <div class="rounded-[12px] overflow-hidden transition-all border"
           :style="openSection === 'trim-silence' ? 'border-color:rgba(53,211,230,.4)' : 'border-color:rgba(255,255,255,.07)'">
        <button
          class="w-full flex items-center gap-[10px] px-[13px] py-3 bg-transparent border-none cursor-pointer text-left select-none"
          @click="toggleSection('trim-silence')"
        >
          <div class="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center shrink-0 transition-colors"
               :style="openSection === 'trim-silence' ? 'background:rgba(53,211,230,.14)' : 'background:rgba(255,255,255,.04)'">
            <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none" :style="{ color: openSection === 'trim-silence' ? '#7fe9f6' : 'rgba(255,255,255,.5)' }" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
          </div>
          <div class="flex-1">
            <div class="text-[13px] font-bold text-[#eaf6f8]">Remove Silence</div>
            <div class="text-[11px] font-medium mt-[1px] text-[rgba(255,255,255,.42)]">Remove quiet sections</div>
          </div>
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none transition-transform shrink-0" stroke="rgba(255,255,255,.35)" stroke-width="2.5"
               :class="{ 'rotate-180': openSection === 'trim-silence' }">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        <div v-if="openSection === 'trim-silence'" class="px-[13px] pb-[13px] flex flex-col gap-[10px]">
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Silence threshold</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ silenceThreshold }} dB</span>
            </div>
            <input type="range" min="-60" max="-10" v-model.number="silenceThreshold"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>
          <div>
            <div class="flex justify-between items-center mb-[6px]">
              <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Min silence length</span>
              <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.4)] tabular-nums">{{ (silenceMinLength / 10).toFixed(1) }} s</span>
            </div>
            <input type="range" min="1" max="30" v-model.number="silenceMinLength"
                   class="w-full h-1.5 rounded-full appearance-none cursor-pointer" style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
          </div>
          <button
            class="w-full flex items-center justify-center gap-[7px] border-none rounded-full cursor-pointer py-[10px] text-[12.5px] font-bold tracking-[.02em] transition-opacity disabled:opacity-40 disabled:cursor-default"
            style="color:#08161a;background:linear-gradient(180deg,#4fe0f0,#22b6cf)"
            :disabled="!hasSelection"
            @click="showToast('Remove silence coming soon')"
          >
            <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Remove Silence
          </button>
        </div>
      </div>

      <div class="text-[11px] font-semibold rounded-[12px] px-3 py-[10px] text-center leading-relaxed transition-opacity duration-700"
           style="color:#e0b84a;background:rgba(224,184,74,.08);border:1px solid rgba(224,184,74,.32)"
           :class="hasSelection ? 'opacity-0' : 'opacity-100'">
        Make a selection on the waveform to apply effects
      </div>

    </div>
  </div>
</template>
