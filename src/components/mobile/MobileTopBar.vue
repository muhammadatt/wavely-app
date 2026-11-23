<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { useFileImport } from '../../composables/useFileImport.js'
import { useFileSave } from '../../composables/useFileSave.js'
import { useFormFactor } from '../../composables/useFormFactor.js'
import { useMobileSheets } from '../../composables/useMobileSheets.js'
import { formatDuration } from '../../utils/format.js'
import { baseName } from '../../ui/tabName.js'
import Icon from '../ui/Icon.vue'
import { useAccountActions } from '../../composables/useAccountActions.js'

/**
 * The mobile shell's header: the active file (its name opens the file
 * switcher sheet), its details, ONE Undo / Redo control with a seam, Save,
 * and a ⋯ menu for the rest — open, files, Save As, the account and the
 * desktop layout. The account lives in ⋯ (design "small fixes" #1, November
 * 2026), not as its own button: the name and its details had no room.
 */
const {
  state, documents, activeDoc, undo, redo, canUndo, canRedo, hasFile,
  documentHasUnsavedWork,
} = useEditorState()
const { promptForFiles } = useFileImport()
const { saveDocument, saveDocumentAs, isSaving } = useFileSave()
const { chooseLayout } = useFormFactor()

const meta = computed(() => {
  const f = state.currentFile
  if (!f) return ''
  const channels = f.channels === 1 ? 'Mono' : f.channels === 2 ? 'Stereo' : `${f.channels} ch`
  return [
    f.name.split('.').pop().toUpperCase(),
    `${+(f.sampleRate / 1000).toFixed(1)} kHz`,
    channels,
    formatDuration(f.duration),
  ].join(' · ')
})

// Without its extension, as the desktop tabs show it: the format is on the
// line below, and the name is what needs the room.
const title = computed(() => baseName(state.name || ''))

const fileCount = computed(() => documents.value.length)
const position = computed(() => documents.value.findIndex(d => d.id === activeDoc.value?.id) + 1)
const unsaved = computed(() => !!activeDoc.value && documentHasUnsavedWork(activeDoc.value.id))

const { fileSheetOpen, toggleFileSheet, openFileSheet } = useMobileSheets()
const account = useAccountActions()
const accountsOn = computed(() => account.status.value !== 'disabled' && account.status.value !== 'loading')

// ── The overflow menu ───────────────────────────────────────────────────────
const menuOpen = ref(false)

function onWindowPointer(e) {
  if (!e.target.closest?.('[data-mobile-menu]')) menuOpen.value = false
}
onMounted(() => window.addEventListener('pointerdown', onWindowPointer))
onUnmounted(() => window.removeEventListener('pointerdown', onWindowPointer))

function run(action) {
  menuOpen.value = false
  action()
}
</script>

<template>
  <header class="m-top">
    <button
      v-if="hasFile"
      type="button"
      class="m-file"
      :title="state.currentFile?.name"
      aria-label="Switch file"
      :aria-expanded="String(fileSheetOpen)"
      data-testid="mobile-file-switcher"
      @click="toggleFileSheet"
    >
      <span class="m-file-name">
        <span class="truncate">{{ title }}</span>
        <svg viewBox="0 0 24 24" class="m-chev" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        <span v-if="fileCount > 1" class="m-count">{{ position }}/{{ fileCount }}</span>
      </span>
      <span class="m-file-meta">{{ meta }}</span>
    </button>
    <div v-else class="m-brand">
      <img src="/crisp-fm-logo.png" alt="crisp.fm" class="h-[20px] w-auto" draggable="false" />
    </div>

    <div class="m-actions">
      <template v-if="hasFile">
        <div class="m-history" role="group" aria-label="History">
          <button type="button" :disabled="!canUndo || !!state.isProcessing" aria-label="Undo" title="Undo" @click="undo">
            <Icon name="undo" :size="16" />
          </button>
          <span class="m-seam" aria-hidden="true" />
          <button type="button" :disabled="!canRedo || !!state.isProcessing" aria-label="Redo" title="Redo" @click="redo">
            <Icon name="redo" :size="16" />
          </button>
        </div>
        <button
          type="button"
          class="m-btn m-save"
          :class="{ 'is-unsaved': unsaved }"
          :disabled="isSaving"
          aria-label="Save"
          title="Save"
          data-testid="mobile-save"
          @click="saveDocument()"
        >
          <svg viewBox="0 0 24 24" class="m-ico" aria-hidden="true"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
          <span v-if="unsaved" class="m-dot" aria-hidden="true" />
        </button>
      </template>

      <div class="relative" data-mobile-menu>
        <button
          type="button"
          class="m-btn"
          aria-label="More"
          title="More"
          :aria-expanded="String(menuOpen)"
          data-testid="mobile-more"
          @click="menuOpen = !menuOpen"
        >
          <svg viewBox="0 0 24 24" class="m-ico" aria-hidden="true"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
          <!-- A failed payment can't hide in a menu: Pro lapses if the card
               isn't fixed. -->
          <span v-if="account.pastDue.value" class="m-dot is-warn" aria-label="Payment failed" />
        </button>
        <div v-if="menuOpen" class="m-menu" role="menu">
          <button type="button" role="menuitem" @click="run(promptForFiles)">Open audio…</button>
          <button v-if="fileCount" type="button" role="menuitem" @click="run(openFileSheet)">All files</button>
          <button v-if="hasFile" type="button" role="menuitem" @click="run(() => saveDocumentAs())">Save as…</button>
          <template v-if="accountsOn">
            <hr />
            <template v-if="account.signedIn.value">
              <div class="m-acct" data-testid="mobile-account">
                <span class="m-acct-name">{{ account.displayName.value }}</span>
                <span class="m-acct-plan">{{ account.planLabel.value }} plan<template v-if="account.subscriptionLine.value"> · {{ account.subscriptionLine.value }}</template></span>
                <span v-if="account.accountError.value" class="m-acct-warn">Couldn’t load your plan</span>
              </div>
              <button v-if="account.pastDue.value" type="button" role="menuitem" class="is-warn" @click="run(() => account.openAccount('billing'))">Payment failed — update card</button>
              <button v-if="account.canUpgrade.value" type="button" role="menuitem" class="is-gold" @click="run(account.upgrade)">Upgrade to Pro</button>
              <button type="button" role="menuitem" @click="run(() => account.openAccount())">Account</button>
              <button v-if="account.hasSubscription.value" type="button" role="menuitem" @click="run(account.manageBilling)">Manage subscription</button>
              <button type="button" role="menuitem" @click="run(account.signOut)">Sign out</button>
            </template>
            <template v-else>
              <button type="button" role="menuitem" data-testid="mobile-sign-in" @click="run(account.signIn)">Log in</button>
              <button type="button" role="menuitem" @click="run(account.signUp)">Create a free account</button>
            </template>
          </template>
          <hr />
          <button type="button" role="menuitem" data-testid="use-desktop-layout" @click="run(() => chooseLayout('desktop'))">Use desktop layout</button>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
