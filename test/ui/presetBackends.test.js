import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  resetPluginPresets, setPresetBackend, presetBackendKind, canSaveUserPresets,
  saveUserPreset, deleteUserPreset, listPresets, onPresetsChanged, onPresetError,
} from '../../src/audio/pluginPresets/store.js'
import { registerPluginPresets, OPTO_SMOOTH_PRESET_PLUGIN } from '../../src/audio/pluginPresets/index.js'
import { createAccountPresetBackend } from '../../src/auth/presetBackend.js'

const PLUGIN = OPTO_SMOOTH_PRESET_PLUGIN
const tick = () => new Promise(r => setTimeout(r, 5))

function fresh() {
  resetPluginPresets()
  registerPluginPresets()
}

const userNames = () => listPresets(PLUGIN).filter(p => p.source === 'user').map(p => p.name)

/**
 * A supabase-js query builder stand-in over an in-memory table with the real
 * table's rules: unique (plugin, lower(name)) — 23505 on a clash — and ids
 * that never change on update. `fail(op, row)` returning true fails that write.
 */
function fakeSupabase(rows = [], { fail = () => false, holdLoads = false } = {}) {
  const calls = []
  const heldLoads = []
  const clash = (row, exceptId) =>
    rows.some(r => r.id !== exceptId && r.plugin_id === row.plugin_id && r.name.toLowerCase() === row.name.toLowerCase())
  const client = {
    from(table) {
      assert.equal(table, 'user_presets')
      return {
        select() {
          const snapshot = () => rows.map(r => ({ ...r }))
          return {
            order: () => {
              const data = snapshot() // what the SELECT sees is fixed when it runs
              if (!holdLoads) return Promise.resolve({ data, error: null })
              return new Promise(resolve => heldLoads.push(() => resolve({ data, error: null })))
            },
            eq: async (col, val) => ({ data: snapshot().filter(r => r[col] === val), error: null }),
          }
        },
        async insert(row) {
          calls.push(['insert', row])
          if (fail('insert', row)) return { error: { message: 'permission denied' } }
          if (clash(row)) return { error: { code: '23505', message: 'duplicate key' } }
          rows.push({ ...row })
          return { error: null }
        },
        update(fields) {
          return {
            eq: (col, id) => ({
              select: async () => {
                calls.push(['update', id, fields])
                if (fail('update', { id, ...fields })) return { data: null, error: { message: 'permission denied' } }
                const row = rows.find(r => r.id === id)
                if (!row) return { data: [], error: null }
                Object.assign(row, fields)
                return { data: [{ id }], error: null }
              },
            }),
          }
        },
        delete() {
          return {
            eq: async (col, id) => {
              calls.push(['delete', id])
              if (fail('delete', { id })) return { error: { message: 'permission denied' } }
              const i = rows.findIndex(r => r.id === id)
              if (i >= 0) rows.splice(i, 1)
              return { error: null }
            },
          }
        },
      }
    },
  }
  return { client, rows, calls, releaseLoads: () => heldLoads.splice(0).forEach(f => f()) }
}

const userIds = () => listPresets(PLUGIN).filter(p => p.source === 'user').map(p => p.id)

test('the default backend is local and unchanged', () => {
  fresh()
  assert.equal(presetBackendKind(), 'local')
  assert.equal(canSaveUserPresets(), true)
})

test("'none' empties the user collection and refuses to save", () => {
  fresh()
  setPresetBackend('none')
  assert.deepEqual(userNames(), [])
  assert.equal(canSaveUserPresets(), false)
  assert.throws(
    () => saveUserPreset(PLUGIN, 'Mine', {}),
    err => err.code === 'sign_in_required',
  )
})

