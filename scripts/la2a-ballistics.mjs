/**
 * OptoSmooth's ballistics, measured directly instead of inferred.
 *
 *   npm run la2a:ballistics -- --stimulus   write the test signals
 *   npm run la2a:ballistics -- --selftest   prove the fitter on our own kernel
 *   npm run la2a:ballistics                 fit whatever captures are present
 *
 * WHY A STEP TEST AND NOT MORE SPEECH. Every ballistic constant in
 * la2aProcessor.js — ATTACK_S, FAST_FRACTION, FAST_RELEASE_S, the
 * SLOW_RELEASE range and the three MEM_* constants — was chosen to reproduce a
 * described behaviour, never measured. Speech cannot settle the question: the
 * dry/wet pair work (`npm run la2a:pairs`) recovers the gain envelope
 * faithfully but every trajectory in it is a superposition of attack, release
 * and memory on material that never holds still, and an attempt to separate
 * them by looking at "settled" regions failed — 60 ms of held gain is not
 * enough to escape a memory that moves on 0.8-8 s time constants, and at 150 ms
 * there are not enough settled blocks in speech to bin.
 *
 * A LEVEL STEP SEPARATES THEM BY CONSTRUCTION. Hold a tone below threshold, step
 * it up, hold, step it down: the rise is the attack alone, the fall is the
 * release alone, and sweeping how LONG the tone was held measures how the
 * release tail stretches with exposure — which is the LDR memory, isolated.
 *
 * ⚠ LAEA IS A LEGITIMATE REFERENCE FOR THIS, HAVING BEEN USELESS FOR THE TUBE
 * STAGE. `docs/la2a_tube_capture_protocol.md` found it has no output-stage
 * saturation at all, which killed it as a distortion reference. Its Peak
 * Reduction does do real gain reduction — 24.9 dB measured there — so its
 * ballistics are real and worth capturing. Being a plugin is a limitation to
 * state, not a disqualification: it is a reference, not hardware.
 *
 * HOW THE ENVELOPE IS RECOVERED. Quadrature demodulation at the probe
 * frequency — multiply by cos and sin, low-pass, take the magnitude. That gives
 * the amplitude at about 1 ms resolution and rejects the 2f detector ripple
 * that would otherwise sit on top of it. An RMS window long enough to be smooth
 * on a 1 kHz tone is ~15 ms, which would smear the very attack being measured.
 *
 * ⚠ THE INPUT SIDE IS ANALYTIC, NOT DEMODULATED. We wrote the stimulus, so its
 * envelope is known exactly; dividing by a demodulated input would put the
 * filter's group delay on both sides of the ratio, where it cancels only while
 * the gain is still — i.e. everywhere except during the attack.
 */

import { writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { readWav } from '../test/voicerx/wav.js'
import { LA2AKernel } from '../src/audio/la2aProcessor.js'

const SR = 44100
const PROBE_HZ = 1000        // above the R37 shelf corner, so the side-chain is flat here
const LOW_DBFS = -40         // below threshold at any useful knob: the cell rests open
const HIGH_DBFS = -18        // nominal line level
const FADE_MS = 5            // step edges are raised-cosine, so nothing clicks

/** Burst lengths, seconds. The spread is what measures the memory. */
const BURSTS = [0.05, 0.2, 1.0, 3.0, 10.0]
const PRE_S = 2.0            // cell resting open before each step
const POST_S = 6.0           // release observed here
const REST_S = 20.0          // memory discharges before the next burst

/** Staircase levels for the static curve, dBFS. */
const STAIRS = [-45, -40, -35, -30, -25, -20, -15, -10]
const STAIR_S = 4.0
const STAIR_REST_S = 8.0

const STIM_DIR = path.join(process.cwd(), 'data/corpus/la2a-ballistics/stimulus')
const CAP_DIR = path.join(process.cwd(), 'data/corpus/la2a-ballistics/captures')

const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))
const lin = d => Math.pow(10, d / 20)

