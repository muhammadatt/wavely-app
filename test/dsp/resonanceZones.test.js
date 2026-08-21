import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive } from 'vue'
import {
  DEFAULT_RESONANCE_ZONES,
  RESONANCE_ZONE_EDGE_OCTAVES,
  RESONANCE_ZONE_MAX,
  RESONANCE_ZONE_MIN_OCTAVES,
  RESONANCE_ZONE_SENS_MAX_DB,
  RESONANCE_DEFAULTS,
  buildResonanceZoneCurves,
  toKernelParams,
  zoneBounds,
  zoneSettings,
  zoneSettingsAt,
} from '../../src/audio/resonanceParams.js'
import {
  ResonanceKernel,
  RESONANCE_KERNEL_DEFAULTS,
  processResonanceBuffer,
} from '../../src/audio/resonanceProcessor.js'
import {
  boundaryAt,
  hzFromX,
  moveBoundary,
  removeBoundary,
  setDepth,
  setSensitivity,
  splitZone,
  toggleZone,
  xFromHz,
  zoneIndexAt,
} from '../../src/components/meters/resonanceZoneEdit.js'

/**
 * Sensitivity zones: the model, the curves it hands the kernel, and the edits
 * the plot makes to it.
 *
 * The whole point of testing the edits separately from the component is that
 * these are the parts that can be wrong without looking wrong — a frequency
 * mapping off by an octave, a boundary drag that lets two boundaries cross, a
 * crossfade that is a step. Drawing is not tested here; a canvas needs eyes.
 */

const SR = 44100
const BINS = 1025
const BW = SR / 2048

const axis = { w: 600, minHz: 20, maxHz: 20000 }

function zones(...specs) {
  return specs.map((s, i) => ({
    id: `z${i}`, hiHz: s.hiHz ?? 20000, sensitivityDb: s.sens ?? 0,
    depth: s.depth ?? 1, enabled: s.enabled ?? true,
  }))
}

// ── The model ───────────────────────────────────────────────────────────────

test('the shipping zones are neutral, so they cost the detector nothing', () => {
  assert.equal(
    buildResonanceZoneCurves(DEFAULT_RESONANCE_ZONES, BINS, BW, 40, 20000), null)
})

test('a zone set that changes nothing returns null however it says so', () => {
  assert.equal(buildResonanceZoneCurves([], BINS, BW, 40, 20000), null)
  assert.equal(buildResonanceZoneCurves(null, BINS, BW, 40, 20000), null)
  assert.equal(
    buildResonanceZoneCurves(zones({ hiHz: 500 }, {}), BINS, BW, 40, 20000), null)
})

test('bounds are contiguous and clamped to the processed band', () => {
  const b = zoneBounds(zones({ hiHz: 200 }, { hiHz: 2000 }, {}), 60, 8000)
  assert.deepEqual(b.map(z => [z.loHz, z.hiHz]), [[60, 200], [200, 2000], [2000, 8000]])
  // A boundary outside the band collapses rather than inverting.
  const tight = zoneBounds(zones({ hiHz: 200 }, { hiHz: 2000 }, {}), 60, 500)
  assert.ok(tight.every(z => z.hiHz >= z.loHz))
  assert.equal(tight[2].hiHz, 500)
})

test('a disabled zone reaches the kernel as depth zero, not as a special case', () => {
  const s = zoneSettings({ sensitivityDb: 9, depth: 1, enabled: false })
  assert.equal(s.depth, 0)
  assert.equal(s.sensitivityDb, 0)
  assert.equal(s.enabled, false)
})

test('settings are clamped to the parameter limits', () => {
  assert.equal(zoneSettings({ sensitivityDb: 99 }).sensitivityDb, RESONANCE_ZONE_SENS_MAX_DB)
  assert.equal(zoneSettings({ sensitivityDb: -99 }).sensitivityDb, -RESONANCE_ZONE_SENS_MAX_DB)
  assert.equal(zoneSettings({ depth: 5 }).depth, 1)
  assert.equal(zoneSettings({ depth: -1 }).depth, 0)
})

