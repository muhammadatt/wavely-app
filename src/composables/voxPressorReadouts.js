import { computed } from 'vue'
import { releaseSecondsForDial } from '../audio/fet1176Processor.js'
import {
  PEAKS_BODY_WARN_DB, PEAKS_BODY_TOUCH_DB, PEAKS_MAX, BODY_MAX, PEAKS_RIPPLE_WARN_DB, peaksTiming,
  BODY_GUIDE_EDGE_DB, BODY_GUIDE_WARN_DB,
} from '../audio/effects/voxPressorParams.js'

/**
 * VoxPressor's readouts, warnings and guide zones — what its faceplate SAYS,
 * decided here so any face can draw it. The panel picks which stage the needle
 * reads, the 0–100 display scale and the colours; nothing here knows them.
 *
 * The readouts are MEASURED at the knobs (`measureVoxPressor`): the knobs act
 * at once, the figures follow when the measurement lands. Every warning is a
 * warning, never a cap — the knob always goes where it is turned.
 *
 * Built once per plugin copy, from that copy's refs (useVoxPressor.js).
 *
 * @param {object} s  the copy's refs: voxPeaks, voxBody, voxSpeed, voxParallel,
 *   voxParallelComp, voxPreview, voxReadout, voxMeasured, voxBusy,
 *   voxUpstreamStale, voxPeaksStale, voxPeaksGuide, voxBodyGuide, voxPeaksGr,
 *   voxBodyGr, voxParallelGr
 */
