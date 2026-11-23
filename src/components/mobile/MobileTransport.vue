<script setup>
import { computed } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { useTransport, installTransport, SKIP_SECONDS } from '../../composables/useTransport.js'

/**
 * The mobile shell's transport: the clock, skip back / forward, Play and Loop.
 * The play / stop rules are the desktop transport's (useTransport); zoom is a
 * pinch on the waveform, so there are no zoom controls.
 */
const { state, totalDuration, hasSelection, toggleLoop, hasFile } = useEditorState()
const { togglePlay, skipBack, skipForward } = useTransport()
installTransport()

function clock(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const cs = Math.floor((seconds % 1) * 100)
  return { main: `${m}:${String(s).padStart(2, '0')}`, cs: `.${String(cs).padStart(2, '0')}` }
}

const now = computed(() => clock(state.playhead))
const total = computed(() => clock(totalDuration.value))
const playLabel = computed(() => state.isPlaying ? 'Stop' : hasSelection.value ? 'Play selection' : 'Play')
</script>

<template>
  <div class="m-transport">
    <div class="m-clock" aria-label="Playhead">
      <span class="m-clock-main">{{ now.main }}<small>{{ now.cs }}</small></span>
      <!-- To the clock's own precision, so a 3.9 s file is not "0:03". -->
      <span class="m-clock-total" data-testid="mobile-total">of {{ total.main }}{{ total.cs }}</span>
    </div>

    <div class="m-controls">
      <button type="button" class="m-tbtn" :disabled="!hasFile" :aria-label="`Back ${SKIP_SECONDS} seconds`" @click="skipBack">
        <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="11 19 2 12 11 5 11 19" /><polygon points="22 19 13 12 22 5 22 19" /></svg>
      </button>
      <button type="button" class="m-play" :disabled="!hasFile" :aria-label="playLabel" data-testid="mobile-play" @click="togglePlay">
        <svg v-if="!state.isPlaying" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l13 8-13 8z" /></svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
      </button>
      <button type="button" class="m-tbtn" :disabled="!hasFile" :aria-label="`Forward ${SKIP_SECONDS} seconds`" @click="skipForward">
        <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="13 19 22 12 13 5 13 19" /><polygon points="2 19 11 12 2 5 2 19" /></svg>
      </button>
    </div>

    <button
      type="button"
      class="m-loop"
      :class="{ 'is-on': state.isLooping }"
      :disabled="!hasFile"
      :aria-pressed="String(state.isLooping)"
      aria-label="Loop"
      @click="toggleLoop"
    >
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-repeat-2 preview-icon"><path d="m2 9 3-3 3 3"/><path d="M13 18H7a2 2 0 0 1-2-2V6"/><path d="m22 15-3 3-3-3"/><path d="M11 6h6a2 2 0 0 1 2 2v10"/></svg>
      <span>Loop</span>
    </button>
  </div>
</template>

<style scoped>
.m-transport {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  flex-shrink: 0;
  border-top: 1px solid rgba(255,255,255,.06);
  background: linear-gradient(#1a2029, #12161d);
}
.m-clock { display: flex; flex-direction: column; font-family: 'JetBrains Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.m-clock-main { font-size: 19px; font-weight: 700; color: #eaf6f8; }
.m-clock-main small { font-size: 12px; color: rgba(255,255,255,.4); }
.m-clock-total { font-size: 10px; color: rgba(255,255,255,.4); }
.m-controls { display: flex; align-items: center; gap: 14px; }
.m-tbtn {
  width: 40px; height: 40px; border-radius: 50%;
  display: grid; place-items: center;
  border: none; background: rgba(255,255,255,.05);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.1);
  color: rgba(255,255,255,.75);
}
.m-tbtn svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linejoin: round; }
.m-play {
  width: 56px; height: 56px; border-radius: 50%;
  display: grid; place-items: center;
  border: none; background: #35d3e6;
  box-shadow: 0 0 22px rgba(53,211,230,.35);
}
.m-play svg { width: 22px; height: 22px; fill: #08161a; }
.m-play svg path { transform: translateX(1.5px); }
.m-play:disabled, .m-tbtn:disabled, .m-loop:disabled { opacity: .35; }
.m-loop {
  justify-self: end;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 7px 11px; 
  border-radius: 10px;
  border: none; background: none;
  color: rgba(255,255,255,.55);
  font: 600 9.5px 'Inter', sans-serif;
}
.m-loop svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.m-loop.is-on { color: #eaf6f8; background: rgba(53,211,230,.12); }
@media (max-height: 500px) {
  .m-transport { padding: 4px 14px; }
  .m-play { width: 44px; height: 44px; }
  .m-tbtn { width: 34px; height: 34px; }
  .m-clock-main { font-size: 16px; }
}
</style>
