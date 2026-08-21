import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive } from 'vue'
import {
  DEFAULT_RESONANCE_ZONES,
  RESONANCE_ZONE_EDGE_OCTAVES,
  RESONANCE_ZONE_MAX,
  RESONANCE_ZONE_MIN_OCTAVES,
  RESONANCE_ZONE_RANGES,
  RESONANCE_ZONE_STOCK,
  RESONANCE_DEFAULTS,
  buildResonanceZoneCurves,
  toKernelParams,
  uniformZones,
  zoneBounds,
  zoneSettings,
  zoneSettingsAt,
  zoneWeightsAt,
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
  setZoneCount,
  setZoneParam,
  splitZone,
  toggleZone,
  xFromHz,
  zoneIndexAt,
} from '../../src/components/meters/resonanceZoneEdit.js'

/**
 * Sensitivity zones: the model, the curves it hands the kernel, and the edits
 * the plot makes to it.
 *
 * Every zone carries its own depth, sharpness and selectivity — absolute
 * values, with no global setting for them to be offsets from. The parts worth
 * testing separately from the component are the ones that can be wrong without
 * looking wrong: an axis mapping off by an octave, a boundary drag that lets
 * two boundaries cross, a crossfade that is really a step, and the promise that
 * a patch nobody has zoned sounds exactly as it did before zones existed.
 */

const SR = 44100
const BINS = 1025
const BW = SR / 2048
const axis = { w: 600, minHz: 20, maxHz: 20000 }

function zones(...specs) {
  // protect defaults OFF here: these tests are about what the detector does,
  // and the harmonic mask blocks 67-77% of every octave, which would swamp any
  // measurement of a zone setting.
  return specs.map((s, i) => ({
    id: `z${i}`, hiHz: s.hiHz ?? 20000, ...RESONANCE_ZONE_STOCK, protect: false, ...s,
  }))
}

// ── The model ───────────────────────────────────────────────────────────────

test('the shipping zones all carry the stock settings', () => {
  for (const z of DEFAULT_RESONANCE_ZONES) {
    const s = zoneSettings(z)
    assert.equal(s.depth, RESONANCE_ZONE_STOCK.depth)
    assert.equal(s.sharpness, RESONANCE_ZONE_STOCK.sharpness)
    assert.equal(s.selectivity, RESONANCE_ZONE_STOCK.selectivity)
  }
  // One envelope group, so the kernel assigns rather than blends.
  const c = buildResonanceZoneCurves(DEFAULT_RESONANCE_ZONES, BINS, BW)
  assert.equal(c.uniform, true)
  assert.equal(c.groups.length, 1)
})

test('bounds are contiguous and cover the band', () => {
  const b = zoneBounds(zones({ hiHz: 200 }, { hiHz: 2000 }, {}), 20, 20000)
  assert.deepEqual(b.map(z => [z.loHz, z.hiHz]), [[20, 200], [200, 2000], [2000, 20000]])
})

test('a disabled zone reaches the kernel as depth zero, not as a special case', () => {
  const s = zoneSettings({ depth: 1, selectivity: 5, enabled: false })
  assert.equal(s.depth, 0)
  assert.equal(s.enabled, false)
  // Its other settings are still reported, so switching it back on restores
  // what was set rather than a default.
  assert.equal(s.selectivity, 5)
})

test('settings are clamped to the parameter ranges', () => {
  const R = RESONANCE_ZONE_RANGES
  assert.equal(zoneSettings({ selectivity: 99 }).selectivity, R.selectivity.max)
  assert.equal(zoneSettings({ selectivity: 0 }).selectivity, R.selectivity.min)
  assert.equal(zoneSettings({ depth: 5 }).depth, 1)
  assert.equal(zoneSettings({ sharpness: -1 }).sharpness, 0)
})

test('BOUNDARIES CROSSFADE, they do not step', () => {
  // A hard step means the bin below a split and the bin above it are judged by
  // different rules, so a resonance sitting across the line is half treated and
  // slides between the two regimes as the pitch moves — the same per-bin gain
  // movement the effect exists to avoid.
  const z = zones({ hiHz: 1000, selectivity: 20 }, { selectivity: 4 })
  const half = RESONANCE_ZONE_EDGE_OCTAVES / 2
  assert.ok(Math.abs(zoneSettingsAt(z, 1000 * Math.pow(2, -half * 1.2)).selectivity - 20) < 1e-9)
  assert.ok(Math.abs(zoneSettingsAt(z, 1000).selectivity - 12) < 1e-6)
  assert.ok(Math.abs(zoneSettingsAt(z, 1000 * Math.pow(2, half * 1.2)).selectivity - 4) < 1e-9)

  let prev = Infinity
  for (let i = 0; i <= 40; i++) {
    const hz = 1000 * Math.pow(2, -half + (2 * half * i) / 40)
    const v = zoneSettingsAt(z, hz).selectivity
    assert.ok(v <= prev + 1e-9 && v >= 4 - 1e-9 && v <= 20 + 1e-9)
    prev = v
  }
})

