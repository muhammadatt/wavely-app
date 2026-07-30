<script setup>
import { useEditorState } from '../composables/useEditorState.js'

const { state } = useEditorState()
</script>

<template>
  <div class="fixed inset-0 z-[500] flex items-center justify-center" style="background: rgba(5,7,9,.65); backdrop-filter: blur(6px);">
    <div
      class="rounded-[24px] px-[52px] py-[44px] text-center min-w-[290px] font-['Inter']"
      style="background:linear-gradient(155deg,#181c22,#0d1013);box-shadow:0 24px 60px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.06);animation: bounceIn 0.4s cubic-bezier(0.34,1.56,0.64,1) both;"
    >
      <!-- Spinner -->
      <div class="w-[52px] h-[52px] mx-auto mb-5 rounded-full" style="border:4px solid rgba(255,255,255,.08);border-top-color:#35d3e6;border-right-color:#e0b84a;animation: spin 0.7s linear infinite;"></div>

      <div class="text-xl font-bold text-[#eaf6f8] mb-1.5">{{ state.processingMessage }}</div>
      <div class="text-[13px] font-semibold text-[rgba(255,255,255,.42)] mb-[22px] min-h-[18px] transition-all duration-300"
           :key="state.processingStage"
           style="animation: fadeStage 0.35s ease both;">
        {{ state.processingStage || 'This may take a moment' }}
      </div>

      <!-- Progress bar -->
      <div class="w-full h-2.5 rounded-md overflow-hidden" style="background:rgba(255,255,255,.06);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)">
        <div
          class="h-full rounded transition-all duration-400"
          style="background: linear-gradient(90deg, #35d3e6, #e0b84a); box-shadow: 0 0 10px rgba(53,211,230,.5);"
          :style="{ width: `${state.processingProgress * 100}%` }"
        ></div>
      </div>
    </div>
  </div>
</template>
