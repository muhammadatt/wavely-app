/**
 * Shared listens in Supabase (supabase/migrations/20261125000000_shares.sql).
 * Takes the client so it can be driven by a fake under `node --test`.
 *
 *   create   row (not ready) → upload both takes → mark ready
 *   get      one ready share by id (the `get_share` RPC: anyone with the link)
 *   listOwn  the signed-in user's shares, newest first
 *   remove   both takes, then the row
 */
import { SHARE_BUCKET, newShareId, normalizeShareRow, sharePaths } from '../audio/shareRecord.js'

/** Supabase's error, as an Error whose message a toast can show. */
function fail(error, fallback) {
  const message = error?.message || fallback
  // The limit trigger and the paid-plan policy are the two refusals a user can hit.
  if (/Share limit/i.test(message)) return new Error(message)
  if (/row-level security|violates/i.test(message)) return new Error('Sharing needs Pro — your plan may have changed. Reload and try again.')
  return new Error(message)
}

export function createShareApi(client, { newId = newShareId } = {}) {
  const bucket = () => client.storage.from(SHARE_BUCKET)

  function publicUrl(path) {
    return bucket().getPublicUrl(path).data.publicUrl
  }

  function audioUrls(id) {
    const p = sharePaths(id)
    return { off: publicUrl(p.off), on: publicUrl(p.on) }
  }

  /**
   * @param {{ title, note, chain, seconds, levelDb: { off, on }, off: Blob, on: Blob }} share
   * @param {{ onStage?: (stage: 'record'|'upload'|'finish') => void }} [opts]
   * @returns {Promise<string>} the new share's id
   */
  async function create(share, { onStage } = {}) {
    const id = newId()
    onStage?.('record')
    const { error: insertError } = await client.from('shares').insert({
      id,
      title: share.title,
      note: share.note,
      chain: share.chain,
      seconds: share.seconds,
      level_off_db: Number.isFinite(share.levelDb?.off) ? share.levelDb.off : null,
      level_on_db: Number.isFinite(share.levelDb?.on) ? share.levelDb.on : null,
    })
    if (insertError) throw fail(insertError, 'Could not create the share')

    try {
      onStage?.('upload')
      const paths = sharePaths(id)
      for (const side of ['off', 'on']) {
        const { error } = await bucket().upload(paths[side], share[side], {
          contentType: 'audio/mpeg', cacheControl: '31536000', upsert: false,
        })
        if (error) throw fail(error, 'Could not upload the audio')
      }
      onStage?.('finish')
      const { error: readyError } = await client.from('shares').update({ ready: true }).eq('id', id)
      if (readyError) throw fail(readyError, 'Could not finish the share')
      return id
    } catch (err) {
      // Leave nothing half-made behind: what was uploaded, then the row.
      await remove(id).catch(() => {})
      throw err
    }
  }

  /** A ready share by id, normalised, with its audio URLs — or null. */
  async function get(id) {
    const { data, error } = await client.rpc('get_share', { share_id: id })
    if (error) throw fail(error, 'Could not load the share')
    const row = normalizeShareRow(Array.isArray(data) ? data[0] : data)
    return row ? { ...row, audio: audioUrls(row.id) } : null
  }

  async function listOwn() {
    const { data, error } = await client.from('shares')
      .select('id, title, seconds, ready, created_at')
      .order('created_at', { ascending: false })
    if (error) throw fail(error, 'Could not list your shares')
    return (data ?? []).map(r => ({ id: r.id, title: r.title, seconds: Number(r.seconds), ready: r.ready, createdAt: r.created_at }))
  }

  async function remove(id) {
    const p = sharePaths(id)
    const { error: storageError } = await bucket().remove([p.off, p.on])
    if (storageError) throw fail(storageError, 'Could not delete the audio')
    const { error } = await client.from('shares').delete().eq('id', id)
    if (error) throw fail(error, 'Could not delete the share')
  }

  return { create, get, listOwn, remove, audioUrls }
}
