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
 *
 * ── WHAT THE FIRST VERSION OF THIS STIMULUS COULD NOT HAVE SEEN ─────────────
 *
 * The T4 is an electroluminescent panel lighting a CdS photoresistor, and the
 * cell's speed depends on how much light it has already absorbed: a cell
 * sitting in darkness responds sluggishly to a transient, while one already lit
 * catches the next one far faster. The "about 10 ms" figure is an average over
 * that behaviour, not a time constant.
 *
 *  1. ⚠ EVERY BURST USED TO START FROM A DARK CELL — 20 s of rest before each
 *     one. That measures how the RELEASE tail lengthens with exposure and is
 *     structurally blind to the ATTACK speeding up, which is the half of the
 *     memory that decides what a transient does. `retrigger.wav` fixes it: a
 *     conditioning burst, then a test step at a sweep of gaps, so the attack is
 *     measured against how recently the cell was lit.
 *
 *  2. ⚠ ONE PROBE AT 1 kHz. The cell responds faster to highs than lows and
 *     1 kHz sits above most voice fundamentals, so the one frequency measured
 *     was the one narration cares least about. `frequency.wav` steps the same
 *     burst at 100 / 200 / 400 / 1000 / 3000 Hz.
 *
 *  3. ⚠ A 5 ms RAISED-COSINE EDGE AND A 500 Hz DEMODULATOR COULD NOT RESOLVE AN
 *     ATTACK FASTER THAN ABOUT 5 ms — so a 1-2 ms pre-lit attack would have
 *     come back as "10 ms" no matter what the plugin did, confirming our own
 *     constant by construction. Both are gone: steps land exactly on a zero
 *     crossing of the probe (no discontinuity in the waveform, so no click and
 *     no fade needed), and the envelope is the magnitude of the analytic signal
 *     via an FFT Hilbert transform, which for an amplitude-modulated tone is
 *     EXACT rather than smoothed.
 */

import { writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { readWav } from '../test/voicerx/wav.js'
import { getFFT } from '../src/audio/dsp/fft.js'
import {
  LA2AKernel, scDriveDbFor, SC_DRIVE_MAX_DB, SC_DRIVE_SPAN_DB, SC_TAPER,
} from '../src/audio/la2aProcessor.js'

const SR = 44100
const PROBE_HZ = 1000        // default probe; `frequency.wav` sweeps it
const LOW_DBFS = -40         // below threshold at any useful knob: the cell rests open
const HIGH_DBFS = -18        // nominal line level

/** Probe frequencies for the frequency-dependence file, Hz. Voice-weighted:
 *  two fundamentals, two formant-region, one sibilance. */
const FREQS_HZ = [100, 200, 400, 1000, 3000]

/** Gaps between a conditioning burst and the test step, seconds. The cell's
 *  light history decays across this, so the test step's attack is measured
 *  against how recently it was lit. */
const RETRIGGER_GAPS = [0.05, 0.15, 0.5, 1.5, 5.0]
const COND_S = 2.0           // conditioning burst: long enough to light the cell fully
const TEST_S = 0.5           // test step
/**
 * ⚠ THE TEST STEP IS LOUDER THAN THE CONDITIONING BURST, and that is not a
 * detail. At equal levels a short gap leaves the cell already closed to very
 * near the test's target, so there is almost no excursion left and the rise
 * time is measured on 1 dB of travel — ill-conditioned, and it read as 0.0 ms.
 * Stepping UP from the conditioned state demands fresh reduction at every gap.
 */
const COND_DBFS = -24
const TEST_DBFS = -12

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

/**
 * Every event carries its own probe frequency and levels. Steps land on a ZERO
 * CROSSING of that probe, which is what lets the edge be instantaneous: the
 * waveform value is continuous across it (only its derivative jumps), so there
 * is nothing to click and no fade to blur the attack.
 */
function snapToZeroCrossing(tSec, freqHz) {
  const halfPeriod = 1 / (2 * freqHz)
  return Math.round(tSec / halfPeriod) * halfPeriod
}

function burstPlan() {
  const events = []
  let t = 1.0
  for (const T of BURSTS) {
    const up = snapToZeroCrossing(t + PRE_S, PROBE_HZ)
    events.push({ tag: `burst ${T}s`, T, freqHz: PROBE_HZ, hiDb: HIGH_DBFS,
      up, down: snapToZeroCrossing(up + T, PROBE_HZ) })
    t += PRE_S + T + POST_S + REST_S
  }
  return { events, seconds: t + 1.0 }
}

function stairPlan() {
  const events = []
  let t = 1.0
  for (const L of STAIRS) {
    const up = snapToZeroCrossing(t + STAIR_REST_S, PROBE_HZ)
    events.push({ tag: `${L} dBFS`, L, freqHz: PROBE_HZ, hiDb: L,
      up, down: snapToZeroCrossing(up + STAIR_S, PROBE_HZ) })
    t += STAIR_REST_S + STAIR_S
  }
  return { events, seconds: t + 1.0 }
}

/**
 * ATTACK MEMORY. Each block is: rest (dark) -> conditioning burst -> gap ->
 * test step. The conditioning burst lights the cell; the gap decides how much
 * of that light is left when the test step arrives. If the attack is
 * program-dependent, the test step's rise time shortens as the gap shortens —
 * and the first block's gap is long enough to serve as the dark-cell control.
 */
function retriggerPlan() {
  const events = []
  let t = 1.0
  for (const gap of RETRIGGER_GAPS) {
    const cUp = snapToZeroCrossing(t + PRE_S, PROBE_HZ)
    const cDown = snapToZeroCrossing(cUp + COND_S, PROBE_HZ)
    const tUp = snapToZeroCrossing(cDown + gap, PROBE_HZ)
    events.push({ tag: `condition (gap ${gap}s)`, freqHz: PROBE_HZ, hiDb: COND_DBFS,
      up: cUp, down: cDown, role: 'condition' })
    events.push({ tag: `test after ${gap}s`, gap, freqHz: PROBE_HZ, hiDb: TEST_DBFS,
      up: tUp, down: snapToZeroCrossing(tUp + TEST_S, PROBE_HZ), role: 'test' })
    t = tUp + TEST_S + POST_S + REST_S
  }
  return { events, seconds: t + 1.0 }
}

/**
 * FREQUENCY DEPENDENCE. The same step at each probe, each in its own segment
 * with a full rest between, so no segment inherits the previous one's light.
 */
function freqPlan() {
  const events = []
  let t = 1.0
  for (const f of FREQS_HZ) {
    const up = snapToZeroCrossing(t + PRE_S, f)
    events.push({ tag: `${f} Hz`, freqHz: f, hiDb: HIGH_DBFS,
      up, down: snapToZeroCrossing(up + 1.0, f) })
    t += PRE_S + 1.0 + POST_S + REST_S
  }
  return { events, seconds: t + 1.0 }
}

/**
 * TAPER RAMP — one slow sweep instead of a staircase.
 *
 * The Peak Reduction knob is side-chain DRIVE into a fixed internal threshold,
 * so what a capture has to pin down is WHERE COMPRESSION STARTS at each knob.
 * A 5 dB staircase can only bracket that between two steps; a ramp reads it
 * directly, and hands back the whole curve as a bonus — including how the ratio
 * drifts with level, which is a separate open question.
 *
 * ⚠ 0.5 dB/s IS SLOW ENOUGH TO READ AS QUASI-STATIC AND NOT INSTANT. The cell's
 * memory moves on 0.8-8 s, over which this ramp climbs 0.4-4 dB, so the curve
 * lags slightly. The same lag applies to our model when its own threshold is
 * measured the same way, so it largely cancels — but it is a reason to read the
 * fitted taper as a threshold match, not as a claim about the reference's
 * instantaneous curve.
 */
/**
 * ⚠ THE RANGE HAS TO COVER THE WHOLE KNOB TRAVEL OR THE FIT IS DRAGGED BY ITS
 * OWN EDGE. At -55..-5 the self-test lost knob 20 entirely (threshold above the
 * top) and clipped knob 95 (threshold below the bottom, reported 1.11 dB high),
 * and that one clipped point pulled a three-constant fit off four good ones.
 * -70..0 spans it, and `rampCurve` now refuses a crossing that lands within
 * 3 dB of either end rather than reporting the ramp's own boundary as a
 * measurement.
 */
const RAMP_FROM_DBFS = -70
const RAMP_TO_DBFS = 0
const RAMP_S = 140

function rampPlan() {
  const lead = 5.0
  return {
    events: [{ tag: 'ramp', freqHz: PROBE_HZ, hiDb: RAMP_TO_DBFS, up: lead, down: lead + RAMP_S }],
    seconds: lead + RAMP_S + 2.0,
    isRamp: true,
    envAt(t) {
      if (t < lead) return lin(RAMP_FROM_DBFS)
      const u = Math.min(1, (t - lead) / RAMP_S)
      return lin(RAMP_FROM_DBFS + (RAMP_TO_DBFS - RAMP_FROM_DBFS) * u)
    },
  }
}

/**
 * Build the waveform. Between events the probe sits at LOW_DBFS at that
 * event's frequency; frequency changes happen during a rest, at a zero
 * crossing, so they too are click-free.
 */
function build(plan) {
  const n = Math.round(plan.seconds * SR)
  const x = new Float32Array(n)
  if (plan.isRamp) {
    const env = new Float64Array(n)
    let phase = 0
    for (let i = 0; i < n; i++) {
      env[i] = plan.envAt(i / SR)
      x[i] = env[i] * Math.sin(phase)
      phase += 2 * Math.PI * PROBE_HZ / SR
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI
    }
    return { x, env }
  }
  const env = new Float64Array(n).fill(lin(LOW_DBFS))
  const freq = new Float64Array(n).fill(plan.events[0]?.freqHz ?? PROBE_HZ)

  // Each event owns the span from halfway back to the previous event.
  for (let e = 0; e < plan.events.length; e++) {
    const ev = plan.events[e]
    const prev = plan.events[e - 1]
    const from = prev ? Math.round(((prev.down + ev.up) / 2) * SR) : 0
    const to = e + 1 < plan.events.length
      ? Math.round(((ev.down + plan.events[e + 1].up) / 2) * SR) : n
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) freq[i] = ev.freqHz
    const a = Math.round(ev.up * SR), b = Math.round(ev.down * SR)
    for (let i = Math.max(0, a); i < Math.min(n, b); i++) env[i] = lin(ev.hiDb)
  }
  // Continuous phase, so a frequency change mid-rest cannot step the waveform.
  let phase = 0
  for (let i = 0; i < n; i++) {
    x[i] = env[i] * Math.sin(phase)
    phase += 2 * Math.PI * freq[i] / SR
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI
  }
  return { x, env, freq }
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
 * Envelope by COHERENT DETECTION at a known probe frequency: multiply by cos
 * and sin, low-pass, take the magnitude. Two cascaded one-poles.
 *
 * ⚠ THE CUTOFF FOLLOWS THE PROBE, and it has to. The image sits at 2f, so the
 * low-pass must be well below that — fine at 1 kHz, and a hard physical limit
 * at 100 Hz, where the envelope simply is not knowable faster than a cycle.
 * `envelopeResolutionMs` reports it per probe so a frequency row is never read
 * as an attack time it cannot support.
 *
 * ⚠ AN FFT HILBERT WAS TRIED HERE FIRST AND WAS WORSE, not better. It is exact
 * for a smoothly modulated tone and rings badly on the abrupt steps this
 * stimulus is made of — the Hilbert transform of a step has a log singularity —
 * which put a spike at every edge and made the rise times read as zero.
 *
 * ⚠ AND THE CLAIM THAT A DEMODULATOR COULD NOT SEE A FAST ATTACK WAS WRONG.
 * Two poles at 500 Hz rise in about 0.8 ms, which resolves a 1-2 ms attack
 * comfortably. The thing that actually blinded the first stimulus was its 5 ms
 * raised-cosine edge, now replaced by a zero-crossing step.
 */
function cutoffFor(freqHz) { return Math.min(500, freqHz / 2.5) }

function envelopeResolutionMs(freqHz) {
  return 1000 * 2.4 / (2 * Math.PI * cutoffFor(freqHz))
}

function demodulate(y, freqHz) {
  const n = y.length
  const a = Math.exp(-2 * Math.PI * cutoffFor(freqHz) / SR)
  let i1 = 0, i2 = 0, q1 = 0, q2 = 0
  const amp = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const w = 2 * Math.PI * freqHz * k / SR
    const I = y[k] * Math.cos(w), Q = y[k] * Math.sin(w)
    i1 = a * i1 + (1 - a) * I; i2 = a * i2 + (1 - a) * i1
    q1 = a * q1 + (1 - a) * Q; q2 = a * q2 + (1 - a) * q1
    amp[k] = 2 * Math.hypot(i2, q2)
  }
  // Compensate the pair's group delay so the envelope sits on the edge that
  // produced it rather than after it.
  const gd = Math.round(2 / (2 * Math.PI * cutoffFor(freqHz)) * SR)
  const out = new Float64Array(n)
  for (let k = 0; k < n; k++) out[k] = amp[Math.min(n - 1, k + gd)]
  return out
}

