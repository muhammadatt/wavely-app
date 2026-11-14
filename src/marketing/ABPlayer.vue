<script setup>
/**
 * The before / after player: one clip at a time, the dry and processed takes
 * playing in LOCK-STEP, and an ON / BYPASS switch that crossfades between them
 * without a gap or a jump in position — the A/B the commercial plugin pages
 * offer, on audio rendered by the real DSP (`npm run marketing:render`).
 *
 * ── HOW THE TWO STAY TOGETHER ───────────────────────────────────────────────
 * Both takes are decoded up front and started by two AudioBufferSourceNodes on
 * the SAME `when` and offset, each through its own gain; the switch only moves
 * the gains (a 25 ms equal-power fade, short enough to read as instant and long
 * enough not to click). Switching two <audio> elements cannot do this: they
 * drift, and seeking one to the other's time lands tens of ms off.
 *
 * ── AUDIOCONTEXT ON A GESTURE ───────────────────────────────────────────────
 * The waveforms are decoded on an OfflineAudioContext at load, so the page can
 * draw them; the realtime context is created on the first Play (the app's rule,
 * and the browsers' autoplay policy). An AudioBuffer belongs to no context, so
 * the decoded takes play in it as they are.
 *
 * ── LEVEL MATCH ─────────────────────────────────────────────────────────────
 * A processed voice is usually louder, and louder reads as better. "Match
 * levels" turns the louder take down by the gated-RMS difference the render
 * script measured, so a listener can judge the change and not the volume. Off
 * by default: the level is part of what the effect does.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  /** [{ id, title, text, setting, audio: { on, off, seconds, levelDb, placeholder? } }] */
  samples: { type: Array, required: true },
  /** The effect's name, for the switch's label. */
  name: { type: String, required: true },
})

const FADE_S = 0.025
const index = ref(0)
const sample = computed(() => props.samples[index.value])
const on = ref(true)
const matchLevels = ref(false)
const playing = ref(false)
const loading = ref(false)
const failed = ref(false)
const position = ref(0)
const duration = ref(0)

/** Decoded pairs by sample id: { off, on, peaks: { off, on } }. */
const decoded = new Map()
let ctx = null
let nodes = null // { srcs: [off, on], gains: [off, on] }
let startedAt = 0 // ctx time at which offset 0 would have played
let raf = 0
const canvas = ref(null)

