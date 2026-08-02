<script setup>
import { useEditorState } from '../composables/useEditorState.js'

/**
 * Processing state for the *active* document.
 *
 * Scoped to the waveform area rather than the whole screen: with multiple
 * documents open, a job on one file must not lock the app, or queueing several
 * chapters to master while you keep editing — the point of multi-file — is
 * impossible. Other documents' jobs surface on their tabs instead.
 */
const { state } = useEditorState()
</script>

<template>
  <div
    class="absolute inset-0 z-[60] flex items-center justify-center font-['Inter']"
    style="background:rgba(8,10,13,.82);backdrop-filter:blur(4px)"
  >
    <div class="text-center px-10 py-8 min-w-[290px]">
      <!-- Spinner -->
      <div
        class="w-[44px] h-[44px] mx-auto mb-[18px] rounded-full"
        style="border:4px solid rgba(255,255,255,.08);border-top-color:#35d3e6;border-right-color:#e0b84a;animation:spin .7s linear infinite"
      ></div>

      <div class="text-[17px] font-bold text-[#eaf6f8] mb-1.5">{{ state.processingMessage }}</div>
      <div
        class="text-[12.5px] font-semibold text-[rgba(255,255,255,.42)] mb-5 min-h-[18px]"
        :key="state.processingStage"
        style="animation:fadeStage .35s ease both"
      >
        {{ state.processingStage || 'This may take a moment' }}
      </div>

      <!-- Progress bar -->
      <div class="w-full h-2 rounded-md overflow-hidden" style="background:rgba(255,255,255,.06);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)">
        <div
          class="h-full rounded transition-all duration-400"
          style="background:linear-gradient(90deg,#35d3e6,#e0b84a);box-shadow:0 0 10px rgba(53,211,230,.5)"
          :style="{ width: `${state.processingProgress * 100}%` }"
        ></div>
      </div>

      <div class="mt-4 text-[11px] font-semibold text-[rgba(255,255,255,.3)]">
        You can switch to another file while this runs
      </div>
    </div>
  </div>
</template>
