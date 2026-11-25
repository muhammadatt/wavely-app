<script setup>
/**
 * The shared listen page's player: play, a plain waveform you can click to
 * seek, and an Original / Processed switch — the effect pages' lock-step
 * engine (`useABPlayback`) in a deliberately ordinary face, so a page reached
 * from a Reddit comment reads as a file someone shared, not an advert.
 *
 * Colours come from the page's tokens (--ls-*), so it follows light / dark.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useABPlayback, formatClock } from '../marketing/abPlayback.js'

const props = defineProps({
  /** { id, audio: { off, on, levelDb } } */
  clip: { type: Object, required: true },
})

const sample = computed(() => props.clip)
const canvas = ref(null)
const {
  on, matchLevels, playing, loading, failed, position, duration, levelDiffDb,
  ensureLoaded, toggle, seekTo, peaks: peaksAt,
} = useABPlayback(sample, () => draw())

const matchNote = computed(() => {
  const d = levelDiffDb.value
  if (d == null || Math.abs(d) < 0.05) return ''
  return `${d > 0 ? 'Processed' : 'Original'} turned down ${Math.abs(d).toFixed(1)} dB`
})

function onWaveClick(e) {
  if (!duration.value) return
  const r = e.currentTarget.getBoundingClientRect()
  seekTo(((e.clientX - r.left) / r.width) * duration.value)
}
function onWaveKey(e) {
  if (e.key === 'ArrowLeft') { seekTo(position.value - 2); e.preventDefault() }
  if (e.key === 'ArrowRight') { seekTo(position.value + 2); e.preventDefault() }
}
/** Space plays, B switches — while the player has focus. */
function onKey(e) {
  if (e.target.closest('input, textarea')) return
  if (e.key === ' ') { toggle(); e.preventDefault() }
  else if (e.key === 'b' || e.key === 'B') on.value = !on.value
}

function draw() {
  const el = canvas.value
  if (!el) return
  const dpr = window.devicePixelRatio || 1
  const w = el.clientWidth, h = el.clientHeight
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
  }
  const g = el.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)
  const step = 3
  const cols = Math.max(1, Math.floor(w / step))
  const peaks = peaksAt(cols)
  if (!peaks) return
  const css = getComputedStyle(el)
  const ink = css.getPropertyValue('--ls-ink').trim() || '#1f1f1f'
  const rest = css.getPropertyValue('--ls-wave').trim() || '#c4c4c0'
  const data = on.value ? peaks.on : peaks.off
  const mid = h / 2, scale = h * 0.48
  const played = duration.value ? position.value / duration.value : 0
  for (let x = 0; x < cols; x++) {
    const amp = Math.max(Math.abs(data[2 * x]), Math.abs(data[2 * x + 1]))
    const half = Math.max(0.75, amp * scale)
    g.fillStyle = x / cols < played ? ink : rest
    g.fillRect(x * step, mid - half, 2, half * 2)
  }
}

// The canvas reads its colours from the page's tokens when it draws, so a
// light / dark switch while the page is open needs a redraw.
const scheme = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : null
const onScheme = () => draw()

let ro = null
onMounted(() => {
  ensureLoaded()
  ro = new ResizeObserver(() => draw())
  if (canvas.value) ro.observe(canvas.value)
  scheme?.addEventListener?.('change', onScheme)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  scheme?.removeEventListener?.('change', onScheme)
})
</script>

<template>
  <div class="sp" tabindex="-1" @keydown="onKey">
    <div class="sp-row">
      <button type="button" class="sp-play" :aria-label="playing ? 'Pause' : 'Play'" :disabled="failed" @click="toggle">
        <svg v-if="!playing" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" /></svg>
      </button>
      <div
        class="sp-wave" role="slider" tabindex="0" aria-label="Playback position"
        :aria-valuemin="0" :aria-valuemax="Math.round(duration)" :aria-valuenow="Math.round(position)"
        :aria-valuetext="formatClock(position)"
        @click="onWaveClick" @keydown="onWaveKey"
      >
        <canvas ref="canvas" class="sp-canvas"></canvas>
        <span v-if="loading" class="sp-status">Loading…</span>
        <span v-else-if="failed" class="sp-status">The audio couldn’t be loaded.</span>
      </div>
      <span class="sp-time">{{ formatClock(position) }} / {{ formatClock(duration) }}</span>
    </div>

    <div class="sp-row sp-row--opts">
      <div class="sp-switch" role="radiogroup" aria-label="Which version to hear">
        <button type="button" role="radio" class="sp-seg" :class="{ 'is-on': !on }" :aria-checked="!on" @click="on = false">Original</button>
        <button type="button" role="radio" class="sp-seg" :class="{ 'is-on': on }" :aria-checked="on" @click="on = true">Processed</button>
      </div>
      <label class="sp-match" :title="matchNote || 'Both versions are at the same level'">
        <input v-model="matchLevels" type="checkbox" />
        Match volume
      </label>
    </div>
  </div>
</template>

<style scoped>
.sp { outline: none; }
.sp-row { display: flex; align-items: center; gap: 12px; }
.sp-row--opts { margin-top: 12px; justify-content: space-between; flex-wrap: wrap; }
.sp-play {
  flex: none; width: 40px; height: 40px; border-radius: 50%;
  display: grid; place-items: center; cursor: pointer;
  border: 1px solid var(--ls-line); background: var(--ls-card); color: var(--ls-ink);
}
.sp-play:hover:not(:disabled) { background: var(--ls-hover); }
.sp-play:disabled { opacity: .4; cursor: default; }
.sp-play svg { width: 18px; height: 18px; }
.sp-wave { position: relative; flex: 1; min-width: 0; height: 44px; cursor: pointer; border-radius: 4px; }
.sp-wave:focus-visible { outline: 2px solid var(--ls-focus); outline-offset: 2px; }
.sp-canvas { display: block; width: 100%; height: 100%; }
.sp-status { position: absolute; inset: 0; display: grid; place-items: center; font-size: 13px; color: var(--ls-muted); }
.sp-time { flex: none; font-size: 12.5px; color: var(--ls-muted); font-variant-numeric: tabular-nums; }
.sp-switch { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--ls-hover); }
.sp-seg {
  border: none; background: none; cursor: pointer; padding: 6px 12px; border-radius: 6px;
  font: inherit; font-size: 13px; color: var(--ls-soft);
}
.sp-seg.is-on { background: var(--ls-card); color: var(--ls-ink); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, .12); }
.sp-match { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ls-soft); cursor: pointer; }
@media (max-width: 480px) {
  .sp-time { display: none; }
}
</style>
