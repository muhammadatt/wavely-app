<script setup>
import { useEditorState } from './composables/useEditorState.js'
import EditorScreen from './components/EditorScreen.vue'
import FilesPanel from './components/FilesPanel.vue'
import ExportDialog from './components/ExportDialog.vue'
import ToastNotification from './components/ToastNotification.vue'
import CommandPalette from './components/CommandPalette.vue'
import WaveformContextMenu from './components/WaveformContextMenu.vue'
import WindowLayer from './components/WindowLayer.vue'
import AuthDialog from './components/AuthDialog.vue'
import UpgradeDialog from './components/UpgradeDialog.vue'
import { onPresetError } from './audio/pluginPresets/store.js'
import { useAuth } from './composables/useAuth.js'
import { useBilling } from './composables/useBilling.js'
import { checkoutReturnMessage } from './auth/billing.js'

// ProcessingOverlay is no longer mounted here — it now renders inside the
// waveform area so a job on one document doesn't block the whole app.
//
// Floating effect windows are no longer listed here either: WindowLayer renders
// whatever the window manager has open, so adding one is a registry entry.
const { appState, showToast } = useEditorState()

// Started here rather than on first use so an auth redirect (email link,
// password reset) is handled on load even before the top bar renders.
const { state: authState } = useAuth()

// Presets save to the account behind the menu; a write that fails is rolled
// back by the store, and this is where the user hears about it.
onPresetError(({ message }) => showToast(message, 5000))

// Finish a return from Stripe Checkout or the billing portal (when it landed in
// this tab rather than the one we opened), and follow plan changes made in
// other tabs. A no-op with accounts off.
useBilling().start().then(result => {
  const message = checkoutReturnMessage(result)
  if (message) showToast(message.text, message.ms)
})
</script>

<template>
  <EditorScreen />
  <FilesPanel v-if="appState.filesPanelOpen" />
  <ExportDialog v-if="appState.exportDialogOpen" />
  <WindowLayer />
  <CommandPalette v-if="appState.commandPaletteOpen" />
  <!-- Keyed on position: right-clicking while the menu is open nulls and re-sets
       contextMenu within one tick, so without this Vue reuses the instance and
       the menu stays at the previous coordinates. -->
  <WaveformContextMenu
    v-if="appState.contextMenu"
    :key="`${appState.contextMenu.x},${appState.contextMenu.y}`"
  />
  <UpgradeDialog v-if="authState.upgradeFor" />
  <AuthDialog v-if="authState.dialog" />
  <ToastNotification />
</template>
