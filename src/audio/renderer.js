import { getSegmentDuration } from './operations.js'

/**
 * Waveform Canvas Renderer
 *
 * Draws waveform peaks, selection overlay, and playhead onto a canvas.
 * Handles devicePixelRatio for retina displays.
 */

const WAVEFORM_FILL = '#5df0b0'
// Selection reads by dimming everything outside it rather than by tinting the
// inside. A 7% cyan wash over a bright waveform on near-black was close to
// invisible; veiling the unselected audio gives the contrast instead.
const SELECTION_COLOR = 'rgba(53, 211, 230, 0.10)'
const SELECTION_BORDER_COLOR = 'rgba(126, 240, 255, 0.9)'
const UNSELECTED_VEIL_COLOR = 'rgba(5, 7, 9, 0.55)'
const PLAYHEAD_COLOR = '#ff5a4d'

// Clip marks. The colour is the Soft Clipper panel's accent, so a mark on the
// waveform and the lamp on the faceplate read as the same instrument reporting
// twice rather than as two unrelated indicators.
const CLIP_MARK_COLOR = '#ff8f6b'
const CLIP_MARK_STEM_COLOR = 'rgba(255,143,107,.13)'
const CLIP_MARK_MIN_PX = 6
const CLIP_MARK_MAX_PX = 16
// Matches the lamp's own full scale, so a pinned lamp and a full-height notch
// mean the same reduction. Moving one without the other would make the panel
// and the timeline disagree about the same event.
const CLIP_MARK_FULL_SCALE_DB = 3
const ZERO_LINE_COLOR = 'rgba(255, 255, 255, 0.07)'
const LANE_DIVIDER_COLOR = 'rgba(255, 255, 255, 0.14)'
// Clears the ruler labels, which sit on a 13px baseline in a 10px font. Callers
// that want a ruler-safe waveform pass this as topGutter, so the two stay tied
// together rather than drifting apart in separate files.
export const RULER_GUTTER_HEIGHT = 18
const LANE_LABEL_COLOR = 'rgba(255, 255, 255, 0.38)'
// Stereo is the case worth labelling; anything wider falls back to numbers.
const LANE_LABELS = ['L', 'R']

/**
 * Compute peaks for a segment for each pixel column.
 *
 * The peak cache is precomputed once at a fixed resolution (samplesPerPx)
 * for cheap full-file/overview rendering. It's coarser than what's needed
 * once the user zooms in past that resolution — reading it at that point
 * just stretches the same low-res buckets across pixels, which reads as
 * blocky rather than a true sample-accurate close-up. So: read peaks
 * straight from the decoded AudioBuffer whenever the current zoom asks for
 * more detail than the cache has (samplesPerPx below the cache's own), and
 * fall back to the cache otherwise — the visible sample range at that point
 * is small enough that scanning it directly every frame is still cheap.
 */
function getSegmentPeaksForRange(segment, peakCaches, startPx, endPx, samplesPerPx, sampleRate, channelIndex = 0) {
  if (segment.sourceBuffer === null) {
    // Silence — return flat line
    const count = endPx - startPx
    const result = []
    for (let i = 0; i < count; i++) {
      result.push({ min: 0, max: 0 })
    }
    return result
  }

  const bufferId = segment.sourceBufferId
  const cache = peakCaches.get(bufferId)
  const sourceStartSample = Math.floor(segment.sourceStart * sampleRate)

  // A buffer can hold fewer channels than the timeline has lanes — a
  // server-processed mono result dropped into a stereo file, say. Fall back to
  // its last channel so that segment still draws in both lanes rather than
  // vanishing from the right one.
  const bufferCh = Math.min(channelIndex, segment.sourceBuffer.numberOfChannels - 1)

  const useRaw = !cache || samplesPerPx < cache.samplesPerPx
  if (useRaw) {
    const channelData = segment.sourceBuffer.getChannelData(bufferCh)
    const totalSamples = channelData.length
    const result = []
    for (let px = startPx; px < endPx; px++) {
      const sampleStart = sourceStartSample + Math.floor(px * samplesPerPx)
      // Always cover at least one raw sample, even when samplesPerPx < 1
      // (multiple pixels per sample, at the very deepest zoom).
      const sampleEnd = Math.max(sampleStart + 1, sourceStartSample + Math.floor((px + 1) * samplesPerPx))

      let min = Number.POSITIVE_INFINITY
      let max = Number.NEGATIVE_INFINITY
      let hasData = false
      const s0 = Math.max(0, sampleStart)
      const s1 = Math.min(totalSamples, sampleEnd)
      for (let j = s0; j < s1; j++) {
        const v = channelData[j]
        if (v < min) min = v
        if (v > max) max = v
        hasData = true
      }

      result.push(hasData ? { min, max } : { min: 0, max: 0 })
    }
    return result
  }

  const result = []
  const cachePeaks = cache.channels[Math.min(channelIndex, cache.channels.length - 1)]

  for (let px = startPx; px < endPx; px++) {
    // px is the pixel offset within the segment — use it directly to map to
    // the correct source samples.  The old code subtracted startPx, which
    // always reset to 0 and caused the waveform to render from the segment
    // start regardless of scroll position.
    const sampleStart = sourceStartSample + Math.floor(px * samplesPerPx)
    const sampleEnd = sourceStartSample + Math.floor((px + 1) * samplesPerPx)

    // Map to peak cache indices
    const cacheSPP = cache.samplesPerPx
    const cacheStart = Math.floor(sampleStart / cacheSPP)
    const cacheEnd = Math.ceil(sampleEnd / cacheSPP)

    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let hasData = false
    for (let ci = cacheStart; ci < cacheEnd && ci * 2 + 1 < cachePeaks.length; ci++) {
      if (ci < 0) continue
      const cMin = cachePeaks[ci * 2]
      const cMax = cachePeaks[ci * 2 + 1]
      if (cMin < min) min = cMin
      if (cMax > max) max = cMax
      hasData = true
    }

    if (!hasData) {
      result.push({ min: 0, max: 0 })
    } else {
      result.push({ min, max })
    }
  }

  return result
}