// ── Stimulus ────────────────────────────────────────────────────────────────

/** Amplitude envelope of the burst stimulus, and where each event sits. */
function burstPlan() {
  const events = []
  let t = 1.0                                   // a second of lead-in
  for (const T of BURSTS) {
    events.push({ T, up: t + PRE_S, down: t + PRE_S + T })
    t += PRE_S + T + POST_S + REST_S
  }
  return { events, seconds: t + 1.0 }
}

function stairPlan() {
  const events = []
  let t = 1.0
  for (const L of STAIRS) {
    events.push({ L, up: t + STAIR_REST_S, down: t + STAIR_REST_S + STAIR_S })
    t += STAIR_REST_S + STAIR_S
  }
  return { events, seconds: t + 1.0 }
}

/** Raised-cosine ramp between two amplitudes, so a bounce cannot click. */
function build(plan, ampAt) {
  const n = Math.round(plan.seconds * SR)
  const x = new Float32Array(n)
  const fade = Math.round(FADE_MS / 1000 * SR)
  const env = new Float64Array(n).fill(lin(LOW_DBFS))
  for (const e of plan.events) {
    const a = Math.round(e.up * SR), b = Math.round(e.down * SR)
    const hi = ampAt(e)
    for (let i = a; i < b && i < n; i++) env[i] = hi
    for (let j = 0; j < fade; j++) {
      const lo = lin(LOW_DBFS), u = 0.5 * (1 - Math.cos(Math.PI * j / fade))
      if (a + j < n) env[a + j] = lo + (hi - lo) * u
      if (b + j < n) env[b + j] = hi + (lo - hi) * u
    }
  }
  for (let i = 0; i < n; i++) x[i] = env[i] * Math.sin(2 * Math.PI * PROBE_HZ * i / SR)
  return { x, env }
}

function writeFloatWav(file, samples) {
  const n = samples.length, fmtSize = 18, factSize = 4, dataSize = n * 4
  const buf = Buffer.alloc(12 + (8 + fmtSize) + (8 + factSize) + (8 + dataSize))
  let o = 0
  buf.write('RIFF', o); o += 4
  buf.writeUInt32LE(buf.length - 8, o); o += 4
  buf.write('WAVE', o); o += 4
  buf.write('fmt ', o); o += 4
  buf.writeUInt32LE(fmtSize, o); o += 4
  buf.writeUInt16LE(3, o); o += 2
  buf.writeUInt16LE(1, o); o += 2
  buf.writeUInt32LE(SR, o); o += 4
  buf.writeUInt32LE(SR * 4, o); o += 4
  buf.writeUInt16LE(4, o); o += 2
  buf.writeUInt16LE(32, o); o += 2
  buf.writeUInt16LE(0, o); o += 2
  buf.write('fact', o); o += 4
  buf.writeUInt32LE(factSize, o); o += 4
  buf.writeUInt32LE(n, o); o += 4
  buf.write('data', o); o += 4
  buf.writeUInt32LE(dataSize, o); o += 4
  for (let i = 0; i < n; i++) { buf.writeFloatLE(samples[i], o); o += 4 }
  writeFileSync(file, buf)
}

// ── Envelope recovery ───────────────────────────────────────────────────────

/**
 * Quadrature demodulation at PROBE_HZ. Two cascaded one-poles at `cutHz`; the
 * pair's group delay is 2/(2*pi*cutHz) and is compensated on the way out, so
 * the returned envelope is aligned with the signal that produced it.
 */
