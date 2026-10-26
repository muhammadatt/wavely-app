import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createUsageRecorder, createBlockResolver } from '../lib/usage.js'

/** Just enough of the supabase-js query builder for lib/usage.js. */
function fakeAdmin({ profiles = {}, failInsert = false, failSelect = false } = {}) {
  const calls = { inserts: [], deletes: [], selects: 0 }
  return {
    calls,
    from(table) {
      return {
        insert: async row => {
          if (failInsert) return { error: { message: 'insert broke' } }
          calls.inserts.push({ table, row })
          return { error: null }
        },
        delete: () => ({
          lt: async (column, value) => {
            calls.deletes.push({ table, column, value })
            return { error: null }
          },
        }),
        select: () => ({
          eq: (_column, id) => ({
            maybeSingle: async () => {
              calls.selects++
              if (failSelect) return { data: null, error: { message: 'db down' } }
              return { data: id in profiles ? { blocked_at: profiles[id] } : null, error: null }
            },
          }),
        }),
      }
    },
  }
}

function quietly(fn) {
  const orig = console.error
  console.error = () => {}
  return Promise.resolve(fn()).finally(() => { console.error = orig })
}

test('record writes one normalised usage row', async () => {
  const admin = fakeAdmin()
  const usage = createUsageRecorder(admin)
  await usage.record({
    userId: 'u1', ip: '203.0.113.9', feature: 'autoLevel', mode: 'preview',
    audioSeconds: 28.44, uploadBytes: 12345.6, outcome: 'ok', durationMs: 812.4,
  })
  assert.deepEqual(admin.calls.inserts, [{
    table: 'usage_events',
    row: {
      user_id: 'u1', ip: '203.0.113.9', feature: 'autoLevel', mode: 'preview',
      audio_seconds: 28.44, upload_bytes: 12346, outcome: 'ok', duration_ms: 812,
    },
  }])
})

test('record: unknowns become null, no admin is a no-op, a failed write never throws', async () => {
  const admin = fakeAdmin()
  await createUsageRecorder(admin).record({ feature: 'mastering', outcome: 'error', audioSeconds: NaN })
  assert.deepEqual(admin.calls.inserts[0].row, {
    user_id: null, ip: null, feature: 'mastering', mode: null,
    audio_seconds: null, upload_bytes: null, outcome: 'error', duration_ms: null,
  })

  await createUsageRecorder(null).record({ feature: 'mastering', outcome: 'ok' })
  assert.equal(createUsageRecorder(null).enabled, false)

  await quietly(() => createUsageRecorder(fakeAdmin({ failInsert: true })).record({ feature: 'x', outcome: 'ok' }))
})

test('prune deletes rows older than the retention window; 0 keeps everything', async () => {
  const admin = fakeAdmin()
  const now = Date.parse('2026-10-26T00:00:00Z')
  const usage = createUsageRecorder(admin, { now: () => now })
  await usage.prune(90)
  assert.deepEqual(admin.calls.deletes, [{ table: 'usage_events', column: 'created_at', value: '2026-07-28T00:00:00.000Z' }])
  await usage.prune(0)
  assert.equal(admin.calls.deletes.length, 1)
})

test('isBlocked reads profiles.blocked_at and caches per user for its TTL', async () => {
  let clock = 0
  const admin = fakeAdmin({ profiles: { bad: '2026-10-26T00:00:00Z', good: null } })
  const isBlocked = createBlockResolver(admin, { ttlMs: 60_000, now: () => clock })
  assert.equal(await isBlocked('bad'), true)
  assert.equal(await isBlocked('good'), false)
  assert.equal(await isBlocked('nobody'), false)
  assert.equal(admin.calls.selects, 3)

  clock = 59_000
  await isBlocked('bad')
  assert.equal(admin.calls.selects, 3, 'cached')
  clock = 61_000
  await isBlocked('bad')
  assert.equal(admin.calls.selects, 4, 're-read after the TTL — a block lands within a minute')
})

test('a failed block lookup fails OPEN, and is not cached', async () => {
  const admin = fakeAdmin({ failSelect: true })
  const isBlocked = createBlockResolver(admin)
  await quietly(async () => {
    assert.equal(await isBlocked('u1'), false)
    assert.equal(await isBlocked('u1'), false)
  })
  assert.equal(admin.calls.selects, 2)
  assert.equal(await createBlockResolver(null)('u1'), false)
})