/**
 * Main render function — draws waveform peaks only.
 * Selection and playhead are handled separately by renderOverlay().
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} options
 * @param {Array} options.segments
 * @param {Map} options.peakCaches
 * @param {number} options.sampleRate
 * @param {number} options.scrollLeft - horizontal scroll in seconds
 * @param {number} options.pixelsPerSecond - zoom level
 * @param {number} options.totalDuration
 */
export function renderWaveform(canvas, options) {
  const {
    segments,
    peakCaches: peakCacheMap,
    sampleRate,
    scrollLeft = 0,
    pixelsPerSecond = 100,
    totalDuration = 0,
    // Lanes to draw. Defaults to 1 so the overview strip and any other caller
    // keeps its single-lane look without opting in.
    channelCount = 1,
    // Height reserved above the lanes for the ruler labels. The waveform is
    // drawn after the grid, so at full scale its fill painted straight over the
    // timestamps; the lanes now start below them instead. Defaults to 0 to
    // leave the short overview strip at its full height.
    topGutter = 0,
    // The overview strip is for navigation, not measurement — the main canvas
    // carries the ruler, and repeating it in a strip a few pixels tall reads as
    // clutter.
    showTimeGrid = true,
  } = options

  const dpr = window.devicePixelRatio || 1
  const logicalWidth = canvas.clientWidth
  const logicalHeight = canvas.clientHeight

  // Set canvas actual size for retina
  canvas.width = logicalWidth * dpr
  canvas.height = logicalHeight * dpr

  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  // Clear
  ctx.clearRect(0, 0, logicalWidth, logicalHeight)

  // Each channel gets an equal horizontal band, so a stereo file reads as two
  // stacked lanes sharing one time axis.
  const lanes = Math.max(1, channelCount)
  const laneTop = Math.min(topGutter, logicalHeight)
  const laneHeight = (logicalHeight - laneTop) / lanes
  const laneCenterY = i => laneTop + laneHeight * i + laneHeight / 2
  const amplitude = laneHeight / 2 - 2 // Leave 2px padding

  // Time grid — drawn first so the waveform fill paints over it, matching
  // the reference design's layering (grid behind the waveform, inside the
  // same box, rather than a separate ruler strip above it). Spans the full
  // height: the time axis is shared by every lane.
  if (showTimeGrid) drawTimeGrid(ctx, logicalWidth, logicalHeight, scrollLeft, pixelsPerSecond)

  // Zero line per lane
  ctx.strokeStyle = ZERO_LINE_COLOR
  ctx.lineWidth = 1
  for (let i = 0; i < lanes; i++) {
    ctx.beginPath()
    ctx.moveTo(0, laneCenterY(i))
    ctx.lineTo(logicalWidth, laneCenterY(i))
    ctx.stroke()
  }

  // Divider between lanes, brighter than the zero lines so the split between
  // channels doesn't read as another zero crossing.
  if (lanes > 1) {
    ctx.strokeStyle = LANE_DIVIDER_COLOR
    for (let i = 1; i < lanes; i++) {
      ctx.beginPath()
      ctx.moveTo(0, laneTop + laneHeight * i)
      ctx.lineTo(logicalWidth, laneTop + laneHeight * i)
      ctx.stroke()
    }
  }

  if (segments.length === 0 || !sampleRate) return

  const samplesPerPx = sampleRate / pixelsPerSecond

  // Draw waveform for each segment
  for (const seg of segments) {
    const dur = getSegmentDuration(seg)
    const segStartPx = (seg.outputStart - scrollLeft) * pixelsPerSecond
    const segWidthPx = dur * pixelsPerSecond

    // Skip segments not visible
    if (segStartPx + segWidthPx < 0 || segStartPx > logicalWidth) continue

    const visibleStartPx = Math.max(0, segStartPx)
    const visibleEndPx = Math.min(logicalWidth, segStartPx + segWidthPx)

    const offsetInSegStartPx = visibleStartPx - segStartPx
    const offsetInSegEndPx = visibleEndPx - segStartPx

    for (let lane = 0; lane < lanes; lane++) {
      const peaks = getSegmentPeaksForRange(
        seg, peakCacheMap,
        Math.floor(offsetInSegStartPx),
        Math.ceil(offsetInSegEndPx),
        samplesPerPx, sampleRate, lane
      )

      if (peaks.length === 0) continue

      const centerY = laneCenterY(lane)

      // Filled body — solid, opaque, mid-tone
      ctx.beginPath()
      for (let i = 0; i < peaks.length; i++) {
        const x = visibleStartPx + i
        const yTop = centerY + peaks[i].max * amplitude
        if (i === 0) ctx.moveTo(x, yTop)
        else ctx.lineTo(x, yTop)
      }
      for (let i = peaks.length - 1; i >= 0; i--) {
        const x = visibleStartPx + i
        const yBottom = centerY + peaks[i].min * amplitude
        ctx.lineTo(x, yBottom)
      }
      ctx.closePath()
      ctx.fillStyle = WAVEFORM_FILL
      ctx.fill()
    }
  }

  // Lane labels last, so they sit above the waveform fill rather than under it.
  if (lanes > 1) drawLaneLabels(ctx, lanes, laneTop, laneHeight)

}

