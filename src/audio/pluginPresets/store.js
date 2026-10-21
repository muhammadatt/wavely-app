/**
 * Plugin preset store — plugin-agnostic, one small collection per plugin.
 *
 * A preset is a NAMED, COMPLETE SET OF PARAMS for one plugin. Two rules do
 * almost all of the work here, and both come from mistakes this codebase has
 * already made:
 *
 * 1. A PRESET CARRIES ONLY PARAMS, AND THE LIST IS DECLARED UP FRONT.
 *    `paramKeys` is a whitelist, and everything read or written goes through
 *    it. The failure it prevents is the one the resonance panel documents at
 *    length: DELTA, the per-zone delta and the selected zone are MONITORING
 *    and UI state, and `applyResonanceRegion` spreads its param object
 *    straight into the kernel — so a preset that round-tripped a monitoring
 *    mode would be one Apply away from rendering a difference signal into the
 *    timeline. A whitelist makes that unexpressible rather than merely
 *    discouraged.
 *
 * 2. A FACTORY PRESET STATES EVERY PARAM. It is not a partial over the
 *    plugin's defaults. Inheriting is how the soft clipper's knee anchor got
 *    silently re-derived by an edit that read as a UI preference: moving a
 *    default moved three curves that had been calibrated against the old one.
 *    A preset is a recorded operating point, so it has to survive its
 *    plugin's defaults moving underneath it. `definePluginPresets` throws on
 *    an incomplete factory preset rather than filling the gap in.
 *
 * User presets are normalised on the way in AND on the way out, so a preset
 * written by an older build cannot push an out-of-range value at a kernel —
 * the panel clamps its knobs, and a stored value never went through a knob.
 *
 * WHERE THEY ARE STORED is a pluggable BACKEND (`setPresetBackend`):
 *
 *   local    localStorage. The default, and what a build WITHOUT accounts uses —
 *            so a deployment with no Supabase configured behaves as it always has.
 *   account  the signed-in user's `user_presets` rows (src/auth/presetBackend.js).
 *   none     accounts are on and nobody is signed in: no user presets, and
 *            saving is refused. Saving requires an account; there is no
 *            browser-only fallback once accounts exist (owner's call).
 *
 * The API stays SYNCHRONOUS over an in-memory mirror: menus read the mirror,
 * writes update it at once and persist behind it. A remote write that fails
 * is rolled back and reported through `onPresetError`, so the menu never goes
 * on showing a preset the account does not have.
 */

export const PRESET_STORAGE_KEY = 'wavely.pluginPresets.v1'

/** pluginId -> { pluginId, paramKeys, factory, normalize } */
const definitions = new Map()

/** pluginId -> [{ id, name, params }] — the user's own, mirrored from storage. */
let userPresets = null

const listeners = new Set()
const errorListeners = new Set()

/**
 * Where user presets persist. `load()` may be async (the account backend
 * fetches); `save` / `remove` are fire-and-forget from the mirror's point of
 * view and reject on failure.
 */
const localBackend = {
  kind: 'local',
  canSave: true,
  load: loadFromLocalStorage,
  save: persistLocal,
  remove: persistLocal,
}

const noBackend = {
  kind: 'none',
  canSave: false,
  load: () => new Map(),
}

let backend = localBackend
/** Bumped on every backend switch, so a slow load for the old one is dropped. */
let backendGeneration = 0

/**
 * Deep copy of a plain params value.
 *
 * ⚠ NOT `structuredClone`. The panels hold their params in Vue refs, which
 * hand out reactive Proxies, and structuredClone refuses those outright — the
 * resonance zones took the whole spectrum display down once for exactly this
 * reason (the throw landed on the first param push, so nothing after it ran).
 * A hand-rolled copy reads through a Proxy like any other object.
 */
export function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = clonePlain(value[key])
    return out
  }
  return value
}

/** Structural equality over plain params. Used only to decide "is this preset still the one in effect". */
export function paramsEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => paramsEqual(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && paramsEqual(a[k], b[k]))
  }
  // Numbers compared exactly: these are stored values, not measurements, and a
  // preset that reads as "modified" the instant it is loaded is worse than one
  // that misses a rounding difference no control can produce.
  return a === b
}

/**
 * Register a plugin's preset surface.
 *
 * `normalize(params)` is the plugin's own clamp — the same arithmetic its
 * knobs apply — and it is the only place a stored value is trusted to become
 * a live one.
 */
