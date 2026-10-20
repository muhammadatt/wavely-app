import { effectScope, getCurrentInstance, inject } from 'vue'

/**
 * Copies of every chainable plugin: the SOLO copy, opened from the rail, the
 * Effects menu or the palette, with an Apply of its own; and one CHAIN copy per
 * slot in the Plugin Chain — as many as the chain holds, so a plugin can sit in
 * it more than once, the way a DAW inserts a plugin twice.
 *
 * Each copy has its own settings, its own node in the EffectChain and its own
 * window. One shared object served both jobs at first, and a plugin in the
 * chain could then not be opened and applied on its own: opening it from the
 * Effects menu reached the chain's slot, with the chain window and no Apply.
 *
 * A chain copy's ids are the solo ids with `@chain-<n>`: `inflator@chain-2` is
 * both its window and its EffectChain entry. Which copy a plugin window edits
 * is provided by the window layer (PluginCopy.vue), so a plugin's components
 * are the same for every copy and call their composable exactly as before.
 *
 * A chain copy lives until its slot is removed, and is then DISPOSED (see
 * `pluginCopies`), so a plugin added again starts from its defaults rather than
 * from whatever a removed slot was left at.
 */

export const PLUGIN_COPY_KEY = Symbol('plugin-copy')

/** @typedef {string} PluginCopy  'solo', or 'chain-<n>' */

const CHAIN_COPY = /^chain-[1-9]\d*$/
const CHAIN_ID = /@(chain-[1-9]\d*)$/

/** The copy name of a plugin's n-th chain copy. */
export const chainCopy = n => `chain-${n}`

/** Which chain copy a copy name is (1, 2, …), or 0 for the solo copy. */
export const chainCopyNumber = copy => (CHAIN_COPY.test(copy) ? Number(copy.slice(6)) : 0)

export const isChainCopyId = id => typeof id === 'string' && CHAIN_ID.test(id)

/** The solo id behind a window or effect id (itself, for a solo id). */
export const baseId = id => (isChainCopyId(id) ? id.replace(CHAIN_ID, '') : id)

/** The id of `copy` of the plugin whose solo id is `id`. */
export const idForCopy = (id, copy) => (CHAIN_COPY.test(copy) ? `${baseId(id)}@${copy}` : baseId(id))

/** Which copy a window or effect id belongs to. */
export const copyOfId = id => (isChainCopyId(id) ? id.match(CHAIN_ID)[1] : 'solo')

/** An effect definition for `copy`: a chain copy is the same effect under its own id. */
export function effectForCopy(effect, copy) {
  return CHAIN_COPY.test(copy) ? { ...effect, id: idForCopy(effect.id, copy) } : effect
}

/**
 * The copy the calling component edits: the one its window was opened for, or
 * the solo copy outside a plugin window (and outside a component altogether).
 * Read during setup or a lifecycle hook, where inject() is allowed.
 */
export function currentPluginCopy() {
  return getCurrentInstance() ? inject(PLUGIN_COPY_KEY, 'solo') : 'solo'
}

/**
 * Per-copy singletons. `define(copy, life)` builds one copy's state and returns
 * its composable; it runs once per copy, the first time that copy is asked for,
 * so each copy's state survives its window closing exactly as the single
 * shared state used to.
 *
 * `life` is the copy's lifetime:
 *   scope      an effect scope that lives as long as the copy. Its definition
 *              runs inside it, and a watcher that must outlive the window that
 *              made it belongs in it (`life.scope.run(() => watch(...))`) —
 *              never in a detached scope of its own, which nothing would stop.
 *   onDispose  register cleanup: clear a timer, cancel a measurement.
 *   dispose    end the copy: run the cleanups, stop the scope, and forget it,
 *              so asking for the same copy again builds a fresh one.
 *
 * @template T
 * @param {(copy: PluginCopy, life: { scope: import('vue').EffectScope, onDispose: (fn: () => void) => void, dispose: () => void }) => T} define
 * @returns {((copy?: PluginCopy) => T)}
 */
export function pluginCopies(define) {
  const copies = new Map()

  function get(copy = currentPluginCopy()) {
    let entry = copies.get(copy)
    if (!entry) {
      const scope = effectScope(true)
      const cleanups = []
      const life = {
        scope,
        onDispose: fn => { cleanups.push(fn) },
        dispose: () => {
          if (copies.get(copy) !== entry) return
          copies.delete(copy)
          for (const fn of cleanups.splice(0)) {
            try { fn() } catch (err) { console.error('plugin copy cleanup failed:', err) }
          }
          scope.stop()
        },
      }
      entry = { life }
      copies.set(copy, entry)
      try {
        entry.use = scope.run(() => define(copy, life))
        if (entry.use === undefined) throw new Error('plugin copy definition failed')
      } catch (err) {
        // Not cached half-built: the next ask tries again rather than handing
        // every later window an undefined composable.
        life.dispose()
        throw err
      }
    }
    return entry.use
  }

  return get
}
