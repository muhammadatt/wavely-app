import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * A NODE'S SOLO IS A MONITORING STATE AND MUST NOT BECOME A PARAMETER.
 *
 * ⚠ THE MORE DANGEROUS OF THE TWO MONITORS ON THIS PANEL, for the reason the
 * zone delta it replaces was: the delta monitor itself is expressible only
 * inside the kernel, but the ISOLATION it rides on is an ordinary parameter —
 * `focus.solo` — so nothing about it would LOOK wrong if it leaked into what
 * Apply renders. It would simply write a one-node pass into the timeline.
 *
 * `useResonance` cannot be imported here: it reaches for an AudioContext at
 * module scope through useEditorState. So the guarantee is pinned by reading
 * the source, which is what resonanceZoneDelta.test.js does for the same reason.
 */

const SRC = readFileSync(
  new URL('../../src/composables/useResonance.js', import.meta.url), 'utf8')

function body(name) {
  const at = SRC.indexOf(`function ${name}(`)
  assert.ok(at >= 0, `${name} not found`)
  return SRC.slice(at, SRC.indexOf('\n  }', at))
}

test('the solo is applied on the way to the live kernel, and nowhere else', () => {
  // It exists as its own state...
  assert.match(SRC, /const resSoloNode = ref\(-1\)/)
  // ...is folded in by liveFocus...
  assert.match(body('liveFocus'), /resSoloNode\.value < 0\) return f/)
  assert.match(body('liveFocus'), /solo: resSoloNode\.value/)
  // ...and every push to the live kernel goes through it.
  assert.match(SRC, /updateParam\(resonanceEffect\.id, 'focus', liveFocus\(\)\)/)
  assert.match(SRC, /pushParam\('focus', liveFocus\(\)\)/)
})

/**
 * THE ASSERTION THAT CARRIES THE GUARANTEE. `currentParams()` is what
 * `applyResonanceRegion` receives, so a solo mentioned anywhere inside it is a
 * one-node pass rendered into the file.
 */
test('what Apply renders never mentions the solo', () => {
  const params = body('currentParams')
  assert.doesNotMatch(params, /resSoloNode|liveFocus|solo/)
  // It hands over the STORED patch, not the live one.
  assert.match(params, /focus: resFocus\.value/)
})

test('the delta monitor is on whenever any of the three asks for it', () => {
  const m = body('monitoringDelta')
  assert.match(m, /resDelta\.value/)
  assert.match(m, /resDeltaZone\.value >= 0/)
  assert.match(m, /resSoloNode\.value >= 0/)
})

/**
 * The effect entry outlives the panel, so a monitor left set would come back
 * later describing a file that is no longer open — the reason teardown clears
 * the other two.
 */
test('teardown clears it, as it does the other monitors', () => {
  const t = SRC.slice(SRC.indexOf('function teardown'))
  const end = t.indexOf('\n  }')
  assert.match(t.slice(0, end), /resSoloNode\.value = -1/)
  // Beside the other two, so the three cannot drift apart.
  assert.match(t.slice(0, end), /resDeltaZone\.value = -1/)
})

test('a second click on the same node clears it', () => {
  assert.match(body('toggleFocusSolo'),
    /resSoloNode\.value = resSoloNode\.value === index \? -1 : index/)
})

/**
 * The plot has to DRAW it, or the display disagrees with the speakers — the
 * same rule that made a bypassed zone wash out.
 */
test('the plot is told which node is soloed and veils the rest', () => {
  const plot = readFileSync(
    new URL('../../src/components/meters/ResonanceSpectrum.vue', import.meta.url), 'utf8')
  assert.match(plot, /soloFocusNode:\s*\{\s*type:\s*Number/)
  assert.match(plot, /focusNodeWeightAt\(focusNode\(soloed\), hz\)/)
  const modal = readFileSync(
    new URL('../../src/components/panels/ResonanceModal.vue', import.meta.url), 'utf8')
  assert.match(modal, /:solo-focus-node="resSoloNode"/)
  assert.match(modal, /@focus-solo="toggleFocusSolo"/)
})
