import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  HELP, HELP_META, HELP_CATEGORIES, helpFor, helpUrl, publishedHelpIds, listedHelpIds,
  helpSlug, helpIdForSlug,
} from '../../src/content/help/index.js'
import { helpSlugFromPath } from '../../src/help/route.js'

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

    assert.ok(Array.isArray(entry.intro), `${id}: intro must be an array of paragraphs`)
    assert.ok(entry.intro.length >= 1 && entry.intro.length <= 3, `${id}: intro wants 1–3 paragraphs`)

    assert.ok(Array.isArray(entry.controls), `${id}: controls must be an array`)
    assert.ok(entry.controls.length >= 1, `${id}: no controls documented`)
    const CONTROL_KEYS = new Set(['label', 'text', 'group', 'details', 'range', 'default', 'shot'])
    for (const c of entry.controls) {
      assert.ok(c.label && typeof c.label === 'string', `${id}: a control has no label`)
      assert.ok(c.text && typeof c.text === 'string', `${id}: ${c.label} has no text`)
      for (const k of ['group', 'range', 'default', 'shot']) {
        if (c[k] !== undefined) assert.ok(typeof c[k] === 'string' && c[k], `${id}: ${c.label}.${k} must be a non-empty string`)
      }
      if (c.details !== undefined) {
        assert.ok(Array.isArray(c.details) && c.details.length, `${id}: ${c.label}.details must be a non-empty array`)
      }
      if (c.shot !== undefined) assert.match(c.shot, /^[a-z0-9-]+$/, `${id}: ${c.label}.shot must be a kebab-case data-help id`)
      const unknown = Object.keys(c).filter(k => !CONTROL_KEYS.has(k))
      assert.deepEqual(unknown, [], `${id}: ${c.label} has unknown key(s) ${unknown.join(', ')}`)
    }

    const labels = entry.controls.map(c => c.label)
    assert.equal(
      new Set(labels).size, labels.length,
      `${id}: two control entries share a label, so one of them is unreachable`,
    )

    assert.ok(Array.isArray(entry.quickStart), `${id}: quickStart must be an array`)
    assert.ok(entry.quickStart.length >= 2 && entry.quickStart.length <= 6, `${id}: quickStart wants 2–6 steps`)
    if (entry.notes !== undefined) {
      assert.ok(Array.isArray(entry.notes), `${id}: notes must be an array`)
      assert.ok(entry.notes.length >= 1, `${id}: notes is present but empty`)
    }

    // Nothing outside the documented shape: an unknown key is either a typo for
    // a real one (and silently renders nothing) or a section the page cannot
    // draw. Both are invisible without this.
    const allowed = new Set(['summary', 'intro', 'controls', 'quickStart', 'notes'])
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
      ...entry.intro,
      ...entry.quickStart,
      ...(entry.notes ?? []),
      ...entry.controls.flatMap(c => [c.label, c.text, c.group, c.range, c.default, ...(c.details ?? [])]),
    ]
    for (const s of strings.filter(x => x !== undefined)) {
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
    assert.equal(helpIdForSlug(helpSlugFromPath(helpUrl(id))), id)
    assert.equal(helpIdForSlug(helpSlugFromPath(helpUrl(id).replace(/\/$/, ''))), id)
  }
  assert.equal(helpSlugFromPath('/help/'), null)
  assert.equal(helpSlugFromPath('/help'), null)
  assert.equal(helpSlugFromPath('/'), null)
  assert.equal(helpIdForSlug('opto-smooth'), null, 'old window ids are not URLs')
})

test('page URLs are the product names, unique, and never an old window id', () => {
  const slugs = Object.keys(HELP_META).map(helpSlug)
  assert.equal(new Set(slugs).size, slugs.length, 'two pages share a URL')
  for (const slug of slugs) assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  assert.equal(helpUrl('opto-smooth'), '/help/la-vintage-2a/')
  assert.equal(helpUrl('fet-punch'), '/help/la-classic-76/')
  assert.equal(helpUrl('phatass'), '/help/phatss/')
})

test('the index and sidebar list shipping effects only, in every build', () => {
  const listed = new Set(listedHelpIds())
  for (const [id, meta] of Object.entries(HELP_META)) {
    assert.equal(listed.has(id), meta.release !== 'dev', `${id}: wrong listing`)
  }
})

test('screenshots live under the page slug', () => {
  const dir = join(HELP_DIR, 'shots')
  let files = []
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')) } catch { return }
  for (const f of files) {
    const id = f.replace(/\.json$/, '')
    const m = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    const prefix = `/help/shots/${helpSlug(id)}/`
    for (const img of [m.panel, ...Object.values(m.controls ?? {})].filter(Boolean)) {
      assert.ok(img.src.startsWith(prefix), `shots/${f}: ${img.src} is not under ${prefix}`)
    }
  }
})

/**
 * A control's `shot` names a `data-help` id the screenshot script crops. One
 * no panel carries would silently lose its picture on the next run.
 */
test('every control shot is a data-help id some panel carries', () => {
  const carried = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.vue')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/data-help="([^"]+)"/g)) carried.add(m[1])
      }
    }
  }
  walk(join(ROOT, 'src/components'))
  for (const [id, entry] of Object.entries(HELP)) {
    for (const c of entry.controls) {
      if (c.shot) assert.ok(carried.has(c.shot), `${id}: ${c.label} names shot "${c.shot}", which no panel carries as data-help`)
    }
  }
})

test('every screenshot manifest belongs to a help entry and names real shots', () => {
  const dir = join(HELP_DIR, 'shots')
  let files = []
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')) } catch { return }
  for (const f of files) {
    const id = f.replace(/\.json$/, '')
    assert.ok(HELP[id], `shots/${f} has no help entry`)
    const m = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    const shots = new Set(HELP[id].controls.map(c => c.shot).filter(Boolean))
    for (const k of Object.keys(m.controls ?? {})) {
      assert.ok(shots.has(k), `shots/${f}: crop "${k}" is no longer named by any control — re-run npm run help:shots -- ${id}`)
    }
  }
})
