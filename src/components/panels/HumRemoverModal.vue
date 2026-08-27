<script setup>
import { computed, onMounted } from 'vue'
import { useHumRemover } from '../../composables/useHumRemover.js'
import { useEditorState } from '../../composables/useEditorState.js'
import Knob from '../knobs/Knob.vue'
import SegmentedSwitch from '../knobs/SegmentedSwitch.vue'
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
  if (!humPreview.value) togglePreview()
})

const ACCENT = '#c9a7ff'

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
  return String(Math.round(v))
}

function formatDepth(v) {
  return `−${v.toFixed(0)}`
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
    :width="620"
    :accent="ACCENT"
    brand-lead="HUM"
    brand-tail="REMOVER"
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
    <div class="px-[26px] pt-[22px] pb-[24px]">
      <div class="flex items-start justify-between gap-[20px]">
        <LevelMeter :levels="humInputLevels" label="IN" :height="176" />

        <div class="flex-1">
          <!-- Mains frequency + analyse -->
          <div class="flex items-center justify-between gap-[16px]">
            <SegmentedSwitch
              :model-value="humFundamental"
              @update:model-value="setFundamental"
              :options="MAINS_OPTIONS"
              :accent="ACCENT"
              :disabled="humAnalyzing"
              caption="Mains frequency"
            />
            <button
              class="px-[18px] py-[9px] rounded-lg cursor-pointer transition-all disabled:cursor-default"
              :style="{
                background: humAnalyzing ? 'rgba(255,255,255,.05)' : 'rgba(201,167,255,.16)',
                border: `1px solid ${humAnalyzing ? 'rgba(255,255,255,.09)' : 'rgba(201,167,255,.42)'}`,
                color: humAnalyzing ? 'rgba(255,255,255,.4)' : '#dcc7ff',
                font: `700 10px 'JetBrains Mono',monospace`,
                letterSpacing: '.1em',
                opacity: hasSelection ? 1 : 0.4,
              }"
              :disabled="humAnalyzing || !hasSelection"
              @click="analyze"
            >{{ humAnalyzing ? 'ANALYSING…' : 'ANALYSE' }}</button>
          </div>

          <!-- Harmonic table -->
          <div class="mt-[16px]">
            <div
              class="grid items-center gap-x-[10px] pb-[6px] uppercase"
              style="grid-template-columns:26px 62px 1fr 58px;font:700 8.5px/1 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.28);border-bottom:1px solid rgba(255,255,255,.06)"
            >
              <span></span><span>Freq</span><span>Above floor</span><span class="text-right">Δ dB</span>
            </div>

            <div v-if="humHarmonics.length === 0"
                 class="py-[22px] text-center"
                 style="font:500 10.5px 'Inter';color:rgba(255,255,255,.3)">
              No analysis yet.
            </div>

            <div
              v-for="h in humHarmonics" :key="h.frequency"
              class="grid items-center gap-x-[10px] py-[7px]"
              style="grid-template-columns:26px 62px 1fr 58px;border-bottom:1px solid rgba(255,255,255,.04)"
            >
              <!-- Reads as a checkbox to assistive tech: the visual tick and
                   the accent fill are the only other cue that a row is on. -->
              <button
                class="w-[16px] h-[16px] rounded-[4px] cursor-pointer transition-all"
                :style="{
                  background: h.enabled ? ACCENT : 'transparent',
                  border: `1px solid ${h.enabled ? ACCENT : 'rgba(255,255,255,.22)'}`,
                }"
                role="checkbox"
                :aria-checked="h.enabled"
                :aria-label="harmonicToggleLabel(h)"
                :title="h.enabled ? 'Notching this frequency' : 'Leave this frequency alone'"
                :disabled="h.deltaDb === null"
                @click="toggleHarmonic(h.frequency)"
              >
                <svg v-if="h.enabled" viewBox="0 0 24 24" class="w-full h-full"
                     fill="none" stroke="#1a1024" stroke-width="4"
                     stroke-linecap="round" stroke-linejoin="round"
                     aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>

              <span style="font:600 11px 'JetBrains Mono',monospace;color:rgba(255,255,255,.72)">
                {{ h.frequency }}
              </span>

              <!-- Prominence bar, plus why a harmonic was left unticked -->
              <div class="flex items-center gap-[8px]">
                <div class="flex-1 h-[5px] rounded-full overflow-hidden"
                     style="background:rgba(255,255,255,.06)">
                  <div
                    class="h-full rounded-full transition-all"
                    :style="{
                      width: `${deltaWidth(h.deltaDb)}%`,
                      background: h.flagged ? ACCENT : 'rgba(255,255,255,.2)',
                    }"
                  />
                </div>
                <span
                  v-if="h.matchesPitchedSource"
                  :title="pitchedTooltip(h)"
                  style="font:700 7.5px 'JetBrains Mono',monospace;letter-spacing:.08em;color:#ffb27a;white-space:nowrap"
                >IN SOURCE</span>
                <span
                  v-else-if="rejectionLabel(h)"
                  style="font:500 8.5px 'Inter';color:rgba(255,255,255,.26);white-space:nowrap"
                >{{ rejectionLabel(h) }}</span>
              </div>

              <span class="text-right"
                    style="font:600 11px 'JetBrains Mono',monospace;color:rgba(255,255,255,.55)">
                {{ h.deltaDb === null ? '—' : h.deltaDb.toFixed(1) }}
              </span>
            </div>
          </div>

          <p
            class="mt-[12px]"
            :style="{
              font: `500 10px/1.5 'Inter'`,
              color: isStale ? '#ffb27a' : 'rgba(255,255,255,.35)',
            }"
          >{{ statusLine }}</p>
        </div>

        <LevelMeter :levels="humOutputLevels" label="OUT" :height="176" />
      </div>

      <!-- Notch shape -->
      <div class="flex items-center justify-between mt-[18px] pt-[16px]"
           style="border-top:1px solid rgba(255,255,255,.06)">
        <p style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.3);max-width:320px">
          Narrow cuts at the mains frequency and its harmonics. Deeper and wider
          removes more hum but takes more of the recording with it.
        </p>
        <div class="flex gap-[26px]">
          <div class="w-[80px]">
            <Knob
              :model-value="humQ"
              @update:model-value="syncQ"
              :min="5" :max="60" :step="1" :value-font-px="13"
              label="Width Q" :accent="ACCENT" :format-value="formatQ"
              :disabled="!humPreview"
            />
          </div>
          <div class="w-[80px]">
            <Knob
              :model-value="humDepth"
              @update:model-value="syncDepth"
              :min="0" :max="40" :step="1" :value-font-px="13"
              label="Depth dB" :accent="ACCENT" :format-value="formatDepth"
              :disabled="!humPreview"
            />
          </div>
        </div>
      </div>

    </div>
  </FloatingWindow>
</template>