/**
 * Small L / R tag in the bottom-left of each lane. Bottom rather than top so it
 * never collides with the time-grid labels, which sit along the top edge.
 */
function drawLaneLabels(ctx, lanes, laneTop, laneHeight) {
  ctx.font = "700 9px 'JetBrains Mono', monospace"
  ctx.textAlign = 'left'
  ctx.fillStyle = LANE_LABEL_COLOR
  for (let i = 0; i < lanes; i++) {
    const label = lanes === 2 ? LANE_LABELS[i] : String(i + 1)
    ctx.fillText(label, 5, laneTop + laneHeight * (i + 1) - 5)
  }
}

/**
 * Overlay render function — draws selection highlight and playhead only.
 * Call this independently to update transient state without re-rendering peaks.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} options
 * @param {number} options.scrollLeft - horizontal scroll in seconds
 * @param {number} options.pixelsPerSecond - zoom level
 * @param {Object|null} options.selection - { start, end } in seconds
 * @param {number} options.playhead - playhead position in seconds
 */
export function renderOverlay(canvas, options) {
  const {
    scrollLeft = 0,
    pixelsPerSecond = 100,
    selection = null,
    playhead = 0,
    clipMarks = null,
  } = options

  const dpr = window.devicePixelRatio || 1
  const logicalWidth = canvas.clientWidth
  const logicalHeight = canvas.clientHeight

  canvas.width = logicalWidth * dpr
  canvas.height = logicalHeight * dpr

  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, logicalWidth, logicalHeight)

  // Draw selection overlay
  if (selection) {
    const selStartPx = (selection.start - scrollLeft) * pixelsPerSecond
    const selEndPx = (selection.end - scrollLeft) * pixelsPerSecond
    const selWidth = selEndPx - selStartPx

    if (selEndPx > 0 && selStartPx < logicalWidth) {
      // Veil the audio on either side, then lift the selection itself.
      ctx.fillStyle = UNSELECTED_VEIL_COLOR
      if (selStartPx > 0) ctx.fillRect(0, 0, Math.min(selStartPx, logicalWidth), logicalHeight)
      if (selEndPx < logicalWidth) ctx.fillRect(selEndPx, 0, logicalWidth - selEndPx, logicalHeight)

      ctx.fillStyle = SELECTION_COLOR
      ctx.fillRect(selStartPx, 0, selWidth, logicalHeight)

      // Solid edges, not dashed — a dashed boundary reads as provisional, and
      // these are the handles the user is about to cut on.
      ctx.strokeStyle = SELECTION_BORDER_COLOR
      ctx.lineWidth = 1.5

      ctx.beginPath()
      ctx.moveTo(selStartPx, 0)
      ctx.lineTo(selStartPx, logicalHeight)
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(selEndPx, 0)
      ctx.lineTo(selEndPx, logicalHeight)
      ctx.stroke()
    }
  }

  // Clip marks — where a stage actually did something.
  //
  // Drawn UNDER the playhead so the playhead stays the brightest vertical line
  // on the canvas; two similar lines competing is how a playhead stops reading
  // as one. A notch at the top rather than a full-height rule for the same
  // reason: these can number in the hundreds on a long file, and hundreds of
  // full-height lines is a hatch pattern over the waveform rather than an
  // annotation of it. The faint stem under each notch is what makes a single
  // mark findable without the notch having to be tall.
  if (clipMarks && clipMarks.length) {
    for (const m of clipMarks) {
      const x = (m.t - scrollLeft) * pixelsPerSecond
      if (x < -1 || x > logicalWidth + 1) continue
      // Depth sets height, over the same 3 dB the panel's lamp is scaled to,
      // so a deep mark and a bright lamp mean the same thing.
      const depth = Math.min(1, m.db / CLIP_MARK_FULL_SCALE_DB)
      const h = CLIP_MARK_MIN_PX + depth * (CLIP_MARK_MAX_PX - CLIP_MARK_MIN_PX)

      ctx.strokeStyle = CLIP_MARK_STEM_COLOR
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(Math.round(x) + 0.5, 0)
      ctx.lineTo(Math.round(x) + 0.5, logicalHeight)
      ctx.stroke()

      ctx.strokeStyle = CLIP_MARK_COLOR
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(Math.round(x) + 0.5, 0)
      ctx.lineTo(Math.round(x) + 0.5, h)
      ctx.stroke()
    }
  }

  // Draw playhead
  const playheadPx = (playhead - scrollLeft) * pixelsPerSecond
  if (playheadPx >= 0 && playheadPx <= logicalWidth) {
    ctx.strokeStyle = PLAYHEAD_COLOR
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(playheadPx, 0)
    ctx.lineTo(playheadPx, logicalHeight)
    ctx.stroke()

    // Playhead triangle head
    ctx.fillStyle = PLAYHEAD_COLOR
    ctx.beginPath()
    ctx.moveTo(playheadPx - 6, 0)
    ctx.lineTo(playheadPx + 6, 0)
    ctx.lineTo(playheadPx, 8)
    ctx.closePath()
    ctx.fill()
  }
}