test('BOUNDARIES CROSSFADE, they do not step', () => {
  // A hard step means the bin below a split and the bin above it are judged by
  // different rules, so a resonance sitting across the line is half treated and
  // slides between the two regimes as the pitch moves — the same per-bin gain
  // movement the effect exists to avoid.
  const z = zones({ hiHz: 1000, sens: 12 }, { sens: 0 })
  const half = RESONANCE_ZONE_EDGE_OCTAVES / 2
  const below = zoneSettingsAt(z, 1000 * Math.pow(2, -half * 1.2), 20, 20000)
  const at = zoneSettingsAt(z, 1000, 20, 20000)
  const above = zoneSettingsAt(z, 1000 * Math.pow(2, half * 1.2), 20, 20000)
  assert.ok(Math.abs(below.sensitivityDb - 12) < 1e-9, `${below.sensitivityDb}`)
  assert.ok(Math.abs(at.sensitivityDb - 6) < 1e-6, `${at.sensitivityDb}`)
  assert.ok(Math.abs(above.sensitivityDb) < 1e-9, `${above.sensitivityDb}`)
  // Monotone through the crossfade, with no overshoot at either end.
  let prev = Infinity
  for (let i = 0; i <= 40; i++) {
    const hz = 1000 * Math.pow(2, -half + (2 * half * i) / 40)
    const v = zoneSettingsAt(z, hz, 20, 20000).sensitivityDb
    assert.ok(v <= prev + 1e-9 && v >= -1e-9 && v <= 12 + 1e-9)
    prev = v
  }
})

test('depth crossfades on the same edge as sensitivity', () => {
  const z = zones({ hiHz: 1000, depth: 0 }, { depth: 1 })
  assert.ok(Math.abs(zoneSettingsAt(z, 1000, 20, 20000).depth - 0.5) < 1e-6)
})

test('the curves carry both values onto the bin grid', () => {
  const z = zones({ hiHz: 1000, sens: 8, depth: 0.5 }, {})
  const c = buildResonanceZoneCurves(z, BINS, BW, 40, 20000)
  const at = hz => Math.round(hz / BW)
  assert.ok(Math.abs(c.weightDb[at(300)] - 8) < 1e-9)
  assert.ok(Math.abs(c.depthScale[at(300)] - 0.5) < 1e-9)
  assert.ok(Math.abs(c.weightDb[at(5000)]) < 1e-9)
  assert.ok(Math.abs(c.depthScale[at(5000)] - 1) < 1e-9)
  // Bin 0 is DC and would be log2(0); it copies its neighbour rather than NaN.
  assert.ok(Number.isFinite(c.weightDb[0]) && Number.isFinite(c.depthScale[0]))
})

// ── What the kernel does with them ──────────────────────────────────────────

function bandTone(freqHz, seconds = 0.6) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    // A tone on a noise bed: the tone is the resonance, the bed is what the
    // reference is built from. Deterministic noise so the test cannot flake.
    let r = 0
    for (let k = 1; k <= 6; k++) r += Math.sin((2 * Math.PI * 137 * k * i) / SR + k)
    x[i] = 0.3 * Math.sin((2 * Math.PI * freqHz * i) / SR) + 0.02 * r
  }
  return x
}

function rmsAt(sig, freqHz) {
  let re = 0
  let im = 0
  for (let i = 0; i < sig.length; i++) {
    const w = 2 * Math.PI * freqHz * i / SR
    re += sig[i] * Math.cos(w)
    im += sig[i] * Math.sin(w)
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / sig.length + 1e-12)
}

const UNPROTECTED = { preserveHarmonics: false, selectivity: 6, depth: 1 }

/**
 * Render and trim the STFT's latency.
 *
 * Not optional bookkeeping: the kernel holds back a full frame, so an untrimmed
 * render is the input delayed by 2048 samples and a fixed-length measurement
 * over it reads 0.7 dB low on a 0.6 s clip — which looks exactly like a small
 * amount of unwanted suppression. Cost me a wrong diagnosis of the zone code
 * once already.
 */
function render(x, params) {
  const out = processResonanceBuffer([x], SR, { ...RESONANCE_KERNEL_DEFAULTS, ...params })
  return out.channelData[0].subarray(2048)
}
/** The input over the same span the trimmed render covers. */
function aligned(x) {
  return x.subarray(0, x.length - 2048)
}

test('a zone with more sensitivity cuts what a neutral one leaves alone', () => {
  const x = bandTone(3000)
  const base = render(x, { ...UNPROTECTED, selectivity: 22 })
  const lifted = render(x, {
    ...UNPROTECTED, selectivity: 22, zones: zones({ hiHz: 2000 }, { sens: 12 }),
  })
  const before = rmsAt(base, 3000)
  const after = rmsAt(lifted, 3000)
  assert.ok(after < before - 1, `${after} vs ${before}`)
})

