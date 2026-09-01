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

/**
 * One declaration's body. ⚠ Both spellings — this file mixes `function f()` and
 * `const f = (v) => {`, and a helper that only knew the first reported
 * "syncFocus not found" as though the guarantee were missing rather than the
 * helper being narrow.
 */
function body(name) {
  const at = [`function ${name}(`, `const ${name} = (`]
    .map(pat => SRC.indexOf(pat))
    .filter(i => i >= 0)
    .sort((a, b) => a - b)[0]
  assert.ok(at >= 0 && at !== undefined, `${name} not found`)
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
  const t = body('toggleFocusSolo')
  assert.match(t, /const on = resSoloNode\.value !== index/)
  assert.match(t, /resSoloNode\.value = on \? index : -1/)
})

/**
 * ⚠ THE SOLO IS RECONCILED BY ID, NOT BY INDEX — reported from use: deleting a
 * node left the delta monitor on, auditioning whatever node had shifted into
 * that slot, or nothing at all with the panel still lit. Every edit replaces
 * the array, so an index survives a deletion happily and silently means
 * something else afterwards.
 *
 * The reconcile lives in `syncFocus` rather than in the gestures because every
 * route that can invalidate a solo — the card's DELETE, the plot's
 * double-click, the keyboard's Delete — arrives through that one function, and
 * a rule applied per gesture is a rule with a gesture missing from it.
 */
test('deleting the soloed node clears the solo, and an earlier deletion does not', () => {
  const sync = body('syncFocus')
  assert.match(sync, /findIndex\(n => n\.id === soloId\)/)
  assert.match(sync, /if \(at < 0\) clearFocusSolo\(\)/)
  assert.match(sync, /else resSoloNode\.value = at/)
  // Clearing puts the kernel's monitor back, or the delta keeps sounding with
  // nothing soloed.
  assert.match(body('clearFocusSolo'), /setMonitorDelta\(monitoringDelta\(\)\)/)
  // And the id is captured when the solo is set, or there is nothing to re-find.
  assert.match(body('toggleFocusSolo'), /soloId = on \? \(resFocus\.value\?\.nodes\?\.\[index\]\?\.id/)
})

/**
 * The rule itself, reproduced exactly as the composable applies it — the source
 * check above pins that the composable still has it, this pins what it does.
 */
test('the reconcile rule survives an earlier deletion and clears on its own', () => {
  const reconcile = (nodes, soloId) => {
    const at = nodes.findIndex(n => n.id === soloId)
    return at < 0 ? { solo: -1, soloId: null } : { solo: at, soloId }
  }
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(reconcile(nodes.filter(n => n.id !== 'a'), 'b'), { solo: 0, soloId: 'b' })
  assert.deepEqual(reconcile(nodes.filter(n => n.id !== 'b'), 'b'), { solo: -1, soloId: null })
  assert.deepEqual(reconcile([], 'b'), { solo: -1, soloId: null })
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
