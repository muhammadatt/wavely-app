import { getCurrentInstance, inject } from 'vue'

/**
 * Two copies of every chainable plugin: the SOLO copy, opened from the rail,
 * the Effects menu or the palette, with an Apply of its own; and the CHAIN
 * copy, which holds the plugin's slot in the Plugin Chain.
 *
 * Each copy has its own settings, its own node in the EffectChain and its own
 * window, the way inserting a plugin twice in a DAW gives two instances. One
 * shared object served both jobs at first, and a plugin in the chain could
 * then not be opened and applied on its own: opening it from the Effects menu
 * reached the chain's slot, with the chain window and no Apply.
 *
 * The chain copy's ids are the solo ids with CHAIN_SUFFIX: `inflator@chain` is
 * the window and `inflator@chain` the EffectChain entry. Which copy a plugin
 * window edits is provided by the window layer (PluginCopy.vue), so a plugin's
 * components are the same for both and call their composable exactly as before.
 */

export const CHAIN_SUFFIX = '@chain'

export const PLUGIN_COPY_KEY = Symbol('plugin-copy')

/** @typedef {'solo' | 'chain'} PluginCopy */

export const isChainCopyId = id => typeof id === 'string' && id.endsWith(CHAIN_SUFFIX)

/** The solo id behind a window or effect id (itself, for a solo id). */
export const baseId = id => (isChainCopyId(id) ? id.slice(0, -CHAIN_SUFFIX.length) : id)

/** The id of `copy` of the plugin whose solo id is `id`. */
export const idForCopy = (id, copy) => (copy === 'chain' ? `${baseId(id)}${CHAIN_SUFFIX}` : baseId(id))

/** Which copy a window id shows. */
export const copyOfId = id => (isChainCopyId(id) ? 'chain' : 'solo')

/** An effect definition for `copy`: the chain copy is the same effect under its own id. */
export function effectForCopy(effect, copy) {
  return copy === 'chain' ? { ...effect, id: idForCopy(effect.id, copy) } : effect
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
 * Per-copy singletons. `define(copy)` builds one copy's state and returns its
 * composable; it runs once per copy, the first time that copy is asked for, so
 * each copy's state survives its window closing exactly as the single shared
 * state used to.
 *
 * @template T
 * @param {(copy: PluginCopy) => T} define
 * @returns {(copy?: PluginCopy) => T}
 */
export function pluginCopies(define) {
  const copies = {}
  return (copy = currentPluginCopy()) => (copies[copy] ??= define(copy))
}
