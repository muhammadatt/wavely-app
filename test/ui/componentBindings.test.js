/**
 * Every identifier a template reaches for is declared in its own script.
 *
 * ⚠ THIS IS THE ONLY THING IN THE SUITE THAT LOOKS AT A COMPONENT AT ALL, and it
 * exists because two crashes shipped past 780 passing tests in one sitting, both
 * caught by a person opening the panel:
 *
 *   - `smoothArrays.detect` was never allocated, so the plot threw on its first
 *     frame — every frame, for every user.
 *   - A scripted edit removed five declarations from ResonanceModal's script and
 *     left the template referencing them, so the focus node panel could never
 *     open.
 *
 * Neither is catchable by `vite build`: `<script setup>` compiles happily with a
 * template that names something it does not declare, and Vue only complains at
 * render. Nothing else here renders — the panel's import chain reaches
 * `?worker&url` specifiers that only Vite resolves, which is why these
 * components cannot simply be mounted under node.
 *
 * So this reads the source instead. It is a coarse instrument and deliberately
 * biased toward silence: it reports an identifier only when it appears in a
 * template expression, is not a keyword or an allowed global, is not bound by
 * the template itself, and appears NOWHERE in the script block.
 *
 * ⚠ "APPEARS NOWHERE" IS THE LIMIT, AND IT IS DELIBERATE. This does not know a
 * declaration from a reference, so removing `const x = ...` while something else
 * in the script still mentions `x` reads as fine. Mutation-tested both ways:
 * deleting the whole block that declared `nodePanelOpen`, which is what actually
 * happened, IS caught; commenting out its declaration alone while its watcher
 * survives is NOT. Knowing the difference needs a parser, and the failure this
 * exists for is the first shape, not the second.
 *
 * ⚠ EVERY PATTERN HERE IS A REGEX LITERAL. Built from strings they need doubled
 * escapes, and every layer between the source and the file — template literal,
 * heredoc, editor — is another place for a backslash to be eaten. It was, twice,
 * while this test was being written: `[\s\S]` became `[sS]`, matched nothing,
 * and the test failed on all six components with "expected both a script and a
 * template" rather than reporting anything about them. A literal cannot lose an
 * escape.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')

/** The ResoTame surface. Widening this to every .vue is the obvious next step. */
const FILES = [
  'src/components/meters/ResonanceSpectrum.vue',
  'src/components/panels/FocusNodePanel.vue',
  'src/components/panels/ResonanceFocusControls.vue',
  'src/components/panels/ResonanceModal.vue',
  'src/components/panels/ResonanceZoneControls.vue',
  'src/components/panels/ResonanceZoneCount.vue',
]

/**
 * Anything a template may legitimately name without the script declaring it.
 *
 * Explicit rather than "skip anything that looks global": the point of the check
 * is that an unknown name is an error, so every exemption is one somebody wrote.
 */
const ALLOWED = new Set([
  '$slots', '$attrs', '$emit', '$props', '$el', '$refs', '$event',
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Date',
  'parseFloat', 'parseInt', 'isNaN', 'window', 'document',
])

const KEYWORDS = new Set([
  'in', 'of', 'new', 'typeof', 'instanceof', 'void', 'delete', 'return', 'if',
  'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'const',
  'let', 'var', 'function', 'class', 'this', 'try', 'catch', 'finally', 'throw',
  'await', 'async', 'yield',
])

function blocks(src, tag) {
  const re = tag === 'script'
    ? /<script[^>]*>([\s\S]*?)<\/script>/g
    : /<template[^>]*>([\s\S]*?)<\/template>/g
  const out = []
  let m
  while ((m = re.exec(src))) out.push(m[1])
  return out
}

/**
 * Every expression a template evaluates: interpolations, bound attributes,
 * handlers and directives. Static attributes are skipped — `class="x"` is a
 * string where `:class="x"` is an expression.
 */
function templateExpressions(tpl) {
  const out = []
  for (const m of tpl.matchAll(/\{\{([\s\S]*?)\}\}/g)) out.push(m[1])
  for (const m of tpl.matchAll(/(?::|@|v-bind:|v-on:)[\w.[\]-]*="([^"]*)"/g)) out.push(m[1])
  for (const m of tpl.matchAll(/v-(?:if|else-if|show|for|model)="([^"]*)"/g)) out.push(m[1])
  return out
}

