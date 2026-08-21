/**
 * Resonance Suppressor — what each reference does to real narration.
 *
 *   npm run reso:real
 *
 * Drop finished or raw narrator recordings in `data/corpus/resonance/`
 * (gitignored — `*.wav` is ignored repo-wide, so commercial audio never reaches
 * the repo). Every WAV in there is measured and, with `--render`, written back
 * out per configuration so the result can be listened to.
 *
 * WHY THIS EXISTS. Every number behind the peak-envelope reference was
 * synthetic, and the first real file overturned two of them. There is
 * deliberately no baseline and no pass/fail here: nobody knows what a correct
 * amount of resonance suppression is on a given voice, and the only instrument
 * that settles it is a person listening. Read it, do not gate on it.
 *
 * WHAT IT MEASURES
 *
 *   mean cut       average gain the effect applied in a band, over active
 *                  frames. The aggressiveness knob, and the thing that must be
 *                  MATCHED before any other column can be compared — a config
 *                  that cuts nothing has no artefacts, which is not a virtue.
 *
 *   gain jitter    rms of the frame-to-frame change in that applied gain, split
 *                  by how fast the pitch is moving. This is reason 1 made
 *                  countable on real audio: a detector that chases moving
 *                  harmonics produces gain that moves with them, and the
 *                  fast-pitch column is where that shows. The ratio between the
 *                  columns says how much of the movement is pitch-driven; the
 *                  absolute values say how audible it is.
 *
 *   tracker health what fraction of voiced frame-to-frame transitions the pitch
 *                  tracker reports as octave jumps or worse. The harmonic mask
 *                  and the peak reference are both built from that estimate, so
 *                  a file the tracker cannot follow is a file neither mechanism
 *                  can be trusted on. This is not a detector metric — it is a
 *                  precondition, and it is the first thing to read.
 */
import fs from 'node:fs'
import path from 'node:path'
import { F0Tracker } from '../src/audio/dsp/f0.js'
import { getFFT, rfftBinCount } from '../src/audio/dsp/fft.js'
import {
  processResonanceBuffer,
  RESONANCE_KERNEL_DEFAULTS,
} from '../src/audio/resonanceProcessor.js'

const CORPUS = path.join(process.cwd(), 'data/corpus/resonance')
/**
 * Renders go in a SUBDIRECTORY, not beside the sources.
 *
 * Writing them alongside was a real bug, not an untidiness: the runner
 * enumerates every WAV it finds, so its own output became input on the next
 * run and the script cheerfully measured what a suppressor does to
 * already-suppressed audio. Excluding them by filename is the fix that looks
 * sufficient and is not — scratch probes drop files here too, and those follow
 * nobody's convention. A separate directory cannot be got wrong.
 */
const RENDERS = path.join(CORPUS, 'rendered')
const RENDER = process.argv.includes('--render')

const FRAME = 2048
const HOP = 512
const LATENCY = 2048

/** Bands the two failure modes live in, for this product's material. */
const BANDS = [
  { label: '100-400 Hz', lo: 100, hi: 400 },
  { label: '2-6 kHz', lo: 2000, hi: 6000 },
]

/**
 * Configurations compared.
 *
 * `solveFor` asks the runner to find the selectivity that produces that much
 * mean cut in the first band, so artefacts are compared at matched
 * aggressiveness rather than at each config's own calibration. Without it the
 * comparison is decided by whichever config happens to be set louder.
 */
const CONFIGS = [
  { slug: 'shipping', label: 'shipping (cepstral + mask)', params: {} },
  {
    slug: 'cepstral-nomask',
    label: 'cepstral, protection off',
    params: { preserveHarmonics: false },
    solveFor: 3,
  },
  {
    slug: 'cepstral-slow',
    label: 'cepstral, off, slow ballistics',
    params: { preserveHarmonics: false, attackMs: 100, releaseMs: 500 },
    solveFor: 3,
  },
  {
    slug: 'peak',
    label: 'peak-envelope, no mask',
    params: { refMode: 'peak', preserveHarmonics: false, depth: 1 },
    solveFor: 3,
  },
  {
    slug: 'peak-slow',
    label: 'peak-envelope + slow ballistics',
    params: {
      refMode: 'peak', preserveHarmonics: false, depth: 1,
      attackMs: 100, releaseMs: 500,
    },
    solveFor: 3,
  },

  // MATCHED ON CUT DEPTH RATHER THAN ON THE MEAN. Reported by ear: two configs
  // matched at 3 dB of mean cut removed visibly different amounts of resonance,
  // the deeper-and-narrower one sounding like it had done more. The mean cannot
  // see that difference and p90 can, so the pairs below are matched on it — the
  // only way to ask "same amount of treatment, which one artefacts less".
  {
    slug: 'cepstral-slow-p6',
    label: 'cepstral+slow @ p90 6 dB',
    params: { preserveHarmonics: false, attackMs: 100, releaseMs: 500 },
    solveFor: 6,
    solveOn: 'p90',
  },
  {
    slug: 'peak-slow-p6',
    label: 'peak+slow     @ p90 6 dB',
    params: {
      refMode: 'peak', preserveHarmonics: false, depth: 1,
      attackMs: 100, releaseMs: 500,
    },
    solveFor: 6,
    solveOn: 'p90',
  },
  {
    slug: 'cepstral-slow-p10',
    label: 'cepstral+slow @ p90 10 dB',
    params: { preserveHarmonics: false, attackMs: 100, releaseMs: 500 },
    solveFor: 10,
    solveOn: 'p90',
  },
  {
    slug: 'peak-slow-p10',
    label: 'peak+slow     @ p90 10 dB',
    params: {
      refMode: 'peak', preserveHarmonics: false, depth: 1,
      attackMs: 100, releaseMs: 500,
    },
    solveFor: 10,
    solveOn: 'p90',
  },
]

