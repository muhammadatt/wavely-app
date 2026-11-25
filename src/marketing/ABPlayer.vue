<script setup>
/**
 * The effect pages' before / after player: a list of clips and, for the one
 * picked, the dry and processed takes in LOCK-STEP with an ON / BYPASS switch,
 * on audio rendered by the real DSP (`npm run marketing:render`). The engine —
 * lock-step playback, the crossfading switch, level match — is
 * `useABPlayback` (abPlayback.js), shared with the shared listen page's plainer
 * player (src/listen/SharePlayer.vue); this file is the page's look.
 *
 * "Match levels" is off by default: the level is part of what the effect does.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useABPlayback, formatClock as fmt } from './abPlayback.js'

const props = defineProps({
  /** [{ id, title, text, setting, audio: { on, off, seconds, levelDb, placeholder? } }] */
  samples: { type: Array, required: true },
  /** The effect's name, for the switch's label. */
  name: { type: String, required: true },
  /** The editor link that opens a sample there (`tryOutUrl`), or null for none. */
  tryHref: { type: Function, default: null },
  /** The editor link's words. */
  tryLabel: { type: String, default: 'Try it on this clip' },
  /** Show the clip list (off for a page with one recording). */
  showList: { type: Boolean, default: true },
})

const index = ref(0)
const sample = computed(() => props.samples[index.value])
const canvas = ref(null)

const {
  on, matchLevels, playing, loading, failed, position, duration, levelDiffDb,
  ensureLoaded, toggle, seekTo, switchTo, peaks,
} = useABPlayback(sample, () => draw())

async function select(i) {
  if (i === index.value && !loading.value && duration.value) return
  await switchTo(() => { index.value = i })
}