/** Names the template binds for itself, which the script has no reason to hold. */
function templateLocals(tpl) {
  const local = new Set()
  for (const m of tpl.matchAll(/v-for="\(?([^)"]*?)\)?\s+(?:in|of)\s/g)) {
    for (const part of m[1].split(',')) local.add(part.trim())
  }
  for (const m of tpl.matchAll(/#[\w-]+="\{?([^}"]*)\}?"/g)) {
    for (const part of m[1].split(',')) local.add(part.trim())
  }
  return local
}

/**
 * Root identifiers in an expression — `a.b.c` contributes `a`, `'x'` nothing.
 *
 * ⚠ FOUR THINGS LOOK LIKE REFERENCES AND ARE NOT, and every one of them was a
 * false positive on the first run. A test that cries wolf on working code gets
 * switched off, so each is removed before the scan rather than exempted by name:
 *
 *   - OBJECT KEYS. `{ spanOct: $event }` names a field, not a variable.
 *   - ARROW PARAMETERS. `t => parseFloat(t)` binds `t` inside the expression.
 *   - PROPERTY ACCESS. `node.hz` is one reference, not two.
 *   - `$`-PREFIXED NAMES. A word boundary sits between `$` and `event`, so a
 *     naive scan reports `event` — a name no script would ever declare.
 *
 * Regex literals go with the strings for the same reason: `/st$/i` is a value,
 * and its body scanned as an identifier called `st$`.
 */
function rootIdentifiers(expr) {
  const stripped = expr
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    // Regex literals. `:parse="t => (/st$/i.test(t) ? ... )"` is real, and its
    // body scanned as `st$` and its flag as `i`. Only matched where a regex can
    // legally start, so a division never looks like one.
    .replace(/(^|[(,=:!&|?\s])\/(?:[^/\\n]|\.)+\/[gimsuy]*/g, '$1')
    // Object keys: `{ a: 1, b: 2 }`. Not ternaries — those have a `?` before the
    // colon and no `{` or `,` immediately before the name.
    .replace(/([{,]\s*)[A-Za-z_$][\w$]*\s*:/g, '$1')
  const params = new Set()
  for (const m of stripped.matchAll(/\(?([\w$,\s]*?)\)?\s*=>/g)) {
    for (const part of m[1].split(',')) if (part.trim()) params.add(part.trim())
  }
  const out = new Set()
  // The leading char is captured rather than using \b, so `$event` is one name
  // and `a.b` yields only `a`.
  for (const m of stripped.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)/g)) {
    if (!params.has(m[2])) out.add(m[2])
  }
  return out
}

for (const rel of FILES) {
  test(`${rel} declares everything its template names`, () => {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    const script = blocks(src, 'script').join('\n')
    const tpl = blocks(src, 'template').join('\n')
    assert.ok(script.length > 0, 'no <script> block found')
    assert.ok(tpl.length > 0, 'no <template> block found')

    // Every identifier the script mentions — declared, imported, destructured or
    // named as a prop. A membership set rather than a per-name regex: the check
    // is for names appearing NOWHERE, so the coarse instrument is the right one.
    //
    // ⚠ COMMENTS ARE STRIPPED FIRST, and without that this test does not catch
    // the bug it was written for. These files carry more prose than code, and
    // every removed declaration leaves a note explaining the removal — which
    // mentions the name. Counting comments, a deleted binding still reads as
    // declared. Verified by mutation: commenting out `const nodePanelOpen` is
    // caught only once the comment text stops counting.
    const code = script
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
    const declared = new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? [])
    const locals = templateLocals(tpl)

    const missing = new Set()
    for (const expr of templateExpressions(tpl)) {
      for (const name of rootIdentifiers(expr)) {
        if (ALLOWED.has(name) || KEYWORDS.has(name)) continue
        if (locals.has(name) || declared.has(name)) continue
        missing.add(name)
      }
    }
    assert.deepEqual([...missing], [], `template names nothing declares`)
  })
}

test('the file list covers every ResoTame component', () => {
  // ⚠ A LIST THAT SILENTLY STOPS COVERING THINGS IS WORSE THAN NO LIST. A new
  // component in these folders named Resonance* or Focus* is part of this panel
  // and belongs above.
  const found = []
  for (const dir of ['src/components/meters', 'src/components/panels']) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (/^(Resonance|Focus).*\.vue$/.test(f)) found.push(`${dir}/${f}`)
    }
  }
  assert.deepEqual(found.sort(), [...FILES].sort())
})
