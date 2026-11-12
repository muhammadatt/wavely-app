import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  HELP, HELP_META, HELP_CATEGORIES, helpFor, helpUrl, publishedHelpIds,
} from '../../src/content/help/index.js'
import { helpIdFromPath } from '../../src/help/route.js'

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

/**
 * The help pages print a title and a category for each entry, and hide the
 * dev-only ones from production. Those repeat the registry's `label`,
 * `category` and `release` — the registry imports every faceplate, so the help
 * page cannot read it — and are read back out of its source here so the two
 * cannot drift.
 */
function registryOperations() {
  const src = readFileSync(join(ROOT, 'src/ui/registry.js'), 'utf8')
  const body = src.slice(src.indexOf('const ALL_OPERATIONS'))
  const ops = {}
  // Each operation starts at an `id:` line; its fields run to the next one.
  const chunks = body.split(/\n\s{4}id: /).slice(1)
  for (const chunk of chunks) {
    const id = /^'([^']+)'/.exec(chunk)[1]
    const label = /\n\s{4}label: '([^']+)'/.exec(chunk)?.[1]
    const cat = /\n\s{4}category: (null|'([^']+)')/.exec(chunk)
    const release = /\n\s{4}release: '([^']+)'/.exec(chunk)?.[1]
    ops[id] = { label, category: cat?.[2] ?? null, release }
  }
  return ops
}

test('every help entry has page metadata, and only help entries do', () => {
  assert.deepEqual(Object.keys(HELP_META).sort(), Object.keys(HELP).sort())
})

test('help page titles, categories and release gating match the registry', () => {
  const ops = registryOperations()
  const known = new Set(HELP_CATEGORIES.map(c => c.id))
  for (const [id, meta] of Object.entries(HELP_META)) {
    const op = ops[id]
    assert.ok(op, `${id}: no registry operation with this id`)
    assert.equal(meta.title, op.label, `${id}: help title differs from the registry label`)
    assert.equal(meta.category, op.category, `${id}: help category differs from the registry`)
    assert.equal(meta.release, op.release, `${id}: release gating differs from the registry`)
    assert.ok(known.has(meta.category), `${id}: category ${meta.category} has no heading on the index`)
  }
})

test('dev-only help pages are published only in dev builds', () => {
  const prod = new Set(publishedHelpIds(false))
  const dev = new Set(publishedHelpIds(true))
  assert.equal(dev.size, Object.keys(HELP).length)
  for (const [id, meta] of Object.entries(HELP_META)) {
    assert.equal(prod.has(id), meta.release !== 'dev', `${id}: wrong production visibility`)
  }
})

test('a help URL routes back to its own entry', () => {
  for (const id of Object.keys(HELP)) {
    assert.equal(helpIdFromPath(helpUrl(id)), id)
    assert.equal(helpIdFromPath(helpUrl(id).replace(/\/$/, '')), id)
  }
  assert.equal(helpIdFromPath('/help/'), null)
  assert.equal(helpIdFromPath('/help'), null)
  assert.equal(helpIdFromPath('/help/index.html'), 'index.html')
  assert.equal(helpIdFromPath('/'), null)
})