/** Cache one demodulation per distinct probe frequency in the plan. */
function envelopesFor(capture, plan) {
  const byFreq = new Map()
  for (const ev of plan.events) {
    if (!byFreq.has(ev.freqHz)) byFreq.set(ev.freqHz, demodulate(capture, ev.freqHz))
  }
  return byFreq
}

/**
 * Stretches where the capture is silent but the stimulus is not.
 *
 * ⚠ DEMO PLUGINS MUTE ON A TIMER — Waves inserts a second of silence every
 * twenty — and a muted second inside a measurement window does not look like an
 * error, it looks like a compressor that clamped to nothing. Any event whose
 * windows touch one of these is reported as corrupted rather than read.
 */
function findGaps(capture, plan) {
  const win = Math.round(0.02 * SR)
  const gaps = []
  let inGap = false, start = 0
  for (let i = 0; i + win < capture.length; i += win) {
    let cm = 0, sm = 0
    for (let j = 0; j < win; j++) {
      const a = Math.abs(capture[i + j]); if (a > cm) cm = a
      const r = plan.env[Math.min(i + j, plan.env.length - 1)]; if (r > sm) sm = r
    }
    const dead = cm < 1e-6 && sm > 1e-4
    if (dead && !inGap) { inGap = true; start = i / SR }
    if (!dead && inGap) { inGap = false; gaps.push([start, i / SR]) }
  }
  if (inGap) gaps.push([start, capture.length / SR])
  return gaps
}

/** Does [a,b] touch any gap? */
function hitsGap(gaps, a, b) {
  return gaps.some(([g0, g1]) => b >= g0 && a <= g1)
}

/**
 * Gain reduction trajectory around one event, in dB, against the resting gain
 * just before its step. The stimulus envelope is known analytically, so only
 * the capture is demodulated.
 */
function eventGain(envs, plan, ev, lag) {
  const env = envs.get(ev.freqHz)
  const gainAt = (tSec) => {
    const i = Math.round(tSec * SR) + lag
    const j = Math.round(tSec * SR)
    if (i < 0 || i >= env.length || j < 0 || j >= plan.env.length) return NaN
    return plan.env[j] > 0 ? db(env[i]) - db(plan.env[j]) : NaN
  }
  let rest = 0, c = 0
  for (let t = ev.up - 0.25; t < ev.up - 0.02; t += 0.002) {
    const v = gainAt(t); if (Number.isFinite(v)) { rest += v; c++ }
  }
  return { rest: c ? rest / c : NaN, gr: (t) => (c ? rest / c : NaN) - gainAt(t) }
}

/**
 * Align a capture to the stimulus by ENVELOPE, not waveform — a periodic probe
 * correlates ambiguously at its own period, 1 ms at 1 kHz, which is the same
 * order as the attack being measured.
 */
