<script setup>
/**
 * The offer a shared chain or preset link carries (useSharedLink.js): what it
 * is, and Load / Save to my presets. Nothing loads until Load is pressed —
 * loading a chain replaces the rack.
 */
import { computed } from 'vue'
import { useSharedLink } from '../composables/useSharedLink.js'
import { usePluginChain } from '../composables/usePluginChain.js'

const { state, load, save, dismiss, canSave } = useSharedLink()
const { slots } = usePluginChain()

const offer = computed(() => state.offer)
const eyebrow = computed(() => (offer.value?.kind === 'chain' ? 'Shared chain' : `Shared ${offer.value?.pluginLabel} preset`))
const replaces = computed(() => offer.value?.kind === 'chain' && slots.value.length > 0)
</script>

<template>
  <div v-if="offer" class="share" role="dialog" aria-label="Shared settings" data-testid="shared-link">
    <div class="share-eyebrow">{{ eyebrow }}</div>
    <div class="share-name" :title="offer.name">{{ offer.name }}</div>

    <ol v-if="offer.kind === 'chain'" class="share-slots">
      <li v-for="(p, i) in offer.plugins" :key="i" :class="{ off: !p.active, missing: !p.available }">
        {{ p.label }}<span v-if="!p.available"> — not in this version</span><span v-else-if="!p.active"> (bypassed)</span>
      </li>
    </ol>

    <div class="share-line">
      <template v-if="offer.kind === 'chain'">
        Loads into the Plugin Chain{{ replaces ? `, replacing the ${slots.length} plugin${slots.length === 1 ? '' : 's'} there` : '' }}. Open a file to hear it.
      </template>
      <template v-else>Sets {{ offer.pluginLabel }}’s controls and opens it.</template>
    </div>

    <div class="share-actions">
      <button type="button" class="share-load" @click="load">Load</button>
      <button type="button" class="share-link" :title="canSave() ? '' : 'Log in to save presets'" @click="save">Save to my {{ offer.kind === 'chain' ? 'chains' : 'presets' }}</button>
      <button type="button" class="share-link" @click="dismiss">Dismiss</button>
    </div>
  </div>
</template>

<style scoped>
.share {
  position: fixed;
  left: 50%;
  /* Below the header, the category row and the tab row, clear of the toolbar. */
  top: 168px;
  transform: translateX(-50%);
  z-index: 46;
  width: min(360px, calc(100vw - 32px));
  box-sizing: border-box;
  padding: 14px 16px;
  border-radius: 14px;
  background: #161b22;
  border: 1px solid rgba(255,255,255,.1);
  box-shadow: 0 12px 32px rgba(0,0,0,.45);
  font-family: 'Inter', sans-serif;
}
.share-eyebrow {
  font: 600 10.5px 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: #35d3e6;
}
.share-name {
  margin-top: 4px;
  font-size: 14px;
  font-weight: 700;
  color: #eaf6f8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.share-slots {
  margin: 8px 0 0;
  padding-left: 20px;
  list-style: decimal;
  font-size: 12.5px;
  line-height: 1.6;
  color: rgba(255,255,255,.78);
}
@media (max-height: 520px), (max-width: 640px) {
  .share { top: auto; bottom: 16px; }
}
.share-slots .off { color: rgba(255,255,255,.45); }
.share-slots .missing { color: #e0b84a; }
.share-line {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.45;
  color: rgba(255,255,255,.62);
}
.share-actions {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 14px;
}
.share-load {
  height: 32px;
  padding: 0 16px;
  border: none;
  border-radius: 10px;
  background: #35d3e6;
  color: #06232a;
  font: 700 12.5px 'Inter', sans-serif;
  cursor: pointer;
}
.share-link {
  border: none;
  background: none;
  padding: 0;
  font: 600 12px 'Inter', sans-serif;
  color: rgba(255,255,255,.55);
  text-decoration: underline;
  cursor: pointer;
}
.share-link:hover { color: #eaf6f8; }
</style>
