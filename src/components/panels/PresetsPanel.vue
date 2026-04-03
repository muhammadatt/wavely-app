<script setup>
import { computed } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  PRESETS, OUTPUT_PROFILES,
  getPresetList, getOutputProfileList, isOutputProfileLocked, formatLoudness,
} from '../../audio/presets.js'
import { processAudioOnServer } from '../../api/processing.js'
import { computePeakCache } from '../../audio/processing.js'
import ProcessingReportPanel from './ProcessingReportPanel.vue'

const {
  state, setPreset, setOutputProfile, setProcessingReport, showToast,
  getAudioContext, replaceRegion, setPeakCache, totalDuration,
  startProcessing, updateProcessingProgress, updateProcessingStage, endProcessing,
} = useEditorState()

// Friendly stage sequence shown while the server processes the audio.
// Each entry has a message (cute/friendly), progress (0-1), and delay in ms.
const PROCESSING_STAGES = [
  { message: 'Getting to know your audio…',       progress: 0.06, delay: 0     },
  { message: 'Clearing out the low rumbles…',      progress: 0.15, delay: 1200  },
  { message: 'Chasing away background gremlins…',  progress: 0.30, delay: 3000  },
  { message: 'Giving your tone a little glow-up…', progress: 0.48, delay: 6500  },
  { message: 'Smoothing out the bumpy bits…',       progress: 0.62, delay: 10000 },
  { message: 'Finding your perfect volume…',        progress: 0.75, delay: 13500 },
  { message: 'Catching any sneaky loud peaks…',     progress: 0.85, delay: 17000 },
  { message: 'Running the final report card…',      progress: 0.93, delay: 20500 },
  { message: 'Almost there — hang tight!',          progress: 0.97, delay: 24000 },
]

const presetList = getPresetList()
const outputProfileList = getOutputProfileList()

const currentPreset = computed(() => PRESETS[state.selectedPreset])
const outputProfileLocked = computed(() => isOutputProfileLocked(state.selectedPreset))
const isOverridden = computed(() =>
  state.selectedOutputProfile !== currentPreset.value?.defaultOutputProfile
)

// Warning for noise_eraser + acx combination
const showNoiseEraserAcxWarning = computed(() =>
  state.selectedPreset === 'noise_eraser' && state.selectedOutputProfile === 'acx'
)

const presetIcons = {
  acx_audiobook: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>',
  podcast_ready: '<path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  voice_ready: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14"/><path d="M15.54 8.46a5 5 0 010 7.07"/>',
  general_clean: '<path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16l-6.4 5.2 2.4-7.2-6-4.8h7.6z"/>',
  noise_eraser: '<path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/><path d="M19 2l-7 7M5 22l7-7" stroke-width="2.5"/>',
}

function compressionLabel(preset) {
  if (!preset) return ''
  if (preset.compression.mode === 'none') return 'None'
  const { mode, ratio } = preset.compression
  return `${ratio}:1 ${mode === 'conditional' ? '(conditional)' : '(always-on)'}`
}

function channelLabel(preset) {
  if (!preset) return ''
  return preset.channelOutput === 'mono' ? 'Mono' : 'Preserve original'
}

async function handleProcess() {
  if (!state.currentFile || state.isProcessing) return

  // Noise Eraser pipeline is not yet implemented
  if (state.selectedPreset === 'noise_eraser') {
    showToast('Noise Eraser is coming soon!')
    return
  }

  startProcessing('Making your audio shine')

  // Fire the first stage immediately (synchronously) so it's visible right away
  updateProcessingStage(PROCESSING_STAGES[0].message)
  updateProcessingProgress(PROCESSING_STAGES[0].progress)

  // Queue the remaining stages
  const stageTimers = PROCESSING_STAGES.slice(1).map(({ message, progress, delay }) =>
    setTimeout(() => {
      updateProcessingStage(message)
      updateProcessingProgress(progress)
    }, delay)
  )

  try {
    const { report, audioBlob, peaks } = await processAudioOnServer({
      segments: state.segments,
      sampleRate: state.currentFile.sampleRate,
      channels: state.currentFile.channels,
      fileName: state.currentFile.name,
      presetId: state.selectedPreset,
      outputProfileId: state.selectedOutputProfile,
    })

    // Decode the processed audio blob into an AudioBuffer
    const ctx = getAudioContext()
    const arrayBuffer = await audioBlob.arrayBuffer()
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer)

    // Replace the entire timeline with the processed audio
    const dur = totalDuration.value
    const bufferId = replaceRegion(0, dur, audioBuffer)

    // Compute peak cache for the new buffer
    const cache = await computePeakCache(audioBuffer, 256)
    setPeakCache(bufferId, cache)

    // Set the processing report
    setProcessingReport(report)

    if (report.acx_certification) {
      const label = report.acx_certification.certificate === 'pass' ? 'PASS' : 'FAIL'
      showToast(`Processing complete — ACX certification: ${label}`)
    } else {
      showToast('Processing complete')
    }
  } catch (err) {
    console.error('Server processing failed:', err)
    showToast(err.message || 'Processing failed')
  } finally {
    stageTimers.forEach(clearTimeout)
    endProcessing()
  }
}
</script>

