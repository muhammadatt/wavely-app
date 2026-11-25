<script setup>
import { defineAsyncComponent, watch } from 'vue'
import { useEditorState } from './composables/useEditorState.js'
import FilesPanel from './components/FilesPanel.vue'
import SaveDialog from './components/SaveDialog.vue'
import ToastNotification from './components/ToastNotification.vue'
import CommandPalette from './components/CommandPalette.vue'
import WaveformContextMenu from './components/WaveformContextMenu.vue'
import WindowLayer from './components/WindowLayer.vue'
import AuthDialog from './components/AuthDialog.vue'
import UpgradeDialog from './components/UpgradeDialog.vue'
import AccountScreen from './components/account/AccountScreen.vue'
import { onPresetError } from './audio/pluginPresets/store.js'
import { useAuth } from './composables/useAuth.js'
import { useBilling } from './composables/useBilling.js'
import { useAccountScreen } from './composables/useAccountScreen.js'
import { checkoutReturnMessage } from './auth/billing.js'
import { useTryOut } from './composables/useTryOut.js'
import { useSessionAutosave } from './composables/useSessionAutosave.js'
import { useServerJobs } from './composables/useServerJobs.js'
import ServerJobsNotice from './components/ServerJobsNotice.vue'
import SharedLinkNotice from './components/SharedLinkNotice.vue'
import ShareDialog from './components/ShareDialog.vue'
import { useSharedLink } from './composables/useSharedLink.js'
import { createWakeLock } from './platform/wakeLock.js'
import { useFormFactor } from './composables/useFormFactor.js'

// One editor shell per visit: the desktop layout or the phone one, chosen at
// startup (ui/formFactor.js) unless the user picked one. Each loads on its
// own, so a phone never downloads the desktop shell and a desktop never
// downloads the phone one; everything they edit lives outside them.
const EditorScreen = defineAsyncComponent(() => import('./components/EditorScreen.vue'))
const MobileEditorScreen = defineAsyncComponent(() => import('./components/mobile/MobileEditorScreen.vue'))
const { layout } = useFormFactor()

// ProcessingOverlay is no longer mounted here — it now renders inside the
// waveform area so a job on one document doesn't block the whole app.
//
// Floating effect windows are no longer listed here either: WindowLayer renders
// whatever the window manager has open, so adding one is a registry entry.
const { appState, showToast, anyProcessing } = useEditorState()

// A marketing page's "Try it on this clip" link: read now, so the clip is
// fetching while the page loads. The empty state shows the offer.
useTryOut()

// A shared chain or preset link (`#share=…`): read now, offered on a card
// (SharedLinkNotice) and loaded only when the user says so.
useSharedLink()

// Recovery copies of files with unsaved edits, and the offer to restore the
// work a closed or crashed tab left (shown by the empty state).
useSessionAutosave().start()

// Mastering and Noise Reduction jobs a closed or crashed tab left running on
// the server: picked up again here, and offered once done (ServerJobsNotice).
useServerJobs().start()

// The screen stays on while a file is processing, so a phone does not lock
// (and suspend the page) mid-upload or mid-render.
const wakeLock = createWakeLock()
watch(anyProcessing, on => wakeLock.set(on))

// Started here rather than on first use so an auth redirect (email link,
// password reset) is handled on load even before the top bar renders.
const { state: authState } = useAuth()

// A plan that turns Pro while this tab is open (Checkout finished in its own
// tab) is welcomed here — unless the upgrade dialog is open, which shows its
// own success view, or this load IS the Checkout return, which toasts below.
// Keyed on the LOADED account: a Pro user's page load goes undefined → 'pro'
// and is not an upgrade.
const returningFromCheckout = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('checkout')
watch(() => authState.account?.plan, (now, before) => {
  if (now === 'pro' && before === 'free' && !authState.upgradeFor && !returningFromCheckout) {
    showToast('Welcome to Pro — every tool is unlocked', 5000)
  }
})

// Presets save to the account behind the menu; a write that fails is rolled
// back by the store, and this is where the user hears about it.
onPresetError(({ message }) => showToast(message, 5000))

// Finish a return from Stripe Checkout or the billing portal (when it landed in
// this tab rather than the one we opened), and follow plan changes made in
// other tabs. A no-op with accounts off.
// The account dashboard follows the address bar's `#/account/…`; a deep link
// opens it on load (after a log-in if needed).
const accountScreen = useAccountScreen()
accountScreen.start()

useBilling().start().then(result => {
  // Back from the billing portal in THIS tab (the one we opened closes itself):
  // land where it was opened from.
  if (result?.kind === 'portal') accountScreen.open('billing')
  const message = checkoutReturnMessage(result)
  if (message) showToast(message.text, message.ms)
})
</script>

<template>
  <!-- Kept mounted under the account dashboard (documents live in memory),
       but inert: nothing behind it takes focus or clicks. -->
  <component
    :is="layout === 'mobile' ? MobileEditorScreen : EditorScreen"
    :inert="accountScreen.state.open || undefined"
  />
  <FilesPanel v-if="appState.filesPanelOpen" />
  <SaveDialog v-if="appState.saveDialog" :key="appState.saveDialog.docId" />
  <WindowLayer />
  <CommandPalette v-if="appState.commandPaletteOpen" />
  <!-- Keyed on position: right-clicking while the menu is open nulls and re-sets
       contextMenu within one tick, so without this Vue reuses the instance and
       the menu stays at the previous coordinates. -->
  <WaveformContextMenu
    v-if="appState.contextMenu"
    :key="`${appState.contextMenu.x},${appState.contextMenu.y}`"
  />
  <AccountScreen v-if="accountScreen.state.open" />
  <UpgradeDialog v-if="authState.upgradeFor" />
  <AuthDialog v-if="authState.dialog" />
  <ServerJobsNotice />
  <SharedLinkNotice />
  <ShareDialog />
  <ToastNotification />
</template>