export function createVoxReadouts(s) {
  /**
   * A stage's gain reduction for the needle, dB ≥ 0. The effect reports it as
   * NEGATIVE dB (DynamicsCompressorNode's convention, which the GR bars read
   * with Math.abs); the needle wants it positive.
   */
  function stageGrDb(stage) {
    const gr = { peaks: s.voxPeaksGr, body: s.voxBodyGr, parallel: s.voxParallelGr }[stage]
    return Math.abs(gr?.value ?? 0)
  }

  // ── Warnings ──────────────────────────────────────────────────────────────

  /** Peaks has started lowering the voice itself (past PEAKS_BODY_WARN_DB): red. */
  const peaksOver = computed(() => {
    const r = s.voxReadout.value
    return !!r && s.voxPeaks.value > 0 && r.peaksBodyDb > PEAKS_BODY_WARN_DB
  })
  /** Peaks touches the voice at all (PEAKS_BODY_TOUCH_DB, where 0.0 stops printing): amber, as the ring. */
  const peaksTouch = computed(() => {
    const r = s.voxReadout.value
    return !!r && s.voxPeaks.value > 0 && r.peaksBodyDb >= PEAKS_BODY_TOUCH_DB
  })
  /** Body levels past BODY_GUIDE_EDGE_DB on average: amber. */
  const bodyEdge = computed(() => {
    const r = s.voxReadout.value
    return !!r && s.voxBody.value > 0 && r.bodyDb >= BODY_GUIDE_EDGE_DB
  })
  /** Body levels past BODY_GUIDE_WARN_DB: red. */
  const bodyOver = computed(() => {
    const r = s.voxReadout.value
    return !!r && s.voxBody.value > 0 && r.bodyDb >= BODY_GUIDE_WARN_DB
  })
  /** Gain ripple: the 1176 moving its gain within the voice's own cycles. */
  const rippleWarn = computed(() => {
    const r = s.voxReadout.value
    return !!r && s.voxPeaks.value > 0 && Number.isFinite(r.peaksRippleDb) && r.peaksRippleDb > PEAKS_RIPPLE_WARN_DB
  })
  const rippleNote = computed(() => {
    const r = s.voxReadout.value
    if (!r || s.voxPeaks.value <= 0 || !Number.isFinite(r.peaksRippleDb)) return ''
    const v = `ripple ${r.peaksRippleDb.toFixed(0)} dB`
    return rippleWarn.value ? `${v} · distorting${s.voxSpeed.value === 'gentle' ? '' : ', try NORMAL'}` : v
  })

  // ── Guide zones (param units, 0–PEAKS_MAX / 0–BODY_MAX) ───────────────────

  /**
   * THE PEAKS GUIDE (`measureVoxPressor`'s `peaksGuide`): 'ok' while the stage
   * leaves the voice alone, 'edge' from the first touch (PEAKS_BODY_TOUCH_DB),
   * 'over' past PEAKS_BODY_WARN_DB (owner, November 2026: the Peaks stage
   * should not reduce the body at all). A guide, never a cap.
   */
  const peaksZones = computed(() => {
    const g = s.voxPeaksGuide.value
    if (!g) return null
    const red = Math.max(g.touch, g.warn)
    return [
      { from: 0, to: g.touch, level: 'ok' },
      { from: g.touch, to: red, level: 'edge' },
      { from: red, to: PEAKS_MAX, level: 'over' },
    ]
  })
  /**
   * THE BODY GUIDE (`measureVoxPressor`'s `bodyGuide`): 'ok' while the LA-2A
   * levels this voice gently, 'edge' past BODY_GUIDE_EDGE_DB of average
   * leveling, 'over' past BODY_GUIDE_WARN_DB. Reasoned; a guide, never a cap.
   */
  const bodyZones = computed(() => {
    const g = s.voxBodyGuide.value
    if (!g) return null
    const red = Math.max(g.edge, g.warn)
    return [
      { from: 0, to: g.edge, level: 'ok' },
      { from: g.edge, to: red, level: 'edge' },
      { from: red, to: BODY_MAX, level: 'over' },
    ]
  })

  // ── The readout under the meter drum ──────────────────────────────────────

  /**
   * Per stage: line 1 is what the stage did, measured — never the GR (the
   * needle shows that) and never a knob's own value (the knob shows it); each
   * figure NAMES WHAT IT MEASURES with its unit (owner, November 2026), as
   * `{ k, v }` pairs:
   *   Peaks     loudest peaks −x dB · voice −y dB   (taken off the loudest peaks; what it cost the voice)
   *   Body      avg leveling −x dB                  (the LA-2A's average reduction on the voice)
   *   Parallel  parallel makeup +x dB               (the copy's measured wet gain)
   * 'stage out' for a stage that is out, '' before its first figures.
   * `stale`: a measurement that can change THIS stage is in flight — Peaks only
   * for its own knob, mode, speed or the alignment; Body for anything upstream;
   * Parallel for any measurement.
   */
  const stageReadouts = computed(() => {
    const r = s.voxReadout.value
    const peaksLine = s.voxPeaks.value <= 0 ? 'stage out'
      : r ? [{ k: 'loudest peaks', v: `${cut(r.peaksDb)} dB` }, { k: 'voice', v: `${cut(r.peaksBodyDb)} dB` }] : ''
    const bodyLine = s.voxBody.value <= 0 ? 'stage out'
      : r ? [{ k: 'avg leveling', v: `${cut(r.bodyDb)} dB` }] : ''
    // Parallel: the copy's measured MAKEUP (its wet gain, solved on the blend —
    // mostly Drive's; Mix moves it a few tenths).
    const m = s.voxMeasured.value.parallelMakeupDb
    const parallelLine = s.voxParallel.value <= 0 ? 'stage out'
      : Number.isFinite(m) ? [{ k: 'parallel makeup', v: `${m >= 0 ? '+' : '−'}${Math.abs(m).toFixed(1)} dB` }] : ''
    return {
      peaks: {
        line: peaksLine, stale: s.voxPeaksStale.value,
        warn: peaksTouch.value, over: peaksOver.value,
        // The ripple takes the note line when it warns.
        note: rippleWarn.value ? rippleNote.value : '',
      },
      body: { line: bodyLine, stale: s.voxUpstreamStale.value, warn: bodyEdge.value, over: bodyOver.value },
      // Every measurement re-solves Parallel, so any one in flight makes it stale.
      parallel: { line: parallelLine, stale: s.voxBusy.value && s.voxPreview.value },
    }
  })

  /**
   * The readout of `stage` as the panel prints it: its line ('—' when there is
   * nothing to show and nothing coming) and a `status` — 'measuring…' before
   * the first figures, 'remeasuring…' while newer ones are in flight (the old
   * ones dimmed, not blanked), '' otherwise. A stage that is out measures
   * nothing.
   */
  function stageReadout(stage) {
    const r = stageReadouts.value[stage] ?? stageReadouts.value.peaks
    const out = r.line === 'stage out'
    const busy = !out && (r.stale || (!r.line && s.voxBusy.value))
    return { ...r, line: r.line || (busy ? '' : '—'), status: busy ? (r.line ? 'remeasuring…' : 'measuring…') : '' }
  }

  /**
   * The Attack / release setter times BOTH 1176s — the Peaks stage and the
   * parallel copy when it is the 1176 — so it is live while either is in.
   */
  const speedInUse = computed(() =>
    s.voxPeaks.value > 0 || (s.voxParallel.value > 0 && s.voxParallelComp.value === '1176'))

  /** The bench's line of measured values: the voice corner, the release the speed resolves to, the makeups. */
  const measuredSummary = computed(() => {
    const m = s.voxMeasured.value
    const corner = Number.isFinite(m.cornerHz) ? `voice corner ${Math.round(m.cornerHz)} Hz` : 'voice corner 80 Hz (default)'
    const t = peaksTiming(s.voxSpeed.value, m.voiceF0Hz)
    const release = `release ${Math.round(releaseSecondsForDial(t.release) * 1000)} ms`
    const speed = s.voxSpeed.value === 'auto'
      ? (Number.isFinite(m.voiceF0Hz) ? `F0 ${Math.round(m.voiceF0Hz)} Hz → ${release}` : `${release} until F0 is measured`)
      : release
    // Per-stage makeup, restores included: the 1176's lands on its Output, the
    // LA-2A's is its Gain plus the restore after the chain.
    const sign = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
    const makeup = `makeup 1176 ${sign(m.peaksMakeupDb ?? 0)} · LA-2A ${sign((m.bodyMakeupDb ?? 0) + (m.makeupDb ?? 0))} dB`
    return `${corner} · ${speed} · ${makeup}`
  })

  return {
    stageGrDb, stageReadouts, stageReadout,
    peaksTouch, peaksOver, bodyEdge, bodyOver, rippleWarn, rippleNote,
    peaksZones, bodyZones, speedInUse, measuredSummary,
  }
}

/** A reduction, dB ≥ 0, as the readouts print it: −x.x, and 0.0 rather than "−0.0". */
export const cut = v => (Math.abs(v) < 0.05 ? '0.0' : `−${Math.abs(v).toFixed(1)}`)