/**
 * Tick intervals the ruler is allowed to use, in seconds. Every step is a
 * value a listener would actually count in — tenths, seconds, quarter minutes,
 * minutes, then quarter hours — so a label always lands on a round time no
 * matter how far out the file is zoomed.
 */
const TICK_INTERVALS = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800, 3600,
]

/**
 * Smallest interval from the ladder whose ticks are at least `minSpacingPx`
 * apart at this zoom.
 *
 * The old ladder keyed off zoom alone and bottomed out at 10 s, which is a
 * label every 5 px once a 30-minute file is fitted to the window — the labels
 * collided into an unreadable smear. Choosing from the required spacing instead
 * means the ruler thins itself out for as long as the file needs, and the
 * spacing is measured from the widest label actually being drawn, so it holds
 * as labels grow a minutes field and then an hours field.
 *
 * Exported for the unit tests; the renderer is the only other caller.
 */
export function chooseTickInterval(pixelsPerSecond, minSpacingPx) {
  if (!(pixelsPerSecond > 0) || !(minSpacingPx > 0)) return 1
  for (const interval of TICK_INTERVALS) {
    if (interval * pixelsPerSecond >= minSpacingPx) return interval
  }
  // Past an hour per tick, keep doubling rather than let the labels collide.
  let interval = TICK_INTERVALS[TICK_INTERVALS.length - 1]
  while (interval * pixelsPerSecond < minSpacingPx) interval *= 2
  return interval
}

/**
 * Format a ruler label. `tickInterval` sets the precision: sub-second grids get
 * decimals, and the hours field appears only once the file is long enough to
 * need it, so short files keep the compact `m:ss` they had.
 *
 * Exported for the unit tests.
 */
