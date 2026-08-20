/**
 * Turning an FFT into something drawable.
 *
 * An AnalyserNode hands back equally spaced bins, and a spectrum analyzer is
 * drawn on a log frequency axis — so the two ends of the array need opposite
 * treatment. At 4096 points and 44.1 kHz a bin is 10.8 Hz: the bottom octave
 * (20-40 Hz) is covered by two bins spread across a tenth of the display, and
 * the top octave (10-20 kHz) packs 926 bins into the same tenth. Drawing the
 * raw array puts almost every point in the right-hand tenth of the plot, where
 * they overdraw each other, and leaves the left-hand tenth with nothing to
 * draw but a straight line between two samples.
 *
 * So the array is resampled onto a fixed log grid before it is drawn: dense
 * cells take the LOUDEST bin they cover, sparse cells interpolate. Max rather
 * than mean, because the thing being looked for in the top octaves is usually a
 * narrow feature — a whistle, a ring, a switching supply — and averaging it
 * with its 30 quiet neighbours is exactly how it disappears. The cost is that
 * broadband noise reads a little hot, which is the safe direction for a display
 * whose job is "is there something up there".
 *
 * All of this is pure and lives here rather than in the canvas component so it
 * can be tested without a DOM or an audio graph.
 */

/** Default display resolution. ~1.5 px per cell on a 600 px plot. */
export const DEFAULT_CELLS = 384

/** Where the axis starts and ends. Below 20 Hz nothing is audible; above
 *  20 kHz nothing is either, and at 44.1 kHz there are no bins past 22.05. */
export const DEFAULT_MIN_HZ = 20
export const DEFAULT_MAX_HZ = 20000

/**
 * Resampler from FFT bins onto a log-frequency grid.
 *
 * The bin ranges are precomputed once per (fftSize, sampleRate, cells) triple
 * rather than derived per frame: the mapping cannot change between frames
 * unless one of those does, and recomputing 384 log() pairs sixty times a
 * second to get the same answer is the kind of work that shows up as a dropped
 * frame on a laptop under load.
 */
export function createLogMapper({
  binCount,
  binWidthHz,
  cells = DEFAULT_CELLS,
  minHz = DEFAULT_MIN_HZ,
  maxHz = DEFAULT_MAX_HZ,
}) {
  const nyquist = binCount * binWidthHz
  const hi = Math.min(maxHz, nyquist)
  const lo = Math.min(minHz, hi / 2)
  const ratio = hi / lo

  const centers = new Float32Array(cells)
  // Inclusive bin range per cell; -1 for cells narrower than a bin, which are
  // interpolated instead.
  const first = new Int32Array(cells)
  const last = new Int32Array(cells)
  // Fractional bin index at the cell centre, for those interpolated cells.
  const at = new Float32Array(cells)

  for (let d = 0; d < cells; d++) {
    const edgeLo = lo * ratio ** (d / cells)
    const edgeHi = lo * ratio ** ((d + 1) / cells)
    const centre = Math.sqrt(edgeLo * edgeHi)
    centers[d] = centre
    at[d] = centre / binWidthHz

    // Bin k is centred at k * binWidthHz. Skip bin 0: it is DC, it carries any
    // offset the file has, and it is never on the axis.
    let f = Math.max(1, Math.ceil(edgeLo / binWidthHz))
    let l = Math.min(binCount - 1, Math.floor(edgeHi / binWidthHz))
    if (l < f) { f = -1; l = -1 }
    first[d] = f
    last[d] = l
  }

  const out = new Float32Array(cells)

  return {
    cells,
    minHz: lo,
    maxHz: hi,
    /** Cell centre frequencies, in Hz. Do not mutate. */
    centers,
    /**
     * Resample one frame of dB magnitudes.
     *
     * Reuses one output array — read it or copy it, do not retain it. Bins that
     * come back non-finite (a silent analyser reports -Infinity) are floored, so
     * a pause draws a flat line at the bottom instead of vanishing.
     */
    map(spectrumDb, floorDb = -140) {
      for (let d = 0; d < cells; d++) {
        const f = first[d]
        if (f === -1) {
          // Narrower than a bin: read between the two neighbours rather than
          // repeating whichever one happens to be nearest, which would give the
          // bottom octave a visible staircase.
          const x = at[d]
          const k = Math.floor(x)
          const a = valueAt(spectrumDb, k, floorDb)
          const b = valueAt(spectrumDb, k + 1, floorDb)
          out[d] = a + (b - a) * (x - k)
          continue
        }
        let peak = floorDb
        for (let k = f; k <= last[d]; k++) {
          const v = spectrumDb[k]
          if (v > peak) peak = v
        }
        out[d] = Number.isFinite(peak) ? peak : floorDb
      }
      return out
    },
  }
}

