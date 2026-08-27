/**
 * The harness chassis variant, and the token set both variants have to carry.
 *
 * Two designs — 5a lifts the chrome above the faceplate, 5b drops it below —
 * and a person has to choose between them by looking at the real app in all
 * fifteen hues. Neither the switch nor the tokens can be checked by rendering
 * one of them: a window drawn in the wrong variant looks exactly like a window
 * drawn in the right one unless the other is on screen beside it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DEFAULT_CHROME, resolveHarnessChrome } from '../../src/ui/harnessChrome.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRAME = join(HERE, '../../src/components/panels/FloatingWindow.vue')
// The help panel is inside the frame, so it inherits the tokens and styles
// itself from them rather than taking a prop — which also means a typo there
// is exactly as silent as one in the frame.
const READERS = [FRAME, join(HERE, '../../src/components/panels/HelpOverlay.vue')]

function withEnv({ search = '', stored = null, throws = false }, fn) {
  const had = 'window' in globalThis
  const previous = globalThis.window
  globalThis.window = {
    location: { search },
    localStorage: {
      getItem: () => {
        if (throws) throw new Error('localStorage is not available')
        return stored
      },
    },
  }
  try {
    return fn()
  } finally {
    if (had) globalThis.window = previous
    else delete globalThis.window
  }
}

test('the shipping chassis is the default', () => {
  assert.equal(withEnv({}, resolveHarnessChrome), DEFAULT_CHROME)
})

test('the query string selects a chassis, and outranks a stored choice', () => {
  assert.equal(withEnv({ search: '?harnessChrome=dark' }, resolveHarnessChrome), 'dark')
  assert.equal(withEnv({ search: '?harnessChrome=light' }, resolveHarnessChrome), 'light')
  assert.equal(
    withEnv({ search: '?harnessChrome=light', stored: 'dark' }, resolveHarnessChrome), 'light',
  )
  assert.equal(withEnv({ stored: 'dark' }, resolveHarnessChrome), 'dark')
})

test('an unrecognised value falls back rather than passing through', () => {
  // A typo must not render a third thing while the person looking at it
  // believes they are seeing the other design — which is the entire job of a
  // switch that exists to decide an A/B.
  assert.equal(withEnv({ search: '?harnessChrome=titanium' }, resolveHarnessChrome), DEFAULT_CHROME)
  assert.equal(withEnv({ stored: '' }, resolveHarnessChrome), DEFAULT_CHROME)
})

test('no window means the default, not a thrown window', () => {
  // A browser refusing localStorage in private mode is not a reason to fail to
  // open a plugin.
  assert.equal(withEnv({ throws: true }, resolveHarnessChrome), DEFAULT_CHROME)
  const had = 'window' in globalThis
  const previous = globalThis.window
  delete globalThis.window
  try {
    assert.equal(resolveHarnessChrome(), DEFAULT_CHROME)
  } finally {
    if (had) globalThis.window = previous
  }
})

/**
 * Every chassis rule reads a token, and the dark block redefines every token
 * the base block declares.
 *
 * This is what makes the two variants the same window at two exposures rather
 * than two designs maintained in parallel: a token added to one and forgotten
 * in the other does not fail — the missing one silently inherits the base
 * value, so the dark chassis renders one plane at the light chassis's colour
 * and nothing says so. That is exactly the defect the inline faceplate
 * gradient caused before the tokens existed.
 */
test('the dark chassis redefines every token the base chassis declares', () => {
  const src = readFileSync(FRAME, 'utf8')

  const base = block(src, '.win-frame {')
  const dark = block(src, ".win-frame[data-chrome='dark'] {")

  const declared = (b) => [...b.matchAll(/^\s*(--chrome-[a-z-]+):/gm)].map(m => m[1]).sort()
  const baseTokens = declared(base)
  const darkTokens = declared(dark)

  assert.ok(baseTokens.length >= 10, `expected a full token set, found ${baseTokens.length}`)
  const missing = baseTokens.filter(t => !darkTokens.includes(t))
  assert.deepEqual(missing, [], `the dark chassis inherits: ${missing.join(', ')}`)
  const extra = darkTokens.filter(t => !baseTokens.includes(t))
  assert.deepEqual(extra, [], `only the dark chassis declares: ${extra.join(', ')}`)
})

test('every chassis token the panels read is one a chassis declares', () => {
  // The other direction: a rule reading `--chrome-face-tint` when the token is
  // called `--chrome-face-top` draws nothing at all and looks like a plane
  // someone forgot to style.
  const declared = new Set(
    [...readFileSync(FRAME, 'utf8').matchAll(/^\s*(--chrome-[a-z-]+):/gm)].map(m => m[1]),
  )
  for (const file of READERS) {
    const read = new Set(
      [...readFileSync(file, 'utf8').matchAll(/var\((--chrome-[a-z-]+)/g)].map(m => m[1]),
    )
    const undeclared = [...read].filter(t => !declared.has(t)).sort()
    assert.deepEqual(undeclared, [], `${file}: read but never declared: ${undeclared.join(', ')}`)
  }
})

test('the help panel takes its surface from the chassis, not from its own copy', () => {
  // It shipped with the 5a gradient written out longhand, which meant the dark
  // chassis drew a light-chassis help panel over a dark-chassis window — a
  // seam only visible with the panel open, on one of the two variants.
  const src = readFileSync(READERS[1], 'utf8')
  assert.ok(
    src.includes('var(--chrome-help-top)') && src.includes('var(--chrome-help-bottom)'),
    'the help surface no longer reads the chassis tokens',
  )
  assert.ok(
    !/color-mix\([^)]*var\(--face/.test(src),
    'the help panel mixes its own surface out of --face instead of reading a token',
  )
})

/** The body of the first CSS rule opening with `head`, braces balanced. */
function block(src, head) {
  const start = src.indexOf(head)
  assert.notEqual(start, -1, `no rule opening \`${head}\``)
  let depth = 0
  for (let i = start + head.length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i)
  }
  throw new Error(`unbalanced braces after \`${head}\``)
}
