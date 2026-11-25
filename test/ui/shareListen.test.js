/**
 * Shared before / after listens (`/s/<id>`): the rules (src/audio/shareRecord.js),
 * the storage calls against a fake Supabase client (src/api/shares.js), and the
 * migration's plan check kept in step with the server's.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  newShareId, isShareId, sharePaths, listenUrl, openInEditorUrl, shareIdFromLocation,
  listenIdFromSearch, cleanShareText, defaultShareTitle, normalizeShareRow, gatedRmsDb,
  shareMp3Rate, SHARE_TITLE_MAX, SHARE_NOTE_MAX,
} from '../../src/audio/shareRecord.js'
import { createShareApi } from '../../src/api/shares.js'
import { ENTITLED_STATUSES, PAID_PLANS } from '../../server/lib/plans.js'
import { hasFeature } from '../../src/auth/plans.js'

test('share ids are 12 base62 characters and do not repeat', () => {
  const seen = new Set()
  for (let i = 0; i < 2000; i++) {
    const id = newShareId()
    assert.ok(isShareId(id), id)
    seen.add(id)
  }
  assert.equal(seen.size, 2000)
  // Rejection sampling: bytes ≥ 248 are skipped, never folded onto low characters.
  let calls = 0
  const id = newShareId((n) => { calls++; return new Uint8Array(n).fill(calls === 1 ? 255 : 0) })
  assert.equal(id, 'AAAAAAAAAAAA')
})

test('links and paths', () => {
  assert.deepEqual(sharePaths('abcdefABCDEF'), { off: 'abcdefABCDEF/dry.mp3', on: 'abcdefABCDEF/wet.mp3' })
  assert.equal(listenUrl('abcdefABCDEF', 'https://crisp.fm/'), 'https://crisp.fm/s/abcdefABCDEF')
  assert.equal(openInEditorUrl('abcdefABCDEF'), '/?listen=abcdefABCDEF')
  assert.equal(shareIdFromLocation('/s/abcdefABCDEF'), 'abcdefABCDEF')
  assert.equal(shareIdFromLocation('/s/abcdefABCDEF/'), 'abcdefABCDEF')
  assert.equal(shareIdFromLocation('/s/', '?id=abcdefABCDEF'), 'abcdefABCDEF')
  assert.equal(shareIdFromLocation('/s/short'), null)
  assert.equal(shareIdFromLocation('/s/abcdefABCDEF/x'), null)
  assert.equal(listenIdFromSearch('?listen=abcdefABCDEF&x=1'), 'abcdefABCDEF')
  assert.equal(listenIdFromSearch('?listen=../../etc'), null)
})

test('the listen page route matches in dev and on Vercel', () => {
  const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'))
  assert.ok(vercel.rewrites.some(r => r.source === '/s/:id' && r.destination === '/s/index.html'))
  const vite = readFileSync(new URL('../../vite.config.js', import.meta.url), 'utf8')
  assert.match(vite, /listen: fileURLToPath\(new URL\('\.\/s\/index\.html'/)
})

test('text is cleaned to what the table takes', () => {
  const { title, note } = cleanShareText(`  a\n b ${'x'.repeat(200)}`, `\r\n${'y'.repeat(900)}`)
  assert.equal(title.length, SHARE_TITLE_MAX)
  assert.ok(title.startsWith('a b '))
  assert.equal(note.length, SHARE_NOTE_MAX)
  assert.equal(defaultShareTitle('Chapter 04.wav'), 'Chapter 04')
  assert.equal(defaultShareTitle(''), 'Before / after')
})

test('a row is normalised, and a bad one refused', () => {
  const row = normalizeShareRow({
    id: 'abcdefABCDEF', title: ' Take 3 ', note: 'n', chain: { slots: [{ plugin: 'de-esser' }] },
    seconds: 12.5, level_off_db: -20.1, level_on_db: null, created_at: '2026-11-25T00:00:00Z',
  })
  assert.deepEqual(row.levelDb, { off: -20.1, on: null })
  assert.equal(row.title, 'Take 3')
  assert.equal(row.chain.slots.length, 1)
  assert.equal(normalizeShareRow({ id: 'bad', title: 'x', seconds: 1 }), null)
  assert.equal(normalizeShareRow({ id: 'abcdefABCDEF', title: '', seconds: 1 }), null)
  assert.deepEqual(normalizeShareRow({ id: 'abcdefABCDEF', title: 't', seconds: 1, chain: 'junk' }).chain, { slots: [] })
})

test('gated RMS: a full-scale sine reads −3 dB, silence is gated out', () => {
  const sr = 8000
  const ch = new Float32Array(sr * 2)
  for (let i = 0; i < sr; i++) ch[i] = Math.sin(2 * Math.PI * 200 * i / sr)
  assert.ok(Math.abs(gatedRmsDb([ch], sr) - -3.01) < 0.05)
  assert.equal(gatedRmsDb([new Float32Array(sr)], sr), -Infinity)
})

test('MP3 rates', () => {
  assert.equal(shareMp3Rate(44100), 44100)
  assert.equal(shareMp3Rate(48000), 48000)
  assert.equal(shareMp3Rate(88200), 44100)
  assert.equal(shareMp3Rate(96000), 48000)
})

function fakeClient({ failUpload = false } = {}) {
  const log = []
  const rows = new Map()
  const client = {
    log, rows,
    from(table) {
      const q = {
        insert(row) { log.push(['insert', table, row.id]); rows.set(row.id, { ...row, ready: false }); return Promise.resolve({ error: null }) },
        update(fields) { return { eq: (_k, id) => { log.push(['update', table, id, fields]); Object.assign(rows.get(id), fields); return Promise.resolve({ error: null }) } } },
        delete() { return { eq: (_k, id) => { log.push(['delete', table, id]); rows.delete(id); return Promise.resolve({ error: null }) } } },
        select() { return { order: () => Promise.resolve({ data: [...rows.values()].map(r => ({ ...r, created_at: 't' })), error: null }) } },
      }
      return q
    },
    storage: {
      from: () => ({
        upload(path) { log.push(['upload', path]); return Promise.resolve({ error: failUpload ? { message: 'too big' } : null }) },
        remove(paths) { log.push(['remove', ...paths]); return Promise.resolve({ error: null }) },
        getPublicUrl: path => ({ data: { publicUrl: `https://cdn.test/shares/${path}` } }),
      }),
    },
    rpc(name, args) {
      log.push(['rpc', name, args.share_id])
      const r = rows.get(args.share_id)
      return Promise.resolve({ data: r && r.ready ? [r] : [], error: null })
    },
  }
  return client
}

const SHARE = { title: 'T', note: '', chain: { slots: [{ plugin: 'de-esser' }] }, seconds: 3, levelDb: { off: -20, on: -18 }, off: 'dry', on: 'wet' }

test('create: row first, then both takes, then ready — and get serves it', async () => {
  const client = fakeClient()
  const api = createShareApi(client, { newId: () => 'abcdefABCDEF' })
  const stages = []
  const id = await api.create(SHARE, { onStage: s => stages.push(s) })
  assert.equal(id, 'abcdefABCDEF')
  assert.deepEqual(client.log.map(l => l.slice(0, 2).join(' ')), [
    'insert shares', 'upload abcdefABCDEF/dry.mp3', 'upload abcdefABCDEF/wet.mp3', 'update shares',
  ])
  assert.deepEqual(stages, ['record', 'upload', 'finish'])
  const got = await api.get(id)
  assert.equal(got.audio.on, 'https://cdn.test/shares/abcdefABCDEF/wet.mp3')
  assert.deepEqual(got.levelDb, { off: -20, on: -18 })
})

test('create: a failed upload leaves nothing behind', async () => {
  const client = fakeClient({ failUpload: true })
  const api = createShareApi(client, { newId: () => 'abcdefABCDEF' })
  await assert.rejects(api.create(SHARE), /too big/)
  assert.equal(client.rows.size, 0)
  const removeAt = client.log.findIndex(l => l[0] === 'remove')
  const deleteAt = client.log.findIndex(l => l[0] === 'delete')
  assert.ok(removeAt >= 0 && deleteAt > removeAt, 'objects are removed before the row (their policy checks it)')
})

test('a share that is not ready is not served', async () => {
  const client = fakeClient()
  client.rows.set('abcdefABCDEF', { id: 'abcdefABCDEF', title: 'x', seconds: 1, chain: { slots: [] }, ready: false })
  assert.equal(await createShareApi(client).get('abcdefABCDEF'), null)
})

test('the migration’s paid-plan check matches the server’s', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261125000000_shares.sql', import.meta.url), 'utf8')
  const statuses = /s\.status in \(([^)]*)\)/.exec(sql)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1))
  assert.deepEqual(new Set(statuses), ENTITLED_STATUSES)
  const plans = [...sql.matchAll(/s\.plan = '([^']+)'/g)].map(m => m[1])
  assert.deepEqual(plans, PAID_PLANS)
  // ...and the browser gate agrees that sharing is a paid feature.
  assert.equal(hasFeature('free', 'shareListen'), false)
  assert.equal(hasFeature('pro', 'shareListen'), true)
  // Unlisted: anon may call get_share and nothing else.
  assert.match(sql, /grant execute on function public\.get_share\(text\) to anon, authenticated/)
  assert.doesNotMatch(sql, /for select\s+to anon/)
})
