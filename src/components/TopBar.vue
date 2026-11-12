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
  >
    <!-- The logo, then the active file's details beside it (owner, November
         2026: centred, they floated; by the logo they read as the title
         line). min-w-0 lets the details give way on a tight window, never
         the actions. -->
    <div class="flex-1 min-w-0 flex items-center">
      <img src="/crisp-fm-logo.png" alt="crisp.fm" class="h-[22px] compact:h-[20px] max-sm:h-[17px] w-auto select-none shrink-0" draggable="false" />
      <!-- Label / value pairs. The format value sits in the teal chip from main;
           the other values stay plain words. -->
      <template v-if="fileMeta">
        <div class="w-px h-[18px] bg-[rgba(255,255,255,.12)] mx-[18px] shrink-0 max-md:hidden"></div>
        <div
          class="min-w-0 flex items-center gap-[16px] overflow-hidden max-md:hidden font-['JetBrains_Mono']"
          :title="state.currentFile?.name || ''"
        >
          <span class="meta"><span class="meta-k">Format</span><span class="meta-chip">{{ fileMeta.format }}</span></span>
          <span class="meta tabular-nums"><span class="meta-k">Length</span> {{ fileMeta.duration }}</span>
          <span class="meta"><span class="meta-k">{{ fileMeta.channels }}</span> {{ fileMeta.sampleRate }}</span>
        </div>
      </template>
    </div>

    <div class="shrink-0 flex items-center justify-end gap-2 compact:gap-1">
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
  border-radius: var(--chrome-btn-radius);
  background: var(--chrome-btn-bg);
  box-shadow: var(--chrome-btn-ring);
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
  color: var(--chrome-btn-text);
  transition: background-color .12s, color .12s;
}
@media (max-height: 520px), (max-width: 640px) {
  .tb-hist { padding: 0; }
}
.tb-hist + .tb-hist { box-shadow: inset 1px 0 0 var(--chrome-btn-seam); }
.tb-hist:hover:not(:disabled) { background: var(--chrome-btn-hover); color: var(--color-text); }
.tb-hist:disabled { color: rgba(255, 255, 255, .25); cursor: default; }
.tb-hist:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }


.meta {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, .45);
  white-space: nowrap;
}
.meta-k {
  font-weight: 500;
  color: rgba(255, 255, 255, .40);
  margin-right: 3px;
}
.meta-chip {
  /* inline-block so its padding and border count toward the line box;
     as a plain inline they overflowed it and the row's overflow-hidden
     clipped the top and bottom of the border. */
  display: inline-block;
  line-height: 1.3;
  vertical-align: middle;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  padding: 3px 6px;
  border-radius: 5px;
  color: #7fe9f6;
  background: rgba(53, 211, 230, .14);
  border: 1px solid rgba(53, 211, 230, .3);
}
</style>
