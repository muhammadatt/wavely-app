let instance = null

/**
 * The live plugin chain: every effect the user has engaged, in series, in an
 * order the user controls.
 *
 * Each entry has two flags, and they are not the same thing:
 *
 *   member   — the effect has a SLOT in the chain. It keeps it until removed,
 *              whether or not its window is open, so building a chain no
 *              longer means keeping every plugin window on screen.
 *   enabled  — the slot is live (the plugin's ON/BYPASS, its "preview").
 *              A bypassed slot keeps its place in the order.
 *
 * Engaging an effect that has no slot yet appends one at the end, so the
 * default order is still the order plugins were turned on — but it is now only
 * a default: `moveEffect` reorders.
 *
 * `bypassed` is the chain's master bypass: every slot out of circuit at once,
 * each keeping its own state for when the chain comes back.
 */
export class EffectChain {
  constructor(audioContext) {
    this.audioContext = audioContext
    this.inputNode = audioContext.createGain()
    this.outputNode = audioContext.createGain()
    this.outputNode.connect(audioContext.destination)
    this.effects = []
    this.bypassed = false
    this.listeners = new Set()
    this.inputNode.connect(this.outputNode)
  }

  /** Called with no arguments after every change to membership, order or state. */
  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  addEffect(effect) {
    const nodes = effect.createNodes(this.audioContext)
    const entry = {
      id: effect.id,
      name: effect.name,
      enabled: false,
      member: false,
      effect,
      nodes,
    }
    this.effects.push(entry)
    this._rebuildChain()
    return entry
  }

  removeEffect(id) {
    const idx = this.effects.findIndex(e => e.id === id)
    if (idx === -1) return
    const entry = this.effects[idx]
    entry.nodes.destroy?.()
    this.effects.splice(idx, 1)
    this._rebuildChain()
  }

  setEnabled(id, enabled) {
    const entry = this.effects.find(e => e.id === id)
    if (!entry) return
    if (enabled && !entry.member) {
      // A new slot goes to the end of the chain: move the entry past every
      // current member so array order stays chain order.
      entry.member = true
      this.effects.splice(this.effects.indexOf(entry), 1)
      this.effects.push(entry)
    }
    entry.enabled = enabled
    this._rebuildChain()
  }

  /** The chain's slots, in processing order. */
  members() {
    return this.effects.filter(e => e.member)
  }

  /** Take an effect's slot away (its nodes stay built for the next time). */
  removeFromChain(id) {
    const entry = this.effects.find(e => e.id === id)
    if (!entry) return
    entry.member = false
    entry.enabled = false
    this._rebuildChain()
  }

  /** Move a slot to position `toIndex` among the chain's members. */
  moveEffect(id, toIndex) {
    const members = this.members()
    const from = members.findIndex(e => e.id === id)
    if (from === -1) return
    const to = Math.max(0, Math.min(members.length - 1, toIndex))
    if (to === from) return
    const [entry] = members.splice(from, 1)
    members.splice(to, 0, entry)
    // Members first in their new order; non-members carry no order.
    this.effects = [...members, ...this.effects.filter(e => !e.member)]
    this._rebuildChain()
  }

  /** Master bypass: the whole chain out of circuit, slots untouched. */
  setBypassed(bypassed) {
    this.bypassed = !!bypassed
    this._rebuildChain()
  }

  updateParam(id, paramName, value) {
    const entry = this.effects.find(e => e.id === id)
    if (!entry) return
    entry.nodes.setParam(paramName, value)
  }

  getParam(id, paramName) {
    const entry = this.effects.find(e => e.id === id)
    if (!entry) return undefined
    return entry.nodes.getParam(paramName)
  }

  isEnabled(id) {
    const entry = this.effects.find(e => e.id === id)
    return entry?.enabled ?? false
  }

  getInputNode() {
    return this.inputNode
  }

  /**
   * The node everything the user hears passes through last.
   *
   * Exposed for measurement taps only — the standalone spectrum analyzer hangs
   * off it so it reads the finished signal, every enabled effect included,
   * rather than one plugin's private output. Nothing may insert audio here:
   * `_rebuildChain` owns what connects into this node.
   */
  getOutputNode() {
    return this.outputNode
  }

  _rebuildChain() {
    this.inputNode.disconnect()
    for (const entry of this.effects) {
      // Only disconnect each effect's OUTPUT (its external hand-off to the next
      // stage). Never call .disconnect() on an effect's `input` node here — that
      // wipes ALL of its outgoing connections, including the effect's own
      // permanent internal wiring (e.g. input -> compressor), leaving audio with
      // nowhere to go the instant it becomes active.
      entry.nodes.output.disconnect()
    }

    const active = this.bypassed ? [] : this.effects.filter(e => e.member && e.enabled)

    if (active.length === 0) {
      this.inputNode.connect(this.outputNode)
    } else {
      this.inputNode.connect(active[0].nodes.input)
      for (let i = 0; i < active.length - 1; i++) {
        active[i].nodes.output.connect(active[i + 1].nodes.input)
      }
      active[active.length - 1].nodes.output.connect(this.outputNode)
    }
    for (const fn of this.listeners) fn()
  }

  destroy() {
    for (const entry of this.effects) {
      entry.nodes.destroy?.()
    }
    this.effects = []
    this.inputNode.disconnect()
    this.outputNode.disconnect()
    for (const fn of this.listeners) fn()
    this.listeners.clear()
  }
}

const createdListeners = new Set()

export function getEffectChain(audioContext) {
  if (!instance || instance.audioContext !== audioContext) {
    instance?.destroy()
    instance = new EffectChain(audioContext)
    for (const fn of createdListeners) fn(instance)
  }
  return instance
}

/** Called with each new chain instance (a new AudioContext builds a new chain). */
export function onEffectChainCreated(fn) {
  createdListeners.add(fn)
  if (instance) fn(instance)
  return () => createdListeners.delete(fn)
}

export function getEffectChainIfExists() {
  return instance
}
