<script setup>
import { computed, ref } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  PRESETS, OUTPUT_PROFILES,
  getPresetList, getOutputProfileList, isOutputProfileLocked, formatLoudness,
  getDefaultOutputProfile,
} from '../../audio/presets.js'
import { processAudioOnServer } from '../../api/processing.js'
import { computePeakCache } from '../../audio/processing.js'
import { getTimelineDuration } from '../../audio/operations.js'
import ProcessingReportPanel from './ProcessingReportPanel.vue'
import BaseButton from '../ui/BaseButton.vue'
import Icon from '../ui/Icon.vue'

const {
  state, appState, setPreset, setOutputProfile, setProcessingReport, showToast,
  getAudioContext, replaceRegion, setPeakCache, getDocument,
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

// Noise Eraser uses a different progress sequence — separation takes much longer
// than the standard chain. Granular stage labels help users understand the wait.
const NE_PROCESSING_STAGES = [

  { message: 'Measuring your audio…',                   progress: 0.04, delay: 0      },
  { message: 'RNNoise pre-pass — quieting the room…',   progress: 0.10, delay: 1500   },
  { message: 'Removing tonal hum and interference…',    progress: 0.16, delay: 4000   },
  { message: 'Extracting your voice (this takes a while)…', progress: 0.25, delay: 7000  },
  { message: 'AI separation in progress…',              progress: 0.45, delay: 20000  },
  { message: 'Still separating — almost through…',      progress: 0.60, delay: 50000  },
  { message: 'Checking separation quality…',            progress: 0.68, delay: 90000  },
  { message: 'Cleaning up any residual noise…',         progress: 0.74, delay: 100000 },
  { message: 'Restoring high frequencies…',             progress: 0.82, delay: 115000 },
  { message: 'Tuning the final tone…',                  progress: 0.88, delay: 130000 },
  { message: 'Matching your target loudness…',          progress: 0.93, delay: 145000 },
  { message: 'Almost there — running final checks…',    progress: 0.97, delay: 155000 },
]

// ClearerVoice Eraser is faster than Demucs-based Noise Eraser (~1–3 min CPU
// vs ~5–10 min). Progress sequence reflects shorter expected wait.
const CV_PROCESSING_STAGES = [
  { message: 'Measuring your audio…',                        progress: 0.04, delay: 0      },
  { message: 'RNNoise pre-pass — quieting the room…',        progress: 0.10, delay: 1500   },
  { message: 'Removing tonal hum and interference…',         progress: 0.16, delay: 4000   },
  { message: 'ClearerVoice enhancing your voice…',           progress: 0.28, delay: 7000   },
  { message: 'AI enhancement in progress…',                  progress: 0.50, delay: 25000  },
  { message: 'Still enhancing — almost through…',            progress: 0.64, delay: 55000  },
  { message: 'Checking enhancement quality…',                progress: 0.72, delay: 75000  },
  { message: 'Cleaning up any residual noise…',              progress: 0.78, delay: 85000  },
  { message: 'Restoring high frequencies…',                  progress: 0.85, delay: 95000  },
  { message: 'Tuning the final tone…',                       progress: 0.91, delay: 105000 },
  { message: 'Matching your target loudness…',               progress: 0.95, delay: 115000 },
  { message: 'Almost there — running final checks…',         progress: 0.97, delay: 125000 },
]

const presetList = getPresetList()
const outputProfileList = getOutputProfileList()

const currentPreset = computed(() => PRESETS[state.selectedPreset])
const outputProfileLocked = computed(() => isOutputProfileLocked(state.selectedPreset))
const isOverridden = computed(() =>
  state.selectedOutputProfile !== currentPreset.value?.defaultOutputProfile
)

const COMING_SOON_PRESETS = new Set()
const isSelectedPresetComingSoon = computed(() => COMING_SOON_PRESETS.has(state.selectedPreset))

/**
 * Presets that expose a model choice.
 *
 * Noise Eraser and ClearerVoice Eraser previously carried two near-identical
 * blocks of markup and two near-identical setters differing only in ids and
 * copy. The chosen model is written back onto the preset config because that
 * object is what processAudioOnServer serialises into the request body.
 */
const MODEL_CHOICES = {
  noise_eraser: {
    title: 'Separation Model',
    configKey: 'separationModel',
    fallback: 'demucs',
    options: [
      {
        id: 'demucs', label: 'Quality', sub: 'Best results, slower',
        note: 'Demucs htdemucs_ft — ~2–10 min per file. Handles severe outdoor noise and non-stationary backgrounds.',
      },
      {
        id: 'convtasnet', label: 'Fast', sub: 'Good results, quicker',
        note: 'ConvTasNet WHAM! — ~30 sec – 2 min per file. Good for moderate noise, low-resource environments.',
      },
    ],
  },
  clearervoice_eraser: {
    title: 'Enhancement Model',
    configKey: 'clearervoiceModel',
    fallback: 'mossformer2_48k',
    options: [
      {
        id: 'mossformer2_48k', label: 'Quality', sub: 'Full-band 48 kHz, slower',
        note: 'MossFormer2_SE_48K — ~1–5 min per file. Handles broadband, tonal, and non-stationary noise.',
      },
      {
        id: 'frcrn_16k', label: 'Fast', sub: '16 kHz, quicker',
        note: 'FRCRN_SE_16K — ~30 sec – 2 min per file. Good for moderate noise, low-resource environments.',
      },
    ],
  },
}

// Selected model per preset id, seeded from whatever the preset config carries.
const selectedModels = ref(
  Object.fromEntries(
    Object.entries(MODEL_CHOICES).map(([presetId, choice]) =>
      [presetId, PRESETS[presetId]?.[choice.configKey] ?? choice.fallback]
    )
  )
)

const modelChoice = computed(() => MODEL_CHOICES[state.selectedPreset] ?? null)
const selectedModel = computed(() => selectedModels.value[state.selectedPreset] ?? null)
const selectedModelNote = computed(() =>
  modelChoice.value?.options.find(o => o.id === selectedModel.value)?.note ?? ''
)

function setModel(modelId) {
  const presetId = state.selectedPreset
  const choice = MODEL_CHOICES[presetId]
  if (!choice) return
  selectedModels.value[presetId] = modelId
  if (PRESETS[presetId]) PRESETS[presetId][choice.configKey] = modelId
}

// Presets whose output ACX's human reviewers are likely to reject on artifacts,
// even when the measurements pass.
const ACX_ARTIFACT_WARNINGS = {
  noise_eraser: 'ACX compliance is not recommended for Noise Eraser output. Separation artifacts may cause ACX human review rejection even if measurements pass.',
  clearervoice_eraser: 'ACX compliance is not recommended for ClearerVoice Eraser output. Enhancement artifacts may cause ACX human review rejection even if measurements pass.',
}

const acxArtifactWarning = computed(() =>
  state.selectedOutputProfile === 'acx'
    ? ACX_ARTIFACT_WARNINGS[state.selectedPreset] ?? ''
    : ''
)

function compressionLabel(preset) {
  if (!preset) return ''
  const c = preset.compression
  if (!c) return 'Conditional'
  if (Array.isArray(c)) return `${c.length}-pass`
  if (c.mode === 'none') return 'None'
  return c.mode === 'conditional' ? 'Conditional' : 'Always-on'
}

function channelLabel(preset) {
  if (!preset) return ''
  return preset.channelOutput === 'mono' ? 'Mono' : 'Preserve original'
}

async function handleProcess() {
  // Bind the whole job to the document that started it. Processing no longer
  // blocks the app, so the user can switch tabs mid-job — every write below
  // has to land on this document, not on whichever one is active when the
  // server finally answers.
  const docId = appState.activeDocumentId
  const doc = getDocument(docId)
  if (!doc || !doc.currentFile || doc.isProcessing) return

  const preset = doc.selectedPreset
  let stages, heading
  if (preset === 'noise_eraser') {
    stages  = NE_PROCESSING_STAGES
    heading = 'Separating your voice…'
  } else if (preset === 'clearervoice_eraser') {
    stages  = CV_PROCESSING_STAGES
    heading = 'ClearerVoice enhancing…'
  } else {
    stages  = PROCESSING_STAGES
    heading = 'Making your audio shine'
  }

  startProcessing(heading, docId)

  // Fire the first stage immediately (synchronously) so it's visible right away
  updateProcessingStage(stages[0].message, docId)
  updateProcessingProgress(stages[0].progress, docId)

  // Queue the remaining stages
  const stageTimers = stages.slice(1).map(({ message, progress, delay }) =>
    setTimeout(() => {
      updateProcessingStage(message, docId)
      updateProcessingProgress(progress, docId)
    }, delay)
  )

  try {
    const { report, audioBlob, peaks } = await processAudioOnServer({
      segments: doc.segments,
      sampleRate: doc.currentFile.sampleRate,
      channels: doc.currentFile.channels,
      fileName: doc.currentFile.name,
      presetId: doc.selectedPreset,
      outputProfileId: doc.selectedOutputProfile,
      separationModel:    preset === 'noise_eraser'        ? selectedModels.value.noise_eraser        : undefined,
      clearervoiceModel:  preset === 'clearervoice_eraser' ? selectedModels.value.clearervoice_eraser : undefined,
    })

    // The user can close a document while its job is in flight. Bail rather
    // than writing results into a detached object and leaking its buffers back
    // into the pool.
    if (!getDocument(docId)) return

    // Decode the processed audio blob into an AudioBuffer
    const ctx = getAudioContext()
    const arrayBuffer = await audioBlob.arrayBuffer()
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer)

    // Replace that document's entire timeline with the processed audio
    const dur = getTimelineDuration(doc.segments)
    const bufferId = replaceRegion(0, dur, audioBuffer, docId)

    // Sync file metadata to reflect the processed audio properties.
    // Server-side presets can change channel count (e.g. Noise Eraser → mono)
    // and sample rate. Without this, export/render loops use the stale original
    // channel count and crash with IndexSizeError when calling getChannelData(1)
    // on a mono AudioBuffer.
    doc.currentFile.channels = audioBuffer.numberOfChannels
    doc.currentFile.sampleRate = audioBuffer.sampleRate
    doc.currentFile.duration = audioBuffer.duration

    // Compute peak cache for the new buffer
    const cache = await computePeakCache(audioBuffer, 256)
    setPeakCache(bufferId, cache)

    setProcessingReport(report, docId)

    // Name the file in the toast — with several documents open, "Processing
    // complete" alone doesn't say which one finished.
    const suffix = appState.documents.length > 1 ? ` — ${doc.name}` : ''
    if (report.acx_certification) {
      const label = report.acx_certification.certificate === 'pass' ? 'PASS' : 'FAIL'
      showToast(`ACX certification: ${label}${suffix}`)
    } else {
      showToast(`Processing complete${suffix}`)
    }
  } catch (err) {
    console.error('Server processing failed:', err)
    const suffix = appState.documents.length > 1 ? ` — ${doc.name}` : ''
    showToast((err.message || 'Processing failed') + suffix)
  } finally {
    stageTimers.forEach(clearTimeout)
    endProcessing(docId)
  }
}
</script>