const pending = new Map()
function load(s) {
  if (decoded.has(s.id)) return Promise.resolve(decoded.get(s.id))
  if (pending.has(s.id)) return pending.get(s.id)
  const decoder = new OfflineAudioContext(1, 1, 44100)
  const one = url => fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: ${r.status}`)
    return r.arrayBuffer()
  }).then(b => decoder.decodeAudioData(b))
  const p = Promise.all([one(s.audio.off), one(s.audio.on)]).then(([off, onBuf]) => {
    const pair = { off, on: onBuf, peaks: null }
    decoded.set(s.id, pair)
    pending.delete(s.id)
    return pair
  })
  pending.set(s.id, p)
  return p
}

async function select(i) {
  if (i === index.value && decoded.has(sample.value.id)) return
  const wasPlaying = playing.value
  stop()
  index.value = i
  position.value = 0
  await ensureLoaded()
  if (wasPlaying && !failed.value) play()
}

async function ensureLoaded() {
  const s = sample.value
  loading.value = !decoded.has(s.id)
  failed.value = false
  try {
    const pair = await load(s)
    if (s !== sample.value) return null
    duration.value = Math.min(pair.off.duration, pair.on.duration)
    draw()
    return pair
  } catch (err) {
    console.error('Sample failed to load:', err)
    if (s === sample.value) failed.value = true
    return null
  } finally {
    if (s === sample.value) loading.value = false
  }
}

// ── Gains ────────────────────────────────────────────────────────────────────

/** The two takes' gains for the current switch and level-match state. */
function targetGains() {
  let trimOff = 1, trimOn = 1
  const lv = sample.value.audio.levelDb
  if (matchLevels.value && Number.isFinite(lv?.on) && Number.isFinite(lv?.off)) {
    const d = lv.on - lv.off
    if (d > 0) trimOn = 10 ** (-d / 20)
    else trimOff = 10 ** (d / 20)
  }
  return on.value ? [0, trimOn] : [trimOff, 0]
}

const matchNote = computed(() => {
  const lv = sample.value?.audio?.levelDb
  if (!Number.isFinite(lv?.on) || !Number.isFinite(lv?.off)) return ''
  const d = lv.on - lv.off
  if (Math.abs(d) < 0.05) return 'Both takes are already at the same level.'
  return `${d > 0 ? 'Processed' : 'Bypassed'} take turned down ${Math.abs(d).toFixed(1)} dB.`
})

function applyGains() {
  if (!nodes) return
  const t = ctx.currentTime
  const target = targetGains()
  nodes.gains.forEach((g, k) => {
    g.gain.cancelScheduledValues(t)
    g.gain.setValueAtTime(g.gain.value, t)
    g.gain.linearRampToValueAtTime(target[k], t + FADE_S)
  })
}

watch([on, matchLevels], applyGains)

// ── Transport ────────────────────────────────────────────────────────────────

async function play() {
  const pair = await ensureLoaded()
  if (!pair) return
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') await ctx.resume()
  stopNodes()
  const offset = position.value >= duration.value - 0.05 ? 0 : position.value
  const when = ctx.currentTime + 0.03
  const target = targetGains()
  const srcs = [pair.off, pair.on].map((buf) => {
    const s = ctx.createBufferSource()
    s.buffer = buf
    s.loop = true
    s.loopEnd = duration.value
    return s
  })
  const gains = srcs.map((s, k) => {
    const g = ctx.createGain()
    g.gain.value = target[k]
    s.connect(g).connect(ctx.destination)
    return g
  })
  srcs.forEach(s => s.start(when, offset))
  nodes = { srcs, gains }
  startedAt = when - offset
  playing.value = true
  tick()
}

function stopNodes() {
  if (!nodes) return
  for (const s of nodes.srcs) { try { s.stop() } catch { /* never started */ } s.disconnect() }
  for (const g of nodes.gains) g.disconnect()
  nodes = null
}

function stop() {
  if (playing.value && ctx) position.value = currentPosition()
  stopNodes()
  playing.value = false
  cancelAnimationFrame(raf)
  draw()
}

function toggle() {
  if (playing.value) stop()
  else play()
}

function currentPosition() {
  if (!ctx || !duration.value) return position.value
  const t = ctx.currentTime - startedAt
  return ((t % duration.value) + duration.value) % duration.value
}

function tick() {
  if (!playing.value) return
  position.value = currentPosition()
  draw()
  raf = requestAnimationFrame(tick)
}

function seekTo(seconds) {
  position.value = Math.max(0, Math.min(duration.value, seconds))
  if (playing.value) play()
  else draw()
}

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

/** Min / max of the channels' mean per column. */
function columnPeaks(buf, cols) {
  const n = buf.length, ch = buf.numberOfChannels
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c))
  const out = new Float32Array(cols * 2)
  for (let x = 0; x < cols; x++) {
    const a = Math.floor((x / cols) * n), b = Math.max(a + 1, Math.floor(((x + 1) / cols) * n))
    let lo = 0, hi = 0
    for (let i = a; i < b; i++) {
      let v = 0
      for (let c = 0; c < ch; c++) v += data[c][i]
      v /= ch
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    out[2 * x] = lo
    out[2 * x + 1] = hi
  }
  return out
}

function draw() {
  const el = canvas.value
  const pair = sample.value && decoded.get(sample.value.id)
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
  if (!pair) return
  const cols = Math.max(1, Math.floor(w / 2))
  if (!pair.peaks || pair.peaks.cols !== cols) {
    pair.peaks = { cols, off: columnPeaks(pair.off, cols), on: columnPeaks(pair.on, cols) }
  }
  const mid = h / 2, scale = h * 0.46
  const played = duration.value ? position.value / duration.value : 0
  const bars = (peaks, color, playedColor) => {
    for (let x = 0; x < cols; x++) {
      const lo = peaks[2 * x], hi = peaks[2 * x + 1]
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
    bars(pair.peaks.off, ghost, ghost)
    bars(pair.peaks.on, `${accent}66`, accent)
  } else {
    bars(pair.peaks.on, ghost, ghost)
    bars(pair.peaks.off, 'rgba(234, 246, 248, 0.38)', 'rgba(234, 246, 248, 0.85)')
  }
  const px = played * w
  g.fillStyle = '#ffffff'
  g.fillRect(Math.round(px), 0, 1, h)
}

watch(on, draw)

function fmt(t) {
  const s = Math.max(0, Math.floor(t))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

let ro = null
onMounted(() => {
  ensureLoaded()
  ro = new ResizeObserver(() => draw())
  if (canvas.value) ro.observe(canvas.value)
})
onBeforeUnmount(() => {
  stop()
  ro?.disconnect()
  ctx?.close()
})
</script>

<template>
  <div class="ab" tabindex="-1" @keydown="onKey">
    <ol class="ab-list" aria-label="Sample clips">
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

@media (max-width: 720px) {
  .ab { grid-template-columns: 1fr; }
  .ab-list { flex-direction: row; overflow-x: auto; padding-bottom: 4px; }
  .ab-list li { flex: 0 0 auto; }
  .ab-pick { width: 200px; }
  .ab-time { margin-left: 0; }
}
</style>
