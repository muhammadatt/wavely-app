/**
 * Which editor shell a visit gets (src/ui/formFactor.js).
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pickLayout, MOBILE_SHORT_SIDE_PX } from '../../src/ui/formFactor.js'

test('a touch phone gets the mobile shell, held either way up', () => {
  assert.equal(pickLayout({ width: 390, height: 844, coarsePointer: true }), 'mobile')
  assert.equal(pickLayout({ width: 844, height: 390, coarsePointer: true }), 'mobile')
})

test('a tablet, a desktop, and a narrow desktop window keep the desktop shell', () => {
  assert.equal(pickLayout({ width: 1024, height: 768, coarsePointer: true }), 'desktop', 'iPad')
  assert.equal(pickLayout({ width: 1440, height: 900, coarsePointer: false }), 'desktop')
  assert.equal(pickLayout({ width: 390, height: 844, coarsePointer: false }), 'desktop', 'a mouse is not a phone')
  assert.equal(pickLayout({ width: MOBILE_SHORT_SIDE_PX, height: 1000, coarsePointer: true }), 'desktop')
})

test('the user\'s choice wins, and anything else in storage is ignored', () => {
  assert.equal(pickLayout({ width: 390, height: 844, coarsePointer: true, override: 'desktop' }), 'desktop')
  assert.equal(pickLayout({ width: 1440, height: 900, coarsePointer: false, override: 'mobile' }), 'mobile')
  assert.equal(pickLayout({ width: 390, height: 844, coarsePointer: true, override: 'tablet' }), 'mobile')
})

test('the two shells share the transport and the editor wiring', () => {
  const read = p => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8')
  for (const shell of ['components/EditorScreen.vue', 'components/mobile/MobileEditorScreen.vue']) {
    assert.match(read(shell), /installEditorShell\(\)/, `${shell} installs the shared editor wiring`)
  }
  for (const transport of ['components/TransportBar.vue', 'components/mobile/MobileTransport.vue']) {
    const src = read(transport)
    assert.match(src, /installTransport\(\)/, `${transport} installs the shared transport`)
    assert.doesNotMatch(src, /startPlayback|onTogglePlaybackRequest/, `${transport} keeps no play logic of its own`)
  }
})
