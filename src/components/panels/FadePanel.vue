<script setup>
import { ref } from "vue"
import { useEditorState } from "../../composables/useEditorState.js"
import BaseButton from "../ui/BaseButton.vue"

const { hasSelection, showToast } = useEditorState()

const fadeType = ref("in")
const curveType = ref("linear")
const duration = ref(20) // 0-100 slider, maps to actual seconds

const fadeTypes = [
  { id: "in", label: "Fade In", path: "M2 22 Q24 22 46 2" },
  { id: "out", label: "Fade Out", path: "M2 2 Q24 22 46 22" },
  { id: "cross", label: "Crossfade", path: "M2 22 Q24 12 46 2" },
]

const curveTypes = [
  { id: "linear", label: "Linear", path: "M2 22 C12 22 36 2 46 2" },
  { id: "expo", label: "Expo", path: "M2 22 C2 22 10 2 46 2" },
  { id: "s-curve", label: "S-Curve", path: "M2 22 C16 22 32 2 46 2" },
]

function durationDisplay() {
  return (duration.value / 20).toFixed(1) + " s"
}

function apply() {
  showToast("Fade applied (coming in production)")
}
</script>

<template>
  <div class="font-['Inter']">
    <!-- Header lives in EditPanel, which owns the Trim/Silence/Fade/Volume group -->
    <div class="p-4 flex flex-col gap-[14px]">
      <!-- Fade type -->
      <div>
        <div class="text-[11px] font-semibold text-[rgba(255,255,255,.4)] mb-2">Type</div>
        <div class="flex gap-[6px]">
          <button
            v-for="ft in fadeTypes"
            :key="ft.id"
            class="flex-1 flex flex-col items-center gap-[5px] py-[10px] px-1 rounded-[12px] border text-[10px] font-semibold cursor-pointer transition-all"
            :style="fadeType === ft.id
              ? 'border-color:rgba(53,211,230,.5);background:rgba(53,211,230,.12);color:#7fe9f6'
              : 'border-color:rgba(255,255,255,.07);background:rgba(255,255,255,.03);color:rgba(255,255,255,.5)'"
            @click="fadeType = ft.id">
            <svg viewBox="0 0 48 24" fill="none" class="w-9 h-[18px]">
              <path
                :d="ft.path"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round" />
            </svg>
            {{ ft.label }}
          </button>
        </div>
      </div>

      <!-- Curve shape -->
      <div>
        <div class="text-[11px] font-semibold text-[rgba(255,255,255,.4)] mb-2">Curve</div>
        <div class="flex gap-[6px]">
          <button
            v-for="ct in curveTypes"
            :key="ct.id"
            class="flex-1 flex flex-col items-center gap-[5px] py-[10px] px-1 rounded-[12px] border text-[10px] font-semibold cursor-pointer transition-all"
            :style="curveType === ct.id
              ? 'border-color:rgba(53,211,230,.5);background:rgba(53,211,230,.12);color:#7fe9f6'
              : 'border-color:rgba(255,255,255,.07);background:rgba(255,255,255,.03);color:rgba(255,255,255,.5)'"
            @click="curveType = ct.id">
            <svg viewBox="0 0 48 24" fill="none" class="w-9 h-[18px]">
              <path
                :d="ct.path"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round" />
            </svg>
            {{ ct.label }}
          </button>
        </div>
      </div>

      <!-- Duration -->
      <div class="rounded-[12px] p-[14px]" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)">
        <div class="flex justify-between items-center mb-2">
          <span class="font-['JetBrains_Mono'] text-[8.5px] font-bold tracking-[.14em] text-[rgba(255,255,255,.4)] uppercase">Duration</span>
          <span class="font-['JetBrains_Mono'] text-[15px] font-bold text-[#7fe9f6] tabular-nums">{{ durationDisplay() }}</span>
        </div>
        <input
          type="range"
          min="1"
          max="100"
          v-model.number="duration"
          class="w-full h-1.5 rounded-full appearance-none cursor-pointer"
          style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
      </div>

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
        Apply Fade
      </BaseButton>

      <div
        class="text-[11px] font-semibold rounded-[12px] px-3 py-[10px] text-center leading-relaxed transition-opacity duration-700"
        style="color:#e0b84a;background:rgba(224,184,74,.08);border:1px solid rgba(224,184,74,.32)"
        :class="hasSelection ? 'opacity-0' : 'opacity-100'">
        Make a selection on the waveform to apply fade
      </div>
    </div>
  </div>
</template>
