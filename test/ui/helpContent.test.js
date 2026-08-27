import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { HELP, helpFor } from '../../src/content/help/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const HELP_DIR = join(ROOT, 'src/content/help')
const PANELS_DIR = join(ROOT, 'src/components/panels')

/**
 * The help content is data, and this is what stops it drifting from the app.
 *
 * None of it can be checked by rendering: a panel with the wrong instructions
 * looks exactly like a panel with the right ones. What CAN be checked is that
 * every window has an entry, that no entry describes a window that no longer
 * exists, and that the shape and the voice hold — so those are pinned here and
 * the prose is left to a person.
 */

/** Every `window-id` a faceplate actually mounts, read from the source. */
function windowIdsInApp() {
  const ids = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.vue')) {
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(/window-id="([^"]+)"/g)) ids.add(m[1])
      }
    }
  }
  walk(PANELS_DIR)
  return ids
}

test('every effect window has a help entry', () => {
  const missing = [...windowIdsInApp()].filter(id => !HELP[id]).sort()
  assert.deepEqual(
    missing, [],
    `these windows open with no help behind the ? button: ${missing.join(', ')}`,
  )
})

test('no help entry describes a window that does not exist', () => {
  const inApp = windowIdsInApp()
  const orphans = Object.keys(HELP).filter(id => !inApp.has(id)).sort()
  assert.deepEqual(
    orphans, [],
    `help written for windows the app no longer has: ${orphans.join(', ')}`,
  )
})

test('the registry key and the filename agree', () => {
  // The lookup is by window id, so a file named for one effect and registered
  // under another id would serve the wrong instructions with nothing to show
  // for it. Catching that here is cheaper than noticing it in the panel.
  const files = readdirSync(HELP_DIR)
    .filter(f => f.endsWith('.js') && f !== 'index.js')
    .map(f => f.replace(/\.js$/, ''))
    .sort()
  assert.deepEqual(files, Object.keys(HELP).sort())
})

test('every entry has the required shape', () => {
  for (const [id, entry] of Object.entries(HELP)) {
    assert.equal(typeof entry.summary, 'string', `${id}: summary must be a string`)
    assert.ok(entry.summary.length > 0, `${id}: summary is empty`)

    assert.ok(Array.isArray(entry.whenToUse), `${id}: whenToUse must be an array`)
    assert.ok(entry.whenToUse.length >= 1, `${id}: whenToUse is empty`)
    assert.ok(entry.whenToUse.length <= 5, `${id}: whenToUse is a list, not a manual`)

    assert.ok(Array.isArray(entry.controls), `${id}: controls must be an array`)
    assert.ok(entry.controls.length >= 1, `${id}: no controls documented`)
    for (const c of entry.controls) {
      assert.ok(c.label && typeof c.label === 'string', `${id}: a control has no label`)
      assert.ok(c.text && typeof c.text === 'string', `${id}: ${c.label} has no text`)
    }

    const labels = entry.controls.map(c => c.label)
    assert.equal(
      new Set(labels).size, labels.length,
      `${id}: two control entries share a label, so one of them is unreachable`,
    )

    for (const key of ['steps', 'notes']) {
      if (entry[key] === undefined) continue
      assert.ok(Array.isArray(entry[key]), `${id}: ${key} must be an array`)
      assert.ok(entry[key].length >= 1, `${id}: ${key} is present but empty`)
    }

    // Nothing outside the documented shape: an unknown key is either a typo for
    // a real one (and silently renders nothing) or a section the panel cannot
    // draw. Both are invisible without this.
    const allowed = new Set(['summary', 'whenToUse', 'controls', 'steps', 'notes'])
    const unknown = Object.keys(entry).filter(k => !allowed.has(k))
    assert.deepEqual(unknown, [], `${id}: unknown key(s) ${unknown.join(', ')}`)
  }
})

test('the house voice holds: no terminal punctuation, no emoji', () => {
  // "No terminal punctuation on UI strings" is a product-wide rule, and help
  // copy is the place it is easiest to lose — prose invites full stops. The
  // question mark and the exclamation are caught too; neither belongs here.
  const EMOJI = /\p{Extended_Pictographic}/u
  for (const [id, entry] of Object.entries(HELP)) {
    const strings = [
      entry.summary,
      ...entry.whenToUse,
      ...(entry.steps ?? []),
      ...(entry.notes ?? []),
      ...entry.controls.flatMap(c => [c.label, c.text]),
    ]
    for (const s of strings) {
      assert.ok(
        !/[.!?]$/.test(s.trim()),
        `${id}: string ends with terminal punctuation — "${s}"`,
      )
      assert.ok(!EMOJI.test(s), `${id}: string carries an emoji — "${s}"`)
    }
  }
})

test('helpFor returns null rather than a stub for an unknown window', () => {
  // The harness hides the ? button on null. A stub would give every window a
  // button that opens an empty panel, which is worse than no button.
  assert.equal(helpFor('no-such-window'), null)
  assert.ok(helpFor('soft-clipper'))
})
