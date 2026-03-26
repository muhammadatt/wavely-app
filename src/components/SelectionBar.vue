<script setup>
import { useEditorState } from "../composables/useEditorState.js"

const {
  state,
  hasSelection,
  hasFile,
  performDelete,
  performSilence,
  selectAll,
  showToast,
} = useEditorState()

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(2)
  return `${m}:${s.padStart(5, "0")}`
}

function handleCopy() {
  showToast("Copied to clipboard")
}
</script>

<template>
  <div
    v-if="hasSelection"
    class="h-10 bg-ink flex items-center px-3.5 gap-2.5 text-[12px] font-bold text-white shrink-0">
    <div class="w-px h-3.5 bg-white/15"></div>

    <span class="text-[11px] text-white/45 font-bold whitespace-nowrap"
      >Selection</span
    >
    <span
      class="text-[12px] text-white font-extrabold font-heading tabular-nums"
      >{{ formatTime(state.selection.start) }}</span
    >
    <div class="w-px h-3.5 bg-white/15"></div>
    <span class="text-[11px] text-white/45 font-bold">to</span>
    <span
      class="text-[12px] text-white font-extrabold font-heading tabular-nums"
      >{{ formatTime(state.selection.end) }}</span
    >

    <div class="w-px h-3.5 bg-white/15"></div>

    <span class="text-[11px] text-white/45 font-bold whitespace-nowrap"
      >Duration</span
    >
    <span
      class="text-[12px] text-white font-extrabold font-heading tabular-nums"
      >{{ (state.selection.end - state.selection.start).toFixed(2) }}s</span
    >

    <div class="w-px h-3.5 bg-white/15"></div>

    <div class="flex items-center gap-[5px] ml-auto">
      <!-- Select All — always visible when a file is loaded -->
      <button
        class="flex items-center gap-[5px] px-3 py-[5px] rounded-[var(--radius-pill)] bg-white/10 text-white font-heading text-[11px] font-bold border-none cursor-pointer transition-all whitespace-nowrap hover:bg-white/[0.22]"
        @click="selectAll">
        <svg
          viewBox="0 0 24 24"
          class="w-3 h-3 fill-none stroke-current"
          stroke-width="2.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 12l2 2 4-4" />
        </svg>
        Select All
      </button>
      <button
        class="flex items-center gap-[5px] px-3 py-[5px] rounded-[var(--radius-pill)] bg-white/10 text-white font-heading text-[11px] font-bold border-none cursor-pointer transition-all whitespace-nowrap hover:bg-white/[0.22]"
        @click="handleCopy">
        <svg
          viewBox="0 0 24 24"
          class="w-3 h-3 fill-none stroke-current"
          stroke-width="2.5">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
        Copy
      </button>
      <button
        class="flex items-center gap-[5px] px-3 py-[5px] rounded-[var(--radius-pill)] bg-white/10 text-white font-heading text-[11px] font-bold border-none cursor-pointer transition-all whitespace-nowrap hover:bg-white/[0.22]"
        @click="performSilence">
        <svg
          viewBox="0 0 24 24"
          class="w-3 h-3 fill-none stroke-current"
          stroke-width="2.5">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
        </svg>
        Silence
      </button>
      <button
        class="flex items-center gap-[5px] px-3 py-[5px] rounded-[var(--radius-pill)] bg-accent/30 text-white font-heading text-[11px] font-bold border-none cursor-pointer transition-all whitespace-nowrap hover:bg-[rgba(255,107,107,0.45)]"
        @click="performDelete">
        <svg
          viewBox="0 0 24 24"
          class="w-3 h-3 fill-none stroke-current"
          stroke-width="2.5">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4h6v2" />
        </svg>
        Cut
      </button>
    </div>
  </div>
</template>
