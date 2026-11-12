import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  baseName, splitTabName, sharedTabWidth,
  TAB_MIN_WIDTH, TAB_MAX_WIDTH, TAB_CHROME_WIDTH,
} from '../../src/ui/tabName.js'

test('the extension is dropped; a leading dot is part of the name', () => {
  assert.equal(baseName('Podcast_Ep14_final_master.wav'), 'Podcast_Ep14_final_master')
  assert.equal(baseName('take.v1.2.m4a'), 'take.v1.2')
  assert.equal(baseName('.hidden'), '.hidden')
  assert.equal(baseName('noext'), 'noext')
})

test('short names stay whole; long names pin their last six characters', () => {
  assert.deepEqual(splitTabName('Bass_DI.aiff'), { head: 'Bass_DI', tail: '' })
  assert.deepEqual(splitTabName('Room_Tone_take3.wav'), { head: 'Room_Tone', tail: '_take3' })
  assert.deepEqual(splitTabName('StuderA800_DrumMachine_wet_v2.wav'),
    { head: 'StuderA800_DrumMachine_', tail: 'wet_v2' })
})

test('a name too long for the narrowest tab splits, so its suffix survives crowding', () => {
  // 14 characters: wider than a 110 px tab's text room, so it must not be
  // kept whole (it was, and a crowded tab cut "_raw" off the end).
  assert.deepEqual(splitTabName('Chapter_07_raw.flac'), { head: 'Chapter_', tail: '07_raw' })
  assert.deepEqual(splitTabName('Take_0003.wav'), { head: 'Take_0003', tail: '' })
})

test('one shared width, clamped between the floor and the cap', () => {
  const w = (s) => s.length * 7
  assert.equal(sharedTabWidth(['a.wav'], w), TAB_MIN_WIDTH)
  assert.equal(sharedTabWidth(['x'.repeat(100) + '.wav'], w), TAB_MAX_WIDTH)
  const mid = sharedTabWidth(['Chapter_07_raw.flac', 'Bass_DI.aiff'], w)
  assert.equal(mid, TAB_CHROME_WIDTH + 'Chapter_07_raw'.length * 7)
})