test('a zone at depth zero leaves its band alone while the rest is treated', () => {
  const x = bandTone(3000)
  const on = render(x, UNPROTECTED)
  const off = render(x, { ...UNPROTECTED, zones: zones({ hiHz: 2000 }, { enabled: false }) })
  assert.ok(rmsAt(on, 3000) < rmsAt(off, 3000) - 1)
  // And OFF means off. This is why zone depth is applied AFTER the spread
  // kernel: applied before, the spread reaches 96 bins either side and smeared
  // a neighbouring zone's reduction straight through the boundary, leaving
  // 0.68 dB of cut on a tone 1.6 octaves clear of the edge.
  const moved = rmsAt(off, 3000) - rmsAt(aligned(x), 3000)
  assert.ok(Math.abs(moved) < 0.1, `bypassed zone moved by ${moved.toFixed(2)} dB`)
})

test('neutral zones are BIT-IDENTICAL to no zones at all', () => {
  const x = bandTone(3000, 0.3)
  const a = render(x, UNPROTECTED)
  const b = render(x, { ...UNPROTECTED, zones: DEFAULT_RESONANCE_ZONES })
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i])
})

test('the kernel accepts a zone change on a live param push', () => {
  const kernel = new ResonanceKernel(SR, 1)
  for (const z of [DEFAULT_RESONANCE_ZONES, zones({ hiHz: 900, sens: 9 }, {}), []]) {
    kernel.setParams({ ...RESONANCE_KERNEL_DEFAULTS, zones: z })
  }
  assert.ok(true)
})

// ── Surviving the structured clone ──────────────────────────────────────────

test('ZONES ARE COPIED, NOT PASSED BY REFERENCE', () => {
  // The param object crosses a structured clone twice — postMessage on every
  // knob move, processorOptions on the offline render — and the panel holds
  // these in a Vue ref, which hands out a reactive Proxy. structuredClone
  // refuses a proxy outright, the throw lands on the first param push, and the
  // symptom is the whole display and the DELTA monitor going dark with nothing
  // on screen about zones. This has happened once; it must not happen twice.
  const live = reactive(zones({ hiHz: 900, sens: 9, depth: 0.4 }, {}))
  const mapped = toKernelParams({ ...RESONANCE_DEFAULTS, zones: live })
  const cloned = structuredClone(mapped)
  assert.deepEqual(cloned.zones, [
    { id: 'z0', hiHz: 900, sensitivityDb: 9, depth: 0.4, enabled: true },
    { id: 'z1', hiHz: 20000, sensitivityDb: 0, depth: 1, enabled: true },
  ])
  // The empty case every panel opens in is just as much a proxy.
  assert.deepEqual(
    structuredClone(toKernelParams({ ...RESONANCE_DEFAULTS, zones: reactive([]) })).zones, [])
})

// ── The plot's edits ────────────────────────────────────────────────────────

test('the axis is logarithmic and round-trips', () => {
  for (const hz of [20, 100, 440, 3000, 20000]) {
    assert.ok(Math.abs(hzFromX(xFromHz(hz, axis), axis) - hz) < hz * 1e-9)
  }
  const a = xFromHz(200, axis) - xFromHz(20, axis)
  const b = xFromHz(2000, axis) - xFromHz(200, axis)
  assert.ok(Math.abs(a - b) < 0.01, `${a} vs ${b}`)
})

test('boundaries are grabbable, and the band limits are not boundaries', () => {
  const z = zones({ hiHz: 200 }, { hiHz: 2000 }, {})
  assert.equal(boundaryAt(z, xFromHz(200, axis), axis), 0)
  assert.equal(boundaryAt(z, xFromHz(2000, axis), axis), 1)
  assert.equal(boundaryAt(z, xFromHz(700, axis), axis), -1)
  // The last zone's hiHz is not a boundary — it is the top of the band, which
  // has its own control. Grabbing it here would give one parameter two editors.
  assert.equal(boundaryAt(z, xFromHz(20000, axis), axis), -1)
})

test('zoneIndexAt finds the zone a column is in', () => {
  const z = zones({ hiHz: 200 }, { hiHz: 2000 }, {})
  assert.equal(zoneIndexAt(z, xFromHz(100, axis), axis, 40, 20000), 0)
  assert.equal(zoneIndexAt(z, xFromHz(900, axis), axis, 40, 20000), 1)
  assert.equal(zoneIndexAt(z, xFromHz(9000, axis), axis, 40, 20000), 2)
})

