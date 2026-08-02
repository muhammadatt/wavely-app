<script setup>
import { ref } from "vue"
import { useEditorState } from "../../composables/useEditorState.js"
import BaseButton from "../ui/BaseButton.vue"
import RequirementNotice from '../ui/RequirementNotice.vue'

const {
  hasSelection,
  performTrimToSelection,
  performTrimBefore,
  performTrimAfter,
  showToast,
} = useEditorState()

const mode = ref("to-selection")

function apply() {
  if (!hasSelection.value) return
  switch (mode.value) {
    case "to-selection":
      performTrimToSelection()
      showToast("Trimmed to selection")
      break
    case "before":
      performTrimBefore()
      showToast("Removed before selection")
      break
    case "after":
      performTrimAfter()
      showToast("Removed after selection")
      break
  }
}

const options = [
  {
    id: "to-selection",
    label: "Trim to selection",
    desc: "Keep only what's selected, remove the rest",
  },
  {
    id: "before",
    label: "Remove before selection",
    desc: "Delete everything to the left of the selection",
  },
  {
    id: "after",
    label: "Remove after selection",
    desc: "Delete everything to the right of the selection",
  },
]
</script>

<template>
  <div class="font-['Inter']">
    <!-- Header lives in ContextPanel, which renders it from the registry entry -->
    <div class="p-4 flex flex-col gap-2.5">
      <button
        v-for="opt in options"
        :key="opt.id"
        class="text-left px-[14px] py-[13px] rounded-[12px] border cursor-pointer transition-all"
        :style="mode === opt.id
          ? 'background:rgba(53,211,230,.12);border-color:rgba(53,211,230,.5)'
          : 'background:rgba(255,255,255,.03);border-color:rgba(255,255,255,.07)'"
        @click="mode = opt.id">
        <div class="flex items-start gap-[11px]">
          <span class="relative top-[1px] w-4 h-4 rounded-full border-[1.5px] shrink-0 flex items-center justify-center"
            style="border-color:rgba(255,255,255,.25)">
            <span v-if="mode === opt.id" class="w-2 h-2 rounded-full" style="background:#35d3e6"></span>
          </span>
          <div>
            <div class="text-[12.5px] font-semibold mb-[2px]" :style="{ color: mode === opt.id ? '#7fe9f6' : '#eaf6f8' }">
              {{ opt.title ?? opt.label }}
            </div>
            <div class="text-[10.5px] leading-snug font-medium text-[rgba(255,255,255,.4)]">
              {{ opt.desc }}
            </div>
          </div>
        </div>
      </button>

      <BaseButton
        class="mt-1" size="lg" block
        :disabled="!hasSelection"
        @click="apply">
        <svg
          viewBox="0 0 24 24"
          class="w-[13px] h-[13px] fill-none stroke-current"
          stroke-width="2.5">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Apply Trim
      </BaseButton>

      <RequirementNotice :met="hasSelection" message="Make a selection on the waveform to trim" />
    </div>
  </div>
</template>
