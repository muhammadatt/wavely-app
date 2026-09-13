/**
 * Run with:  npm test
 *
 * EVERY NAME A PANEL DESTRUCTURES FROM A COMPOSABLE IS ACTUALLY RETURNED BY IT.
 *
 * ⚠ THIS IS THE HALF `componentBindings.test.js` CANNOT SEE, and it is not a
 * hypothetical gap. That file reports an identifier only when it appears
 * NOWHERE in the script — its own header says so — and a name taken off a
 * composable in a destructuring pattern appears in the script by definition. So
 * the whole class of "the composable does not return this" is invisible to it.
 *
 * It happened while the vocal chain dynamics panel was being written:
 * `CLIP_MAX_DEPTH_DB` is a module-level export of `dynamicsSolve.js`, re-exported
 * by the composable's MODULE but never put on the object `useDynamics()`
 * returns. The panel destructured it anyway. `vite build` was happy, the smoke
 * test opened the panel happily — the value is only read inside a caption that
 * renders when the clipper's cap binds — and it would have printed
 * "held at undefined dB" to a user at exactly the moment the panel had something
 * important to say.
 *
 * ⚠ SOURCE-SCANNED, NOT EXECUTED, FOR THE SAME REASON EVERYTHING ELSE HERE IS: a
 * composable calls `useEditorState()` on invocation, and a panel's import chain
 * reaches `?worker&url` specifiers that only Vite resolves. Neither can be
 * imported under Node.
 *
 * ⚠ COARSE AND BIASED TOWARD SILENCE. It only checks pairs it can match with
 * confidence — a `const { ... } = useX()` against a `return { ... }` it can find
 * in that composable — and skips anything it cannot parse rather than guessing.
 * A check that cried wolf here would be turned off.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const PANELS = join(ROOT, 'src/components/panels')
const COMPOSABLES = join(ROOT, 'src/composables')

const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Every .vue under the panels tree, recursively. */
function panelFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...panelFiles(p))
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

/**
 * Top-level keys of the object a composable returns.
 *
 * Finds `return {` and walks braces to its match, so nested objects inside the
 * return — a summary, a plan — do not contribute their own keys.
 */
function returnedKeys(src, composable) {
  /**
   * ⚠ THE COMPOSABLE'S OWN RETURN, NOT THE LAST ONE IN THE FILE. Taking the
   * last `return {` found `splitTuning`'s one-line helper return at the bottom
   * of `useDeEsser.js` and reported its entire surface as missing — eighteen
   * false positives from a file with nothing wrong with it.
   *
   * The composable's return is the first one at its function's own indent after
   * `export function useX(`, and it is a MULTI-LINE object: a one-line
   * `return { a, b }` is a helper's, never a composable's public surface.
   */
  const exported = src.indexOf(`export function ${composable}(`)
  if (exported < 0) return null
  const m = /\n  return \{\s*\n/.exec(src.slice(exported))
  if (!m) return null
  const at = exported + m.index
  let depth = 0
  let end = -1
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) return null

  const body = src.slice(src.indexOf('{', at) + 1, end)
  const keys = new Set()
  let nest = 0
  for (const line of body.split('\n')) {
    /**
     * ⚠ SEVERAL KEYS PER LINE IS THE COMMON CASE, NOT THE EXCEPTION. The first
     * version of this took one identifier per line and reported eighteen false
     * positives against `useDeEsser`, whose return lists five shorthand keys to
     * a line. A check that fires on correct code gets switched off, so it has
     * to read the line the way the language does.
     */
    if (nest === 0) {
      for (const part of line.split(',')) {
        const m = part.trim().match(/^([A-Za-z_$][\w$]*)\s*[:]?/)
        if (m) keys.add(m[1])
      }
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') nest++
      else if (ch === '}' || ch === ')' || ch === ']') nest--
    }
  }
  return keys
}

/** `const { a, b } = useX()` pairs in a panel's script. */
function destructures(src) {
  const out = []
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*(use[A-Z][\w]*)\s*\(/g)) {
    const names = m[1]
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      // `a: b` renames and `a = 1` defaults take the SOURCE name.
      .map(s => s.split(/[:=]/)[0].trim())
      .filter(s => /^[A-Za-z_$][\w$]*$/.test(s))
    out.push({ composable: m[2], names })
  }
  return out
}

const COMPOSABLE_SRC = new Map(
  readdirSync(COMPOSABLES)
    .filter(f => f.endsWith('.js'))
    .map(f => [f.replace(/\.js$/, ''), stripComments(readFileSync(join(COMPOSABLES, f), 'utf8'))]),
)

test('the scan actually finds panels and composables to check', () => {
  // Guards the guard: a matcher that stopped matching would make the assertion
  // below vacuous, which is the failure mode of every source-scanning test.
  assert.ok(panelFiles(PANELS).length > 10)
  assert.ok(COMPOSABLE_SRC.size > 10)
})

test('every destructured name is on the object its composable returns', () => {
  const problems = []
  let checked = 0

  for (const file of panelFiles(PANELS)) {
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const { composable, names } of destructures(src)) {
      const composableSrc = COMPOSABLE_SRC.get(composable)
      if (!composableSrc) continue // not one of ours — a Vue or vendor hook
      const keys = returnedKeys(composableSrc, composable)
      if (keys === null) continue // could not parse it; stay silent rather than guess
      checked++
      for (const name of names) {
        if (!keys.has(name)) {
          problems.push(
            `${file.slice(ROOT.length + 1)} destructures \`${name}\` from `
            + `${composable}(), which does not return it — it will be undefined at `
            + 'render, and neither the build nor the smoke test will say so',
          )
        }
      }
    }
  }

  assert.ok(checked > 5, `expected several panel/composable pairs, checked ${checked}`)
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`)
})
