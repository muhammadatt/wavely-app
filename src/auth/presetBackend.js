/**
 * The account backend for plugin presets: the signed-in user's rows in
 * `public.user_presets`, read and written with their own session.
 *
 * Row-level security restricts every query to the user's rows, so nothing
 * here filters by user for safety; `user_id` is sent on insert for clarity
 * (the column defaults to auth.uid() anyway).
 *
 * The store (src/audio/pluginPresets/store.js) keeps the in-memory mirror and
 * the write journal; this file only talks to the database.
 */

const TABLE = 'user_presets'
const UNIQUE_VIOLATION = '23505'

function saveError(preset, error) {
  return new Error(`Could not save “${preset.name}”: ${error.message}`)
}

export function createAccountPresetBackend(client, userId) {
  /** Update a row by id; resolves its id, or null when no such row exists. */
  async function updateById(id, fields) {
    const { data, error } = await client.from(TABLE).update(fields).eq('id', id).select('id')
    if (error) throw new Error(`Could not save “${fields.name}”: ${error.message}`)
    return data?.[0]?.id ?? null
  }

  return {
    kind: 'account',
    canSave: true,

    // Ids are minted here rather than by the database so the menu can select
    // a just-saved preset before the write lands.
    makeId: () => globalThis.crypto.randomUUID(),

    async load() {
      const { data, error } = await client
        .from(TABLE)
        .select('id, plugin_id, name, params')
        .order('created_at', { ascending: true })
      if (error) throw new Error(`Could not load your presets: ${error.message}`)
      const byPlugin = new Map()
      for (const row of data ?? []) {
        if (!byPlugin.has(row.plugin_id)) byPlugin.set(row.plugin_id, [])
        byPlugin.get(row.plugin_id).push({ id: row.id, name: row.name, params: row.params })
      }
      return byPlugin
    },

    /**
     * Save one preset; resolves the id of the row actually written.
     *
     * ⚠ NOT AN UPSERT ON THE NAME. An upsert that carries an id rewrites the
     * conflicting row's primary key to the saving tab's new uuid, so a second
     * tab holding the old id deletes nothing and reports success. And names
     * are unique case-INsensitively (the store matches them that way, and so
     * does the unique index), which a column conflict target cannot express.
     *
     * So: a preset the mirror already had is UPDATED by id; a new one is
     * INSERTED; and if the insert loses a race to another tab that saved the
     * same name, the existing row is updated instead and ITS id is returned
     * for the store to adopt.
     */
    async save(pluginId, preset, { existing = false } = {}) {
      const fields = { name: preset.name, params: preset.params }
      if (existing) {
        const id = await updateById(preset.id, fields)
        if (id) return id
        // Deleted elsewhere since this tab loaded it: fall through and re-create.
      }
      const { error } = await client
        .from(TABLE)
        .insert({ id: preset.id, user_id: userId, plugin_id: pluginId, ...fields })
      if (!error) return preset.id
      if (error.code !== UNIQUE_VIOLATION) throw saveError(preset, error)

      const { data, error: findError } = await client
        .from(TABLE)
        .select('id, name')
        .eq('plugin_id', pluginId)
      if (findError) throw saveError(preset, findError)
      const row = (data ?? []).find(r => r.name.toLowerCase() === preset.name.toLowerCase())
      if (!row) throw saveError(preset, error)
      const id = await updateById(row.id, fields)
      if (!id) throw saveError(preset, error)
      return id
    },

    async remove(pluginId, presetId) {
      const { error } = await client.from(TABLE).delete().eq('id', presetId)
      if (error) throw new Error(`Could not delete the preset: ${error.message}`)
    },
  }
}
