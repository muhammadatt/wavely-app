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

test('the shape holds: copy, a search description, highlights, specs', () => {
  for (const [id, p] of Object.entries(MARKETING)) {
    for (const k of ['eyebrow', 'headline', 'description']) assert.equal(typeof p[k], 'string', `${id}.${k}`)
    assert.ok(p.description.length <= 160, `${id}: description is ${p.description.length} characters (search results cut at ~160)`)
    assert.ok(Array.isArray(p.pitch) && p.pitch.length >= 1 && p.pitch.length <= 2, `${id}.pitch`)
    assert.ok(p.highlights.length >= 3 && p.highlights.length <= 6, `${id}.highlights`)
    for (const h of p.highlights) assert.ok(h.title && h.text, `${id}: highlight needs title and text`)
    for (const s of p.specs) assert.ok(s.label && s.value, `${id}: spec needs label and value`)
    if (p.feature) assert.ok(FEATURES[p.feature], `${id}: unknown plan feature ${p.feature}`)
    for (const r of p.related ?? []) assert.ok(MARKETING[r] && r !== id, `${id}: related ${r} has no page`)
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