function demodulate(y, cutHz = 500) {
  const n = y.length
  const a = Math.exp(-2 * Math.PI * cutHz / SR)
  let i1 = 0, i2 = 0, q1 = 0, q2 = 0
  const amp = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const w = 2 * Math.PI * PROBE_HZ * k / SR
    const I = y[k] * Math.cos(w), Q = y[k] * Math.sin(w)
    i1 = a * i1 + (1 - a) * I; i2 = a * i2 + (1 - a) * i1
    q1 = a * q1 + (1 - a) * Q; q2 = a * q2 + (1 - a) * q1
    amp[k] = 2 * Math.hypot(i2, q2)
  }
  const gd = Math.round(2 / (2 * Math.PI * cutHz) * SR)
  const out = new Float64Array(n)
  for (let k = 0; k < n; k++) out[k] = amp[Math.min(n - 1, k + gd)]
  return out
}

/** Align a capture to the stimulus by its ENVELOPE, not its waveform — a
 *  periodic probe tone correlates ambiguously at the period, 1 ms here. */
function alignByEnvelope(refEnv, capEnv, maxLag = 4410) {
  const step = 16
  let best = 0, bestErr = Infinity
  for (let lag = -maxLag; lag <= maxLag; lag += step) {
    let e = 0, c = 0
    for (let i = Math.max(0, -lag); i + lag < capEnv.length && i < refEnv.length; i += 64) {
      e += (Math.log(Math.max(capEnv[i + lag], 1e-9)) - Math.log(Math.max(refEnv[i], 1e-9))) ** 2
      c++
    }
    if (c && e / c < bestErr) { bestErr = e / c; best = lag }
  }
  return best
}

// ── Fitting ─────────────────────────────────────────────────────────────────

/**
 * Gain reduction trajectory around one burst, in dB, relative to the resting
 * gain measured just before the step.
 */
function trajectory(gainDb, plan, ev, lag) {
  const at = (tSec) => {
    const i = Math.round(tSec * SR) + lag
    return (i >= 0 && i < gainDb.length) ? gainDb[i] : NaN
  }
  // Resting gain: the 200 ms before the step, where the cell is open.
  let rest = 0, c = 0
  for (let t = ev.up - 0.25; t < ev.up - 0.05; t += 0.002) { const v = at(t); if (Number.isFinite(v)) { rest += v; c++ } }
  rest = c ? rest / c : NaN
  return { rest, gr: (tSec) => rest - at(tSec) }
}

function fitBursts(gainDb, plan, lag, label) {
  console.log(`\n  ── ${label} ──`)
  console.log('  ATTACK — gain reduction (dB) after the step up')
  console.log('    burst      +1ms   +2ms   +5ms  +10ms  +20ms  +50ms +100ms   t63    t90')
  const finals = new Map()
  for (const ev of plan.events) {
    const { rest, gr } = trajectory(gainDb, plan, ev, lag)
    if (!Number.isFinite(rest)) continue
    // Final value: the last 20 % of the burst, or 200 ms in for short ones.
    const settleT = Math.min(ev.down - 0.01, ev.up + Math.max(0.2, (ev.down - ev.up) * 0.8))
    let fin = 0, c = 0
    for (let t = settleT - 0.02; t < settleT; t += 0.002) { const v = gr(t); if (Number.isFinite(v)) { fin += v; c++ } }
    fin = c ? fin / c : NaN
    finals.set(ev.T, fin)
    const offs = [0.001, 0.002, 0.005, 0.010, 0.020, 0.050, 0.100]
    const vals = offs.map(o => gr(ev.up + o))
    // time to 63 % and 90 % of the final excursion
    const timeTo = (frac) => {
      for (let t = 0; t < Math.min(0.5, ev.down - ev.up); t += 0.0005) {
        if (gr(ev.up + t) >= frac * fin) return t * 1000
      }
      return NaN
    }
    console.log(`    ${String(ev.T).padStart(5)}s  ${vals.map(v => (Number.isFinite(v) ? v.toFixed(2) : '  -').padStart(6)).join('')}  ${timeTo(0.63).toFixed(1).padStart(5)}  ${timeTo(0.90).toFixed(1).padStart(5)} ms`)
  }
  console.log('\n  RELEASE — gain reduction (dB) remaining after the step down')
  console.log('    burst    final   +20ms  +50ms +100ms +200ms +500ms    +1s    +2s    +5s   fast%')
  for (const ev of plan.events) {
    const { rest, gr } = trajectory(gainDb, plan, ev, lag)
    if (!Number.isFinite(rest)) continue
    const fin = finals.get(ev.T)
    const offs = [0.020, 0.050, 0.100, 0.200, 0.500, 1.0, 2.0, 5.0]
    const vals = offs.map(o => gr(ev.down + o))
    // Share recovered in the first 100 ms — the fast stage's fraction.
    const fast = Number.isFinite(fin) && fin > 0.5 ? 100 * (fin - vals[2]) / fin : NaN
    console.log(`    ${String(ev.T).padStart(5)}s  ${(Number.isFinite(fin) ? fin.toFixed(2) : '  -').padStart(6)}  ${vals.map(v => (Number.isFinite(v) ? v.toFixed(2) : '  -').padStart(6)).join('')}  ${(Number.isFinite(fast) ? fast.toFixed(0) + '%' : '   -').padStart(6)}`)
  }
  console.log('    ⚠ "fast%" is the share of the reduction gone within 100 ms. In our')
  console.log('      model that is FAST_FRACTION; the rest is the slow tail, and how the')
  console.log('      tail lengthens down this column IS the LDR memory.')
}

