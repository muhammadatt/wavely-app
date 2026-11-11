<script setup>
import { computed } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { formatDuration } from '../utils/format.js'
import Icon from './ui/Icon.vue'
import AccountMenu from './AccountMenu.vue'

const { state, undo, redo, canUndo, canRedo } = useEditorState()

// The active file's properties. They sat on the tab row for a while; with
// the categories in their own row again (owner, November 2026) the header's
// middle is free, and they read as the title line of the file below.
const fileMeta = computed(() => {
  const f = state.currentFile
  if (!f) return null
  return {
    format: f.name.split('.').pop().toUpperCase(),
    duration: formatDuration(f.duration),
    channels: f.channels === 1 ? 'Mono' : f.channels === 2 ? 'Stereo' : `${f.channels} ch`,
    sampleRate: `${+(f.sampleRate / 1000).toFixed(1)} kHz`,
  }
})
</script>

<template>
  <!-- The header: brand, the active file's details, history and the account.
       The categories have their own row under it (FloatingToolbar) and the
       file actions (Save, Files) sit on the tab row, beside the files. -->
  <div
    class="h-[56px] compact:h-[44px] flex items-center px-5 compact:px-2 gap-[13px] compact:gap-2 shrink-0 z-10"
    style="background:var(--color-chrome)"
  >
    <!-- flex-1 from a zero basis on both sides keeps the details centred on
         the window; min-w-fit stops either end shrinking under its own
         content, so on a tight window the details give way, never the
         actions. -->
    <div class="flex-1 basis-0 min-w-fit flex items-center">
      <img src="/crisp-fm-logo.png" alt="crisp.fm" class="h-[26px] compact:h-[20px] max-sm:h-[17px] w-auto select-none shrink-0" draggable="false" />
    </div>

    <!-- Label / value pairs: the label names the property, so the format
         needs no badge and the line reads as words rather than a code. -->
    <div
      v-if="fileMeta"
      class="min-w-0 flex items-center justify-center gap-[16px] overflow-hidden max-md:hidden"
      :title="state.currentFile?.name || ''"
    >
      <span class="meta"><span class="meta-k">Format</span> {{ fileMeta.format }}</span>
      <span class="meta tabular-nums"><span class="meta-k">Length</span> {{ fileMeta.duration }}</span>
      <span class="meta"><span class="meta-k">{{ fileMeta.channels }}</span> {{ fileMeta.sampleRate }}</span>
    </div>

    <div class="flex-1 basis-0 min-w-fit flex items-center justify-end gap-2 compact:gap-1">
      <!-- History. One outlined group, the two halves split by a hairline,
           each with its word (owner, November 2026: with the categories out
           of the header there is room to say it). Compact viewports keep the
           arrows alone. -->
      <div class="tb-history flex items-stretch shrink-0" role="group" aria-label="History">
        <button
          class="tb-hist"
          :disabled="!canUndo"
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
          @click="undo"
        ><Icon name="undo" :size="15" /><span class="tb-hist-label compact:hidden">Undo</span></button>
        <button
          class="tb-hist"
          :disabled="!canRedo"
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
          @click="redo"
        ><Icon name="redo" :size="15" /><span class="tb-hist-label compact:hidden">Redo</span></button>
      </div>

      <AccountMenu />
    </div>
  </div>
</template>

<style scoped>
.tb-history {
  height: 34px;
  border-radius: 10px;
  background: rgba(255, 255, 255, .03);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .1);
  overflow: hidden;
}
.tb-hist {
  cursor: pointer;
  min-width: 38px;
  padding: 0 13px 0 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text-soft);
  transition: background-color .12s, color .12s;
}
@media (max-height: 520px), (max-width: 640px) {
  .tb-hist { padding: 0; }
}
.tb-hist + .tb-hist { box-shadow: inset 1px 0 0 rgba(255, 255, 255, .1); }
.tb-hist:hover:not(:disabled) { background: rgba(255, 255, 255, .07); color: var(--color-text); }
.tb-hist:disabled { color: rgba(255, 255, 255, .25); cursor: default; }
.tb-hist:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }

/* 12 px reference text: a step under the header's buttons (12.5). */
.meta {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-soft);
  white-space: nowrap;
}
.meta-k {
  font-weight: 500;
  color: rgba(255, 255, 255, .42);
  margin-right: 3px;
}
</style>