export function formatRulerTime(seconds, tickInterval = 1) {
  // Hide 0:00 so the first visible label is the first real elapsed time.
  if (seconds <= 0) return ''

  const decimals = tickInterval < 0.1 ? 2 : tickInterval < 1 ? 1 : 0
  // Round onto the label's own precision first, so the fields below can't be
  // derived from a value that displays as :60.
  const scale = 10 ** decimals
  const t = Math.round(seconds * scale) / scale

  const hrs = Math.floor(t / 3600)
  const mins = Math.floor((t - hrs * 3600) / 60)
  const secs = t - hrs * 3600 - mins * 60

  const secStr = decimals > 0
    ? secs.toFixed(decimals).padStart(decimals + 3, '0')
    : String(Math.floor(secs)).padStart(2, '0')

  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${secStr}`
  return `${mins}:${secStr}`
}

/**
 * Draw vertical time-grid lines + labels inside the waveform box, near the
 * top edge — the reference design overlays these on the waveform itself
 * rather than in a separate ruler strip.
 */
function drawTimeGrid(ctx, logicalWidth, logicalHeight, scrollLeft, pixelsPerSecond) {
  ctx.fillStyle = 'rgba(255,255,255,.32)'
  ctx.font = "600 10px 'JetBrains Mono', monospace"

  const EDGE_PAD = 4
  // Gap between neighbouring labels. Small enough that the ruler stays dense on
  // short files, large enough that two labels never touch.
  const LABEL_GAP = 14

  const endTime = scrollLeft + logicalWidth / pixelsPerSecond

  // Measure the widest label this view will produce — the last one on screen,
  // which carries the most fields — rather than assuming a width. Two passes:
  // the first picks an interval from a provisional width, the second re-picks
  // it once the label's real precision is known, since dropping to a coarser
  // interval can also drop the decimals and narrow the label.
  let tickInterval = 1
  for (let pass = 0; pass < 2; pass++) {
    const sample = formatRulerTime(Math.max(endTime, tickInterval), tickInterval) || '0:00'
    tickInterval = chooseTickInterval(pixelsPerSecond, ctx.measureText(sample).width + LABEL_GAP)
  }

  const startTime = Math.floor(scrollLeft / tickInterval) * tickInterval

  // Right edge of the last label drawn. The interval keeps ticks far enough
  // apart for centred labels, but a label whose tick sits on a canvas edge is
  // shifted inward by up to half its width and can still run into its
  // neighbour, so each label is checked against what was actually drawn.
  let lastLabelRight = -Infinity

  for (let i = 0; ; i++) {
    // Stepping by index rather than accumulating keeps sub-second intervals
    // from drifting off their round values across a screenful of ticks.
    const t = startTime + i * tickInterval
    if (t > endTime + tickInterval) break

    const x = (t - scrollLeft) * pixelsPerSecond
    if (x < -50 || x > logicalWidth + 50) continue

    // Full-height gridline, subtle — the waveform fill paints over it
    ctx.strokeStyle = 'rgba(255,255,255,.05)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, logicalHeight)
    ctx.stroke()

    // Label near the top edge. Centring every label clips the ones whose tick
    // sits on a canvas edge — at scroll 0 the "0s" label lost its digit and
    // showed as a bare "s" — so labels near an edge flip to hugging it.
    // Ticks are drawn slightly past both edges so their gridlines reach the
    // corners, but a label belongs to a tick the user can see. Hugging the edge
    // for a tick that is off-canvas produced a half-clipped timestamp at the
    // left edge that read as a different, wrong time.
    if (x < 0 || x > logicalWidth) continue

    const label = formatRulerTime(t, tickInterval)
    if (!label) continue
    const width = ctx.measureText(label).width
    const half = width / 2

    let left
    let align
    let drawX
    if (x - half < EDGE_PAD) {
      align = 'left'; drawX = x + EDGE_PAD; left = drawX
    } else if (x + half > logicalWidth - EDGE_PAD) {
      align = 'right'; drawX = x - EDGE_PAD; left = drawX - width
    } else {
      align = 'center'; drawX = x; left = x - half
    }

    // Drop the label rather than let two of them touch. Only an edge-hugged
    // label can trip this, and dropping it costs nothing — its gridline is
    // still there, and the tick beside it is the same round number one
    // interval along.
    if (left < lastLabelRight + LABEL_GAP) continue

    ctx.textAlign = align
    ctx.fillText(label, drawX, 13)
    lastLabelRight = left + width
  }
}