function valueAt(spectrum, k, floorDb) {
  if (k < 0 || k >= spectrum.length) return floorDb
  const v = spectrum[k]
  return Number.isFinite(v) ? v : floorDb
}

/**
 * Tilt the trace by a fixed slope, in dB per octave.
 *
 * Speech and music both fall away with frequency, so an untilted analyzer draws
 * every voice as a ramp down to the right and the top two octaves live in the
 * bottom of the plot whatever is happening up there. The convention every
 * analyzer offers is to add back a slope — 3 dB/oct puts pink noise flat,
 * 4.5 dB/oct is the usual compromise for programme material — which turns the
 * question from "where is the energy" into "what is unusual about this file".
 *
 * Anchored at 1 kHz so the midrange stays where it is on the dB scale and the
 * setting does not double as a level control.
 */
export function applyTilt(values, centers, slopeDbPerOct, pivotHz = 1000) {
  if (!slopeDbPerOct) return values
  for (let d = 0; d < values.length; d++) {
    values[d] += slopeDbPerOct * Math.log2(centers[d] / pivotHz)
  }
  return values
}

/** How long a peak sits before it starts to fall, in ms. */
export const PEAK_HOLD_MS = 1500
/** How fast it falls once it does, in dB per second. */
export const PEAK_FALL_DB_PER_SEC = 18

/**
 * Per-cell peak hold.
 *
 * ONE AGE PER CELL, not one timer for the trace. A shared timer is reset by any
 * cell rising, and across 384 cells of real audio one always is, so the hold
 * never reaches its decay phase and stops being a record of anything. This is
 * the same mistake the resonance display's hold was built with and measured
 * out of; see ResonanceSpectrum.vue for the numbers.
 *
 * dB per second is the right decay law here — unlike the gain-reduction meters,
 * this display's vertical axis is linear in dB, so a fixed dB/s falls at a
 * constant speed on screen.
 */
export function createSpectrumPeakHold(cells, {
  holdMs = PEAK_HOLD_MS,
  fallDbPerSec = PEAK_FALL_DB_PER_SEC,
  floorDb = -140,
} = {}) {
  const values = new Float32Array(cells).fill(floorDb)
  const ages = new Float32Array(cells)

  return {
    values,
    push(frame, dtMs) {
      const fall = fallDbPerSec * (dtMs / 1000)
      for (let d = 0; d < cells; d++) {
        const v = frame[d]
        if (v >= values[d]) {
          values[d] = v
          ages[d] = 0
        } else {
          ages[d] += dtMs
          if (ages[d] > holdMs) values[d] = Math.max(floorDb, values[d] - fall)
        }
      }
      return values
    },
    reset() {
      values.fill(floorDb)
      ages.fill(0)
    },
  }
}

/**
 * Loudest cell in a frame, as `{ hz, db }`.
 *
 * Drives the readout that names the frequency you are looking at. Reported
 * from the drawn (tilted) frame on purpose: the peak the user is pointing at is
 * the one on screen, and reporting a different one because it is louder before
 * tilting would make the number disagree with the picture.
 */
export function dominant(values, centers) {
  let best = -Infinity
  let idx = -1
  for (let d = 0; d < values.length; d++) {
    if (values[d] > best) { best = values[d]; idx = d }
  }
  if (idx === -1) return { hz: 0, db: -Infinity }
  return { hz: centers[idx], db: best }
}

/** Axis-style frequency label: 20, 200, 2k, 20k. */
export function formatHz(hz) {
  if (hz >= 10000) return `${Math.round(hz / 1000)}k`
  if (hz >= 1000) {
    const k = hz / 1000
    return `${k >= 10 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`
  }
  return String(Math.round(hz))
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/**
 * Nearest equal-tempered note, with cents deviation — `A2 +12`.
 *
 * Present because the frequency of a problem is rarely what you want to know
 * about it: a room mode, a hum harmonic and a resonant note are all easier to
 * reason about by name, and a narrator reporting "my room rings on A" is
 * reporting 110 Hz.
 */
export function noteFor(hz) {
  if (!(hz > 0)) return ''
  const semis = 12 * Math.log2(hz / 440)
  const nearest = Math.round(semis)
  const cents = Math.round((semis - nearest) * 100)
  const midi = nearest + 69
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  return `${name}${octave}${cents === 0 ? '' : cents > 0 ? ` +${cents}` : ` ${cents}`}`
}