function alignByEnvelope(refEnv, capture, maxLag = 22050) {
  const rect = new Float64Array(capture.length)
  const a = Math.exp(-1 / (SR * 0.005))
  let e = 0
  for (let i = 0; i < capture.length; i++) { e = a * e + (1 - a) * Math.abs(capture[i]); rect[i] = e }

  // ⚠ EXCLUDE THE DEMO MUTES FROM THE COST, OR THE FIT RAILS. Seven seconds of
  // silence that the stimulus does not have will dominate a log-envelope
  // distance, and the search pins itself to the end of its range — measured, it
  // came back at -4394 against a +/-4410 limit, and every table downstream was
  // nonsense (22 dB of reduction half a millisecond after a step, negative
  // reduction during a release). The window is also widened, so a genuine
  // plugin latency cannot be mistaken for the same failure.
  const dead = new Uint8Array(capture.length)
  {
    const win = Math.round(0.02 * SR)
    for (let i = 0; i + win < capture.length; i += win) {
      let cm = 0
      for (let j = 0; j < win; j++) { const v = Math.abs(capture[i + j]); if (v > cm) cm = v }
      if (cm < 1e-6) for (let j = 0; j < win; j++) dead[i + j] = 1
    }
  }

  let best = 0, bestErr = Infinity
  for (let lag = -maxLag; lag <= maxLag; lag += 8) {
    let err = 0, c = 0
    for (let i = Math.max(0, -lag); i + lag < rect.length && i < refEnv.length; i += 128) {
      if (dead[i + lag]) continue
      const r = refEnv[i] * 0.6366                     // mean |sin|, so the scales match
      err += (Math.log(Math.max(rect[i + lag], 1e-9)) - Math.log(Math.max(r, 1e-9))) ** 2
      c++
    }
    if (c > 1000 && err / c < bestErr) { bestErr = err / c; best = lag }
  }
  // Refine to the sample.
  let refined = best
  for (let lag = best - 8; lag <= best + 8; lag++) {
    let err = 0, c = 0
    for (let i = Math.max(0, -lag); i + lag < rect.length && i < refEnv.length; i += 32) {
      if (dead[i + lag]) continue
      const r = refEnv[i] * 0.6366
      err += (Math.log(Math.max(rect[i + lag], 1e-9)) - Math.log(Math.max(r, 1e-9))) ** 2
      c++
    }
    if (c > 1000 && err / c < bestErr) { bestErr = err / c; refined = lag }
  }
  return refined
}

// ── Fitting ─────────────────────────────────────────────────────────────────

/** Settled reduction near the end of an event's hold. */
function finalGR(gr, ev) {
  const hold = ev.down - ev.up
  const at = ev.down - Math.min(0.02, hold * 0.1)
  let v = 0, c = 0
  for (let t = at - Math.min(0.05, hold * 0.3); t < at; t += 0.001) {
    const g = gr(t); if (Number.isFinite(g)) { v += g; c++ }
  }
  return c ? v / c : NaN
}

/** Time to reach a fraction of the settled reduction, ms. */
function timeTo(gr, ev, frac, fin) {
  // An excursion under a dB cannot support a rise time; say so rather than
  // returning a confident 0.0 ms, which is what a bare threshold search does.
  if (!Number.isFinite(fin) || fin < 1.0) return NaN
  const limit = Math.min(0.4, ev.down - ev.up)
  for (let t = 0.0002; t < limit; t += 0.0002) {
    const v = gr(ev.up + t)
    if (Number.isFinite(v) && v >= frac * fin) return t * 1000
  }
  return NaN
}

const OFFS = [0.0005, 0.001, 0.002, 0.005, 0.010, 0.020, 0.050]

function attackTable(envs, plan, lag, rows, gaps = []) {
  console.log('  ATTACK — gain reduction (dB) after the step up')
  console.log('    event                +0.5ms   +1ms   +2ms   +5ms  +10ms  +20ms  +50ms    final    t63    t90')
  console.log('    (a t63 marked <=res is at or under the detector\'s own step response —')
  console.log('     the attack is faster than this probe can resolve, not this fast)')
  const out = []
  for (const ev of rows) {
    // The resting window before the step, and the settling window before the
    // step down, are the two the measurement depends on.
    if (hitsGap(gaps, ev.up - 0.3, ev.up + 0.15) || hitsGap(gaps, ev.down - 0.6, ev.down + 5.2)) {
      console.log(`    ${ev.tag.padEnd(20)}  — skipped: a demo mute overlaps this event`)
      continue
    }
    const { rest, gr } = eventGain(envs, plan, ev, lag)
    if (!Number.isFinite(rest)) continue
    const fin = finalGR(gr, ev)
    const vals = OFFS.map(o => gr(ev.up + o))
    // ⚠ A RISE TIME AT OR UNDER THE DETECTOR'S OWN RESOLUTION IS THE DETECTOR.
    // The demodulator's step response is ~1 ms at a 1 kHz probe and ~10 ms at
    // 100 Hz; without this flag a capture whose attack is genuinely faster than
    // the probe can resolve comes back as a confident sub-millisecond number.
    const res = envelopeResolutionMs(ev.freqHz)
    const t63 = timeTo(gr, ev, 0.63, fin), t90 = timeTo(gr, ev, 0.90, fin)
    const mark = (Number.isFinite(t63) && t63 <= res * 1.5) ? ' <=res' : ''
    console.log(`    ${ev.tag.padEnd(20)}${vals.map(v => (Number.isFinite(v) ? v.toFixed(2) : '  -').padStart(7)).join('')}  ${fin.toFixed(2).padStart(7)}  ${t63.toFixed(1).padStart(5)}  ${t90.toFixed(1).padStart(5)} ms${mark}`)
    out.push({ ev, fin, gr, t63, belowRes: Number.isFinite(t63) && t63 <= res * 1.5 })
  }
  return out
}

