<script setup>
import { computed, ref, watch } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useWindows } from '../composables/useWindows.js'
import { usePluginChain } from '../composables/usePluginChain.js'
import { CATEGORIES } from '../ui/registry.js'
import Icon from './ui/Icon.vue'

const { state, setActiveTool, hasFile, openCommandPalette, closeRail } = useEditorState()
const { openWindow, isOpen } = useWindows()
const { slots, liveSlots, bypassed, suspended } = usePluginChain()

// The chain plays whether or not its window is open, so the toolbar says so —
// in TWO states only. Whatever takes the chain out of the signal (the user's
// master bypass, a plugin outside the chain being open, or every slot switched
// off) reads the same BYPASSED: to the ear they are the same thing. Which one
// it is goes in the tooltip.
const chainActive = computed(() => liveSlots.value.length > 0 && !bypassed.value && !suspended.value)
const chainTitle = computed(() => {
  const n = slots.value.length
  if (!n) return 'Plugin chain — empty'
  if (chainActive.value) return `Plugin chain — active, ${liveSlots.value.length} of ${n} plugin(s) on`
  if (suspended.value) return 'Plugin chain — bypassed while a plugin outside it is open, so that plugin previews exactly what its Apply writes. Turn it back on in the chain window'
  if (bypassed.value) return 'Plugin chain — bypassed. Turn it on in the chain window'
  return 'Plugin chain — bypassed: every plugin in it is switched off'
})

// Until the chain has been opened once, an empty chain says NEW: it is the
// feature most worth finding and the one a new user is least likely to look
// for. Kept per browser; storage can be missing or throw, and then the badge
// simply shows for the session.
const SEEN_KEY = 'wavely:plugin-chain-seen'
function readSeen() {
  try { return localStorage.getItem(SEEN_KEY) === '1' } catch { return false }
}
const chainSeen = ref(readSeen())
watch(() => isOpen('plugin-chain'), (open) => {
  if (!open || chainSeen.value) return
  chainSeen.value = true
  try { localStorage.setItem(SEEN_KEY, '1') } catch { /* session only */ }
})
const chainBadge = computed(() => {
  if (slots.value.length) return chainActive.value ? 'ACTIVE' : 'BYPASSED'
  return chainSeen.value ? '' : 'NEW'
})

// The rail closes as the chain comes up (usePluginChain.js); closed here too,
// for the click that finds the chain already in front and changes nothing.
function openChain() {
  closeRail()
  openWindow('plugin-chain')
}

// The category list lives in the registry, so the toolbar and the rail can no
// longer disagree about which tools exist.
const tools = CATEGORIES
</script>

<template>
  <div class="h-[65px] compact:h-[46px] flex items-center gap-3 compact:gap-[6px] max-sm:gap-1 px-5 compact:px-2 max-sm:px-[6px] shrink-0 border-b border-[rgba(255,255,255,.06)]" style="background:linear-gradient(180deg,#12161b,#0e1216)">
    <!-- Search is the escape hatch from the category hierarchy: as the number
         of operations grows, this is how you reach one without knowing which
         category it lives in. -->
    <div class="flex-1 compact:flex-none min-w-0 flex items-center">
      <button
        class="palette-trigger flex items-center gap-2 pl-[10px] pr-2 max-sm:px-[8px] py-[7px] rounded-[10px] cursor-pointer max-w-[210px]"
        :disabled="!hasFile"
        title="Search operations (Ctrl+K)"
        @click="openCommandPalette"
      >
        <Icon name="search" :size="13" />
        <span class="text-[11.5px] font-semibold truncate compact:hidden">Search…</span>
        <kbd class="compact:hidden ml-auto shrink-0 font-mono text-[9.5px] font-bold px-[5px] py-[2px] rounded-[5px] tracking-[.04em]">Ctrl K</kbd>
      </button>
    </div>
    <!-- min-w-0 + scroll: the tool group gives up centring before it collides
         with the zoom controls on a narrow window. -->
    <div class="tool-group flex items-center gap-[4px] p-[5px] rounded-[13px] min-w-0 overflow-x-auto" style="background:linear-gradient(180deg, #1a2029, #12161d);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)">
      <button
        v-for="tool in tools"
        :key="tool.id"
        type="button"
        class="tool-btn"
        :class="{ 'is-active': state.activeTool === tool.id }"
        :disabled="!hasFile"
        :aria-pressed="String(state.activeTool === tool.id)"
        :title="tool.desc"
        @click="setActiveTool(tool.id)"
      >
        <Icon :name="tool.icon" :size="15" class="tool-btn__icon" />
        <span class="tool-btn__label">{{ tool.label }}</span>
      </button>
    </div>
    <!-- The chain sits WITH the categories, not off at the far edge: it is the
         product's headline feature, and beside the menus a new user scans it
         reads as one of the places to go. Its own colour (the chain's amber)
         keeps it from reading as a fifth category. It needs a door that is
         always on screen anyway — the chain plays with every window closed. -->
    <button
      type="button"
      class="chain-btn"
      :class="{ 'is-active': isOpen('plugin-chain') }"
      :disabled="!hasFile"
      :title="chainTitle"
      @click="openChain"
    >
      <Icon name="chain" :size="15" class="tool-btn__icon" />
      <span class="chain-label">Plugin Chain</span>
      <span
        v-if="chainBadge"
        class="chain-count"
        :class="{ 'is-live': chainActive, 'is-new': chainBadge === 'NEW' }"
      >{{ chainBadge }}</span>
    </button>
    <!-- Undo/Redo moved to the TopBar, next to Export. This spacer stays: it
         balances the search button on the left so the tool group sits centred
         rather than drifting right. -->
    <div class="flex-1 compact:flex-none min-w-0"></div>
  </div>
</template>

<style scoped>
/* Segmented control, styled here rather than through BaseButton.
 *
 * The toolbar is the app's primary navigation and wants a look of its own: a
 * group of chips sharing one recessed tray, where the selected chip lifts out
 * of it. BaseButton's toggle is built for standalone on/off controls, and its
 * selected state is a solid cyan fill — correct for a lone button, but shouting
 * inside a group of four.
 *
 * The selected chip is a solid accent fill. This is deliberately louder than
 * the accent *wash* used for selected rows in the rail and selected preset
 * cards: those are selections within a panel you are already looking at, while
 * this one says which panel you are in at all.
 */
.tool-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  white-space: nowrap;
  padding: 10px 16px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-softer);
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease,
              border-color 0.15s ease, box-shadow 0.15s ease;
}

