import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  MARKETING, marketingSlug, marketingIdForSlug, marketingUrl, publishedMarketingIds,
} from '../../src/content/marketing/index.js'
import { HELP, HELP_META, helpSlug } from '../../src/content/help/index.js'
import { FEATURES } from '../../src/auth/plans.js'
import { marketingSlugFromPath } from '../../src/marketing/route.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const json = p => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))

/**
 * The marketing pages borrow the help pages' control text and screenshots and
 * play audio the render script made. None of that can be checked by looking at
 * the page, so the links between them are pinned here.
 */

test('every marketing page is an effect with a help entry, at the help page’s slug', () => {
  for (const id of Object.keys(MARKETING)) {
    assert.ok(HELP[id] && HELP_META[id], `${id}: no help entry`)
    assert.equal(marketingSlug(id), helpSlug(id))
    assert.equal(marketingIdForSlug(marketingSlug(id)), id)
    assert.equal(marketingUrl(id), `/plugins/${helpSlug(id)}/`)
  }
})

test('the shape holds: copy, a search description, the overview and its features, specs', () => {
  for (const [id, p] of Object.entries(MARKETING)) {
    for (const k of ['eyebrow', 'headline', 'description']) assert.equal(typeof p[k], 'string', `${id}.${k}`)
    assert.ok(p.description.length <= 160, `${id}: description is ${p.description.length} characters (search results cut at ~160)`)
    assert.ok(Array.isArray(p.pitch) && p.pitch.length >= 1 && p.pitch.length <= 2, `${id}.pitch`)
    assert.ok(Array.isArray(p.overview) && p.overview.length === 2, `${id}.overview: design 3a is a lead paragraph and one more`)
    assert.ok(Array.isArray(p.features) && p.features.length >= 6 && p.features.length <= 16, `${id}.features`)
    assert.equal(new Set(p.features.map(f => f.title)).size, p.features.length, `${id}: a feature title is listed twice`)
    for (const f of p.features) {
      assert.ok(f && typeof f.title === 'string' && typeof f.text === 'string', `${id}: a feature is { title, text }`)
      assert.ok(f.title.split(/\s+/).length <= 5, `${id}: “${f.title}” — a title is a few words`)
      // The list's voice: a lower-case clause after the title, no full stop.
      // (A product or control name may open it: “Peak Reduction does…”.)
      assert.ok(!/[.]$/.test(f.text) && !f.text.includes('\n'), `${id}: “${f.text}” — one line, no full stop`)
    }
    for (const s of p.specs) assert.ok(s.label && s.value, `${id}: spec needs label and value`)
    if (p.feature) assert.ok(FEATURES[p.feature], `${id}: unknown plan feature ${p.feature}`)
  }
})

test('every hotspot is a documented control with a box on the screenshot', () => {
  for (const [id, p] of Object.entries(MARKETING)) {
    const shots = json(`src/content/help/shots/${id}.json`)
    assert.ok(existsSync(join(ROOT, 'public', shots.panel.src)), `${id}: panel screenshot missing`)
    const seen = new Set()
    for (const h of p.hotspots) {
      assert.ok(!seen.has(h.shot), `${id}: hotspot ${h.shot} twice`)
      seen.add(h.shot)
      assert.ok(HELP[id].controls.some(c => c.shot === h.shot), `${id}: no help control carries shot ${h.shot}`)
      const at = shots.controls[h.shot]?.at
      assert.ok(at, `${id}: ${h.shot} has no box — re-run npm run help:shots -- ${id}`)
      assert.ok(at.x >= 0 && at.y >= 0 && at.x + at.w <= shots.panel.w + 1 && at.y + at.h <= shots.panel.h + 1,
        `${id}: ${h.shot}'s box falls outside the panel`)
    }
  }
})

test('samples are unique, briefed, and every rendered one has both takes on disk', () => {
  for (const [id, p] of Object.entries(MARKETING)) {
    const ids = p.samples.map(s => s.id)
    assert.equal(new Set(ids).size, ids.length, `${id}: duplicate sample id`)
    for (const s of p.samples) {
      assert.match(s.id, /^[a-z0-9-]+$/, `${id}: sample id ${s.id} must be a plain file name`)
      for (const k of ['title', 'text', 'setting', 'brief']) assert.ok(s[k], `${id}/${s.id}: ${k}`)
    }
    const path = `src/content/marketing/audio/${id}.json`
    if (!existsSync(join(ROOT, path))) continue
    for (const [sid, a] of Object.entries(json(path).samples)) {
      assert.ok(ids.includes(sid), `${id}: rendered sample ${sid} is not listed`)
      for (const take of [a.on, a.off]) assert.ok(existsSync(join(ROOT, 'public', take)), `${id}: ${take} missing`)
    }
  }
})

test('production lists no page for a dev-only effect', () => {
  for (const id of publishedMarketingIds(false)) assert.notEqual(HELP_META[id].release, 'dev')
})

test('the route reads the slug from the path', () => {
  assert.equal(marketingSlugFromPath('/plugins/'), null)
  assert.equal(marketingSlugFromPath('/plugins'), null)
  assert.equal(marketingSlugFromPath('/plugins/voxpressor/'), 'voxpressor')
  assert.equal(marketingSlugFromPath('/plugins/voxpressor'), 'voxpressor')
  assert.equal(marketingSlugFromPath('/plugins/%/'), '%')
  assert.equal(marketingSlugFromPath('/help/voxpressor/'), null)
})

test('every sample’s try-out link opens that sample in the editor, and nothing else does', async () => {
  const { tryOutUrl, tryOutFromSearch, sampleDryUrl } = await import('../../src/content/marketing/index.js')
  for (const [id, p] of Object.entries(MARKETING)) {
    for (const s of p.samples) {
      const url = tryOutUrl(id, s.id)
      const got = tryOutFromSearch(url.slice(url.indexOf('?')))
      assert.equal(got.windowId, id)
      assert.equal(got.sample.id, s.id)
      assert.deepEqual(got.sample.settings, s.settings ?? {})
      assert.equal(got.url, sampleDryUrl(id, s.id))
      // The dry take is what the editor loads: the render script's `off` file.
      const audioPath = join(ROOT, 'src/content/marketing/audio', `${id}.json`)
      if (existsSync(audioPath)) {
        const rendered = json(`src/content/marketing/audio/${id}.json`).samples[s.id]
        if (rendered) assert.equal(rendered.off, got.url)
      }
    }
    // No clip named: the page's first sample.
    assert.equal(tryOutFromSearch(`?try=${marketingSlug(id)}`).sample.id, p.samples[0].id)
  }
  assert.equal(tryOutFromSearch(''), null)
  assert.equal(tryOutFromSearch('?try=no-such-effect'), null)
  assert.equal(tryOutFromSearch('?try=voxpressor&clip=nope'), null)
  // A clip is a name in the page's own list, never a path the editor would fetch.
  assert.equal(tryOutFromSearch('?try=voxpressor&clip=..%2F..%2Fsecret'), null)
  assert.equal(tryOutFromSearch('?try=opto-smooth'), null, 'the window id is not a slug')
})