function releaseTable(fits) {
  console.log('\n  RELEASE — gain reduction (dB) still present after the step down')
  console.log('    event                 final   +20ms  +50ms +100ms +200ms +500ms    +1s    +2s    +5s   fast%')
  for (const { ev, fin, gr } of fits) {
    const offs = [0.020, 0.050, 0.100, 0.200, 0.500, 1.0, 2.0, 5.0]
    const vals = offs.map(o => gr(ev.down + o))
    const fast = Number.isFinite(fin) && fin > 0.5 ? 100 * (fin - vals[2]) / fin : NaN
    console.log(`    ${ev.tag.padEnd(20)}${(Number.isFinite(fin) ? fin.toFixed(2) : '  -').padStart(7)}${vals.map(v => (Number.isFinite(v) ? v.toFixed(2) : '  -').padStart(7)).join('')}  ${(Number.isFinite(fast) ? fast.toFixed(0) + '%' : '   -').padStart(6)}`)
  }
  console.log('    ⚠ "fast%" is the share gone within 100 ms — FAST_FRACTION in our model.')
  console.log('      How the tail lengthens DOWN this column is the release side of the memory.')
}

function fitBursts(capture, plan, lag, label) {
  const envs = envelopesFor(capture, plan)
  const gaps = findGaps(capture, plan)
  if (gaps.length) console.log(`\n  ⚠ ${gaps.length} demo mute(s) detected; affected events are skipped, not read.`)
  console.log(`\n  ── ${label} ──`)
  releaseTable(attackTable(envs, plan, lag, plan.events, gaps))
}

function fitRetrigger(capture, plan, lag, label) {
  const envs = envelopesFor(capture, plan)
  const gaps = findGaps(capture, plan)
  if (gaps.length) console.log(`\n  ⚠ ${gaps.length} demo mute(s) detected; affected events are skipped, not read.`)
  console.log(`\n  ── ${label} ──`)
  console.log('  ATTACK MEMORY — the same test step, varying how recently the cell was lit.')
  console.log('  If the attack is program-dependent, t63 SHORTENS as the gap shortens.')
  const tests = plan.events.filter(e => e.role === 'test')
  const fits = attackTable(envs, plan, lag, tests, gaps)
  const byGap = fits.filter(f => Number.isFinite(f.t63)).sort((a, b) => a.ev.gap - b.ev.gap)
  if (byGap.length >= 2) {
    const fastest = byGap[0], slowest = byGap[byGap.length - 1]
    const spread = slowest.t63 - fastest.t63
    console.log(`\n    t63 at the shortest gap (${fastest.ev.gap}s): ${fastest.t63.toFixed(1)} ms`)
    console.log(`    t63 at the longest gap  (${slowest.ev.gap}s): ${slowest.t63.toFixed(1)} ms`)
    console.log(`    => attack memory spans ${spread.toFixed(1)} ms.`)
    console.log(`    ⚠ THE CONTROL IS NOT ZERO. Our kernel has a FIXED attack and still`)
    console.log(`      returns about -2 ms here (13.4 ms at the 0.05 s gap against 11.4 ms at`)
    console.log(`      5 s) — the release is still moving while the attack is measured. So a`)
    console.log(`      real memory has to beat roughly 2 ms, and has to run the other way:`)
    console.log(`      SHORTER t63 at SHORTER gaps. Anything smaller is this artefact.`)
  }
}

function fitFrequency(capture, plan, lag, label) {
  const envs = envelopesFor(capture, plan)
  const gaps = findGaps(capture, plan)
  if (gaps.length) console.log(`\n  ⚠ ${gaps.length} demo mute(s) detected; affected events are skipped, not read.`)
  console.log(`\n  ── ${label} ──`)
  console.log('  FREQUENCY DEPENDENCE — the same step at each probe.')
  console.log('  The cell is described as faster to highs than lows; voice fundamentals')
  console.log('  sit at 100-250 Hz, which is where narration actually lives.')
  console.log('\n  ⚠ THE ENVELOPE OF A LOW TONE IS NOT KNOWABLE FASTER THAN ITS OWN CYCLE.')
  console.log('    Detection resolution by probe, below. A t63 near or under these numbers')
  console.log('    is the measurement, not the compressor:')
  console.log('      ' + FREQS_HZ.map(f => `${f} Hz: ${envelopeResolutionMs(f).toFixed(1)} ms`).join('   '))
  console.log('    ⚠ AND OUR OWN KERNEL IS NOT FLAT HERE EITHER — `--selftest` returns t63 of')
  console.log('      10.4 / 11.4 / 13.6 / 17.0 ms at 3000 / 1000 / 400 / 200 Hz, from the 80 Hz')
  console.log('      side-chain high-pass and the detector, with 100 Hz unmeasurable. Compare a')
  console.log('      reference against THAT baseline, never against a flat one.\n')
  attackTable(envs, plan, lag, plan.events, gaps)
}