export function definePluginPresets({ pluginId, paramKeys, factory = [], normalize }) {
  if (!pluginId) throw new Error('definePluginPresets: pluginId is required')
  if (!Array.isArray(paramKeys) || paramKeys.length === 0) {
    throw new Error(`definePluginPresets(${pluginId}): paramKeys must be a non-empty array`)
  }

  const seen = new Set()
  for (const preset of factory) {
    if (seen.has(preset.id)) {
      throw new Error(`definePluginPresets(${pluginId}): duplicate factory preset id "${preset.id}"`)
    }
    seen.add(preset.id)
    // Rule 2: complete, not partial. A missing key here is a preset that
    // silently changes meaning the next time a default moves.
    for (const key of paramKeys) {
      if (!Object.prototype.hasOwnProperty.call(preset.params ?? {}, key)) {
        throw new Error(
          `definePluginPresets(${pluginId}): factory preset "${preset.id}" is missing param "${key}". ` +
          'Factory presets state every param — they do not inherit the plugin defaults.'
        )
      }
    }
    // Rule 1: nothing but params.
    for (const key of Object.keys(preset.params ?? {})) {
      if (!paramKeys.includes(key)) {
        throw new Error(
          `definePluginPresets(${pluginId}): factory preset "${preset.id}" carries "${key}", ` +
          'which is not one of this plugin\'s params.'
        )
      }
    }
  }

  const def = { pluginId, paramKeys: [...paramKeys], factory, normalize }
  definitions.set(pluginId, def)
  return def
}

export function getPluginPresetDef(pluginId) {
  return definitions.get(pluginId) ?? null
}

/** Test seam — drops every registration and the in-memory user mirror. */
export function resetPluginPresets() {
  definitions.clear()
  userPresets = null
  listeners.clear()
  errorListeners.clear()
  backend = localBackend
  backendGeneration++
}

/** Notified whenever the user's own collection changes. */
export function onPresetsChanged(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  for (const fn of [...listeners]) fn()
}

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Storage can throw on access alone in a locked-down context.
    return null
  }
}

function loadUserPresets() {
  if (userPresets) return userPresets
  userPresets = new Map()
  const loaded = backend.load()
  if (loaded && typeof loaded.then === 'function') {
    const generation = backendGeneration
    loaded.then(map => {
      if (generation !== backendGeneration) return
      userPresets = sanitizeLoaded(map)
      emit()
    }, err => {
      if (generation !== backendGeneration) return
      reportError(err, 'load')
    })
  } else {
    userPresets = sanitizeLoaded(loaded)
  }
  return userPresets
}

function sanitizeLoaded(map) {
  const out = new Map()
  for (const [pluginId, list] of map ?? []) {
    if (!Array.isArray(list)) continue
    out.set(pluginId, list.filter(p => p && p.id && p.name).map(p => ({
      id: String(p.id),
      name: String(p.name),
      params: clonePlain(p.params ?? {}),
    })))
  }
  return out
}

function loadFromLocalStorage() {
  const store = storage()
  if (!store) return new Map()
  try {
    const raw = store.getItem(PRESET_STORAGE_KEY)
    if (!raw) return new Map()
    return new Map(Object.entries(JSON.parse(raw) ?? {}))
  } catch {
    // A corrupt or unreadable store is an empty one. Presets are a
    // convenience; refusing to open a plugin over them would not be.
    return new Map()
  }
}

/**
 * Switch where user presets live. The mirror is dropped and reloaded from the
 * new backend; a load still in flight for the previous one is ignored.
 *
 *   setPresetBackend('local' | 'none')   or   setPresetBackend(backendObject)
 */
export function setPresetBackend(next) {
  const resolved = next === 'local' ? localBackend
    : next === 'none' || next == null ? noBackend
      : next
  backend = resolved
  backendGeneration++
  userPresets = null
  loadUserPresets()
  emit()
}

/** 'local' | 'account' | 'none' — what the menus should say about saving. */
export function presetBackendKind() {
  return backend.kind
}

/** Can the current backend save presets at all? (False while signed out with accounts on.) */
export function canSaveUserPresets() {
  return backend.canSave === true
}

/** Notified with `{ message, op }` when a backend load or write fails. */
export function onPresetError(fn) {
  errorListeners.add(fn)
  return () => errorListeners.delete(fn)
}

function reportError(err, op) {
  const message = err?.message ?? String(err)
  for (const fn of [...errorListeners]) fn({ message, op })
}

/**
 * Run a backend write behind the mirror; on failure restore `snapshot` (the
 * plugin's list as it was) and report.
 */
function persistBehind(op, pluginId, snapshot, write) {
  const generation = backendGeneration
  let pending
  try {
    pending = write()
  } catch (err) {
    pending = Promise.reject(err)
  }
  if (!pending || typeof pending.then !== 'function') return
  pending.then(applyServerId => {
    if (generation !== backendGeneration || typeof applyServerId !== 'function') return
    applyServerId(loadUserPresets())
    emit()
  }, err => {
    if (generation !== backendGeneration) return
    loadUserPresets().set(pluginId, snapshot)
    emit()
    reportError(err, op)
  })
}

function snapshotList(pluginId) {
  return (loadUserPresets().get(pluginId) ?? []).map(p => ({ ...p, params: clonePlain(p.params) }))
}

