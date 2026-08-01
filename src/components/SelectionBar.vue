<script setup>
import { computed } from "vue"
import { useEditorState } from "../composables/useEditorState.js"
import BaseButton from "./ui/BaseButton.vue"

const {
  state,
  hasSelection,
  hasClipboard,
  performSilence,
  performTrimToSelection,
  performCut,
  performCopy,
  performPaste,
  selectAll,
  showToast,
} = useEditorState()

// The bar is always mounted, so every readout has to survive selection === null.
const EMPTY = "—"

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return EMPTY
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(2)
  return `${m}:${s.padStart(5, "0")}`
}

const selectionDuration = computed(() => {
  if (!hasSelection.value) return EMPTY
  return `${(state.selection.end - state.selection.start).toFixed(2)}s`
})

// Every action below is a no-op without its precondition, so the toast only
// fires once the operation has actually run.
function handleCopy() {
  if (!hasSelection.value) return
  performCopy()
  showToast("Copied to clipboard")
}

function handleCut() {
  if (!hasSelection.value) return
  performCut()
  showToast("Cut to clipboard")
}

function handlePaste() {
  if (!hasClipboard.value) return
  performPaste(state.playhead)
  showToast("Pasted at playhead")
}

function handleSilence() {
  if (!hasSelection.value) return
  performSilence()
  showToast("Region silenced")
}

// Mirrors the Trim panel's "Trim to selection" mode — same wording, same toast,
// so the shortcut and the panel don't read as two different operations.
function handleTrim() {
  if (!hasSelection.value) return
  performTrimToSelection()
  showToast("Trimmed to selection")
}
</script>

<template>
  <!-- Scrolls rather than clips: with the context panel open on a narrow window
       the readouts and actions together exceed the bar, and the trailing
       actions were being cut off with no way to reach them. -->
  <div
    class="selection-bar h-9 flex items-center px-[14px] gap-[10px] font-['Inter'] shrink-0 overflow-x-auto border-t border-[rgba(255,255,255,.08)]"
    style="background:rgba(5,7,9,.85);backdrop-filter:blur(4px)">
    <span class="text-[10.5px] font-bold tracking-[.08em] text-[rgba(255,255,255,.4)] whitespace-nowrap uppercase shrink-0"
      >Selection</span
    >
    <span
      class="font-['JetBrains_Mono'] text-[11.5px] font-semibold tabular-nums shrink-0"
      :class="hasSelection ? 'text-[#7fe9f6]' : 'text-[rgba(255,255,255,.28)]'"
      >{{ formatTime(state.selection?.start) }}</span
    >
    <span class="text-[10.5px] text-[rgba(255,255,255,.3)] font-bold">→</span>
    <span
      class="font-['JetBrains_Mono'] text-[11.5px] font-semibold tabular-nums shrink-0"
      :class="hasSelection ? 'text-[#7fe9f6]' : 'text-[rgba(255,255,255,.28)]'"
      >{{ formatTime(state.selection?.end) }}</span
    >

    <div class="w-px h-3.5 shrink-0 bg-[rgba(255,255,255,.1)]"></div>

    <span class="text-[10.5px] font-bold tracking-[.08em] text-[rgba(255,255,255,.4)] whitespace-nowrap uppercase shrink-0"
      >Duration</span
    >
    <span
      class="font-['JetBrains_Mono'] text-[11.5px] font-semibold tabular-nums shrink-0"
      :class="hasSelection ? 'text-[rgba(255,255,255,.7)]' : 'text-[rgba(255,255,255,.28)]'"
      >{{ selectionDuration }}</span
    >

    <span
      v-if="!hasSelection"
      class="text-[10.5px] font-medium text-[rgba(255,255,255,.3)] whitespace-nowrap shrink-0"
      >Drag on the waveform to select</span
    >

    <div class="flex items-center gap-[6px] ml-auto shrink-0 pl-2">
      <!-- Select All — the only action here that needs no precondition -->
      <BaseButton
        size="xs" color="ghost" :pill="false"
        class="whitespace-nowrap font-semibold"
        title="Select All (Ctrl+A)"
        @click="selectAll">
        <svg
          viewBox="0 0 24 24"
          class="w-3 h-3 fill-none stroke-current"
          stroke-width="2.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 12l2 2 4-4" />
        </svg>
        Select All
      </BaseButton>
      <BaseButton
        size="xs" color="ghost" :pill="false"
        class="whitespace-nowrap font-semibold"
        :disabled="!hasSelection"
        title="Copy (Ctrl+C)"
        @click="handleCopy">
        <svg
          viewBox="0 0 24 24"
          class="w-3 h-3 fill-none stroke-current"
          stroke-width="2.5">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
        Copy
      </BaseButton>
      <BaseButton
        size="xs" color="ghost" :pill="false"
        class="whitespace-nowrap font-semibold"
        :disabled="!hasClipboard"
        title="Paste at playhead (Ctrl+V)"
        @click="handlePaste">
        <svg
          viewBox="0 0 24 24"
          class="w-3 h-3 fill-none stroke-current"
          stroke-width="2.5">
          <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        </svg>
        Paste
      </BaseButton>
      <BaseButton
        size="xs" color="ghost" :pill="false"
        class="whitespace-nowrap font-semibold"
        :disabled="!hasSelection"
        title="Replace selection with silence"
        @click="handleSilence">
        <svg
          viewBox="0 0 24 24"
          class="w-3 h-3 fill-none stroke-current"
          stroke-width="2.5">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
        </svg>
        Silence
      </BaseButton>
      <BaseButton
        size="xs" color="ghost" :pill="false"
        class="whitespace-nowrap font-semibold"
        :disabled="!hasSelection"
        title="Cut selection to clipboard (Ctrl+X or Del)"
        @click="handleCut">
        <svg
          viewBox="0 0 24 24"
          class="w-3 h-3 fill-none stroke-current"
          stroke-width="2.5">
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <line x1="20" y1="4" x2="8.12" y2="15.88" />
          <line x1="14.47" y1="14.48" x2="20" y2="20" />
          <line x1="8.12" y1="8.12" x2="12" y2="12" />
        </svg>
        Cut
      </BaseButton>
      <BaseButton
        size="xs" color="ghost" :pill="false"
        class="whitespace-nowrap font-semibold"
        :disabled="!hasSelection"
        title="Trim to selection — keep only what's selected"
        @click="handleTrim">
        <svg
          viewBox="0 0 24 24"
          class="w-3 h-3 fill-none stroke-current"
          stroke-width="2.5">
          <path d="M4 7h16" />
          <path d="M4 17h16" />
          <path d="M8 3v18" />
          <path d="M16 3v18" />
        </svg>
        Trim
      </BaseButton>
    </div>
  </div>
</template>

<style scoped>
.selection-bar {
  scrollbar-width: none;
}
.selection-bar::-webkit-scrollbar {
  display: none;
}
</style>