test('the weights always sum to one, which is what lets anything be blended', () => {
  const z = zones({ hiHz: 180 }, { hiHz: 1100 }, { hiHz: 5000 }, {})
  for (const hz of [25, 179, 180, 181, 1100, 1200, 4990, 5000, 5010, 19000]) {
    const w = zoneWeightsAt(z, hz)
    const sum = w.reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-12, `${hz} Hz summed to ${sum}`)
  }
})

test('the curves carry all three settings onto the bin grid', () => {
  const z = zones(
    { hiHz: 1000, depth: 0.5, sharpness: 0.2, selectivity: 20 },
    { depth: 1, sharpness: 0.9, selectivity: 5 },
  )
  const c = buildResonanceZoneCurves(z, BINS, BW)
  const at = hz => Math.round(hz / BW)
  assert.ok(Math.abs(c.depth[at(300)] - 0.5) < 1e-9)
  assert.ok(Math.abs(c.sharpness[at(300)] - 0.2) < 1e-9)
  assert.ok(Math.abs(c.selectivity[at(300)] - 20) < 1e-9)
  assert.ok(Math.abs(c.selectivity[at(5000)] - 5) < 1e-9)
  // Two distinct sharpness values, so two reference envelopes.
  assert.equal(c.groups.length, 2)
  assert.equal(c.uniform, false)
  // Bin 0 is DC and would be log2(0); it copies its neighbour rather than NaN.
  assert.ok(Number.isFinite(c.depth[0]) && Number.isFinite(c.selectivity[0]))
})

test('zones sharing a sharpness share an envelope', () => {
  // The cost of a zone set is the number of DISTINCT sharpness values, not the
  // number of zones: each one is an extra inverse transform per frame.
  const z = zones(
    { hiHz: 500, sharpness: 0.8, selectivity: 6 },
    { hiHz: 5000, sharpness: 0.3, selectivity: 12 },
    { sharpness: 0.8, selectivity: 20 },
  )
  assert.equal(buildResonanceZoneCurves(z, BINS, BW).groups.length, 2)
})

// ── What the kernel does with them ──────────────────────────────────────────

function bandTone(freqHz, seconds = 0.6) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
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

/**
 * Render and trim the STFT's latency.
 *
 * Not optional bookkeeping: the kernel holds back a full frame, so an untrimmed
 * render is the input delayed by 2048 samples and a fixed-length measurement
 * over it reads 0.7 dB low on a 0.6 s clip — which looks exactly like a small
 * amount of unwanted suppression. Cost a wrong diagnosis once already.
 */
function render(x, params) {
  const out = processResonanceBuffer([x], SR, { ...RESONANCE_KERNEL_DEFAULTS, ...params })
  return out.channelData[0].subarray(2048)
}
function aligned(x) {
  return x.subarray(0, x.length - 2048)
}

const UNPROTECTED = {}

test('a zone with a lower threshold cuts what a higher one leaves alone', () => {
  const x = bandTone(3000)
  const quiet = render(x, { ...UNPROTECTED, zones: uniformZones({ selectivity: 24, depth: 1, protect: false }) })
  const keen = render(x, {
    ...UNPROTECTED,
    zones: zones({ hiHz: 2000, selectivity: 24, depth: 1 }, { selectivity: 4, depth: 1 }),
  })
  assert.ok(rmsAt(keen, 3000) < rmsAt(quiet, 3000) - 1)
})

test('A ZONE SWITCHED OFF IS EXACTLY OFF, even beside one working hard', () => {
  // This is why depth is applied AFTER the spread kernel rather than in the
  // detection loop: the spread reaches 96 bins either side, so scaling first
  // let a neighbouring zone's reduction smear straight through the boundary and
  // left 0.68 dB of cut on a tone 1.6 octaves clear of the edge.
  const x = bandTone(3000)
  const on = render(x, { ...UNPROTECTED, zones: uniformZones({ selectivity: 6, depth: 1, protect: false }) })
  const off = render(x, {
    ...UNPROTECTED,
    zones: zones({ hiHz: 2000, selectivity: 6, depth: 1 }, { selectivity: 6, enabled: false }),
  })
  assert.ok(rmsAt(on, 3000) < rmsAt(off, 3000) - 1)
  const moved = rmsAt(off, 3000) - rmsAt(aligned(x), 3000)
  assert.ok(Math.abs(moved) < 0.1, `bypassed zone moved by ${moved.toFixed(2)} dB`)
})