function readWav(file) {
  const d = fs.readFileSync(file)
  if (d.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${file}: not a RIFF file`)
  let i = 12
  let fmt = null
  while (i + 8 <= d.length) {
    const id = d.toString('ascii', i, i + 4)
    const size = d.readUInt32LE(i + 4)
    if (id === 'fmt ') {
      fmt = {
        channels: d.readUInt16LE(i + 10),
        sampleRate: d.readUInt32LE(i + 12),
        bits: d.readUInt16LE(i + 22),
      }
    } else if (id === 'data') {
      if (!fmt) throw new Error(`${file}: data before fmt`)
      if (fmt.bits !== 16 && fmt.bits !== 24 && fmt.bits !== 32) {
        throw new Error(`${file}: ${fmt.bits}-bit is not supported here`)
      }
      const bytes = fmt.bits / 8
      const n = Math.floor(size / bytes / fmt.channels)
      const chans = Array.from({ length: fmt.channels }, () => new Float32Array(n))
      let o = i + 8
      for (let s = 0; s < n; s++) {
        for (let c = 0; c < fmt.channels; c++) {
          let v
          if (fmt.bits === 16) v = d.readInt16LE(o) / 32768
          else if (fmt.bits === 24) v = ((d.readUInt8(o) | (d.readUInt8(o + 1) << 8) | (d.readInt8(o + 2) << 16))) / 8388608
          else v = d.readInt32LE(o) / 2147483648
          chans[c][s] = v
          o += bytes
        }
      }
      return { channelData: chans, sampleRate: fmt.sampleRate }
    }
    i += 8 + size + (size & 1)
  }
  throw new Error(`${file}: no data chunk`)
}

function writeWav(file, channelData, sampleRate) {
  const ch = channelData.length
  const n = channelData[0].length
  const b = Buffer.alloc(44 + n * ch * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * ch * 2, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(ch, 22)
  b.writeUInt32LE(sampleRate, 24)
  b.writeUInt32LE(sampleRate * ch * 2, 28)
  b.writeUInt16LE(ch * 2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * ch * 2, 40)
  let o = 44
  for (let s = 0; s < n; s++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channelData[c][s]))
      b.writeInt16LE(Math.round(v * 32767), o)
      o += 2
    }
  }
  fs.writeFileSync(file, b)
}

/** Pitch contour, activity, and how much the tracker can be trusted on it. */
function analysePitch(x, sampleRate, gate = {}) {
  const tracker = new F0Tracker({
    sampleRate, frameSize: FRAME, defaultF0: null, minHz: 70, maxHz: 400, ...gate,
  })
  const frame = new Float32Array(FRAME)
  const f0 = []
  const active = []
  for (let off = 0; off + FRAME <= x.length; off += HOP) {
    frame.set(x.subarray(off, off + FRAME))
    let s = 0
    for (let i = 0; i < FRAME; i++) s += frame[i] * frame[i]
    const db = 10 * Math.log10(s / FRAME + 1e-20)
    const r = tracker.estimate(frame, db > -60)
    f0.push(r.pitched ? r.f0 : 0)
    active.push(db > -45 ? 1 : 0)
  }

  const dt = HOP / sampleRate
  const velocity = new Float64Array(f0.length)
  let pairs = 0
  let octave = 0
  let wild = 0
  for (let i = 1; i < f0.length; i++) {
    if (f0[i] <= 0 || f0[i - 1] <= 0) { velocity[i] = NaN; continue }
    const ratio = f0[i] / f0[i - 1]
    velocity[i] = Math.abs(12 * Math.log2(ratio)) / dt
    pairs++
    if ((ratio > 1.8 && ratio < 2.2) || (ratio > 0.45 && ratio < 0.55)) octave++
    if (Math.abs(12 * Math.log2(ratio)) > 6) wild++
  }
  const voiced = f0.filter(v => v > 0).sort((a, b) => a - b)
  const pct = p => (voiced.length ? voiced[Math.floor((p / 100) * (voiced.length - 1))] : 0)
  return {
    f0,
    active,
    velocity,
    voicedFraction: voiced.length / f0.length,
    f0p5: pct(5),
    f0median: pct(50),
    f0p95: pct(95),
    octaveJumpRate: pairs ? octave / pairs : 0,
    wildJumpRate: pairs ? wild / pairs : 0,
  }
}

/** Per-hop level in a band, in dB, starting `offset` samples in. */
function bandLevels(sig, sampleRate, lo, hi, offset, frames) {
  const n = 1 << Math.ceil(Math.log2(sig.length))
  const fft = getFFT(n)
  const bins = rfftBinCount(n)
  const buf = new Float64Array(n)
  buf.set(sig)
  const re = new Float64Array(bins)
  const im = new Float64Array(bins)
  fft.rfft(buf, re, im)
  const binHz = sampleRate / n
  for (let k = 0; k < bins; k++) {
    const f = k * binHz
    if (f < lo || f > hi) { re[k] = 0; im[k] = 0 }
  }
  const y = new Float64Array(n)
  fft.irfft(re, im, y)
  const out = new Float64Array(frames)
  for (let j = 0; j < frames; j++) {
    let s = 0
    for (let i = 0; i < HOP; i++) {
      const idx = offset + j * HOP + i
      const v = idx < y.length ? y[idx] : 0
      s += v * v
    }
    out[j] = 10 * Math.log10(s / HOP + 1e-20)
  }
  return out
}

/**
 * MEAN CUT CANNOT TELL MANY SHALLOW CUTS FROM A FEW DEEP ONES, and the two do
 * not sound remotely alike: shallow-and-wide reads as the file getting duller,
 * deep-and-narrow reads as a resonance being removed. Two configurations
 * matched on the mean were reported by ear as removing visibly different
 * amounts of resonance, which is the mean doing exactly what it cannot help
 * doing.
 *
 * So the distribution goes out too. `p90` is the depth of cut where the effect
 * is actually working, and it is the statistic worth MATCHING on when the
 * question is "same amount of treatment, which one artefacts less".
 */
function measure(inLevels, outLevels, sets) {
  const g = new Float64Array(inLevels.length)
  for (let j = 0; j < g.length; j++) g[j] = outLevels[j] - inLevels[j]
  let cut = 0
  let n = 0
  const depths = []
  for (const i of sets.usable) { cut += g[i]; n++; depths.push(-g[i]) }
  depths.sort((a, b) => a - b)
  const pct = q => (depths.length ? depths[Math.floor((q / 100) * (depths.length - 1))] : 0)
  const treated = depths.filter(d => d > 3).length / (depths.length || 1)
  const jitter = set => {
    let s = 0
    let m = 0
    for (const i of set) {
      if (i < 1) continue
      const d = g[i] - g[i - 1]
      if (Number.isFinite(d)) { s += d * d; m++ }
    }
    return m ? Math.sqrt(s / m) : 0
  }
  return {
    cut: n ? cut / n : 0,
    p50: pct(50), p90: pct(90), p99: pct(99),
    treated,
    slow: jitter(sets.slow),
    fast: jitter(sets.fast),
  }
}

/**
 * Selectivity that produces `target` dB of mean cut in the first band.
 *
 * Bisection on a monotone-enough relationship — more selectivity always means
 * less gets through the threshold, so the search is stable even where the
 * curve is lumpy.
 */
function solveSelectivity(x, sampleRate, params, target, stat, inLevels, sets, frames) {
  let lo = 2
  let hi = 40
  for (let it = 0; it < 9; it++) {
    const mid = (lo + hi) / 2
    const out = processResonanceBuffer([x], sampleRate, {
      ...RESONANCE_KERNEL_DEFAULTS, ...params, selectivity: mid,
    }).channelData[0]
    const levels = bandLevels(out, sampleRate, BANDS[0].lo, BANDS[0].hi, LATENCY, frames)
    const m = measure(inLevels, levels, sets)
    const value = stat === 'p90' ? m.p90 : -m.cut
    if (value > target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function run(file) {
  const { channelData, sampleRate } = readWav(file)
  const x = channelData[0]
  const name = path.basename(file)
  console.log(`\n${'═'.repeat(78)}\n${name}  —  ${(x.length / sampleRate).toFixed(1)} s, ${sampleRate} Hz, ${channelData.length} ch`)

  const pitch = analysePitch(x, sampleRate)
  const frames = pitch.f0.length
  console.log(
    `\n  pitch: ${(100 * pitch.voicedFraction).toFixed(0)}% voiced, `
    + `F0 p5 ${pitch.f0p5.toFixed(0)} / median ${pitch.f0median.toFixed(0)} / p95 ${pitch.f0p95.toFixed(0)} Hz`,
  )
  // Reported under both gates: the effect no longer uses the tracker's default,
  // so quoting only the default would describe an estimate nothing consumes.
  const gated = analysePitch(x, sampleRate, { minRatio: 0.7, holdFrames: 16 })
  console.log(
    `  TRACKER HEALTH   default gate: ${(100 * pitch.octaveJumpRate).toFixed(1)}% octave jumps, `
    + `${(100 * pitch.wildJumpRate).toFixed(1)}% over a tritone`,
  )
  console.log(
    `                   as the effect runs it: ${(100 * gated.octaveJumpRate).toFixed(1)}% / `
    + `${(100 * gated.wildJumpRate).toFixed(1)}%`,
  )

  // Only frames with a usable velocity: an octave error is a tracking failure,
  // not pitch movement, and letting it into the fast set measures the tracker.
  const usable = []
  for (let i = 0; i < frames; i++) {
    if (pitch.active[i] && Number.isFinite(pitch.velocity[i]) && pitch.velocity[i] < 400) usable.push(i)
  }
  const byVelocity = [...usable].sort((a, b) => pitch.velocity[a] - pitch.velocity[b])
  const q = Math.floor(byVelocity.length / 4)
  const sets = {
    usable,
    slow: new Set(byVelocity.slice(0, q)),
    fast: new Set(byVelocity.slice(byVelocity.length - q)),
  }

  const inLevels = BANDS.map(b => bandLevels(x, sampleRate, b.lo, b.hi, 0, frames))

  console.log(`\n  ${'config'.padEnd(31)}${'sel'.padStart(5)}   `
    + '100-400 Hz: mean   p90  >3dB    jitter slow/fast      2-6 kHz: mean  jitter')
  for (const cfg of CONFIGS) {
    const selectivity = cfg.solveFor
      ? solveSelectivity(
        x, sampleRate, cfg.params, cfg.solveFor, cfg.solveOn ?? 'mean',
        inLevels[0], sets, frames,
      )
      : (cfg.params.selectivity ?? RESONANCE_KERNEL_DEFAULTS.selectivity)
    const params = { ...RESONANCE_KERNEL_DEFAULTS, ...cfg.params, selectivity }
    const out = processResonanceBuffer([x], sampleRate, params).channelData[0]
    if (RENDER) {
      fs.mkdirSync(RENDERS, { recursive: true })
      writeWav(
        path.join(RENDERS, `${name.replace(/\.wav$/i, '')}__${cfg.slug}.wav`),
        [out.subarray(LATENCY)],
        sampleRate,
      )
    }
    const lf = measure(inLevels[0], bandLevels(out, sampleRate, BANDS[0].lo, BANDS[0].hi, LATENCY, frames), sets)
    const hf = measure(inLevels[1], bandLevels(out, sampleRate, BANDS[1].lo, BANDS[1].hi, LATENCY, frames), sets)
    console.log(
      `  ${cfg.label.padEnd(31)}${selectivity.toFixed(1).padStart(5)}   `
      + `${lf.cut.toFixed(2).padStart(9)}  ${lf.p90.toFixed(1).padStart(4)}  ${(100 * lf.treated).toFixed(0).padStart(3)}%    `
      + `${lf.slow.toFixed(2)} / ${lf.fast.toFixed(2)}      `
      + `${hf.cut.toFixed(2).padStart(9)}  ${hf.slow.toFixed(2)} / ${hf.fast.toFixed(2)}`,
    )
  }
}

const files = fs.existsSync(CORPUS)
  ? fs.readdirSync(CORPUS, { withFileTypes: true })
    .filter(e => e.isFile() && /\.wav$/i.test(e.name))
    .map(e => e.name)
    .sort()
  : []

if (!files.length) {
  console.log(`No audio in ${CORPUS}.`)
  console.log('Drop narrator recordings there (gitignored) and re-run.')
  process.exit(0)
}

console.log('Resonance Suppressor — real-audio comparison.')
console.log('No baseline and no pass/fail on purpose: read it, do not gate on it.')
console.log('Configs marked with a solved `sel` are matched to the same mean cut in the')
console.log('first band, because a config that cuts less has fewer artefacts for free.')
if (!RENDER) console.log('Pass --render to also write the processed audio out for listening.')

for (const f of files) {
  try {
    run(path.join(CORPUS, f))
  } catch (err) {
    console.log(`\n${f}: skipped — ${err.message}`)
  }
}