.tool-btn__icon {
  opacity: 0.8;
  transition: opacity 0.15s ease;
}

.tool-btn:hover:not(:disabled):not(.is-active) {
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text);
}
.tool-btn:hover:not(:disabled) .tool-btn__icon {
  opacity: 1;
}

.tool-btn:active:not(:disabled) {
  transform: translateY(0.5px);
}

/* Solid accent fill with dark text — the selected chip reads as a physical key
 * pressed into the tray rather than an outlined region. The gradient is the
 * same one the logo tile uses, so the brightest thing in the toolbar and the
 * brightest thing in the header are visibly the same colour.
 *
 * No border: at this contrast an accent outline around an accent fill only
 * muddies the edge. The glow does the lifting instead.
 */
.tool-btn.is-active {
  background: linear-gradient(180deg, #7ef0ff, #5ce3f8);
  border-color: transparent;
  color: #08161a;
  /*
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.4),
              0 2px 12px rgba(53, 211, 230, 0.35);
  */
}
.tool-btn.is-active .tool-btn__icon {
  opacity: 1;
}
/* Hover on the already-selected chip: lift, don't recolour. */
.tool-btn.is-active:hover:not(:disabled) {
  filter: brightness(1.06);
}

.tool-btn:focus-visible {
  outline: 2px solid var(--color-accent-bright);
  outline-offset: 2px;
}

.tool-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.palette-trigger {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.45);
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.palette-trigger:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(53, 211, 230, 0.4);
  color: #7fe9f6;
}
.palette-trigger:disabled {
  opacity: 0.4;
  cursor: default;
}
.palette-trigger:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 2px;
}
.palette-trigger kbd {
  background: rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.4);
}

.tool-group {
  scrollbar-width: none;
}
.tool-group::-webkit-scrollbar {
  display: none;
}

.chain-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  white-space: nowrap;
  padding: 9px 14px;
  border-radius: 12px;
  border: 1px solid rgba(232, 163, 61, .45);
  background: linear-gradient(180deg, rgba(232, 163, 61, .14), rgba(232, 163, 61, .06));
  color: #f1c27a;
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.chain-btn:hover:not(:disabled) {
  border-color: #e8a33d;
  background: linear-gradient(180deg, rgba(232, 163, 61, .22), rgba(232, 163, 61, .1));
  color: #ffd79a;
}
.chain-btn.is-active {
  background: linear-gradient(180deg, #f2b65a, #e8a33d);
  border-color: transparent;
  color: #1d1305;
}
.chain-btn:focus-visible {
  outline: 2px solid #e8a33d;
  outline-offset: 2px;
}
.chain-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.chain-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  font-weight: 700;
  padding: 2px 5px;
  border-radius: 5px;
  background: rgba(255, 255, 255, .08);
  color: var(--color-text-softer);
}
.chain-count.is-live {
  background: rgba(232, 163, 61, .2);
  color: #e8a33d;
}
.chain-count.is-new {
  background: #e8a33d;
  color: #1d1305;
}
.chain-btn.is-active .chain-count {
  background: rgba(0, 0, 0, .18);
  color: #1d1305;
}

/* Phone held upright: a TAB BAR. The segmented control stays one row of
   chips, but each chip stacks its icon over a small label and takes an equal
   share of the width, so every category is on screen at once. As chips side
   by side they needed ~550 px and the row hid Tone, Fix and Master behind a
   sideways scroll nothing hinted at. A label that still does not fit is
   ellipsised, and the tray scrolls as a last resort. */
@media (max-width: 639.98px) {
  .tool-group {
    flex: 1 1 auto;
    gap: 2px;
    padding: 3px;
    border-radius: 11px;
  }
  .tool-group .tool-btn {
    /* auto, not 0: equal shares cut "Dynamics" at 360 px while "Fix" had
       room to spare. Content first, then the spare width shared out. */
    flex: 1 1 auto;
    min-width: 34px;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    padding: 5px 2px 4px;
    border-radius: 8px;
    font-size: 10px;
    letter-spacing: -0.01em;
  }
  .chain-btn {
    padding: 7px 6px;
  }
  .tool-group .tool-btn__label {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

/* Compact (the `compact:` variant in main.css): smaller chips so the six
   categories fit a phone's width, and the Chain button down to its icon and a
   dot — ACTIVE / BYPASSED in words costs more width than the row has. */
@media (max-height: 520px), (max-width: 640px) {
  .tool-btn {
    padding: 7px 10px;
    gap: 5px;
    font-size: 12px;
  }
  .chain-btn {
    padding: 7px 10px;
    gap: 5px;
  }
  .chain-btn .chain-label {
    display: none;
  }
  .chain-count {
    font-size: 0;
    width: 7px;
    height: 7px;
    padding: 0;
    border-radius: 50%;
    background: rgba(255, 255, 255, .3);
  }
  .chain-count.is-live {
    background: #e8a33d;
  }
}
</style>