test('per-zone depth scales the cut in its own band only', () => {
  const x = bandTone(3000)
  const full = render(x, { ...UNPROTECTED, zones: uniformZones({ selectivity: 6, depth: 1, protect: false }) })
  const half = render(x, {
    ...UNPROTECTED,
    zones: zones({ hiHz: 2000, selectivity: 6, depth: 1 }, { selectivity: 6, depth: 0.4 }),
  })
  const dry = rmsAt(aligned(x), 3000)
  const deep = dry - rmsAt(full, 3000)
  const shallow = dry - rmsAt(half, 3000)
  assert.ok(shallow > 0.5 && shallow < deep - 1, `${shallow.toFixed(2)} vs ${deep.toFixed(2)}`)
})

test('per-zone Max Cut bounds its own band and nothing else', () => {
  const x = bandTone(3000)
  const dry = rmsAt(aligned(x), 3000)
  const open = render(x, { zones: zones({ selectivity: 4, depth: 1, maxCut: 48 }) })
  const capped = render(x, {
    zones: zones(
      { hiHz: 2000, selectivity: 4, depth: 1, maxCut: 48 },
      { selectivity: 4, depth: 1, maxCut: 3 },
    ),
  })
  const deep = dry - rmsAt(open, 3000)
  const shallow = dry - rmsAt(capped, 3000)
  assert.ok(deep > 6, `uncapped removed only ${deep.toFixed(1)} dB`)
  // The ceiling is on the finished reduction, so a 3 dB cap really does mean
  // three-ish decibels — allow for the spread kernel's shoulders.
  assert.ok(shallow > 0.5 && shallow < 5, `capped removed ${shallow.toFixed(1)} dB`)
})

test('HARMONIC PROTECTION IS PER ZONE', () => {
  // The argument for making it per zone, measured: the mask blocks 67-77% of
  // EVERY octave at a typical F0 and 88% above 10 kHz at a high one, so where
  // partials are wide and dominant it is real protection and where sibilance
  // lives it is a blanket veto. Protecting the bottom while working freely up
  // top is the setting this effect most wants, and it was unreachable.
  const kernel = new ResonanceKernel(SR)
  const split = zones(
    { hiHz: 1000, protect: true },
    { protect: false },
  )
  kernel.setParams({ ...RESONANCE_KERNEL_DEFAULTS, zones: split })
  const bin = hz => Math.round(hz / (SR / 2048))
  assert.equal(kernel.zoneProtect[bin(300)], 1, 'the low zone protects')
  assert.equal(kernel.zoneProtect[bin(6000)], 0, 'the high zone does not')
  // Crossfaded at the boundary, like every other zone setting: a partial
  // sitting on the line must not be half masked by a step.
  const edge = kernel.zoneProtect[bin(1000)]
  assert.ok(edge > 0.2 && edge < 0.8, `boundary weight ${edge}`)
  assert.equal(kernel.anyProtect, true)

  // The mask is not built at all when nothing asks for it.
  kernel.setParams({ ...RESONANCE_KERNEL_DEFAULTS, zones: uniformZones({ protect: false }) })
  assert.equal(kernel.anyProtect, false)
})

test('protection actually holds the cut off harmonics in its own zone only', () => {
  // A pitched tone at 3 kHz that IS a harmonic of the source: protected in one
  // configuration, exposed in the other, with the only difference being which
  // zone it falls in.
  const f0 = 150
  const n = Math.round(SR * 0.7)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = 0
    for (let h = 1; h <= 40; h++) v += Math.sin((2 * Math.PI * f0 * h * i) / SR + h) / h
    // A resonance sitting exactly on the 20th harmonic.
    v += 2.2 * Math.sin((2 * Math.PI * f0 * 20 * i) / SR)
    x[i] = 0.12 * v
  }
  const dry = rmsAt(aligned(x), f0 * 20)
  const protectedRun = render(x, { zones: zones({ selectivity: 5, depth: 1, protect: true }) })
  const exposed = render(x, { zones: zones({ selectivity: 5, depth: 1, protect: false }) })
  const heldBack = dry - rmsAt(protectedRun, f0 * 20)
  const cut = dry - rmsAt(exposed, f0 * 20)
  assert.ok(cut > heldBack + 2,
    `protection made no difference: ${heldBack.toFixed(1)} vs ${cut.toFixed(1)} dB`)
})