test('account backend: loads, inserts new names, updates known ones by id, deletes', async () => {
  fresh()
  const db = fakeSupabase([
    { id: 'row-1', plugin_id: PLUGIN, name: 'Warm vocal', params: {} },
    { id: 'row-2', plugin_id: 'other-plugin', name: 'Elsewhere', params: {} },
  ])
  let changes = 0
  onPresetsChanged(() => { changes++ })
  setPresetBackend(createAccountPresetBackend(db.client, 'user-1'))
  assert.equal(presetBackendKind(), 'account')
  await tick()
  assert.deepEqual(userNames(), ['Warm vocal'])
  assert.ok(changes >= 2, 'switch and load both notify')

  const saved = saveUserPreset(PLUGIN, 'Narration', {})
  assert.match(saved.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(userNames(), ['Warm vocal', 'Narration'], 'in the menu before the write lands')
  await tick()
  assert.equal(db.calls.at(-1)[0], 'insert')
  assert.deepEqual(
    { id: db.calls.at(-1)[1].id, user_id: db.calls.at(-1)[1].user_id, name: db.calls.at(-1)[1].name },
    { id: saved.id, user_id: 'user-1', name: 'Narration' },
  )

  // A different case is the same preset: updated by its id, never a second insert.
  const again = saveUserPreset(PLUGIN, 'narration', {})
  assert.equal(again.id, saved.id)
  await tick()
  assert.deepEqual(db.calls.at(-1).slice(0, 2), ['update', saved.id])
  assert.equal(db.rows.filter(r => r.plugin_id === PLUGIN).length, 2)
  assert.deepEqual(userNames(), ['Warm vocal', 'narration'])

  assert.equal(deleteUserPreset(PLUGIN, 'row-1'), true)
  await tick()
  assert.deepEqual(db.calls.at(-1), ['delete', 'row-1'])
  assert.deepEqual(userNames(), ['narration'])
})

test('a save during the initial load survives a load that answered from before it', async () => {
  fresh()
  const db = fakeSupabase([{ id: 'row-1', plugin_id: PLUGIN, name: 'Old', params: {} }], { holdLoads: true })
  setPresetBackend(createAccountPresetBackend(db.client, 'user-1'))
  await tick() // the SELECT has run; its answer is held
  saveUserPreset(PLUGIN, 'New', {})
  await tick() // the insert has landed
  db.releaseLoads()
  await tick()
  assert.deepEqual(userNames(), ['Old', 'New'])
})

test('a failed write reloads the truth and never undoes a neighbour that succeeded', async () => {
  fresh()
  const db = fakeSupabase(
    [{ id: 'row-1', plugin_id: PLUGIN, name: 'Keep me', params: {} }],
    { fail: (op, row) => row.name === 'Doomed' || (op === 'delete' && row.id === 'row-1') },
  )
  const errors = []
  onPresetError(e => errors.push(e))
  setPresetBackend(createAccountPresetBackend(db.client, 'user-1'))
  await tick()

  saveUserPreset(PLUGIN, 'Doomed', {})
  saveUserPreset(PLUGIN, 'Fine', {})
  assert.deepEqual(userNames(), ['Keep me', 'Doomed', 'Fine'])
  await tick()
  assert.deepEqual(userNames(), ['Keep me', 'Fine'], 'only the failed save is gone')
  assert.equal(errors[0].op, 'save')
  assert.match(errors[0].message, /Could not save “Doomed”: permission denied/)

  // A failed delete comes back; a successful one elsewhere stays gone.
  const fineId = userIds()[1]
  deleteUserPreset(PLUGIN, 'row-1')
  deleteUserPreset(PLUGIN, fineId)
  assert.deepEqual(userNames(), [])
  await tick()
  assert.deepEqual(userNames(), ['Keep me'])
  assert.equal(errors.at(-1).op, 'delete')
})

test('losing a name race to another tab adopts that row’s id instead of rewriting it', async () => {
  fresh()
  const db = fakeSupabase([])
  setPresetBackend(createAccountPresetBackend(db.client, 'user-1'))
  await tick()
  // Another tab saves "Shared" after this one loaded.
  db.rows.push({ id: 'other-tab-row', plugin_id: PLUGIN, name: 'shared', params: {} })

  const saved = saveUserPreset(PLUGIN, 'Shared', {})
  assert.notEqual(saved.id, 'other-tab-row')
  await tick()
  assert.deepEqual(userIds(), ['other-tab-row'], 'the mirror now holds the canonical id')
  assert.deepEqual(db.rows.map(r => r.id), ['other-tab-row'], 'the row kept its primary key')

  deleteUserPreset(PLUGIN, 'other-tab-row')
  await tick()
  assert.equal(db.rows.length, 0)
})

test('an update to a row deleted elsewhere re-creates it', async () => {
  fresh()
  const db = fakeSupabase([{ id: 'row-1', plugin_id: PLUGIN, name: 'Gone', params: {} }])
  setPresetBackend(createAccountPresetBackend(db.client, 'user-1'))
  await tick()
  db.rows.length = 0 // deleted in another tab
  saveUserPreset(PLUGIN, 'Gone', {})
  await tick()
  assert.deepEqual(db.rows.map(r => r.id), ['row-1'])
})

test('switching user drops a load still in flight for the previous one', async () => {
  fresh()
  let release
  const slow = {
    kind: 'account', canSave: true,
    load: () => new Promise(r => { release = r }),
    save: async () => {}, remove: async () => {},
  }
  setPresetBackend(slow)
  setPresetBackend('none')
  release(new Map([[PLUGIN, [{ id: 'x', name: 'Ghost', params: {} }]]]))
  await tick()
  assert.deepEqual(userNames(), [])
})