/**
 * From a ramp, the settled GR against input level, and T1 — the input level at
 * which GR reaches 1 dB.
 *
 * ⚠ T1 IS THE READOUT THE TAPER IS FITTED TO, and deliberately not the whole
 * curve. Drive decides WHERE compression starts; the knee and ratio decide the
 * shape above it. Fitting a knob law to the shape would let our knee's
 * disagreement with the reference's leak into a constant that has nothing to do
 * with it — which is exactly how the previous fit absorbed errors it could not
 * name. T1 depends on drive almost alone.
 */
function rampCurve(capture, plan, lag, gaps = []) {
  const envs = envelopesFor(capture, plan)
  const env = envs.get(PROBE_HZ)
  const pts = []
  for (let t = 0.2; t < RAMP_S - 0.2; t += 0.05) {
    const tSec = 5.0 + t
    if (hitsGap(gaps, tSec - 0.05, tSec + 0.05)) continue
    const i = Math.round(tSec * SR) + lag
    const j = Math.round(tSec * SR)
    if (i < 0 || i >= env.length || j >= plan.env.length) continue
    const inDb = db(plan.env[j])
    pts.push([inDb, db(env[i]) - inDb])
  }
  if (pts.length < 20) return null
  // Resting gain: the flat stretch before compression begins.
  const rest = pts.slice(0, 40).reduce((a, p) => a + p[1], 0) / Math.min(40, pts.length)
  const gr = pts.map(([L, g]) => [L, rest - g])
  let t1 = NaN
  for (let k = 1; k < gr.length; k++) {
    if (gr[k][1] >= 1.0 && gr[k - 1][1] < 1.0) {
      const [x0, y0] = gr[k - 1], [x1, y1] = gr[k]
      t1 = x0 + (x1 - x0) * (1.0 - y0) / (y1 - y0)
      break
    }
  }
  // A crossing at the ramp's own boundary is the boundary, not a threshold.
  if (Number.isFinite(t1) && (t1 < RAMP_FROM_DBFS + 3 || t1 > RAMP_TO_DBFS - 3)) t1 = NaN
  return { gr, t1, rest }
}

function fitRamp(capture, plan, lag, label) {
  const gaps = findGaps(capture, plan)
  if (gaps.length) console.log(`\n  ⚠ ${gaps.length} demo mute(s) detected; those samples are excluded.`)
  const c = rampCurve(capture, plan, lag, gaps)
  console.log(`\n  ── ${label}: taper ramp ──`)
  if (!c) { console.log('    not enough usable samples'); return }
  console.log(`    resting gain ${c.rest.toFixed(2)} dB;  T1 (GR = 1 dB) at ${Number.isFinite(c.t1) ? c.t1.toFixed(2) + ' dBFS' : 'never reached'}`)
  console.log('    input dBFS     GR')
  for (let L = -50; L <= -5; L += 5) {
    const near = c.gr.filter(p => Math.abs(p[0] - L) < 0.4)
    if (!near.length) continue
    console.log(`    ${String(L).padStart(4)}      ${(near.reduce((a, p) => a + p[1], 0) / near.length).toFixed(2).padStart(6)} dB`)
  }
}

