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

/** A supabase-js query builder stand-in over an in-memory table. */
function fakeSupabase(rows = [], { failWrites = false } = {}) {
  const calls = []
  const client = {
    from(table) {
      assert.equal(table, 'user_presets')
      return {
        select() {
          return { order: async () => ({ data: rows.map(r => ({ ...r })), error: null }) }
        },
        async upsert(row, opts) {
          calls.push(['upsert', row, opts])
          if (failWrites) return { error: { message: 'permission denied' } }
          const i = rows.findIndex(r => r.plugin_id === row.plugin_id && r.name === row.name)
          if (i >= 0) rows[i] = { ...row }
          else rows.push({ ...row })
          return { error: null }
        },
        delete() {
          return {
            eq: async (col, id) => {
              calls.push(['delete', id])
              if (failWrites) return { error: { message: 'permission denied' } }
              const i = rows.findIndex(r => r.id === id)
              if (i >= 0) rows.splice(i, 1)
              return { error: null }
            },
          }
        },
      }
    },
  }
  return { client, rows, calls }
}

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

test('account backend: loads the rows, saves with a uuid, overwrites by name, deletes', async () => {
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
  const [, row, opts] = db.calls.at(-1)
  assert.deepEqual({ id: row.id, user_id: row.user_id, plugin_id: row.plugin_id, name: row.name },
    { id: saved.id, user_id: 'user-1', plugin_id: PLUGIN, name: 'Narration' })
  assert.deepEqual(opts, { onConflict: 'user_id,plugin_id,name' })

  // Same name: overwrite in place, same id.
  const again = saveUserPreset(PLUGIN, 'narration', {})
  assert.equal(again.id, saved.id)
  assert.equal(userNames().length, 2)

  assert.equal(deleteUserPreset(PLUGIN, 'row-1'), true)
  await tick()
  assert.deepEqual(db.calls.at(-1), ['delete', 'row-1'])
  assert.deepEqual(userNames(), ['narration'])
})

test('a failed remote write is rolled back and reported', async () => {
  fresh()
  const db = fakeSupabase([{ id: 'row-1', plugin_id: PLUGIN, name: 'Keep me', params: {} }], { failWrites: true })
  const errors = []
  onPresetError(e => errors.push(e))
  setPresetBackend(createAccountPresetBackend(db.client, 'user-1'))
  await tick()

  saveUserPreset(PLUGIN, 'Doomed', {})
  assert.deepEqual(userNames(), ['Keep me', 'Doomed'])
  await tick()
  assert.deepEqual(userNames(), ['Keep me'])
  assert.equal(errors[0].op, 'save')
  assert.match(errors[0].message, /Could not save “Doomed”: permission denied/)

  deleteUserPreset(PLUGIN, 'row-1')
  assert.deepEqual(userNames(), [])
  await tick()
  assert.deepEqual(userNames(), ['Keep me'])
  assert.equal(errors[1].op, 'delete')
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
