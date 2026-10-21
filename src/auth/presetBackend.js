/**
 * The account backend for plugin presets: the signed-in user's rows in
 * `public.user_presets`, read and written with their own session.
 *
 * Row-level security restricts every query to the user's rows, so nothing
 * here filters by user for safety — `user_id` is sent on writes only because
 * the upsert's conflict target includes it.
 *
 * The store (src/audio/pluginPresets/store.js) keeps the in-memory mirror and
 * the rollback; this file only talks to the database.
 */

const TABLE = 'user_presets'

export function createAccountPresetBackend(client, userId) {
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
     * Upsert on (user, plugin, name): saving under a name another tab created
     * since this one loaded overwrites that row rather than failing on the
     * unique constraint — the same overwrite rule the store applies locally.
     */
    async save(pluginId, preset) {
      const { error } = await client
        .from(TABLE)
        .upsert(
          { id: preset.id, user_id: userId, plugin_id: pluginId, name: preset.name, params: preset.params },
          { onConflict: 'user_id,plugin_id,name' },
        )
      if (error) throw new Error(`Could not save “${preset.name}”: ${error.message}`)
    },

    async remove(pluginId, presetId) {
      const { error } = await client.from(TABLE).delete().eq('id', presetId)
      if (error) throw new Error(`Could not delete the preset: ${error.message}`)
    },
  }
}
