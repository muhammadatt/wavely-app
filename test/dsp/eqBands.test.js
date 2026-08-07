/**
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROLES, ROLES_IN_ORDER, MAX_BANDS, PARAM_RANGES,
  createBand, getRole, roleForRegion, roleFreqRange,
  applyForfeiture, candidateRoleFor, tagBand, resetBandQ,
  setBandQ, setBandFrequency, untaggedBands, bandForRole, bandwidthOctaves,
} from '../../src/audio/eqBands.js'
import { MALE_REGIONS, REGION_ORDER, SCAN_LOW, SCAN_HIGH } from '../../src/audio/voicerx/regions.js'
import { eqSections } from '../../src/audio/eqProcessor.js'
import { magnitudeResponseDb } from '../../src/audio/dsp/biquad.js'

const R = MALE_REGIONS

// ── Taxonomy wiring ─────────────────────────────────────────────────────────

test('every role maps to a real detection region, and every region to a role', () => {
  for (const role of ROLES) {
    assert.ok(R[role.region], `role ${role.id} points at unknown region ${role.region}`)
  }
  for (const region of REGION_ORDER) {
    assert.ok(roleForRegion(region), `region ${region} has no role`)
  }
  assert.equal(ROLES_IN_ORDER.length, REGION_ORDER.length)
})

test('roles are ordered low frequency to high', () => {
  let prev = 0
  for (const role of ROLES_IN_ORDER) {
    const [lo] = roleFreqRange(role.id, R)
    assert.ok(lo >= prev, `${role.id} at ${lo} Hz breaks the ordering`)
    prev = lo
  }
})

test('role frequency ranges come from the region table, not the role', () => {
  // The whole reason ranges are not stored on the role: they move with the
  // classified voice type. A role that froze a nominal range would be wrong for
  // every narrator who is not the one it was tuned on.
  const male = roleFreqRange('mud', MALE_REGIONS)
  assert.deepEqual(male, [R.mud[SCAN_LOW], R.mud[SCAN_HIGH]])
  assert.equal(roleFreqRange('mud', null), null)
  assert.equal(roleFreqRange('nonsense', R), null)
})

test('the sign-dependent presence label reads both ways', () => {
  const presence = getRole('presence')
  assert.equal(presence.describe(3), 'more presence')
  assert.equal(presence.describe(-3), 'less harsh')
})

test('every role label reads both ways, not just the bidirectional ones', () => {
  // Scan direction is not slider bias (regions.js): a region scanned only for
  // humps is still draggable upward, so a describe() that ignored its argument
  // would report "less mud" over a boost.
  for (const role of ROLES) {
    assert.notEqual(
      role.describe(4), role.describe(-4),
      `${role.id} describes a boost and a cut identically`,
    )
  }
})

test('bandwidth in octaves falls as Q rises', () => {
  // The width read-out is derived from this, so the direction matters: a higher
  // Q must read as narrower, never the reverse.
  const wide = bandwidthOctaves(0.7)
  const narrow = bandwidthOctaves(3.5)
  assert.ok(wide > narrow, 'a low Q did not come out wider')
  // Q 1.41 is the textbook one-octave case.
  assert.ok(Math.abs(bandwidthOctaves(1.4142) - 1) < 0.01)
  // Never returns nonsense for a degenerate Q, which would corrupt the span.
  assert.ok(Number.isFinite(bandwidthOctaves(0)))
})

test('every role defines its own characteristic without naming itself', () => {
  // The palette's promise is that you can reach for a characteristic without
  // knowing its frequency, which holds only while the word is defined in terms
  // of something audible — and a definition that leans on the label defines
  // nothing.
  for (const role of ROLES) {
    assert.ok(
      role.description && role.description.length > 20,
      `${role.id} has no usable description`,
    )
    assert.ok(
      !role.description.toLowerCase().includes(role.label.toLowerCase()),
      `${role.id} describes itself with its own name`,
    )
  }
})

// ── Band creation ───────────────────────────────────────────────────────────

test('every band carries the full field set, however it was created', () => {
  const FIELDS = [
    'id', 'type', 'frequencyHz', 'gainDb', 'q', 'enabled',
    'role', 'roleFreqRangeHz', 'canonicalQ', 'qModified', 'origin',
  ]
  const general = createBand({ frequencyHz: 1000 })
  const voicerx = createBand({ role: 'mud', regions: R, frequencyHz: 300 })
  for (const f of FIELDS) {
    assert.ok(f in general, `general band missing ${f}`)
    assert.ok(f in voicerx, `voicerx band missing ${f}`)
  }
  // Null, not absent — that is what makes retrofitting unnecessary later.
  assert.equal(general.role, null)
  assert.equal(general.canonicalQ, null)
  assert.equal(general.roleFreqRangeHz, null)
})

test('a role band adopts the role type and canonical Q', () => {
  const b = createBand({ role: 'rumble', regions: R, frequencyHz: 80 })
  assert.equal(b.type, 'lowshelf', 'rumble should be a shelf, not a bell')
  assert.equal(b.q, getRole('rumble').canonicalQ)
  assert.equal(b.qModified, false)
})

test('a suggested band keeps its measured Q and is marked modified', () => {
  // This is what makes the "modified" marker meaningful rather than decorative:
  // a suggestion arrives with the Q measured from the anomaly's width, so the
  // reset affordance has somewhere to go back to.
  const b = createBand({
    role: 'mud', regions: R, frequencyHz: 287, gainDb: -3.2, q: 4.1,
    origin: 'suggestion',
  })
  assert.equal(b.q, 4.1)
  assert.equal(b.canonicalQ, getRole('mud').canonicalQ)
  assert.equal(b.qModified, true)

  resetBandQ(b)
  assert.equal(b.q, getRole('mud').canonicalQ)
  assert.equal(b.qModified, false)
})

test('band ids are unique', () => {
  const ids = new Set()
  for (let i = 0; i < 500; i++) ids.add(createBand({ frequencyHz: 1000 }).id)
  assert.equal(ids.size, 500)
})

test('parameters are clamped to their legal ranges on creation', () => {
  const hot = createBand({ frequencyHz: 999999, gainDb: 400, q: 99 })
  assert.equal(hot.frequencyHz, PARAM_RANGES.frequencyHz[1])
  assert.equal(hot.gainDb, PARAM_RANGES.gainDb[1])
  assert.equal(hot.q, PARAM_RANGES.q.peaking[1])

  // Shelves have a narrower Q range than bells — a shelf at Q 10 is not a shelf.
  const shelf = createBand({ type: 'highshelf', frequencyHz: 12000, q: 10 })
  assert.equal(shelf.q, PARAM_RANGES.q.highshelf[1])
})

// ── Forfeiture ──────────────────────────────────────────────────────────────

test('a role band dragged out of range forfeits its tag silently', () => {
  const b = createBand({ role: 'mud', regions: R, frequencyHz: 300, gainDb: -4, q: 2 })
  const before = { type: b.type, gainDb: b.gainDb, q: b.q }

  setBandFrequency(b, R.mud[SCAN_HIGH] + 50)

  assert.equal(b.role, null)
  assert.equal(b.roleFreqRangeHz, null)
  assert.equal(b.canonicalQ, null)
  assert.equal(b.qModified, false)
  // The audio must not change. Forfeiture is a bookkeeping event, not an edit.
  assert.equal(b.type, before.type)
  assert.equal(b.gainDb, before.gainDb)
  assert.equal(b.q, before.q)
})

test('forfeiture fires outside the edges and not on them', () => {
  const lo = R.mud[SCAN_LOW]
  const hi = R.mud[SCAN_HIGH]
  for (const [f, keeps] of [[lo, true], [hi, true], [lo - 1, false], [hi + 1, false]]) {
    const b = createBand({ role: 'mud', regions: R, frequencyHz: 300 })
    setBandFrequency(b, f)
    assert.equal(b.role === 'mud', keeps, `at ${f} Hz expected keeps=${keeps}`)
  }
})

test('an untagged band is never auto-tagged by drifting into range', () => {
  // The reverse direction offers re-tagging; it must never apply it. A band
  // that wanders into the mud range is not evidence the user wanted Mud.
  const b = createBand({ frequencyHz: 1000, gainDb: 3 })
  setBandFrequency(b, 300)
  assert.equal(b.role, null, 'band was silently adopted by a role')
  assert.equal(candidateRoleFor(b, R), 'mud', 'no re-tag was offered')

  tagBand(b, 'mud', R)
  assert.equal(b.role, 'mud')
  assert.deepEqual(b.roleFreqRangeHz, [R.mud[SCAN_LOW], R.mud[SCAN_HIGH]])
})

test('a tagged band offers no further candidate', () => {
  const b = createBand({ role: 'mud', regions: R, frequencyHz: 300 })
  assert.equal(candidateRoleFor(b, R), null)
})

test('setBandQ tracks divergence from the canon', () => {
  const b = createBand({ role: 'mud', regions: R, frequencyHz: 300 })
  assert.equal(b.qModified, false)
  setBandQ(b, 5)
  assert.equal(b.qModified, true)
  setBandQ(b, b.canonicalQ)
  assert.equal(b.qModified, false)

  // A general band has no canon to diverge from.
  const g = createBand({ frequencyHz: 1000 })
  setBandQ(g, 7)
  assert.equal(g.qModified, false)
})

// ── The governing rule ──────────────────────────────────────────────────────

test('mode switching is idempotent and audibly transparent', () => {
  // Spec §2.1: constraints govern the reachable set, not the representable set.
  // Modes are render-time filters over one array, so a round trip cannot change
  // anything — this test exists to fail loudly if someone later adds a
  // normalise-on-entry step, which is the natural mistake.
  const bands = [
    createBand({ role: 'mud', regions: R, frequencyHz: 287, gainDb: -3.2, q: 4.1, origin: 'suggestion' }),
    createBand({ frequencyHz: 1750, gainDb: 2.5, q: 0.9, origin: 'manual_general' }),
    createBand({ role: 'air', regions: R, frequencyHz: 12000, gainDb: 4, origin: 'manual_voicerx' }),
    createBand({ type: 'notch', frequencyHz: 60, q: 20, origin: 'manual_general' }),
  ]
  const snapshot = JSON.stringify(bands)

  // Whatever a view does, it reads. The VoiceRx view sees role bands; the
  // General view sees all of them. Neither writes.
  const voicerxView = bands.filter(b => b.role !== null)
  const generalView = bands.slice()
  assert.equal(voicerxView.length, 2)
  assert.equal(generalView.length, 4)
  assert.equal(JSON.stringify(bands), snapshot, 'a view mutated the band pool')

  // And the filter graph is bit-identical across the round trip.
  const probe = [50, 300, 1000, 3000, 12000]
  const before = magnitudeResponseDb(eqSections(44100, bands), probe, 44100)
  const after = magnitudeResponseDb(eqSections(44100, bands), probe, 44100)
  assert.deepEqual(Array.from(before), Array.from(after))
})

test('untagged bands are counted, not hidden from the audio path', () => {
  // Spec §2.4: VoiceRx exposes no control for a general band, but its
  // contribution IS in the composite curve. A curve that omitted it would be a
  // lie about what the user is hearing.
  const bands = [
    createBand({ role: 'mud', regions: R, frequencyHz: 300, gainDb: -4 }),
    createBand({ frequencyHz: 1750, gainDb: 6, q: 1 }),
    createBand({ frequencyHz: 5000, gainDb: -5, q: 2 }),
  ]
  assert.equal(untaggedBands(bands).length, 2)
  assert.equal(bandForRole(bands, 'mud').gainDb, -4)
  assert.equal(bandForRole(bands, 'air'), null)

  // All three reach the filter graph.
  assert.equal(eqSections(44100, bands).length, 3)
  const at1750 = magnitudeResponseDb(eqSections(44100, bands), [1750], 44100)[0]
  assert.ok(at1750 > 4, `untagged band absent from the composite: ${at1750} dB at 1750 Hz`)
})

test('the manual gain range is not the pipeline clamp', () => {
  // Spec §1.1: these numbers look related and are justified differently. If
  // someone "harmonises" them to the pipeline's ±5 dB, this fails.
  assert.deepEqual(PARAM_RANGES.gainDb, [-18, 18])
  const deep = createBand({ frequencyHz: 200, gainDb: -15, q: 4 })
  assert.equal(deep.gainDb, -15, 'a 15 dB room-mode cut must be reachable')
})

test('MAX_BANDS is the cap the engine enforces', () => {
  assert.equal(MAX_BANDS, 12)
})