test('A BOUNDARY STOPS AT ITS NEIGHBOURS AND CANNOT CROSS THEM', () => {
  const z = zones({ hiHz: 200 }, { hiHz: 2000 }, {})
  const gap = Math.pow(2, RESONANCE_ZONE_MIN_OCTAVES)
  const pushed = moveBoundary(z, 0, 19000, 40, 20000)
  assert.ok(pushed[0].hiHz < pushed[1].hiHz)
  assert.ok(Math.abs(pushed[0].hiHz - 2000 / gap) < 1)
  const pulled = moveBoundary(z, 1, 10, 40, 20000)
  assert.ok(pulled[1].hiHz > pulled[0].hiHz)
  assert.ok(Math.abs(pulled[1].hiHz - 200 * gap) < 1)
  // Zones stay ordered whatever the drag asks for.
  for (const target of [1, 50, 500, 5000, 50000]) {
    const next = moveBoundary(z, 0, target, 40, 20000)
    assert.ok(next[0].hiHz < next[1].hiHz, `${target}`)
  }
})

test('a split inherits the settings of the zone it divides', () => {
  const z = zones({ hiHz: 200, sens: 7, depth: 0.4 }, {})
  const next = splitZone(z, 100, axis, 'new', 40, 20000)
  assert.equal(next.length, 3)
  assert.equal(next[0].sensitivityDb, 7)
  assert.equal(next[0].depth, 0.4)
  assert.equal(next[1].sensitivityDb, 7)
  assert.ok(next[0].hiHz < next[1].hiHz)
})

test('the zone ceiling returns the list unchanged, by identity', () => {
  let z = zones({ hiHz: 100 }, {})
  for (let i = 0; i < 20; i++) {
    z = splitZone(z, 3000 + i * 900, axis, `s${i}`, 40, 20000)
  }
  assert.equal(z.length, RESONANCE_ZONE_MAX)
  assert.equal(splitZone(z, 6000, axis, 'x', 40, 20000), z)
})

test('a split with no room to land changes nothing', () => {
  const z = zones({ hiHz: 200 }, { hiHz: 210 }, {})
  assert.equal(splitZone(z, 205, axis, 'x', 40, 20000), z)
})

test('merging drops the boundary and keeps the upper zone', () => {
  const z = zones({ hiHz: 200, sens: 3 }, { hiHz: 2000, sens: 6 }, { sens: 9 })
  const merged = removeBoundary(z, 0)
  assert.equal(merged.length, 2)
  assert.equal(merged[0].sensitivityDb, 6)
  assert.deepEqual(zoneBounds(merged, 40, 20000)[0], { loHz: 40, hiHz: 2000 })
  // The last zone cannot be merged away.
  const one = zones({})
  assert.equal(removeBoundary(one, 0), one)
})

test('edits never mutate the array or the zones in it', () => {
  const before = zones({ hiHz: 200 }, {})
  const snapshot = JSON.parse(JSON.stringify(before))
  setSensitivity(before, 0, 5)
  setDepth(before, 1, 0.2)
  toggleZone(before, 0)
  moveBoundary(before, 0, 500, 40, 20000)
  splitZone(before, 100, axis, 'x', 40, 20000)
  removeBoundary(before, 0)
  assert.deepEqual(before, snapshot)
})

test('every edit stays inside the parameter limits', () => {
  let z = zones({ hiHz: 200 }, {})
  z = setSensitivity(z, 0, 999)
  assert.equal(z[0].sensitivityDb, RESONANCE_ZONE_SENS_MAX_DB)
  z = setSensitivity(z, 0, -999)
  assert.equal(z[0].sensitivityDb, -RESONANCE_ZONE_SENS_MAX_DB)
  z = setDepth(z, 0, 9)
  assert.equal(z[0].depth, 1)
  z = setDepth(z, 0, -9)
  assert.equal(z[0].depth, 0)
})

test('toggling a zone flips only that zone', () => {
  const z = toggleZone(zones({ hiHz: 200 }, {}), 0)
  assert.equal(z[0].enabled, false)
  assert.equal(z[1].enabled, true)
  assert.equal(toggleZone(z, 0)[0].enabled, true)
})
