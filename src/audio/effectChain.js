import { reactive, shallowRef } from 'vue'

let instance = null

export class EffectChain {
  constructor(audioContext) {
    this.audioContext = audioContext
    this.inputNode = audioContext.createGain()
    this.outputNode = audioContext.createGain()
    this.outputNode.connect(audioContext.destination)
    this.effects = []
    this.inputNode.connect(this.outputNode)
  }

  addEffect(effect) {
    const nodes = effect.createNodes(this.audioContext)
    const entry = {
      id: effect.id,
      name: effect.name,
      enabled: false,
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
    entry.enabled = enabled
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

  _rebuildChain() {
    this.inputNode.disconnect()
    for (const entry of this.effects) {
      entry.nodes.input.disconnect()
      entry.nodes.output.disconnect()
    }

    const active = this.effects.filter(e => e.enabled)

    if (active.length === 0) {
      this.inputNode.connect(this.outputNode)
      return
    }

    this.inputNode.connect(active[0].nodes.input)
    for (let i = 0; i < active.length - 1; i++) {
      active[i].nodes.output.connect(active[i + 1].nodes.input)
    }
    active[active.length - 1].nodes.output.connect(this.outputNode)
  }

  destroy() {
    for (const entry of this.effects) {
      entry.nodes.destroy?.()
    }
    this.effects = []
    this.inputNode.disconnect()
    this.outputNode.disconnect()
  }
}

export function getEffectChain(audioContext) {
  if (!instance || instance.audioContext !== audioContext) {
    instance?.destroy()
    instance = new EffectChain(audioContext)
  }
  return instance
}

export function getEffectChainIfExists() {
  return instance
}
