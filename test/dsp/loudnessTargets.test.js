/**
 * Run with:  npm test
 *
 * THE BENCHMARK TABLE.
 *
 * ⚠ THE ONE THING HERE THAT IS NOT A SHAPE CHECK IS THE PIN AGAINST
 * `OUTPUT_PROFILES`. Three of these targets — acx, podcast, broadcast — also
 * exist as server output profiles, and the two are set from different files by
 * different people. If they drift, the spot normalizer moves a file to one
 * number and the mastering chain moves it to another, and nothing anywhere
 * says so: both operations succeed and the file ends up wherever the last one
 * put it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LOUDNESS_TARGETS, TARGET_GROUPS, DEFAULT_TARGET_ID, TARGET_MATCH_DB,
  matchTarget, matchingTargets, targetById, targetsInGroup,
} from '../../src/audio/loudnessTargets.js'
import { OUTPUT_PROFILES } from '../../src/audio/presets.js'

test('the client targets and the server output profiles agree', () => {
  for (const id of ['acx', 'podcast', 'broadcast']) {
    const t = targetById(id)
    const p = OUTPUT_PROFILES[id]
    assert.ok(t, `${id} must exist as a target`)
    assert.ok(p, `${id} must exist as an output profile`)
    assert.equal(t.targetDb, p.normalizationTarget, `${id}: loudness target`)
    assert.equal(t.ceilingDb, p.truePeakCeiling, `${id}: peak ceiling`)
    assert.equal(t.unit, p.measurementMethod, `${id}: measurement method`)
  }
})

test('ACX is the only target measured on the RMS meter', () => {
  // Not a detail. Every other spec here is K-weighted and gated; ACX is
  // ungated, unweighted RMS and audits with that measurement. A second entry
  // quietly marked RMS would be a spec being normalized with the wrong meter.
  const rms = LOUDNESS_TARGETS.filter(t => t.unit === 'RMS').map(t => t.id)
  assert.deepEqual(rms, ['acx'])
})

test('every entry has the shape the panel draws from', () => {
  const groups = new Set(TARGET_GROUPS.map(g => g.id))
  for (const t of LOUDNESS_TARGETS) {
    assert.ok(t.id && typeof t.id === 'string', 'id')
    assert.ok(t.label && t.label === t.label.toUpperCase(), `${t.id}: label is a chip`)
    assert.ok(t.name && typeof t.name === 'string', `${t.id}: name`)
    assert.ok(groups.has(t.group), `${t.id}: group "${t.group}" has no heading`)
    assert.ok(['LUFS', 'RMS'].includes(t.unit), `${t.id}: unit`)
    assert.ok(Number.isFinite(t.targetDb) && t.targetDb < 0, `${t.id}: targetDb`)
    assert.ok(Number.isFinite(t.ceilingDb) && t.ceilingDb <= 0, `${t.id}: ceilingDb`)
    assert.ok(t.note && !/[.!?]$/.test(t.note), `${t.id}: note carries terminal punctuation`)
    assert.ok(t.ceilingDb > t.targetDb, `${t.id}: a ceiling below the target is unreachable`)
  }
})

test('ids and labels are unique, so no button is unreachable', () => {
  const ids = LOUDNESS_TARGETS.map(t => t.id)
  const labels = LOUDNESS_TARGETS.map(t => t.label)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(new Set(labels).size, labels.length)
})

test('every group has at least one target, and every target a group', () => {
  for (const g of TARGET_GROUPS) {
    assert.ok(targetsInGroup(g.id).length >= 1, `${g.id} draws an empty row`)
  }
  const listed = TARGET_GROUPS.flatMap(g => targetsInGroup(g.id))
  assert.equal(listed.length, LOUDNESS_TARGETS.length, 'a target sits in no drawn row')
})

test('the default is a real target', () => {
  assert.ok(targetById(DEFAULT_TARGET_ID), `${DEFAULT_TARGET_ID} is not in the table`)
  assert.equal(targetById('nothing-like-this'), null)
})

test('a benchmark lights when the knobs sit on its numbers', () => {
  for (const t of LOUDNESS_TARGETS) {
    const ids = matchingTargets(t.targetDb, t.unit, t.ceilingDb).map(x => x.id)
    assert.ok(ids.includes(t.id), `${t.id} did not light on its own numbers`)
    // Within tolerance, because a knob step lands on -14.0 and a float does not
    // always say so.
    const nudged = matchingTargets(t.targetDb + TARGET_MATCH_DB / 2, t.unit, t.ceilingDb)
    assert.ok(nudged.some(x => x.id === t.id), `${t.id}: should tolerate a knob step`)
  }
})

test('specs that share their numbers all light together', () => {
  // ⚠ NOT A DUPLICATE-ENTRY BUG. -16 LUFS at -1 dBTP is Apple Music AND the
  // podcast norm; -14 at -1 is Spotify, YouTube and Tidal. Lighting only the
  // first would tell a podcaster they had selected Apple Music.
  const sixteen = matchingTargets(-16, 'LUFS', -1).map(t => t.id).sort()
  assert.deepEqual(sixteen, ['apple', 'podcast'])
  const fourteen = matchingTargets(-14, 'LUFS', -1).map(t => t.id).sort()
  assert.deepEqual(fourteen, ['spotify', 'tidal', 'youtube'])
  // Amazon's tighter ceiling really does separate it from the rest.
  assert.deepEqual(matchingTargets(-14, 'LUFS', -2).map(t => t.id), ['amazon-music'])
})

test('a value between benchmarks lights nothing', () => {
  assert.equal(matchTarget(-15, 'LUFS', -1), null)
  assert.deepEqual(matchingTargets(-15, 'LUFS', -1), [])
  // Same numbers on the other meter is a different setting, and lighting ACX
  // for a LUFS target would be the panel lying about which spec it is aiming at.
  assert.equal(matchTarget(-20, 'LUFS', -3), null)
  assert.equal(matchTarget(-20, 'RMS', -3)?.id, 'acx')
})