.m-top {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 6px 14px;
  min-height: 52px;
  flex-shrink: 0;
}
.m-file {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
  background: none;
  border: none;
  padding: 2px 0;
  color: #eaf6f8;
  cursor: pointer;
}
.m-file-name {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  font-size: 15px;
  font-weight: 700;
}
.m-chev { width: 13px; height: 13px; flex: none; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; opacity: .7; }
.m-count {
  flex: none;
  font: 600 10px 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255,255,255,.55);
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(255,255,255,.07);
}
.m-file-meta {
  max-width: 100%;
  font: 500 10.5px 'JetBrains Mono', ui-monospace, monospace;
  color: rgba(255,255,255,.42);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.m-brand { flex: 1; display: flex; align-items: center; }
.m-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.m-btn {
  position: relative;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  color: rgba(255,255,255,.75);
  background: var(--chrome-btn-bg, rgba(255,255,255,.03));
  box-shadow: var(--chrome-btn-ring);
  border: none;
  cursor: pointer;
}
.m-btn:disabled { opacity: .35; cursor: default; }
.m-ico { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.m-ico circle { fill: currentColor; stroke: none; }
.m-history {
  display: flex;
  height: 38px;
  border-radius: 10px;
  background: var(--chrome-btn-bg, rgba(255,255,255,.03));
  box-shadow: var(--chrome-btn-ring);
}
.m-history button {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: none;
  background: none;
  color: rgba(255,255,255,.75);
  cursor: pointer;
}
.m-history button:disabled { opacity: .35; cursor: default; }
.m-seam { width: 1px; margin: 9px 0; background: rgba(255,255,255,.1); }
.m-save.is-unsaved { background: #1e2939; box-shadow: none; color: #eaf6f8; }
.m-dot { position: absolute; top: 6px; right: 6px; width: 6px; height: 6px; border-radius: 50%; background: #e8a33d; }
.m-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 80;
  min-width: 190px;
  padding: 6px;
  border-radius: 12px;
  background: #161b22;
  box-shadow: 0 0 0 1px rgba(255,255,255,.1), 0 14px 32px rgba(0,0,0,.5);
  display: flex;
  flex-direction: column;
  /* With the account in it the menu can outgrow a phone on its side. */
  max-height: calc(100dvh - 70px);
  overflow-y: auto;
}
.m-menu button {
  text-align: left;
  padding: 11px 12px;
  border-radius: 8px;
  border: none;
  background: none;
  color: #eaf6f8;
  font: 500 14px 'Inter', sans-serif;
  cursor: pointer;
}
.m-menu button:active { background: rgba(255,255,255,.06); }
.m-menu button.is-gold { color: #e0b84a; font-weight: 600; }
.m-menu button.is-warn { color: var(--color-warn, #ffb454); font-weight: 600; }
.m-dot.is-warn { background: var(--color-warn, #ffb454); }
.m-acct { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px 6px; min-width: 0; }
.m-acct-name { font: 700 13px 'Inter', sans-serif; color: #eaf6f8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
.m-acct-plan { font: 500 11.5px 'Inter', sans-serif; color: rgba(255,255,255,.55); }
.m-acct-warn { font: 500 11.5px 'Inter', sans-serif; color: var(--color-warn, #ffb454); }
.m-menu hr { border: none; border-top: 1px solid rgba(255,255,255,.08); margin: 4px 6px; }

@media (max-height: 500px) {
  .m-top { min-height: 42px; padding-top: 4px; padding-bottom: 2px; }
  .m-file-meta { display: none; }
  .m-btn { width: 34px; height: 34px; }
  .m-history { height: 34px; }
  .m-history button { width: 34px; height: 34px; }
}
</style>