test('the default zone set is BIT-IDENTICAL to one zone carrying the same settings', () => {
  // The guarantee that makes zones safe to ship: four zones all still on the
  // stock settings must be the same audio as the single global setting they
  // replaced, not merely close. Blending N identical envelopes by weights that
  // sum to 1 differs in the last bits, so the kernel takes an assignment path
  // when there is one envelope group.
  const x = bandTone(3000, 0.3)
  const a = render(x, { zones: uniformZones({ protect: false }) })
  const b = render(x, { zones: DEFAULT_RESONANCE_ZONES.map(z => ({ ...z, protect: false })) })
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], `sample ${i}`)
})

test('mixed sharpness runs, and stays bounded', () => {
  const x = bandTone(3000, 0.3)
  const out = render(x, {
    ...UNPROTECTED,
    zones: zones(
      { hiHz: 300, sharpness: 0, selectivity: 6 },
      { hiHz: 2000, sharpness: 0.5, selectivity: 10 },
      { sharpness: 1, selectivity: 4 },
    ),
  })
  let peak = 0
  for (const v of out) {
    assert.ok(Number.isFinite(v))
    peak = Math.max(peak, Math.abs(v))
  }
  assert.ok(peak > 0.05 && peak < 1.5, `peak ${peak}`)
})

test('the kernel accepts any zone set on a live param push', () => {
  const kernel = new ResonanceKernel(SR, 1)
  const sets = [
    DEFAULT_RESONANCE_ZONES,
    uniformZones({ protect: false }),
    zones({ hiHz: 900, sharpness: 0.1 }, { sharpness: 0.9 }),
    zones({ enabled: false }),
  ]
  for (const z of sets) kernel.setParams({ ...RESONANCE_KERNEL_DEFAULTS, zones: z })
  assert.equal(kernel.envGroups.length >= 1, true)
})

// ── Surviving the structured clone ──────────────────────────────────────────