<template>
  <div>
    <!-- Header -->
    <div class="px-4 pt-[18px] pb-[14px] border-b-2 border-border">
      <div class="font-heading text-[17px] font-black text-ink mb-[3px]">Instant Polish</div>
      <div class="text-[11px] text-ink-lt font-bold">Audio processing presets</div>
    </div>

    <div class="p-3 flex flex-col gap-3">
      <!-- Preset cards -->
      <div class="flex flex-col gap-1.5">
        <button
          v-for="preset in presetList"
          :key="preset.id"
          class="w-full flex items-center gap-2.5 px-[13px] py-3 border-2 rounded-[var(--radius-md)] cursor-pointer text-left select-none transition-all bg-surface"
          :class="state.selectedPreset === preset.id ? 'border-accent shadow-[0_0_0_1px_var(--color-accent)]' : 'border-border hover:border-ink-lt'"
          @click="setPreset(preset.id)"
        >
          <div class="w-[34px] h-[34px] rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 transition-colors"
               :class="state.selectedPreset === preset.id ? 'bg-accent-lt' : 'bg-bg'">
            <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                 :class="state.selectedPreset === preset.id ? 'stroke-accent' : 'stroke-ink-mid'"
                 v-html="presetIcons[preset.id]"></svg>
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-heading text-[13px] font-extrabold text-ink">{{ preset.displayName }}</div>
            <div class="text-[11px] text-ink-lt font-semibold mt-[1px] truncate">{{ preset.description }}</div>
            <span class="inline-block text-[10px] font-bold text-ink-mid bg-bg rounded-[var(--radius-pill)] px-2 py-0.5 mt-1.5">
              {{ preset.audience }}
            </span>
          </div>
        </button>
      </div>

      <!-- Output profile selector -->
      <div>
        <div class="text-[11px] font-bold text-ink-mid mb-2">Output Profile</div>
        <div class="flex gap-1.5 relative"
             :class="{ 'opacity-45 pointer-events-none': outputProfileLocked }">
          <button
            v-for="op in outputProfileList"
            :key="op.id"
            class="flex-1 text-center text-[11px] font-bold py-2 rounded-[var(--radius-sm)] border-2 cursor-pointer transition-all"
            :class="state.selectedOutputProfile === op.id
              ? 'border-accent bg-accent-lt text-accent'
              : 'border-border bg-surface text-ink-mid hover:border-ink-lt'"
            @click="setOutputProfile(op.id)"
          >
            {{ op.displayName }}
          </button>
        </div>
        <!-- Locked indicator -->
        <div v-if="outputProfileLocked" class="flex items-center gap-1 mt-1.5 text-[10px] text-ink-lt font-bold">
          <svg viewBox="0 0 24 24" class="w-3 h-3 fill-none stroke-current" stroke-width="2.5">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
          </svg>
          Locked to {{ OUTPUT_PROFILES[currentPreset?.defaultOutputProfile]?.displayName }}
        </div>
        <!-- Override note -->
        <div v-if="!outputProfileLocked && isOverridden" class="mt-1.5 text-[10px] text-yellow font-bold leading-snug">
          Override: using {{ OUTPUT_PROFILES[state.selectedOutputProfile]?.displayName }} profile with {{ currentPreset?.displayName }} preset
        </div>
        <!-- Noise Eraser + ACX warning -->
        <div v-if="showNoiseEraserAcxWarning" class="mt-1.5 text-[10px] text-accent font-bold leading-snug">
          ACX compliance is not recommended for Noise Eraser output. Separation artifacts may cause ACX human review rejection even if measurements pass.
        </div>
      </div>

      <!-- Preset details -->
      <div class="bg-bg rounded-[var(--radius-md)] p-3 flex flex-col gap-1.5">
        <div class="text-[11px] font-bold text-ink-mid uppercase tracking-wider mb-0.5">Preset Details</div>

        <div class="flex justify-between">
          <span class="text-[11px] font-bold text-ink-mid">Target Loudness</span>
          <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ formatLoudness(currentPreset) }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-[11px] font-bold text-ink-mid">True Peak Ceiling</span>
          <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ currentPreset?.truePeakCeiling }} dBFS</span>
        </div>
        <div class="flex justify-between">
          <span class="text-[11px] font-bold text-ink-mid">Compression</span>
          <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ compressionLabel(currentPreset) }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-[11px] font-bold text-ink-mid">Channel Output</span>
          <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ channelLabel(currentPreset) }}</span>
        </div>
        <div v-if="currentPreset?.noiseFloorTarget" class="flex justify-between">
          <span class="text-[11px] font-bold text-ink-mid">Noise Floor Target</span>
          <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ currentPreset.noiseFloorTarget }} dBFS</span>
        </div>
        <div class="flex justify-between">
          <span class="text-[11px] font-bold text-ink-mid">Character</span>
          <span class="text-[11px] font-bold text-ink-lt">{{ currentPreset?.character }}</span>
        </div>
      </div>

      <!-- Process button -->
      <button
        class="w-full flex items-center justify-center gap-1.5 bg-accent text-white font-heading text-[13px] font-extrabold py-2.5 rounded-[var(--radius-pill)] border-none cursor-pointer transition-all shadow-[0_3px_0_var(--color-accent-dk)] hover:-translate-y-0.5 hover:shadow-[0_5px_0_var(--color-accent-dk),var(--shadow-accent)] active:translate-y-[1px] active:shadow-[0_1px_0_var(--color-accent-dk)] disabled:opacity-45 disabled:cursor-default disabled:translate-y-0 disabled:shadow-none"
        :disabled="state.isProcessing || !state.currentFile"
        @click="handleProcess"
      >
        <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16l-6.4 5.2 2.4-7.2-6-4.8h7.6z"/></svg>
        Process Audio
      </button>

      <!-- Processing report (shown when available) -->
      <div v-if="state.processingReport" class="border-t-2 border-border pt-3">
        <ProcessingReportPanel :report="state.processingReport" />
      </div>
    </div>
  </div>
</template>
