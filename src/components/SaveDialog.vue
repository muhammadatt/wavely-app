<script setup>
import { computed, ref, watch } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileSave } from '../composables/useFileSave.js'
import { getTimelineDuration } from '../audio/operations.js'
import { formatSize, WAV_SIZE_LIMIT } from '../audio/exportPlan.js'
import { isCancellation, pickSaveTarget } from '../audio/fileSave.js'
import {
  BIT_DEPTHS, bitDepthById, sampleRateOptions, defaultSaveSettings,
  qualityLossWarning, formatRate, wavBytesFor, savePlan, toSaveFileName,
} from '../audio/saveFormat.js'
import BaseButton from './ui/BaseButton.vue'

/**
 * The Save dialog: name, location, bit depth and sample rate, before anything
 * is written. Opens on the first Save of a document and on every Save As;
 * later Saves reuse what was confirmed here (useFileSave).
 *
 * ⚠ A WEB PAGE CANNOT SHOW OR TYPE A FOLDER PATH. "Location" is therefore a
 * description — the original file's folder, a folder chosen with Change…, or
 * the downloads folder — and choosing a different one goes through the system
 * save dialog, opened in the original's folder. What the page CAN do is write
 * straight back to the file it was opened from, which is what Save does when
 * the name is left as it is.
 */

const { appState, getDocument, showToast, getSaveTarget, getSaveSettings } = useEditorState()
const { confirmSave, anchorHandleFor, isSaving, canSaveInPlace } = useFileSave()

const docId = appState.saveDialog?.docId
const doc = computed(() => getDocument(docId))

const supportsInPlace = canSaveInPlace()
const anchor = anchorHandleFor(docId)
const anchorIsLastSave = !!anchor && anchor === getSaveTarget(docId)
const source = doc.value?.currentFile?.sourceFormat ?? null
const docRate = doc.value?.currentFile?.sampleRate ?? 44100
const channels = doc.value?.currentFile?.channels ?? 1

const initial = getSaveSettings(docId) ?? defaultSaveSettings(source, docRate)
const fileName = ref(toSaveFileName(doc.value?.name ?? 'untitled.wav'))
const bitDepth = ref(initial.bitDepth)
const sampleRate = ref(initial.sampleRate)
const rateOptions = sampleRateOptions(source, docRate)

// A destination picked with Change…. Editing the name afterwards drops it: the
// handle names one file, and saving it under another name would write to the
// file the user just typed over.
const chosenHandle = ref(null)
watch(fileName, name => {
  if (chosenHandle.value && toSaveFileName(name) !== chosenHandle.value.name) chosenHandle.value = null
})

const plan = computed(() => savePlan({
  supportsInPlace, chosenHandle: chosenHandle.value, anchorHandle: anchor, fileName: fileName.value,
}))

const locationText = computed(() => {
  if (!supportsInPlace) return 'Your downloads folder'
  if (chosenHandle.value) return 'The folder you chose'
  if (anchor) return anchorIsLastSave
    ? `Same folder as the last save (${anchor.name})`
    : `Same folder as the original (${anchor.name})`
  return 'Chosen in the next step'
})

const planText = computed(() => {
  switch (plan.value) {
    case 'replace': return `Replaces ${anchor.name}.`
    case 'chosen': return `Saves as ${chosenHandle.value.name}.`
    case 'download': return 'Your browser can’t write files directly, so this downloads.'
    default: return anchor
      ? 'You’ll confirm in the system dialog, opened in that folder.'
      : 'You’ll pick the folder in the system dialog.'
  }
})

const sourceText = computed(() => {
  if (!source) return null
  const parts = [source.container.toUpperCase()]
  if (source.bitDepth) parts.push(source.float ? '32-bit float' : `${source.bitDepth}-bit`)
  if (source.sampleRate) parts.push(formatRate(source.sampleRate))
  if (source.channels) parts.push(source.channels === 1 ? 'mono' : source.channels === 2 ? 'stereo' : `${source.channels} ch`)
  return parts.join(' · ')
})

const warning = computed(() => qualityLossWarning({ bitDepth: bitDepth.value, sampleRate: sampleRate.value }, source))

const bytes = computed(() => {
  const d = doc.value ? getTimelineDuration(doc.value.segments) : 0
  return wavBytesFor(d, channels, { bitDepth: bitDepth.value, sampleRate: sampleRate.value })
})
const tooBig = computed(() => bytes.value > WAV_SIZE_LIMIT)

const nameValid = computed(() => fileName.value.trim().replace(/\.wav$/i, '').length > 0)
const canSave = computed(() => !!doc.value && nameValid.value && !tooBig.value && !isSaving.value)

function close() {
  if (isSaving.value) return
  appState.saveDialog = null
}

async function changeLocation() {
  if (isSaving.value) return
  try {
    const handle = await pickSaveTarget(fileName.value, chosenHandle.value ?? anchor)
    chosenHandle.value = handle
    fileName.value = handle.name
  } catch (err) {
    if (isCancellation(err)) return
    console.error('Save picker failed:', err)
    showToast("Couldn't open the save dialog")
  }
}

async function save() {
  if (!canSave.value) return
  const ok = await confirmSave(docId, {
    fileName: fileName.value,
    bitDepth: bitDepth.value,
    sampleRate: sampleRate.value,
    chosenHandle: chosenHandle.value,
  })
  if (ok && appState.saveDialog?.docId === docId) appState.saveDialog = null
}