<template>
  <div class="font-['Inter']">
    <!-- Header -->
    <div class="px-5 pt-5 pb-[14px] border-b border-[rgba(255,255,255,.06)]">
      <div class="text-[15px] font-bold text-[#eaf6f8]">Master</div>
      <div class="mt-[4px] text-[11.5px] leading-[1.4] text-[rgba(255,255,255,.42)]">Preset mastering chains</div>
    </div>

    <div class="p-4 flex flex-col gap-[14px]">
      <!-- Preset cards -->
      <div class="flex flex-col gap-[6px]">
        <button
          v-for="preset in presetList"
          :key="preset.id"
          class="w-full flex items-center gap-[10px] px-[13px] py-3 border rounded-[12px] cursor-pointer text-left select-none transition-all"
          :style="state.selectedPreset === preset.id
            ? 'background:rgba(53,211,230,.1);border-color:rgba(53,211,230,.5)'
            : 'background:rgba(255,255,255,.03);border-color:rgba(255,255,255,.07)'"
          @click="setPreset(preset.id)"
        >
          <div class="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center shrink-0 transition-colors"
               :style="state.selectedPreset === preset.id ? 'background:rgba(53,211,230,.14)' : 'background:rgba(255,255,255,.04)'">
            <Icon :name="preset.id" :size="16"
                  :style="{ color: state.selectedPreset === preset.id ? '#7fe9f6' : 'rgba(255,255,255,.5)' }" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-[6px]">
              <div class="text-[13px] font-bold text-[#eaf6f8]">{{ preset.displayName }}</div>
              <span v-if="COMING_SOON_PRESETS.has(preset.id)"
                    class="inline-block text-[9px] font-extrabold uppercase px-[6px] py-0.5 rounded-full leading-none"
                    style="background:rgba(255,255,255,.15);color:#eaf6f8">
                Coming soon
              </span>
            </div>
            <div class="text-[11px] font-medium mt-[1px] truncate text-[rgba(255,255,255,.42)]">{{ preset.description }}</div>
            <span class="inline-block text-[10px] font-bold rounded-full px-2 py-0.5 mt-[6px]" style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.5)">
              {{ preset.audience }}
            </span>
          </div>
        </button>
      </div>

      <!-- Output profile selector -->
      <div>
        <div class="text-[11px] font-semibold text-[rgba(255,255,255,.4)] mb-2">Output Profile</div>
        <div class="flex gap-[6px] relative"
             :class="{ 'opacity-45 pointer-events-none': outputProfileLocked }">
          <button
            v-for="op in outputProfileList"
            :key="op.id"
            class="flex-1 text-center text-[11px] font-bold py-2 rounded-[10px] border cursor-pointer transition-all"
            :style="state.selectedOutputProfile === op.id
              ? 'border-color:rgba(53,211,230,.5);background:rgba(53,211,230,.12);color:#7fe9f6'
              : 'border-color:rgba(255,255,255,.07);background:rgba(255,255,255,.03);color:rgba(255,255,255,.5)'"
            @click="setOutputProfile(op.id)"
          >
            {{ op.displayName }}
          </button>
        </div>
        <!-- Locked indicator -->
        <div v-if="outputProfileLocked" class="flex items-center gap-1 mt-[6px] text-[10px] font-bold text-[rgba(255,255,255,.35)]">
          <svg viewBox="0 0 24 24" class="w-3 h-3 fill-none stroke-current" stroke-width="2.5">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
          </svg>
          Locked to {{ OUTPUT_PROFILES[currentPreset?.defaultOutputProfile]?.displayName }}
        </div>
        <!-- Override note -->
        <div v-if="!outputProfileLocked && isOverridden" class="mt-[6px] text-[10px] font-bold leading-snug" style="color:#e0b84a">
          Override: using {{ OUTPUT_PROFILES[state.selectedOutputProfile]?.displayName }} profile with {{ currentPreset?.displayName }} preset
        </div>
        <!-- Artifact warning for separation/enhancement presets targeting ACX -->
        <div v-if="acxArtifactWarning" class="mt-[6px] text-[10px] font-bold leading-snug text-[#ff8a80]">
          {{ acxArtifactWarning }}
        </div>
      </div>

      <!-- Model choice, for the presets that have one -->
      <div v-if="modelChoice" class="rounded-[12px] p-3 flex flex-col gap-2" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)">
        <div class="text-[11px] font-bold text-[rgba(255,255,255,.4)] uppercase tracking-wider">{{ modelChoice.title }}</div>
        <div class="flex gap-[6px]">
          <button
            v-for="m in modelChoice.options"
            :key="m.id"
            class="flex-1 text-left px-[10px] py-2 rounded-[10px] border cursor-pointer transition-all"
            :style="selectedModel === m.id
              ? 'border-color:rgba(53,211,230,.5);background:rgba(53,211,230,.12)'
              : 'border-color:rgba(255,255,255,.07);background:rgba(255,255,255,.02)'"
            :aria-pressed="selectedModel === m.id"
            @click="setModel(m.id)"
          >
            <div class="text-[12px] font-extrabold" :style="{ color: selectedModel === m.id ? '#7fe9f6' : '#eaf6f8' }">{{ m.label }}</div>
            <div class="text-[10px] font-semibold mt-0.5" :style="{ color: selectedModel === m.id ? '#7fe9f6' : 'rgba(255,255,255,.4)' }">{{ m.sub }}</div>
          </button>
        </div>
        <div class="text-[10px] font-medium leading-snug text-[rgba(255,255,255,.4)]">{{ selectedModelNote }}</div>
      </div>

      <!-- Preset details -->
      <div class="rounded-[12px] p-3 flex flex-col gap-[6px]" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)">
        <div class="text-[11px] font-bold text-[rgba(255,255,255,.4)] uppercase tracking-wider mb-0.5">Preset Details</div>

        <div class="flex justify-between">
          <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Target Loudness</span>
          <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.6)] tabular-nums">{{ formatLoudness(currentPreset) }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">True Peak Ceiling</span>
          <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.6)] tabular-nums">{{ currentPreset?.truePeakCeiling }} dBFS</span>
        </div>
        <div class="flex justify-between">
          <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Compression</span>
          <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.6)] tabular-nums">{{ compressionLabel(currentPreset) }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Channel Output</span>
          <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.6)] tabular-nums">{{ channelLabel(currentPreset) }}</span>
        </div>
        <div v-if="currentPreset?.noiseFloorTarget" class="flex justify-between">
          <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Noise Floor Target</span>
          <span class="font-['JetBrains_Mono'] text-[11px] font-semibold text-[rgba(255,255,255,.6)] tabular-nums">{{ currentPreset.noiseFloorTarget }} dBFS</span>
        </div>
        <div class="flex justify-between">
          <span class="text-[11px] font-semibold text-[rgba(255,255,255,.5)]">Character</span>
          <span class="text-[11px] font-semibold text-[rgba(255,255,255,.6)]">{{ currentPreset?.character }}</span>
        </div>
      </div>

      <!-- Process button -->
      <BaseButton
        size="lg" block
        :disabled="state.isProcessing || !state.currentFile || isSelectedPresetComingSoon"
        @click="handleProcess"
      >
        <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16l-6.4 5.2 2.4-7.2-6-4.8h7.6z"/></svg>
        Process Audio
      </BaseButton>

      <!-- Processing report (shown when available) -->
      <div v-if="state.processingReport" class="border-t border-[rgba(255,255,255,.07)] pt-3">
        <ProcessingReportPanel :report="state.processingReport" />
      </div>
    </div>
  </div>
</template>
