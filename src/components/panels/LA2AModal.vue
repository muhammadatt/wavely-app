<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { useLA2A } from '../../composables/useLA2A.js'
import { useEditorState } from '../../composables/useEditorState.js'
import Knob from '../knobs/Knob.vue'

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
  la2aAutoMakeup.value && la2aAutoMakeupBusy.value ? 'AUTO ···' : 'AUTO'
)

const ACCENT = '#f5a623'
const PANEL_WIDTH = 640

// Floating, draggable position — starts near the top-right so it doesn't
// cover the waveform, and stays wherever the user drags it.
const pos = ref({ x: 0, y: 90 })
const dragging = ref(false)
let dragOffsetX = 0
let dragOffsetY = 0

onMounted(() => {
  pos.value.x = Math.max(16, window.innerWidth - PANEL_WIDTH - 40)
})

function clampToViewport() {
  const maxX = window.innerWidth - 120
  const maxY = window.innerHeight - 60
  pos.value.x = Math.min(Math.max(-PANEL_WIDTH + 120, pos.value.x), maxX)
  pos.value.y = Math.min(Math.max(0, pos.value.y), maxY)
}

function onDragStart(e) {
  dragging.value = true
  dragOffsetX = e.clientX - pos.value.x
  dragOffsetY = e.clientY - pos.value.y
  e.currentTarget.setPointerCapture(e.pointerId)
}

function onDragMove(e) {
  if (!dragging.value) return
  pos.value.x = e.clientX - dragOffsetX
  pos.value.y = e.clientY - dragOffsetY
}

function onDragEnd(e) {
  if (!dragging.value) return
  dragging.value = false
  // On pointercancel the capture is already implicitly released
  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
  clampToViewport()
}

const grPct = computed(() => Math.min(100, Math.abs(la2aReduction.value) * 2.5))

function dbToPct(db) {
  if (!Number.isFinite(db)) return 0
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
}

function close() {
  teardown()
  closeModal()
}

