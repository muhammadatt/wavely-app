<script setup>
import { useFileImport } from '../composables/useFileImport.js'
import { ref } from 'vue'
import { useTryOut } from '../composables/useTryOut.js'
import { useSessionAutosave } from '../composables/useSessionAutosave.js'
import BaseButton from './ui/BaseButton.vue'

// Drag-drop is handled once at the workspace level in EditorScreen so files can
// be dropped at any time, not only from here. This component is just the
// click-to-browse affordance and the import progress readout.
const { promptForFiles, isImporting, importProgress } = useFileImport()
// Arrived from a marketing page's "Try it on this clip" (see useTryOut).
const { tryOut, start: startTryOut, dismiss: dismissTryOut } = useTryOut()
// Work a closed or crashed tab left behind (see useSessionAutosave).
const { autosave, restore, discard } = useSessionAutosave()
// Discarding deletes the only copy, so it takes a second, explicit click.
const confirmingDiscard = ref(false)

function recoveryFiles() {
  return autosave.pending.flatMap(p => p.files)
}

function savedAgo(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(ms).toLocaleDateString()
}
</script>

<template>
  <div
    class="relative flex-1 min-h-0 rounded-[16px] border-3 border-dashed transition-all cursor-pointer m-1 flex items-center justify-center overflow-hidden"
    style="border-color:rgba(255,255,255,.12)"
  >
    <div
      class="text-center px-6 py-10 w-[420px] md:w-[500px]"
      @click="promptForFiles()"
    >
      <div class="w-[60px] h-[60px] rounded-[16px] flex items-center justify-center mx-auto mb-4" style="background:rgba(53,211,230,.12)">
        <svg viewBox="0 0 24 24" class="w-7 h-7 stroke-current" style="color:#7fe9f6" stroke-width="1.8" fill="none">
          <path v-if="tryOut.offer && !isImporting" d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>
          <path v-else d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
        </svg>
      </div>

      <div v-if="isImporting">
        <div class="text-[15px] font-bold text-[#eaf6f8] mb-2">
          Loading audio<span v-if="importProgress.total > 1"> — {{ importProgress.done + 1 }} of {{ importProgress.total }}</span>…
        </div>
        <div class="w-40 h-1.5 rounded-full mx-auto overflow-hidden" style="background:rgba(255,255,255,.08)">
          <div
            v-if="importProgress.total > 1"
            class="h-full rounded-full transition-all duration-300"
            style="background:#35d3e6"
            :style="{ width: `${(importProgress.done / importProgress.total) * 100}%` }"
          ></div>
          <div v-else class="h-full rounded-full animate-pulse w-2/3" style="background:#35d3e6"></div>
        </div>
      </div>

      <!-- Unsaved work from a tab that closed or crashed. Before the try-out:
           the user's own work outranks a demo clip. -->
      <div v-else-if="autosave.pending.length" class="try" data-testid="recovery" @click.stop>
        <div class="try-eyebrow">Unsaved work</div>
        <div class="try-title">
          Restore {{ recoveryFiles().length === 1 ? '1 file' : `${recoveryFiles().length} files` }} from your last session?
        </div>
        <div class="try-setting">Last backed up {{ savedAgo(autosave.pending[0].savedAt) }}</div>
        <ul class="recovery-files">
          <li v-for="(name, i) in recoveryFiles().slice(0, 5)" :key="i">{{ name }}</li>
          <li v-if="recoveryFiles().length > 5">and {{ recoveryFiles().length - 5 }} more</li>
        </ul>
        <BaseButton size="md" class="w-full mt-4" :disabled="autosave.restoring" @click="restore()">
          {{ autosave.restoring ? 'Restoring…' : 'Restore' }}
        </BaseButton>
        <p class="try-note">Your edits come back as unsaved files. Undo history is not restored.</p>
        <button v-if="!confirmingDiscard" type="button" class="try-own" :disabled="autosave.restoring" @click="confirmingDiscard = true">Discard</button>
        <div v-else class="recovery-confirm">
          <span>This deletes the only copy.</span>
          <button type="button" class="try-own danger" :disabled="autosave.restoring" @click="discard(); confirmingDiscard = false">Discard for good</button>
          <button type="button" class="try-own" @click="confirmingDiscard = false">Keep</button>
        </div>
      </div>

      <!-- A try-out link: one click loads the clip, opens the effect and plays. -->
      <div v-else-if="tryOut.offer" class="try" @click.stop>
        <div class="try-eyebrow">Try {{ tryOut.offer.title }}</div>
        <div class="try-title">{{ tryOut.offer.sample.title }}</div>
        <div class="try-setting">{{ tryOut.offer.sample.setting }}</div>
        <BaseButton size="md" class="w-full mt-4" :disabled="tryOut.status === 'loading'" @click="startTryOut()">
          <svg viewBox="0 0 24 24" class="w-[13px] h-[13px]" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
          {{ tryOut.status === 'loading' ? 'Loading the clip…' : tryOut.offer.firstStep ? 'Start — load the clip' : 'Start — load the clip and play' }}
        </BaseButton>
        <p v-if="tryOut.offer.firstStep === 'apply'" class="try-note">Opens the clip with {{ tryOut.offer.title }} set up. Press Apply to hear it, Undo to compare, then try your own audio.</p>
        <p v-else-if="tryOut.offer.firstStep === 'analyse'" class="try-note">Opens the clip with {{ tryOut.offer.title }}. Press Analyse to find the hum, then play to hear it go.</p>
        <p v-else class="try-note">Opens the clip with {{ tryOut.offer.title }} on. Switch it on and off, turn the knobs, then try your own audio.</p>
        <button type="button" class="try-own" @click="dismissTryOut()">Use my own audio instead</button>
      </div>

      <template v-else>
        <div class="text-[15px] font-bold text-[#eaf6f8] mb-1">Drop your audio files here</div>
        <div class="text-[12px] font-medium text-[rgba(255,255,255,.4)] mb-5">or click to browse — you can pick more than one</div>

        <BaseButton size="md" @click.stop="promptForFiles()" class="w-full">
          <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><path d="M9 19V6l12-3v13M9 19c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm12 0c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2z"/></svg>
          Choose audio files
        </BaseButton>

        <div class="mt-5 flex flex-wrap items-center justify-center gap-1.5">
          <span v-for="fmt in ['MP3', 'WAV', 'OGG', 'M4A', 'FLAC']" :key="fmt"
                class="text-[10px] font-bold px-2 py-0.5 rounded-[6px]"
                style="background:rgba(255,255,255,.05);color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.08)">
            {{ fmt }}
          </span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.try { cursor: default; }
.try-eyebrow {
  font: 600 11px 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: #35d3e6;
}
.try-title { margin-top: 6px; font-size: 18px; font-weight: 800; color: #eaf6f8; }
.try-setting { margin-top: 2px; font-size: 12px; font-weight: 500; color: rgba(255,255,255,.45); }
.try-note { margin: 12px 0 0; font-size: 12px; line-height: 1.5; color: rgba(255,255,255,.5); }
.try-own {
  margin-top: 10px;
  border: none;
  background: none;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: rgba(255,255,255,.55);
  text-decoration: underline;
  cursor: pointer;
}
.try-own:hover { color: #eaf6f8; }
.try-own.danger { color: #ff8a80; }
.recovery-files {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12.5px;
  font-weight: 600;
  color: rgba(255,255,255,.7);
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-wrap: anywhere;
}
.recovery-confirm {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: baseline;
  gap: 4px 12px;
  font-size: 12px;
  color: rgba(255,255,255,.55);
}
.recovery-confirm .try-own { margin-top: 0; }
</style>