// The document can close underneath the dialog (the files panel stays usable);
// there is nothing left to save then.
watch(doc, d => { if (!d) appState.saveDialog = null })
</script>

<template>
  <div
    class="fixed inset-0 z-[450] flex items-start justify-center pt-[10vh] px-4"
    style="background:rgba(5,7,9,.6);backdrop-filter:blur(5px)"
    @click.self="close"
  >
    <div
      class="w-full max-w-[460px] flex flex-col rounded-[18px] overflow-hidden font-['Inter']"
      style="background:linear-gradient(155deg,#181c22,#0d1013);box-shadow:0 24px 60px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.07);animation:bounceIn .28s cubic-bezier(.34,1.4,.64,1) both"
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-dialog-title"
    >
      <!-- Header -->
      <div class="px-5 pt-[18px] pb-[14px] border-b border-[rgba(255,255,255,.07)]">
        <div id="save-dialog-title" class="text-[15px] font-bold text-[#eaf6f8]">Save</div>
        <div v-if="sourceText" class="mt-[3px] text-[11.5px] text-[rgba(255,255,255,.42)]">
          Original: <span class="font-['JetBrains_Mono'] font-semibold">{{ sourceText }}</span>
        </div>
      </div>

      <div class="px-5 py-4 flex flex-col gap-[14px]">
        <!-- Name -->
        <label class="flex flex-col gap-[6px]">
          <span class="sd-label">File name</span>
          <input
            v-model="fileName"
            class="sd-field"
            aria-label="File name"
            spellcheck="false"
            :disabled="isSaving"
            @keydown.enter.prevent="save"
          />
        </label>

        <!-- Location -->
        <div class="flex flex-col gap-[6px]">
          <span class="sd-label">Location</span>
          <div class="flex items-center gap-2">
            <div class="sd-field sd-readonly flex-1 min-w-0 truncate" :title="locationText">{{ locationText }}</div>
            <BaseButton
              v-if="supportsInPlace"
              size="sm" color="ghost" :pill="false"
              :disabled="isSaving"
              aria-label="Change location"
              @click="changeLocation"
            >Change…</BaseButton>
          </div>
        </div>

        <!-- Format -->
        <div class="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-[6px] items-end">
          <span class="sd-label">Format</span>
          <span class="sd-label">Bit depth</span>
          <span class="sd-label">Sample rate</span>

          <div class="sd-field font-['JetBrains_Mono'] text-center px-3">WAV</div>
          <div class="flex rounded-[8px] overflow-hidden" style="box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)" role="radiogroup" aria-label="Bit depth">
            <button
              v-for="d in BIT_DEPTHS"
              :key="d.id"
              class="flex-1 py-[7px] text-[11.5px] font-bold transition-colors"
              :style="bitDepth === d.id
                ? 'background:#35d3e6;color:#08161a'
                : 'color:rgba(255,255,255,.6)'"
              role="radio"
              :aria-checked="bitDepth === d.id"
              :disabled="isSaving"
              @click="bitDepth = d.id"
            >{{ d.label.replace(' PCM', '') }}</button>
          </div>
          <select v-model.number="sampleRate" class="sd-field pr-2" aria-label="Sample rate" :disabled="isSaving">
            <option v-for="r in rateOptions" :key="r" :value="r">{{ formatRate(r) }}</option>
          </select>
        </div>

        <div v-if="warning" class="text-[11px] font-bold leading-snug text-[#e0b84a]">
          {{ warning }}
        </div>
        <div v-if="tooBig" class="text-[11px] font-bold leading-snug text-[#ff8a80]">
          This file would be {{ formatSize(bytes) }} — over the 4 GB a WAV's own size fields can
          address. Pick a lower depth or rate, or split it.
        </div>
      </div>

      <!-- Footer -->
      <div class="px-5 py-[13px] border-t border-[rgba(255,255,255,.07)]">
        <div class="mb-[10px] text-[11px] leading-snug text-[rgba(255,255,255,.5)]">
          {{ planText }}
          <span class="font-['JetBrains_Mono'] font-semibold text-[rgba(255,255,255,.35)]">
            · {{ bitDepthById(bitDepth).label }} · {{ formatRate(sampleRate) }} · {{ formatSize(bytes) }}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <div class="flex-1"></div>
          <BaseButton size="sm" color="ghost" :pill="false" :disabled="isSaving" @click="close">Cancel</BaseButton>
          <BaseButton size="md" :pill="false" :disabled="!canSave" @click="save">
            {{ isSaving ? 'Saving…' : plan === 'replace' ? 'Save & replace' : plan === 'pick' ? 'Save…' : 'Save' }}
          </BaseButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sd-label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: rgba(255,255,255,.4);
}
.sd-field {
  background: rgba(255,255,255,.04);
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.1);
  padding: 7px 10px;
  font-size: 12.5px;
  font-weight: 600;
  color: #eaf6f8;
  outline: none;
}
.sd-field:focus {
  box-shadow: inset 0 0 0 1px #35d3e6;
}
.sd-readonly {
  background: transparent;
  color: rgba(255,255,255,.7);
}
select.sd-field option {
  background: #14181d;
}
</style>