async function applyAndClose() {
  await apply()
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
  <div
    class="fixed z-[500] rounded-2xl overflow-hidden"
    :style="{
      left: pos.x + 'px', top: pos.y + 'px', width: PANEL_WIDTH + 'px',
      background: 'linear-gradient(155deg,#1a1815,#100e0b 60%)',
      boxShadow: '0 24px 60px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.05)',
      fontFamily: `'Inter',system-ui,sans-serif`,
      animation: dragging ? 'none' : 'la2aBounceIn 0.3s cubic-bezier(0.34,1.56,0.64,1) both',
      userSelect: dragging ? 'none' : 'auto',
    }"
  >
    <!-- Header (drag handle) -->
    <div
      class="flex items-center justify-between px-[18px] h-12 touch-none"
      :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
      style="background:linear-gradient(#221f1a,#171410);border-bottom:1px solid rgba(255,255,255,.06)"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <div class="flex items-center gap-2.5">
        <div class="w-3.5 h-3.5 rounded-full" style="background:linear-gradient(135deg,#ffd88a,#f5a623);box-shadow:0 0 10px rgba(245,166,35,.65)"></div>
        <span style="font:800 13px/1 'Inter';letter-spacing:.22em;color:#f6ecdd">AXIS&nbsp;<span style="font-weight:500;color:rgba(255,255,255,.4)">DYN</span></span>
      </div>

      <!-- Preset selector — visual mockup only, not yet wired to real presets -->
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

      <div class="flex items-center gap-2">
        <button
          class="flex items-center gap-2 px-3 py-1.5 rounded-full border cursor-pointer transition-opacity"
          style="background:rgba(245,166,35,.14);border-color:rgba(245,166,35,.4)"
          :style="{ opacity: la2aPreview ? 1 : 0.55 }"
          @pointerdown.stop
          @click="togglePreview"
        >
          <span class="w-[7px] h-[7px] rounded-full" style="background:#f5a623;box-shadow:0 0 7px #f5a623"></span>
          <span style="font:700 9px 'JetBrains Mono',monospace;letter-spacing:.14em;color:#f7c877">{{ la2aPreview ? 'ON' : 'BYPASS' }}</span>
        </button>
        <button
          class="flex items-center justify-center w-7 h-7 rounded-full border-none cursor-pointer"
          style="background:rgba(255,255,255,.06);color:rgba(255,255,255,.55)"
          @pointerdown.stop
          @click="close"
        >
          <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-none stroke-current" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <div class="px-[26px] pt-[22px] pb-[28px]">
        <!-- Gain reduction bar -->
        <div class="flex items-center justify-between mb-1.5">
          <span style="font:700 9.5px 'JetBrains Mono',monospace;letter-spacing:.18em;color:rgba(255,255,255,.5)">GAIN REDUCTION</span>
          <span style="font:700 12px 'JetBrains Mono',monospace;color:#f7c877;text-shadow:0 0 8px rgba(245,166,35,.55)">{{ Math.abs(la2aReduction).toFixed(1) }} dB</span>
        </div>
        <div class="relative h-[18px] rounded-[9px]" style="background:#0a0806;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05),inset 0 2px 6px rgba(0,0,0,.8)">
          <div class="absolute top-0 bottom-0 left-0 rounded-[9px] transition-all duration-75"
               :style="{ width: grPct + '%', background: 'linear-gradient(90deg,#ffe0a0,#f5a623)', boxShadow: '0 0 16px rgba(245,166,35,.7)' }"></div>
          <div class="absolute inset-0 rounded-[9px]" style="background:repeating-linear-gradient(90deg,#0000 0 9px,rgba(10,8,6,.85) 9px 11px)"></div>
        </div>
        <div class="flex justify-between mt-[5px]" style="font:600 8px 'JetBrains Mono',monospace;color:rgba(255,255,255,.3)">
          <span>0</span><span>-3</span><span>-6</span><span>-12</span><span>-24</span>
        </div>

        <!-- IN meter · knobs · OUT meter -->
        <div class="flex items-center justify-between gap-[22px] mt-[24px]">
          <!-- IN -->
          <div class="flex flex-col items-center gap-[9px]">
            <div class="flex gap-[3px]">
              <div class="relative w-[9px] h-[150px] rounded-[3px]" style="background:#07090c;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)">
                <div class="absolute bottom-0 left-0 right-0 rounded-[3px] transition-all duration-100"
                     :style="{ height: dbToPct(la2aInputDb) + '%', background: 'linear-gradient(to top,#2ec96b 0 62%,#e9c63b 62% 84%,#e35d4f 84%)' }"></div>
                <div class="absolute inset-0" style="background:repeating-linear-gradient(to top,#0000 0 4px,#07090c 4px 6px)"></div>
              </div>
              <div class="relative w-[9px] h-[150px] rounded-[3px]" style="background:#07090c;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)">
                <div class="absolute bottom-0 left-0 right-0 rounded-[3px] transition-all duration-100"
                     :style="{ height: dbToPct(la2aInputDb) + '%', background: 'linear-gradient(to top,#2ec96b 0 62%,#e9c63b 62% 84%,#e35d4f 84%)' }"></div>
                <div class="absolute inset-0" style="background:repeating-linear-gradient(to top,#0000 0 4px,#07090c 4px 6px)"></div>
              </div>
            </div>
            <span style="font:700 9px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.45)">IN</span>
          </div>

          <!-- Knobs -->
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
              <Knob
                :model-value="la2aGain"
                @update:model-value="syncGain"
                :min="-12" :max="24" :step="0.1"
                label="Gain" :accent="ACCENT" :format-value="formatGain"
                :disabled="!la2aPreview"
                :readonly="la2aAutoMakeup"
              />
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
                  ? 'Auto makeup on — the plugin sets Gain to level-match the output, so you hear the compression rather than the loudness. Click to take manual control.'
                  : 'Auto makeup off — Gain is yours to set. Click to let the plugin level-match it.'"
                @click="toggleAutoMakeup"
              >{{ autoMakeupLabel }}</button>
            </div>
          </div>

          <!-- OUT -->
          <div class="flex flex-col items-center gap-[9px]">
            <div class="flex gap-[3px]">
              <div class="relative w-[9px] h-[150px] rounded-[3px]" style="background:#07090c;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)">
                <div class="absolute bottom-0 left-0 right-0 rounded-[3px] transition-all duration-100"
                     :style="{ height: dbToPct(la2aOutputDb) + '%', background: 'linear-gradient(to top,#2ec96b 0 62%,#e9c63b 62% 84%,#e35d4f 84%)' }"></div>
                <div class="absolute inset-0" style="background:repeating-linear-gradient(to top,#0000 0 4px,#07090c 4px 6px)"></div>
              </div>
              <div class="relative w-[9px] h-[150px] rounded-[3px]" style="background:#07090c;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)">
                <div class="absolute bottom-0 left-0 right-0 rounded-[3px] transition-all duration-100"
                     :style="{ height: dbToPct(la2aOutputDb) + '%', background: 'linear-gradient(to top,#2ec96b 0 62%,#e9c63b 62% 84%,#e35d4f 84%)' }"></div>
                <div class="absolute inset-0" style="background:repeating-linear-gradient(to top,#0000 0 4px,#07090c 4px 6px)"></div>
              </div>
            </div>
            <span style="font:700 9px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.45)">OUT</span>
          </div>
        </div>

        <!-- Secondary row: Comp/Limit mode + small knobs (tube drive, R37 emphasis) -->
        <div class="flex items-center justify-between mt-[20px] pt-[16px]" style="border-top:1px solid rgba(255,255,255,.06)">
          <!-- Compress / Limit — the hardware's rear-panel switch -->
          <div class="flex flex-col gap-[7px]">
            <div class="flex rounded-full overflow-hidden" style="border:1px solid rgba(255,255,255,.1)">
              <button
                class="cursor-pointer border-none px-3.5 py-[7px] transition-colors"
                :style="{
                  background: la2aMode === 'compress' ? 'rgba(245,166,35,.18)' : 'transparent',
                  color: la2aMode === 'compress' ? '#f7c877' : 'rgba(255,255,255,.4)',
                  font: `700 9px 'JetBrains Mono',monospace`, letterSpacing: '.12em',
                }"
                :disabled="!la2aPreview"
                @click="syncMode('compress')"
              >COMP</button>
              <button
                class="cursor-pointer border-none px-3.5 py-[7px] transition-colors"
                :style="{
                  background: la2aMode === 'limit' ? 'rgba(245,166,35,.18)' : 'transparent',
                  color: la2aMode === 'limit' ? '#f7c877' : 'rgba(255,255,255,.4)',
                  font: `700 9px 'JetBrains Mono',monospace`, letterSpacing: '.12em',
                }"
                :disabled="!la2aPreview"
                @click="syncMode('limit')"
              >LIMIT</button>
            </div>
            <span class="text-center" style="font:600 8.5px 'Inter',system-ui;letter-spacing:.08em;color:rgba(255,255,255,.35)">
              {{ la2aMode === 'compress' ? '~3:1 leveling' : 'hard ceiling' }}
            </span>
          </div>

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

        <button
          class="w-full flex items-center justify-center gap-1.5 mt-3 py-2.5 rounded-full border-none cursor-pointer transition-opacity disabled:opacity-60 disabled:cursor-default"
          style="background:linear-gradient(90deg,#f5a623,#e0921a);color:#1a1310;font:800 13px 'Inter';letter-spacing:.02em"
          :disabled="!hasSelection || !la2aPreview"
          @click="applyAndClose"
        >
          {{ !la2aPreview ? 'Turn on LA-2A to apply' : hasSelection ? 'Apply compression' : 'Make a selection on the waveform to apply' }}
        </button>
      </div>
  </div>
</template>

<style scoped>
@keyframes la2aBounceIn {
  0% { opacity: 0; transform: scale(0.94) translateY(8px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
</style>