test('ZONES ARE COPIED, NOT PASSED BY REFERENCE', () => {
  // The param object crosses a structured clone twice — postMessage on every
  // knob move, processorOptions on the offline render — and the panel holds
  // these in a Vue ref, which hands out a reactive Proxy. structuredClone
  // refuses a proxy outright, the throw lands on the first param push, and the
  // symptom is the whole display and the DELTA monitor going dark with nothing
  // on screen about zones. This has happened once; it must not happen twice.
  const live = reactive(zones({ hiHz: 900, depth: 0.4, sharpness: 0.2, selectivity: 15 }, {}))
  const cloned = structuredClone(toKernelParams({ ...RESONANCE_DEFAULTS, zones: live }))
  assert.equal(cloned.zones.length, 2)
  assert.equal(cloned.zones[0].selectivity, 15)
  assert.equal(cloned.zones[0].sharpness, 0.2)
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

test('dividers are grabbable, and the ends of the band are not dividers', () => {
  const z = zones({ hiHz: 200 }, { hiHz: 2000 }, {})
  assert.equal(boundaryAt(z, xFromHz(200, axis), axis), 0)
  assert.equal(boundaryAt(z, xFromHz(2000, axis), axis), 1)
  assert.equal(boundaryAt(z, xFromHz(700, axis), axis), -1)
  assert.equal(boundaryAt(z, xFromHz(20000, axis), axis), -1)
})

test('zoneIndexAt finds the zone a column is in', () => {
  const z = zones({ hiHz: 200 }, { hiHz: 2000 }, {})
  assert.equal(zoneIndexAt(z, xFromHz(100, axis), axis, 20, 20000), 0)
  assert.equal(zoneIndexAt(z, xFromHz(900, axis), axis, 20, 20000), 1)
  assert.equal(zoneIndexAt(z, xFromHz(9000, axis), axis, 20, 20000), 2)
})

test('A DIVIDER STOPS AT ITS NEIGHBOURS AND CANNOT CROSS THEM', () => {
  const z = zones({ hiHz: 200 }, { hiHz: 2000 }, {})
  const gap = Math.pow(2, RESONANCE_ZONE_MIN_OCTAVES)
  const pushed = moveBoundary(z, 0, 19000, 20, 20000)
  assert.ok(pushed[0].hiHz < pushed[1].hiHz)
  assert.ok(Math.abs(pushed[0].hiHz - 2000 / gap) < 1)
  const pulled = moveBoundary(z, 1, 10, 20, 20000)
  assert.ok(pulled[1].hiHz > pulled[0].hiHz)
  for (const target of [1, 50, 500, 5000, 50000]) {
    assert.ok(moveBoundary(z, 0, target, 20, 20000)[0].hiHz < z[1].hiHz, `${target}`)
  }
})

test('a split inherits the settings of the zone it divides', () => {
  const z = zones({ hiHz: 200, selectivity: 17, depth: 0.4, sharpness: 0.3 }, {})
  const next = splitZone(z, 100, axis, 'new', 20, 20000)
  assert.equal(next.length, 3)
  assert.equal(next[0].selectivity, 17)
  assert.equal(next[0].sharpness, 0.3)
  assert.equal(next[1].depth, 0.4)
  assert.ok(next[0].hiHz < next[1].hiHz)
})

test('the zone ceiling returns the list unchanged, by identity', () => {
  let z = zones({ hiHz: 100 }, {})
  for (let i = 0; i < 20; i++) z = splitZone(z, 3000 + i * 900, axis, `s${i}`, 20, 20000)
  assert.equal(z.length, RESONANCE_ZONE_MAX)
  assert.equal(splitZone(z, 6000, axis, 'x', 20, 20000), z)
})

test('setting the count grows and shrinks to exactly that many', () => {
  let z = DEFAULT_RESONANCE_ZONES
  for (const n of [6, 2, 5, 1, 4]) {
    z = setZoneCount(z, n, axis, 20, 20000, i => `n${i}${Math.random()}`)
    assert.equal(z.length, n, `asked for ${n}`)
    // Still ordered, whatever route it took.
    for (let i = 1; i < z.length - 1; i++) assert.ok(z[i].hiHz > z[i - 1].hiHz)
  }
  // Out of range is clamped, not obeyed.
  assert.equal(setZoneCount(z, 99, axis, 20, 20000, () => 'x').length, RESONANCE_ZONE_MAX)
  assert.equal(setZoneCount(z, 0, axis, 20, 20000, () => 'x').length, 1)
})

test('merging drops the divider and keeps the upper zone', () => {
  const z = zones({ hiHz: 200, selectivity: 3 }, { hiHz: 2000, selectivity: 6 }, { selectivity: 9 })
  const merged = removeBoundary(z, 0)
  assert.equal(merged.length, 2)
  assert.equal(merged[0].selectivity, 6)
  assert.deepEqual(zoneBounds(merged, 20, 20000)[0], { loHz: 20, hiHz: 2000 })
  const one = zones({})
  assert.equal(removeBoundary(one, 0), one)
})

test('edits never mutate the array or the zones in it', () => {
  const before = zones({ hiHz: 200 }, {})
  const snapshot = JSON.parse(JSON.stringify(before))
  setZoneParam(before, 0, 'depth', 0.5)
  toggleZone(before, 0)
  moveBoundary(before, 0, 500, 20, 20000)
  splitZone(before, 100, axis, 'x', 20, 20000)
  removeBoundary(before, 0)
  setZoneCount(before, 5, axis, 20, 20000, () => 'y')
  assert.deepEqual(before, snapshot)
})

test('every edit stays inside the parameter ranges', () => {
  const R = RESONANCE_ZONE_RANGES
  let z = zones({ hiHz: 200 }, {})
  z = setZoneParam(z, 0, 'selectivity', 999)
  assert.equal(z[0].selectivity, R.selectivity.max)
  z = setZoneParam(z, 0, 'selectivity', -999)
  assert.equal(z[0].selectivity, R.selectivity.min)
  z = setZoneParam(z, 0, 'depth', 9)
  assert.equal(z[0].depth, 1)
  z = setZoneParam(z, 0, 'sharpness', -9)
  assert.equal(z[0].sharpness, 0)
  // An unknown name is a no-op rather than a silently added key.
  assert.equal(setZoneParam(z, 0, 'nonsense', 1), z)
})

test('toggling a zone flips only that zone', () => {
  const z = toggleZone(zones({ hiHz: 200 }, {}), 0)
  assert.equal(z[0].enabled, false)
  assert.equal(z[1].enabled, true)
  assert.equal(toggleZone(z, 0)[0].enabled, true)
})
