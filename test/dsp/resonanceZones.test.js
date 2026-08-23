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
  zonePeakReductions,
} from '../../src/components/meters/resonanceZoneEdit.js'
import { peaking, BiquadCascade } from '../../src/audio/dsp/biquad.js'

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

/**
 * A pitched voice and a planted resonance, for the threshold-range test.
 *
 * Copied rather than imported: `resonance.test.js` is a test file, not a
 * fixture module, and a shared helper that two suites tune independently is how
 * a probe ends up measuring something neither of them meant.
 */
function voice({ seconds = 1.5, f0 = 150, jitterHz = 3, amp = 0.2, noiseDb = -45 } = {}) {
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const noiseAmp = Math.pow(10, noiseDb / 20)
  let phase = 0
  let s = 4242
  for (let i = 0; i < n; i++) {
    const pitch = f0 + jitterHz * Math.sin(2 * Math.PI * 2.7 * (i / SR))
    phase += (2 * Math.PI * pitch) / SR
    let v = 0
    for (let k = 1; k <= 30; k++) {
      if (pitch * k >= SR / 2) break
      v += (amp / k) * Math.sin(k * phase + k * 0.9)
    }
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = v + noiseAmp * (s / 0x3fffffff - 1)
  }
  return out
}

function resonate(sig, freqHz, q, gainDb) {
  const cascade = new BiquadCascade(1, 1)
  cascade.setSections([peaking(SR, freqHz, q, gainDb)])
  const out = new Float32Array(sig.length)
  cascade.process(sig, out, sig.length, 0)
  return out
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

test('the top of the selectivity range leaves a real resonance alone', () => {
  // WHY THE MAXIMUM MOVED 24 → 36, and why this test cannot prove it.
  //
  // Selectivity runs backwards — it is a threshold, so higher means less clears
  // it and less is cut. The range was inherited from the CEPSTRAL reference,
  // whose stock was 8 and for which 24 was a genuine ceiling. Under the peak
  // reference that now ships, 24 still removed 1.30 dB of mean and 3.60 dB of
  // p90 cut on 46 s of real narration, so winding a zone fully gentle left
  // audible suppression in place and the only way to stop a band being treated
  // was to switch the zone off entirely. Measured there, the cut reaches 0.05 dB
  // at 34 and 0.00 at 40; 36 is the shipped top with margin for material more
  // resonant than one clip.
  //
  // ⚠ NO SYNTHETIC SIGNAL IN THIS SUITE REPRODUCES THAT RESIDUAL, so the half of
  // the property that motivated the change is guarded by the real-audio sweep
  // (`npm run reso:real`) and not by this test. Three probes were tried and all
  // three say the effect is already idle at 24: a pure tone (cut 27 dB at ANY
  // top — a sine sits ~35 dB above its own peak envelope whatever its level,
  // because the reference scales with it), a planted peaking resonance up to
  // +30 dB at Q=20 (untouched at 24, because the peak envelope is drawn THROUGH
  // a boost that wide), and a voice with its noise floor raised to −20 dB
  // (untouched at 18, where the real clip loses 4.3 dB). Real narration's
  // residual comes from narrow, moving spectral structure none of these have.
  // Eleventh time synthetic material has been too clean to answer the question
  // asked of it.
  //
  // What this DOES guard is the direction of the fix: the new top must be a
  // genuine no-op on material the effect is pointed at. If a future change makes
  // the maximum start cutting again, this fails.
  const x = resonate(voice({ seconds: 1.5, f0: 150 }), 900, 6, 10)
  const top = RESONANCE_ZONE_RANGES.selectivity.max
  const wet = render(x, { zones: uniformZones({ selectivity: top, depth: 1, protect: false }) })
  const moved = rmsAt(wet, 900) - rmsAt(aligned(x), 900)
  assert.ok(
    Math.abs(moved) < 0.3,
    `at selectivity ${top} a +10 dB Q=6 resonance should pass untouched, moved ${moved.toFixed(2)} dB`,
  )
})

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
  // Selectivity high enough that the raw reduction stays under Max Cut. Depth
  // is applied before the ceiling, so a saturated cut is saturated at both
  // depths and the test would measure the clip rather than the control — which
  // is exactly what happened when the shipping reference moved to the peak
  // envelope and the same settings started removing 36 dB of this tone.
  const x = bandTone(3000)
  const SEL = 22
  const full = render(x, {
    ...UNPROTECTED, zones: uniformZones({ selectivity: SEL, depth: 1, protect: false }),
  })
  const half = render(x, {
    ...UNPROTECTED,
    zones: zones({ hiHz: 2000, selectivity: SEL, depth: 1 }, { selectivity: SEL, depth: 0.4 }),
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

// ── Per-zone readouts ───────────────────────────────────────────────────────
//
// The plot prints each zone's deepest cut at the top of its own column, and the
// readout line scopes to the selected zone. What can be wrong here is invisible
// on screen: a number attributed to the wrong column looks exactly like a
// number attributed to the right one.

/** A log-grid reduction curve with a single spike at `hz`. */
function spikeAt(hz, db, bins = 192, minHz = 20, maxHz = 20000) {
  const r = new Float32Array(bins)
  const d = Math.round((Math.log2(hz / minHz) / Math.log2(maxHz / minHz)) * (bins - 1))
  r[d] = db
  return r
}

test('a cut is reported by the zone it falls in, and by no other', () => {
  const z = zones({ hiHz: 500 }, { hiHz: 4000 }, {})
  const peaks = zonePeakReductions(z, spikeAt(1000, 7), 192, 20, 20000)
  assert.deepEqual(peaks.map(v => Math.round(v)), [0, 7, 0])
})

test('the readout is the DEEPEST cut in a zone, not its average', () => {
  // The average over a zone is dominated by the bins the effect is correctly
  // leaving alone, so it reads near zero whatever is happening in the band.
  const r = spikeAt(1000, 9)
  const peaks = zonePeakReductions(zones({}), r, 192, 20, 20000)
  assert.equal(Math.round(peaks[0]), 9)
})

test('A SILENT ZONE READS null, NOT ZERO', () => {
  // Zero is a measurement. A bypassed band printing `-0.0` says the effect
  // looked and found nothing, where the truth is that it never looked.
  const z = zones({ hiHz: 500, enabled: false }, {})
  const peaks = zonePeakReductions(z, spikeAt(200, 5), 192, 20, 20000)
  assert.equal(peaks[0], null)

  // Solo is the same statement about every zone but one, and it must not be
  // read out of the stored settings — an unsoloed zone is still `enabled`.
  const soloed = zonePeakReductions(zones({ hiHz: 500 }, {}), spikeAt(200, 5), 192, 20, 20000, 1)
  assert.equal(soloed[0], null)
  assert.equal(Math.round(soloed[1]), 0)
})

test('a zone narrower than one display cell still reads the cell it is in', () => {
  // Rounding outward. Rounding to nearest lets a narrow zone map to an empty
  // range and report nothing, which on screen is a zone that looks idle while
  // it is working.
  const z = zones({ hiHz: 1000 }, { hiHz: 1020 }, {})
  const peaks = zonePeakReductions(z, spikeAt(1010, 6), 192, 20, 20000)
  assert.ok(peaks[1] > 0, 'the narrow middle zone should report the cut inside it')
})