function persistLocal() {
  const store = storage()
  if (!store) return
  try {
    const out = {}
    for (const [pluginId, list] of loadUserPresets()) {
      if (list.length) out[pluginId] = list
    }
    store.setItem(PRESET_STORAGE_KEY, JSON.stringify(out))
  } catch {
    // Full or disabled storage. The session keeps its presets in memory.
  }
}

/**
 * The whitelisted, normalised, deep-copied view of a params object.
 *
 * Every path into and out of this module goes through it, which is what makes
 * the whitelist a guarantee rather than a convention.
 */
export function pickParams(pluginId, params) {
  const def = definitions.get(pluginId)
  if (!def) return null
  const picked = {}
  for (const key of def.paramKeys) {
    if (Object.prototype.hasOwnProperty.call(params ?? {}, key)) {
      picked[key] = clonePlain(params[key])
    }
  }
  return def.normalize ? def.normalize(picked) : picked
}

/** Every preset for a plugin, factory first, each `{ id, name, description, source }`. */
export function listPresets(pluginId) {
  const def = definitions.get(pluginId)
  if (!def) return []
  const factory = def.factory.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description ?? '',
    source: 'factory',
  }))
  const user = (loadUserPresets().get(pluginId) ?? []).map(p => ({
    id: p.id,
    name: p.name,
    description: '',
    source: 'user',
  }))
  return [...factory, ...user]
}

/** A preset's params, ready to hand to a plugin, or null if there is no such preset. */
export function presetParams(pluginId, presetId) {
  const def = definitions.get(pluginId)
  if (!def) return null
  const factory = def.factory.find(p => p.id === presetId)
  if (factory) return pickParams(pluginId, factory.params)
  const user = (loadUserPresets().get(pluginId) ?? []).find(p => p.id === presetId)
  if (user) return pickParams(pluginId, user.params)
  return null
}

/**
 * The id of the preset these params ARE, or null.
 *
 * Used to decide whether the menu shows a preset name or a modified one. A
 * user preset wins a tie with a factory preset of the same settings, because
 * a name the user chose is the more informative of the two.
 */
export function matchPreset(pluginId, params) {
  const def = definitions.get(pluginId)
  if (!def) return null
  const current = pickParams(pluginId, params)
  const user = loadUserPresets().get(pluginId) ?? []
  for (const p of user) {
    if (paramsEqual(pickParams(pluginId, p.params), current)) return p.id
  }
  for (const p of def.factory) {
    if (paramsEqual(pickParams(pluginId, p.params), current)) return p.id
  }
  return null
}

function makeId(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `user:${slug || 'preset'}:${Date.now().toString(36)}`
}

/**
 * Save the given params under a name.
 *
 * Saving over one of the user's own names OVERWRITES it in place, keeping its
 * id — the alternative is two entries with one name, where the menu cannot say
 * which is which. A FACTORY name is refused: a shipped preset is a fixed
 * reference point, and one that quietly became something else would make every
 * note in this file that cites it wrong.
 */
export function saveUserPreset(pluginId, name, params) {
  const def = definitions.get(pluginId)
  if (!def) throw new Error(`saveUserPreset: unknown plugin "${pluginId}"`)
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('saveUserPreset: a preset needs a name')
  if (!backend.canSave) {
    const err = new Error('Sign in to save presets.')
    err.code = 'sign_in_required'
    throw err
  }
  if (def.factory.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`"${trimmed}" is a built-in preset. Choose another name.`)
  }

  const all = loadUserPresets()
  const snapshot = snapshotList(pluginId)
  const list = all.get(pluginId) ?? []
  const picked = pickParams(pluginId, params)
  const existing = list.find(p => p.name.toLowerCase() === trimmed.toLowerCase())
  let saved
  if (existing) {
    existing.params = picked
    existing.name = trimmed
    saved = existing
  } else {
    saved = { id: backend.makeId?.(trimmed) ?? makeId(trimmed), name: trimmed, params: picked }
    list.push(saved)
  }
  all.set(pluginId, list)
  persistBehind('save', pluginId, snapshot, () => backend.save(pluginId, { ...saved, params: clonePlain(picked) }, all))
  emit()
  return { id: saved.id, name: saved.name, source: 'user' }
}

/** Remove one of the user's own presets. Factory presets are not removable. */
export function deleteUserPreset(pluginId, presetId) {
  const all = loadUserPresets()
  const snapshot = snapshotList(pluginId)
  const list = all.get(pluginId) ?? []
  const idx = list.findIndex(p => p.id === presetId)
  if (idx === -1) return false
  list.splice(idx, 1)
  all.set(pluginId, list)
  persistBehind('delete', pluginId, snapshot, () => backend.remove(pluginId, presetId, all))
  emit()
  return true
}

export function isFactoryPreset(pluginId, presetId) {
  const def = definitions.get(pluginId)
  return !!def?.factory.some(p => p.id === presetId)
}
