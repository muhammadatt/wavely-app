<script setup>
import { computed, ref, watch } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useWindows } from '../composables/useWindows.js'
import { usePluginChain } from '../composables/usePluginChain.js'
import { CATEGORIES } from '../ui/registry.js'
import Icon from './ui/Icon.vue'

// `inline`: rendered inside the header (wide windows, see useHeaderTools.js)
// rather than as its own row. Same controls; the row's chrome, the spacers that
// centred it and the search field's words go, since the header centres it and
// has no width to spare.
const props = defineProps({ inline: { type: Boolean, default: false } })

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
  if (!n) return 'Effect chain — empty'
  if (chainActive.value) return `Effect chain — active, ${liveSlots.value.length} of ${n} plugin(s) on`
  if (suspended.value) return 'Effect chain — bypassed while a plugin outside it is open, so that plugin previews exactly what its Apply writes. Turn it back on in the chain window'
  if (bypassed.value) return 'Effect chain — bypassed. Turn it on in the chain window'
  return 'Effect chain — bypassed: every plugin in it is switched off'
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
  <div
    :class="props.inline
      ? 'toolbar-inline flex items-center gap-[10px] min-w-0'
      : 'h-[65px] compact:h-[46px] flex items-center gap-3 compact:gap-[6px] max-sm:gap-1 px-5 compact:px-2 max-sm:px-[6px] shrink-0 toolbar-row'"
  >
    <!-- Search is the escape hatch from the category hierarchy: as the number
         of operations grows, this is how you reach one without knowing which
         category it lives in. -->
    <!-- Icon-only in both layouts. As a field with "Search… Ctrl K" it ran
         under the category group on windows below ~1100 px; the shortcut
         lives in the tooltip and the palette's own hint. -->
    <div :class="props.inline ? 'shrink-0 flex items-center' : 'flex-1 compact:flex-none min-w-0 flex items-center'">
      <button
        class="palette-trigger w-[34px] h-[34px] shrink-0 flex items-center justify-center rounded-[10px] cursor-pointer"
        :disabled="!hasFile"
        title="Search operations (Ctrl+K)"
        aria-label="Search operations"
        @click="openCommandPalette"
      >
        <Icon name="search" :size="14" />
      </button>
    </div>
    <!-- min-w-0 + scroll: the tool group gives up centring before it collides
         with the zoom controls on a narrow window. -->
    <div class="tool-group flex items-center gap-[4px] p-[3px] rounded-[13px] min-w-0 overflow-x-auto">
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
      <span class="chain-label">Chain</span>
      <span
        v-if="chainBadge"
        class="chain-count"
        :class="{ 'is-live': chainActive, 'is-new': chainBadge === 'NEW' }"
      >{{ chainBadge }}</span>
    </button>
    <!-- Undo/Redo moved to the TopBar, next to Export. This spacer stays: it
         balances the search button on the left so the tool group sits centred
         rather than drifting right. -->
    <div v-if="!props.inline" class="flex-1 compact:flex-none min-w-0"></div>
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
  /* 34 px: every control in the header (search, Chain, Undo / Redo, Upgrade,
     the avatar) shares this height, and the tray is these plus its 3 px
     padding — 40 px, with room above and below in the 56 px header. Its
     13 px radius is these chips' 10 + that padding, so the corners nest. */
  height: 34px;
  padding: 0 16px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  /* 88 %: the lighter labels of design 1a (owner, November 2026). */
  color: rgba(255, 255, 255, .88);
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease,
              border-color 0.15s ease, box-shadow 0.15s ease;
}

.tool-btn__icon {
  opacity: 1;
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

/* The tray. On the one chrome surface its old fill (fading to the chrome's
   own colour) and 5 % outline all but vanished and the categories looked
   lost (owner), so it is lifted: a fill a step above the chrome, a firmer
   outline, a top highlight and a soft shadow underneath. */
.tool-group {
  scrollbar-width: none;
  background: linear-gradient(180deg, #1d232c, #171c24);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, .09),
    inset 0 1px 0 rgba(255, 255, 255, .05),
    0 1px 2px rgba(0, 0, 0, .45),
    0 4px 12px rgba(0, 0, 0, .25);
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
  height: 34px;
  padding: 0 14px;
  border-radius: 10px;
  /* An accent TINT, not a fill (owner, November 2026): the headline feature
     still stands out from the plain category chips beside it, without a
     solid cyan block competing for the eye. Open or closed it looks the same:
     the chain is a place to go, not a mode, so its state lives in the badge. */
  border: 1px solid rgba(53, 211, 230, .32);
  background: rgba(53, 211, 230, .12);
  color: #7fe9f6;
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.chain-btn:hover:not(:disabled) {
  background: rgba(53, 211, 230, .2);
  border-color: rgba(53, 211, 230, .5);
}
.chain-btn:focus-visible {
  outline: 2px solid #7fe9f6;
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
  /* Bypassed is the quiet one; live and NEW are solid in the button's ink. */
  background: rgba(127, 233, 246, .14);
  color: rgba(127, 233, 246, .8);
}
.chain-count.is-live,
.chain-count.is-new {
  background: #7fe9f6;
  color: #08161a;
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
    height: auto;
    padding: 5px 2px 4px;
    border-radius: 8px;
    font-size: 10px;
    letter-spacing: -0.01em;
  }
  .chain-btn {
    height: auto;
    align-self: stretch;
    padding: 0 6px;
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
    padding: 0 10px;
    gap: 5px;
    font-size: 12px;
  }
  .chain-btn {
    padding: 0 10px;
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
    background: rgba(127, 233, 246, .35);
  }
  .chain-count.is-live {
    background: #7fe9f6;
  }
}
/* Part of the one chrome surface (see --color-chrome): no line of its own. */
.toolbar-row {
  background: var(--color-chrome);
}
/* In the header: a little tighter, so the whole row fits from 1100 px. Between
   1100 and 1280 the Chain button drops its word first (its badge stays) —
   the category labels go last, since they are what a new user navigates by. */
.toolbar-inline .tool-btn {
  padding: 0 13px;
}
.toolbar-inline .chain-btn {
  padding: 0 12px;
}
@media (max-width: 1279.98px) {
  .toolbar-inline .tool-btn {
    padding: 0 10px;
  }
  .toolbar-inline .chain-label {
    display: none;
  }
}
</style>