function fitStairs(gainDb, plan, lag, label) {
  console.log(`\n  ── ${label}: static curve ──`)
  console.log('    input      settled GR')
  const pts = []
  for (const ev of plan.events) {
    const { rest, gr } = trajectory(gainDb, plan, ev, lag)
    if (!Number.isFinite(rest)) continue
    let v = 0, c = 0
    for (let t = ev.down - 0.5; t < ev.down - 0.05; t += 0.002) { const g = gr(t); if (Number.isFinite(g)) { v += g; c++ } }
    if (!c) continue
    pts.push([ev.L, v / c])
    console.log(`    ${String(ev.L).padStart(4)} dBFS   ${(v / c).toFixed(2).padStart(6)} dB`)
  }
  const w = pts.filter(p => p[1] >= 1.5)
  if (w.length >= 3) {
    let n = w.length, sx = 0, sy = 0, sxx = 0, sxy = 0
    for (const [x, y] of w) { sx += x; sy += y; sxx += x * x; sxy += x * y }
    const m = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    console.log(`    slope ${m.toFixed(3)} dB/dB -> ratio ${(1 / (1 - m)).toFixed(2)}:1  (over ${w[0][0]}..${w[w.length - 1][0]} dBFS)`)
  } else {
    console.log('    not enough compressing steps to fit a ratio; raise the knob and recapture.')
  }
}

// ── Drivers ─────────────────────────────────────────────────────────────────

function gainDbOf(capture, refEnv) {
  const capEnv = demodulate(capture)
  const lag = alignByEnvelope(refEnv, capEnv)
  const g = new Float64Array(capEnv.length)
  for (let i = 0; i < capEnv.length; i++) g[i] = db(capEnv[i]) - db(refEnv[Math.min(i, refEnv.length - 1)])
  return { gainDb: g, lag }
}

function runKernel(x, params) {
  const k = new LA2AKernel(SR)
  k.setParams({ mode: 'compress', gainDb: 0, r37: 100, mix: 1, ...params })
  const o = new Float32Array(x.length)
  for (let i = 0; i < x.length; i += 128) {
    const l = Math.min(128, x.length - i)
    k.process([x.subarray(i, i + l)], [o.subarray(i, i + l)], l)
  }
  const L = k.latencySamples
  const a = new Float32Array(x.length)
  a.set(o.subarray(L), 0)
  return a
}

const args = process.argv.slice(2)