function fitStairs(capture, plan, lag, label) {
  const envs = envelopesFor(capture, plan)
  const gaps = findGaps(capture, plan)
  if (gaps.length) console.log(`\n  ⚠ ${gaps.length} demo mute(s) detected; affected events are skipped, not read.`)
  console.log(`\n  ── ${label}: static curve ──`)
  console.log('    input      settled GR')
  const pts = []
  for (const ev of plan.events) {
    if (hitsGap(gaps, ev.up - 0.3, ev.down + 0.1)) {
      console.log(`    ${String(ev.L).padStart(4)} dBFS   — skipped (demo mute)`)
      continue
    }
    const { rest, gr } = eventGain(envs, plan, ev, lag)
    if (!Number.isFinite(rest)) continue
    const v = finalGR(gr, ev)
    if (!Number.isFinite(v)) continue
    pts.push([ev.L, v])
    console.log(`    ${String(ev.L).padStart(4)} dBFS   ${v.toFixed(2).padStart(6)} dB`)
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

const PLANS = {
  ramp: { plan: rampPlan, fit: fitRamp },
  bursts: { plan: burstPlan, fit: fitBursts },
  retrigger: { plan: retriggerPlan, fit: fitRetrigger },
  frequency: { plan: freqPlan, fit: fitFrequency },
  staircase: { plan: stairPlan, fit: fitStairs },
}

/**
 * THE TAPER FIT.
 *
 * `scDriveDbFor` maps the knob to side-chain drive, which shifts where
 * compression starts. So for our gain computer there is a constant O1 with
 *
 *     T1(knob) = O1 - scDriveDb(knob)
 *
 * O1 being the overshoot at which our curve reaches 1 dB of reduction — a
 * property of the knee and ratio, not of the knob. Measure O1 once from our own
 * kernel, then fit (max, span, taper) so our T1 lands on the reference's at
 * every captured knob.
 *
 * ⚠ THIS MAKES OUR THRESHOLD TRACK THE REFERENCE'S, NOT OUR CURVE MATCH IT. If
 * our knee differs from the reference's, that difference stays — it is simply
 * no longer hidden inside a knob constant, which is what the LAEA-era fit did.
 */
function measureO1() {
  const p = rampPlan()
  const b = build(p)
  p.env = b.env
  const knob = 55
  const c = rampCurve(runKernel(b.x, { peakReduction: knob }), p, 0)
  return c && Number.isFinite(c.t1) ? c.t1 + scDriveDbFor(knob) : NaN
}

function fitTaper(points, o1) {
  const err = (mx, sp, tp) => points.reduce((a, [knob, t1]) =>
    a + (o1 - scDriveDbFor(knob, mx, sp, tp) - t1) ** 2, 0) / points.length
  let best = { mx: SC_DRIVE_MAX_DB, sp: SC_DRIVE_SPAN_DB, tp: SC_TAPER }
  best.e = err(best.mx, best.sp, best.tp)
  // Coarse grid, then three rounds of shrinking coordinate search. The surface
  // is smooth and three-dimensional; nothing cleverer is warranted.
  for (let mx = 15; mx <= 60; mx += 1.5) {
    for (let sp = 30; sp <= 220; sp += 5) {
      for (let tp = 0.15; tp <= 1.6; tp += 0.05) {
        const e = err(mx, sp, tp)
        if (e < best.e) best = { mx, sp, tp, e }
      }
    }
  }
  let step = [1.5, 5, 0.05]
  for (let round = 0; round < 24; round++) {
    step = step.map(v => v * 0.7)
    for (const [i, key] of ['mx', 'sp', 'tp'].entries()) {
      for (const d of [-step[i], step[i]]) {
        const t = { ...best, [key]: best[key] + d }
        const e = err(t.mx, t.sp, t.tp)
        if (e < best.e) best = { ...t, e }
      }
    }
  }
  return best
}

function reportTaper(points, label) {
  const o1 = measureO1()
  if (!Number.isFinite(o1)) { console.log('could not measure O1 from our own kernel'); return }
  console.log(`\n══ TAPER FIT — ${label} ══`)
  console.log(`  our gain computer reaches 1 dB of reduction at an overshoot of ${o1.toFixed(2)} dB`)
  console.log('\n  knob   reference T1   ours now      error')
  for (const [k, t1] of points) {
    const mine = o1 - scDriveDbFor(k)
    console.log(`  ${String(k).padStart(4)}   ${t1.toFixed(2).padStart(9)} dBFS  ${mine.toFixed(2).padStart(8)}   ${(mine - t1).toFixed(2).padStart(7)} dB`)
  }
  if (points.length < 3) {
    console.log(`\n  ⚠ ${points.length} knob position(s). The law has THREE constants; a fit needs`)
    console.log('    at least 3 and really wants 5, spread across the travel. Capture')
    console.log('    ramp.wav at 20 / 35 / 50 / 65 / 80 and put the knob in the filename.')
    return
  }
  const f = fitTaper(points, o1)
  console.log(`\n  shipping : max ${SC_DRIVE_MAX_DB}  span ${SC_DRIVE_SPAN_DB}  taper ${SC_TAPER}   rms ${Math.sqrt(points.reduce((a, [k, t1]) => a + (o1 - scDriveDbFor(k) - t1) ** 2, 0) / points.length).toFixed(3)} dB`)
  console.log(`  FITTED   : max ${f.mx.toFixed(2)}  span ${f.sp.toFixed(2)}  taper ${f.tp.toFixed(4)}   rms ${Math.sqrt(f.e).toFixed(3)} dB`)
  console.log('\n  knob   reference T1    fitted     error')
  for (const [k, t1] of points) {
    const mine = o1 - scDriveDbFor(k, f.mx, f.sp, f.tp)
    console.log(`  ${String(k).padStart(4)}   ${t1.toFixed(2).padStart(9)} dBFS  ${mine.toFixed(2).padStart(8)}   ${(mine - t1).toFixed(2).padStart(7)} dB`)
  }
}

const args = process.argv.slice(2)

if (args.includes('--stimulus')) {
  mkdirSync(STIM_DIR, { recursive: true })
  mkdirSync(CAP_DIR, { recursive: true })
  console.log(`Wrote stimulus to ${STIM_DIR}`)
  for (const [name, { plan }] of Object.entries(PLANS)) {
    const p = plan()
    writeFloatWav(path.join(STIM_DIR, `${name}.wav`), build(p).x)
    console.log(`  ${(name + '.wav').padEnd(16)} ${p.seconds.toFixed(1).padStart(6)} s`)
  }
  console.log('\n  ramp       the Peak Reduction taper — WHERE compression starts, per knob')
  console.log('  bursts     release memory — how the tail lengthens with exposure')
  console.log('  retrigger  ATTACK memory — the same step, varying how recently the cell was lit')
  console.log('  frequency  the same step at 100 / 200 / 400 / 1000 / 3000 Hz')
  console.log('  staircase  the static curve, hence the ratio')
  console.log('\nCapture protocol:')
  console.log('  1. 44.1 kHz, 32-bit float, mono, no dither, nothing else in the chain.')
  console.log('  2. Gain/makeup at 0. A fixed makeup cancels anyway — every reduction is')
  console.log('     measured against the resting gain just before its own step.')
  console.log('  3. R37 / side-chain trim at its FACTORY position, and note where that is.')
  console.log('     It changes the frequency response of the detector, which is half of')
  console.log('     what frequency.wav is measuring.')
  console.log('  4. Bounce the FULL length including the tail. Do not normalise.')
  console.log(`  5. Save into ${CAP_DIR} as <unit>.<knob>.<name>.wav`)
  console.log('     e.g. laea.55.retrigger.wav')
  console.log('\n  FOR THE TAPER: capture ramp.wav at FIVE knob positions and put the knob in')
  console.log('  the filename — lala.30.ramp.wav, lala.45.ramp.wav, and so on. 30 / 45 / 60 /')
  console.log('  75 / 90 is a good spread. Then: npm run la2a:ballistics -- --taper')
  console.log('  ⚠ BELOW ABOUT KNOB 30 THERE IS NOTHING TO MEASURE — the threshold sits above')
  console.log('    the ramp\'s top and the fit correctly refuses the point. Do not fill the')
  console.log('    low end with captures; spread across where the unit actually compresses.')
  console.log('\n  FOR EVERYTHING ELSE: one knob setting across the other four files is enough')
  console.log('  to answer the attack-memory and frequency questions.')
  process.exit(0)
}

if (args.includes('--taper')) {
  const p = rampPlan()
  const b = build(p)
  p.env = b.env
  if (args.includes('--selftest')) {
    // ⚠ THE FIT MUST RECOVER OUR OWN CONSTANTS FROM OUR OWN KERNEL BEFORE IT IS
    // POINTED AT A REFERENCE. If it cannot, an agreeable-looking set of numbers
    // from a real capture would mean nothing.
    const pts = [20, 35, 50, 65, 80, 95].map(k => {
      const c = rampCurve(runKernel(b.x, { peakReduction: k }), p, 0)
      if (!c || !Number.isFinite(c.t1)) { console.log(`  ⚠ knob ${k}: threshold outside the ramp's range; excluded`); return null }
      return [k, c.t1]
    }).filter(Boolean)
    reportTaper(pts, 'SELF-TEST, our own kernel (the fit should return the shipping constants)')
    process.exit(0)
  }
  const files = existsSync(CAP_DIR)
    ? readdirSync(CAP_DIR).filter(f => f.includes('.ramp.') && f.endsWith('.wav')) : []
  if (!files.length) {
    console.log(`No <unit>.<knob>.ramp.wav captures in ${CAP_DIR}.`)
    console.log('Run with --stimulus, render ramp.wav at several knob positions, and')
    console.log('put the knob in the filename — e.g. lala.35.ramp.wav.')
    process.exit(0)
  }
  const byUnit = new Map()
  for (const f of files.sort()) {
    const m = f.match(/^(.+?)\.(\d+(?:\.\d+)?)\.ramp\.wav$/)
    if (!m) { console.log(`⚠ ${f}: name it <unit>.<knob>.ramp.wav so the knob is recorded`); continue }
    const y = readWav(path.join(CAP_DIR, f))
    if (y.sampleRate !== SR) { console.log(`⚠ ${f}: ${y.sampleRate} Hz; capture at ${SR}.`); continue }
    const lag = alignByEnvelope(p.env, y.mono)
    const c = rampCurve(y.mono, p, lag, findGaps(y.mono, p))
    if (!c || !Number.isFinite(c.t1)) { console.log(`⚠ ${f}: no 1 dB crossing — knob too low, or the ramp never compresses`); continue }
    if (!byUnit.has(m[1])) byUnit.set(m[1], [])
    byUnit.get(m[1]).push([Number(m[2]), c.t1])
  }
  for (const [unit, pts] of byUnit) reportTaper(pts.sort((a, b) => a[0] - b[0]), unit)
  process.exit(0)
}

if (args.includes('--selftest')) {
  // ⚠ THE FITTER MUST RECOVER CONSTANTS WE ALREADY KNOW BEFORE IT IS POINTED AT
  // ANYTHING ELSE. Our ATTACK_S is 10 ms and FAST_FRACTION 0.65, so t63 should
  // land near 10 ms and fast% near 65. Two of these tables should come back
  // FLAT by construction, and that is the point: our attack does not vary with
  // light history or with frequency, so `retrigger` and `frequency` measuring
  // no spread on our own kernel is the control that proves any spread found in
  // a real capture belongs to the reference and not to the measurement.
  const pr = 55
  for (const [name, { plan, fit }] of Object.entries(PLANS)) {
    const p = plan()
    const b = build(p)
    p.env = b.env                       // the fitters divide by the known stimulus
    fit(runKernel(b.x, { peakReduction: pr }), p, 0, `our kernel, ${name}, Peak Reduction ${pr}`)
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
for (const f of caps.sort()) {
  const entry = Object.entries(PLANS).find(([name]) => f.includes(`.${name}.`))
  if (!entry) { console.log(`\n⚠ ${f}: name it <unit>.<knob>.<${Object.keys(PLANS).join('|')}>.wav`); continue }
  const [name, { plan, fit }] = entry
  const y = readWav(path.join(CAP_DIR, f))
  if (y.sampleRate !== SR) { console.log(`\n⚠ ${f}: ${y.sampleRate} Hz; capture at ${SR}.`); continue }
  const p = plan()
  p.env = build(p).env
  const lag = alignByEnvelope(p.env, y.mono)
  if (Math.abs(lag) > 2000) console.log(`\n⚠ ${f}: aligned at ${lag} samples (${(lag / 44.1).toFixed(1)} ms) — plugin latency, or a failed fit.`)
  fit(y.mono, p, lag, f)
}
