import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { setPlaybackAudioSession, createAudioContext, resumeIfStopped } from '../platform/audioSession.js'

/**
 * The before / after engine: a dry and a processed take playing in LOCK-STEP,
 * an ON / BYPASS switch that crossfades between them without a gap or a jump
 * in position, and an optional level match. No look of its own — the effect
 * pages' player (ABPlayer.vue) and the shared listen page's (src/listen/
 * SharePlayer.vue) draw it.
 *
 * ── HOW THE TWO STAY TOGETHER ───────────────────────────────────────────────
 * Both takes are decoded up front and started by two AudioBufferSourceNodes on
 * the SAME `when` and offset, each through its own gain; the switch only moves
 * the gains (a 25 ms linear fade, short enough to read as instant and long
 * enough not to click). Switching two <audio> elements cannot do this: they
 * drift, and seeking one to the other's time lands tens of ms off.
 *
 * ── AUDIOCONTEXT ON A GESTURE ───────────────────────────────────────────────
 * The takes are decoded on an OfflineAudioContext at load, so the page can
 * draw them; the realtime context is created on the first Play (the app's rule,
 * and the browsers' autoplay policy). An AudioBuffer belongs to no context, so
 * the decoded takes play in it as they are.
 *
 * ── LEVEL MATCH ─────────────────────────────────────────────────────────────
 * A processed voice is usually louder, and louder reads as better. Matching
 * turns the louder take down by the gated-RMS difference measured when the
 * takes were made (`audio.levelDb`), so a listener can judge the change and
 * not the volume.
 *
 * @param {import('vue').Ref} sample  the clip playing: { id, audio: { off, on, levelDb } }
 * @param {() => void} redraw         called whenever the picture should change
 */
export function useABPlayback(sample, redraw = () => {}) {
  const FADE_S = 0.025
  const on = ref(true)
  const matchLevels = ref(false)
  const playing = ref(false)
  const loading = ref(false)
  const failed = ref(false)
  const position = ref(0)
  const duration = ref(0)

  /** Decoded pairs by sample id: { off, on, peaks }. */
  const decoded = new Map()
  const pending = new Map()
  let ctx = null
  let nodes = null // { srcs: [off, on], gains: [off, on] }
  let startedAt = 0 // ctx time at which offset 0 would have played
  let raf = 0

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
    }, (err) => {
      // Forget the failure so the next play or sample switch fetches again.
      pending.delete(s.id)
      throw err
    })
    pending.set(s.id, p)
    return p
  }

  async function ensureLoaded() {
    const s = sample.value
    loading.value = !decoded.has(s.id)
    failed.value = false
    try {
      const pair = await load(s)
      if (s !== sample.value) return null
      duration.value = Math.min(pair.off.duration, pair.on.duration)
      redraw()
      return pair
    } catch (err) {
      console.error('Sample failed to load:', err)
      if (s === sample.value) failed.value = true
      return null
    } finally {
      if (s === sample.value) loading.value = false
    }
  }

  /** The decoded pair of the current clip, or null. */
  const currentPair = () => (sample.value && decoded.get(sample.value.id)) || null

  // ── Gains ──────────────────────────────────────────────────────────────────

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

  /** The level difference matching removes, in dB (processed − original), or null. */
  const levelDiffDb = computed(() => {
    const lv = sample.value?.audio?.levelDb
    if (!Number.isFinite(lv?.on) || !Number.isFinite(lv?.off)) return null
    return lv.on - lv.off
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
  watch(on, () => redraw())

  // ── Transport ──────────────────────────────────────────────────────────────

  async function play() {
    // Create and resume the context inside the click, before anything is awaited:
    // after a first-time fetch the gesture has expired and Safari / iOS keep the
    // context suspended.
    // The playback session first, so an iPhone on silent still plays the clip.
    setPlaybackAudioSession()
    if (!ctx) ctx = createAudioContext()
    // 'interrupted' too: Safari's state after a call or another app's audio.
    // Never rejects: a refusal (a call still in progress) resolves false.
    const resumed = resumeIfStopped(ctx)
    const pair = await ensureLoaded()
    if (!pair) return
    // Refused: leave the player stopped, so the next press tries again.
    if (!(await resumed)) return
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
    // A seek during playback calls play() again: replace the loop, never stack one.
    cancelAnimationFrame(raf)
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
    redraw()
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
    redraw()
    raf = requestAnimationFrame(tick)
  }

  function seekTo(seconds) {
    position.value = Math.max(0, Math.min(duration.value, seconds))
    if (playing.value) play()
    else redraw()
  }

  /** Switch to another clip (`setIndex` changes what `sample` reads), playing on if it was. */
  async function switchTo(setIndex) {
    const wasPlaying = playing.value
    stop()
    setIndex()
    position.value = 0
    await ensureLoaded()
    if (wasPlaying && !failed.value) play()
  }

  // ── Waveform data ──────────────────────────────────────────────────────────

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

  /** The current clip's peaks at `cols` columns ({ off, on }), or null before it loads. */
  function peaks(cols) {
    const pair = currentPair()
    if (!pair) return null
    if (!pair.peaks || pair.peaks.cols !== cols) {
      pair.peaks = { cols, off: columnPeaks(pair.off, cols), on: columnPeaks(pair.on, cols) }
    }
    return pair.peaks
  }

  onBeforeUnmount(() => {
    stop()
    ctx?.close()
  })

  return {
    on, matchLevels, playing, loading, failed, position, duration, levelDiffDb,
    ensureLoaded, play, stop, toggle, seekTo, switchTo, peaks,
  }
}

/** m:ss */
export function formatClock(t) {
  const s = Math.max(0, Math.floor(t))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