if (args.includes('--stimulus')) {
  mkdirSync(STIM_DIR, { recursive: true })
  mkdirSync(CAP_DIR, { recursive: true })
  const bp = burstPlan(), sp = stairPlan()
  writeFloatWav(path.join(STIM_DIR, 'bursts.wav'), build(bp, () => lin(HIGH_DBFS)).x)
  writeFloatWav(path.join(STIM_DIR, 'staircase.wav'), build(sp, e => lin(e.L)).x)
  console.log(`Wrote stimulus to ${STIM_DIR}`)
  console.log(`  bursts.wav     ${bp.seconds.toFixed(1)} s — attack, release, and the memory`)
  console.log(`  staircase.wav  ${sp.seconds.toFixed(1)} s — the static curve`)
  console.log('\nCapture protocol:')
  console.log('  1. 44.1 kHz, 32-bit float, mono, no dither, no other plugins in the chain.')
  console.log('  2. Compressor Gain/makeup at 0 (or note it — a fixed makeup cancels here,')
  console.log('     because every reduction is measured against the resting gain).')
  console.log('  3. Capture at 2-3 Peak Reduction settings, e.g. 35 / 55 / 75.')
  console.log('  4. Bounce the FULL length, tail included, and do not normalise.')
  console.log(`  5. Save as ${CAP_DIR}/<unit>.<knob>.bursts.wav and .staircase.wav`)
  console.log('     e.g. laea.55.bursts.wav')
  process.exit(0)
}

if (args.includes('--selftest')) {
  // ⚠ THE FITTER MUST RECOVER CONSTANTS WE ALREADY KNOW BEFORE IT IS POINTED AT
  // ANYTHING ELSE. Our kernel's ATTACK_S is 10 ms, FAST_FRACTION 0.65 and
  // FAST_RELEASE_S 35 ms, so the attack column should reach 63 % near 10 ms and
  // the fast% column should land near 65. Anything else means the measurement
  // is wrong, not the model.
  const bp = burstPlan(), sp = stairPlan()
  const b = build(bp, () => lin(HIGH_DBFS)), s = build(sp, e => lin(e.L))
  console.log('SELF-TEST — our own kernel, whose ballistics are known.')
  console.log('Expect: t63 near ATTACK_S = 10 ms, fast% near FAST_FRACTION = 65 %,')
  console.log('and a tail that lengthens with burst duration (the LDR memory).')
  for (const pr of [55, 75]) {
    const gb = gainDbOf(runKernel(b.x, { peakReduction: pr }), b.env)
    fitBursts(gb.gainDb, bp, gb.lag, `our kernel, Peak Reduction ${pr}`)
    const gs = gainDbOf(runKernel(s.x, { peakReduction: pr }), s.env)
    fitStairs(gs.gainDb, sp, gs.lag, `our kernel, Peak Reduction ${pr}`)
  }
  process.exit(0)
}

if (!existsSync(CAP_DIR)) {
  console.log(`No captures at ${CAP_DIR}. Run with --stimulus first.`)
  process.exit(0)
}
const caps = readdirSync(CAP_DIR).filter(f => f.endsWith('.wav'))
if (caps.length === 0) {
  console.log(`No captures in ${CAP_DIR}. Run with --stimulus, render them, and drop them in.`)
  process.exit(0)
}
const bp = burstPlan(), sp = stairPlan()
const bEnv = build(bp, () => lin(HIGH_DBFS)).env
const sEnv = build(sp, e => lin(e.L)).env
for (const f of caps.sort()) {
  const y = readWav(path.join(CAP_DIR, f))
  if (y.sampleRate !== SR) { console.log(`\n⚠ ${f}: ${y.sampleRate} Hz; capture at ${SR}.`); continue }
  if (f.includes('.bursts.')) {
    const g = gainDbOf(y.mono, bEnv)
    fitBursts(g.gainDb, bp, g.lag, f)
  } else if (f.includes('.staircase.')) {
    const g = gainDbOf(y.mono, sEnv)
    fitStairs(g.gainDb, sp, g.lag, f)
  } else {
    console.log(`\n⚠ ${f}: name it <unit>.<knob>.bursts.wav or .staircase.wav`)
  }
}
