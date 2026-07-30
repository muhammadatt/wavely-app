import { getSegmentDuration } from './operations.js'

/**
 * Waveform Canvas Renderer
 *
 * Draws waveform peaks, selection overlay, and playhead onto a canvas.
 * Handles devicePixelRatio for retina displays.
 */

const WAVEFORM_FILL = '#5df0b0'
const WAVEFORM_EDGE = '#5df0b0'
const SELECTION_COLOR = 'rgba(53, 211, 230, 0.07)'
const SELECTION_BORDER_COLOR = 'rgba(53, 211, 230, 0.55)'
const PLAYHEAD_COLOR = '#ff5a4d'
const ZERO_LINE_COLOR = 'rgba(255, 255, 255, 0.07)'

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
function getSegmentPeaksForRange(segment, peakCaches, startPx, endPx, samplesPerPx, sampleRate) {
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

  const useRaw = !cache || samplesPerPx < cache.samplesPerPx
  if (useRaw) {
    const channelData = segment.sourceBuffer.getChannelData(0)
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
    for (let ci = cacheStart; ci < cacheEnd && ci * 2 + 1 < cache.peaks.length; ci++) {
      if (ci < 0) continue
      const cMin = cache.peaks[ci * 2]
      const cMax = cache.peaks[ci * 2 + 1]
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

  const centerY = logicalHeight / 2
  const amplitude = logicalHeight / 2 - 2 // Leave 2px padding

  // Draw zero line
  ctx.strokeStyle = ZERO_LINE_COLOR
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, centerY)
  ctx.lineTo(logicalWidth, centerY)
  ctx.stroke()

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

    const peaks = getSegmentPeaksForRange(
      seg, peakCacheMap,
      Math.floor(offsetInSegStartPx),
      Math.ceil(offsetInSegEndPx),
      samplesPerPx, sampleRate
    )

    if (peaks.length === 0) continue

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

    // Brighter thin contour along the top and bottom edges
    /*
    ctx.strokeStyle = WAVEFORM_EDGE
    ctx.lineWidth = 1.3
    ctx.lineJoin = 'round'

    ctx.beginPath()
    for (let i = 0; i < peaks.length; i++) {
      const x = visibleStartPx + i
      const yTop = centerY + peaks[i].max * amplitude
      if (i === 0) ctx.moveTo(x, yTop)
      else ctx.lineTo(x, yTop)
    }
    ctx.stroke()

    ctx.beginPath()
    for (let i = 0; i < peaks.length; i++) {
      const x = visibleStartPx + i
      const yBottom = centerY + peaks[i].min * amplitude
      if (i === 0) ctx.moveTo(x, yBottom)
      else ctx.lineTo(x, yBottom)
    }
    ctx.stroke()
    */
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
      ctx.fillStyle = SELECTION_COLOR
      ctx.fillRect(selStartPx, 0, selWidth, logicalHeight)

      ctx.strokeStyle = SELECTION_BORDER_COLOR
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])

      ctx.beginPath()
      ctx.moveTo(selStartPx, 0)
      ctx.lineTo(selStartPx, logicalHeight)
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(selEndPx, 0)
      ctx.lineTo(selEndPx, logicalHeight)
      ctx.stroke()

      ctx.setLineDash([])
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
 * Render time ruler ticks.
 */
export function renderTimeRuler(canvas, options) {
  const { scrollLeft = 0, pixelsPerSecond = 100, totalDuration = 0 } = options

  const dpr = window.devicePixelRatio || 1
  const logicalWidth = canvas.clientWidth
  const logicalHeight = canvas.clientHeight

  canvas.width = logicalWidth * dpr
  canvas.height = logicalHeight * dpr

  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  ctx.clearRect(0, 0, logicalWidth, logicalHeight)

  // Determine tick interval based on zoom
  let tickInterval = 1 // seconds
  if (pixelsPerSecond < 20) tickInterval = 10
  else if (pixelsPerSecond < 50) tickInterval = 5
  else if (pixelsPerSecond < 100) tickInterval = 2
  else if (pixelsPerSecond < 300) tickInterval = 1
  else if (pixelsPerSecond < 600) tickInterval = 0.5
  else tickInterval = 0.1

  const startTime = Math.floor(scrollLeft / tickInterval) * tickInterval
  const endTime = scrollLeft + logicalWidth / pixelsPerSecond

  ctx.fillStyle = 'rgba(255,255,255,.42)'
  ctx.font = "600 9.5px 'JetBrains Mono', monospace"
  ctx.textAlign = 'center'

  for (let t = startTime; t <= endTime + tickInterval; t += tickInterval) {
    const x = (t - scrollLeft) * pixelsPerSecond
    if (x < -50 || x > logicalWidth + 50) continue

    // Major tick
    ctx.strokeStyle = 'rgba(255,255,255,.22)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, logicalHeight - 8)
    ctx.lineTo(x, logicalHeight)
    ctx.stroke()

    // Label
    ctx.fillText(formatRulerTime(t), x, logicalHeight - 12)

    // Minor ticks (quarter intervals)
    const minorInterval = tickInterval / 4
    for (let m = 1; m < 4; m++) {
      const mx = ((t + m * minorInterval) - scrollLeft) * pixelsPerSecond
      if (mx < 0 || mx > logicalWidth) continue
      ctx.strokeStyle = 'rgba(255,255,255,.08)'
      ctx.beginPath()
      ctx.moveTo(mx, logicalHeight - 4)
      ctx.lineTo(mx, logicalHeight)
      ctx.stroke()
    }
  }
}

function formatRulerTime(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (seconds < 60) {
    return `${secs.toFixed(secs % 1 === 0 ? 0 : 1)}s`
  }
  return `${mins}:${secs.toFixed(0).padStart(2, '0')}`
}