const matchNote = computed(() => {
  const d = levelDiffDb.value
  if (d == null) return ''
  if (Math.abs(d) < 0.05) return 'Both takes are already at the same level.'
  return `${d > 0 ? 'Processed' : 'Bypassed'} take turned down ${Math.abs(d).toFixed(1)} dB.`
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

/** Space plays, B switches — while the player has focus, so the page still scrolls. */
function onKey(e) {
  if (e.target.closest('input, textarea')) return
  if (e.key === ' ') { toggle(); e.preventDefault() }
  else if (e.key === 'b' || e.key === 'B') on.value = !on.value
}

// ── Waveform ─────────────────────────────────────────────────────────────────

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
  const cols = Math.max(1, Math.floor(w / 2))
  const pk = peaks(cols)
  if (!pk) return
  const mid = h / 2, scale = h * 0.46
  const played = duration.value ? position.value / duration.value : 0
  const bars = (data, color, playedColor) => {
    for (let x = 0; x < cols; x++) {
      const lo = data[2 * x], hi = data[2 * x + 1]
      const y0 = mid - hi * scale, y1 = mid - lo * scale
      g.fillStyle = x / cols < played ? playedColor : color
      g.fillRect(x * 2, y0, 1.4, Math.max(1, y1 - y0))
    }
  }
  // The take you are hearing is drawn in front, in colour; the other sits behind as a ghost.
  const css = getComputedStyle(el)
  const accent = css.getPropertyValue('--mk-accent').trim() || '#35d3e6'
  const ghost = 'rgba(234, 246, 248, 0.16)'
  if (on.value) {
    bars(pk.off, ghost, ghost)
    bars(pk.on, `${accent}66`, accent)
  } else {
    bars(pk.on, ghost, ghost)
    bars(pk.off, 'rgba(234, 246, 248, 0.38)', 'rgba(234, 246, 248, 0.85)')
  }
  const px = played * w
  g.fillStyle = '#ffffff'
  g.fillRect(Math.round(px), 0, 1, h)
}

let ro = null
onMounted(() => {
  ensureLoaded()
  ro = new ResizeObserver(() => draw())
  if (canvas.value) ro.observe(canvas.value)
})
onBeforeUnmount(() => {
  ro?.disconnect()
})
</script>

<template>
  <div class="ab" :class="{ 'ab--single': !showList }" tabindex="-1" @keydown="onKey">
    <ol v-if="showList" class="ab-list" aria-label="Sample clips">
      <li v-for="(s, i) in samples" :key="s.id">
        <button
          type="button"
          class="ab-pick"
          :class="{ 'ab-pick--on': i === index }"
          :aria-pressed="i === index"
          @click="select(i)"
        >
          <span class="ab-pick-title">{{ s.title }}</span>
          <span class="ab-pick-setting">{{ s.setting }}</span>
        </button>
      </li>
    </ol>

    <div class="ab-deck">
      <div class="ab-head">
        <div>
          <h3 class="ab-title">{{ sample.title }}</h3>
          <p class="ab-text">{{ sample.text }}</p>
        </div>
        <span v-if="sample.audio.placeholder" class="ab-placeholder" title="Synthetic speech, rendered through the real effect. Real recordings are on the way.">Placeholder clip</span>
      </div>

      <div class="ab-controls">
        <button
          type="button"
          class="ab-play"
          :aria-label="playing ? 'Pause' : 'Play'"
          :disabled="failed"
          @click="toggle"
        >
          <svg v-if="!playing" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" /></svg>
        </button>

        <div class="ab-switch" role="radiogroup" :aria-label="`${name} on or bypassed`">
          <button
            type="button" role="radio" class="ab-seg" :class="{ 'ab-seg--on': !on }"
            :aria-checked="!on" @click="on = false"
          >Bypass</button>
          <button
            type="button" role="radio" class="ab-seg ab-seg--fx" :class="{ 'ab-seg--on': on }"
            :aria-checked="on" @click="on = true"
          ><span class="ab-lamp" aria-hidden="true"></span>{{ name }} on</button>
        </div>

        <span class="ab-time" aria-live="off">{{ fmt(position) }} / {{ fmt(duration) }}</span>
      </div>

      <div
        class="ab-wave"
        role="slider"
        tabindex="0"
        aria-label="Playback position"
        :aria-valuemin="0"
        :aria-valuemax="Math.round(duration)"
        :aria-valuenow="Math.round(position)"
        :aria-valuetext="fmt(position)"
        @click="onWaveClick"
        @keydown="onWaveKey"
      >
        <canvas ref="canvas" class="ab-canvas"></canvas>
        <span v-if="loading" class="ab-status">Loading…</span>
        <span v-else-if="failed" class="ab-status">This clip could not be loaded.</span>
      </div>

      <div class="ab-foot">
        <label class="ab-match">
          <input v-model="matchLevels" type="checkbox" />
          <span>Match levels</span>
        </label>
        <span class="ab-foot-note">{{ matchLevels ? matchNote : 'Press B to switch, space to play. Headphones recommended.' }}</span>
        <!-- Into the editor with this clip loaded and the effect open on it. -->
        <a v-if="tryHref" :href="tryHref(sample)" class="ab-try">
          {{ tryLabel }}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ab {
  display: grid;
  grid-template-columns: minmax(200px, 260px) 1fr;
  gap: 16px;
  outline: none;
}
.ab--single { grid-template-columns: 1fr; }
.ab-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ab-pick {
  width: 100%;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--mk-hairline);
  background: rgba(255, 255, 255, 0.02);
  color: var(--mk-text);
  cursor: pointer;
  font: inherit;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.ab-pick:hover { background: rgba(255, 255, 255, 0.05); }
.ab-pick--on {
  border-color: rgba(53, 211, 230, 0.55);
  background: rgba(53, 211, 230, 0.08);
}
.ab-pick-title { font-weight: 600; font-size: 14px; }
.ab-pick-setting { font-size: 12px; color: var(--mk-muted); }

.ab-deck {
  min-width: 0;
  border: 1px solid var(--mk-hairline);
  border-radius: 16px;
  background: var(--mk-surface);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ab-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.ab-title { margin: 0; font-size: 17px; font-weight: 700; }
.ab-text { margin: 4px 0 0; font-size: 14px; color: var(--mk-soft); line-height: 1.5; }
.ab-placeholder {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #f2b84b;
  border: 1px solid rgba(242, 184, 75, 0.45);
  border-radius: 999px;
  padding: 3px 9px;
  cursor: help;
}

.ab-controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.ab-play {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: var(--mk-accent);
  color: #06181b;
  display: grid;
  place-items: center;
  cursor: pointer;
  flex: none;
}
.ab-play svg { width: 22px; height: 22px; }
.ab-play:disabled { opacity: 0.4; cursor: default; }

.ab-switch {
  display: inline-flex;
  padding: 4px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--mk-hairline);
}
.ab-seg {
  border: none;
  background: transparent;
  color: var(--mk-muted);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 8px 14px;
  border-radius: 9px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.ab-seg--on { background: rgba(255, 255, 255, 0.1); color: var(--mk-text); }
.ab-seg--fx.ab-seg--on { background: rgba(53, 211, 230, 0.16); color: var(--mk-accent); }
.ab-lamp {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
}
.ab-seg--fx.ab-seg--on .ab-lamp {
  background: var(--mk-accent);
  box-shadow: 0 0 8px var(--mk-accent);
}
.ab-time {
  margin-left: auto;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px;
  color: var(--mk-muted);
}

.ab-wave {
  position: relative;
  height: 120px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.3);
  cursor: pointer;
  outline: none;
}
.ab-wave:focus-visible { box-shadow: 0 0 0 2px var(--mk-accent); }
.ab-canvas { display: block; width: 100%; height: 100%; }
.ab-status {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 13px;
  color: var(--mk-muted);
}

.ab-foot { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: 13px; }
.ab-match { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--mk-soft); }
.ab-match input { accent-color: var(--mk-accent); }
.ab-foot-note { color: var(--mk-muted); }
.ab-try {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-radius: 10px;
  border: 1px solid rgba(53, 211, 230, 0.5);
  color: var(--mk-accent);
  font-weight: 700;
  font-size: 13px;
  text-decoration: none;
  white-space: nowrap;
}
.ab-try:hover { background: rgba(53, 211, 230, 0.1); }
.ab-try svg { width: 15px; height: 15px; }

@media (max-width: 720px) {
  .ab { grid-template-columns: 1fr; }
  .ab-list { flex-direction: row; overflow-x: auto; padding-bottom: 4px; }
  .ab-list li { flex: 0 0 auto; }
  .ab-pick { width: 200px; }
  .ab-time { margin-left: 0; }
}
</style>
