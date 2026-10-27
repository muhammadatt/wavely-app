<script setup>
import { computed, ref, watch } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileSave } from '../composables/useFileSave.js'
import { getTimelineDuration } from '../audio/operations.js'
import { formatSize, WAV_SIZE_LIMIT } from '../audio/exportPlan.js'
import { isCancellation, pickSaveTarget } from '../audio/fileSave.js'
import {
  BIT_DEPTHS, FORMATS, FORMAT_IDS, MP3_BITRATES, bitDepthById, sampleRateOptions,
  defaultSaveSettings, normalizeSettings, formatAvailable, qualityLossWarning,
  formatRate, estimateSaveBytes, savePlan, toSaveFileName,
} from '../audio/saveFormat.js'
import BaseButton from './ui/BaseButton.vue'

/**
 * The Save dialog: name, location, format (WAV / FLAC / MP3), bit depth or
 * bitrate, and sample rate, before anything is written. Opens on the first Save of a document and on every Save As;
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
const { confirmSave, anchorHandleFor, isSaving, saveProgress, canSaveInPlace } = useFileSave()

const docId = appState.saveDialog?.docId
const doc = computed(() => getDocument(docId))

const supportsInPlace = canSaveInPlace()
const anchor = anchorHandleFor(docId)
const anchorIsLastSave = !!anchor && anchor === getSaveTarget(docId)
const source = doc.value?.currentFile?.sourceFormat ?? null
const docRate = doc.value?.currentFile?.sampleRate ?? 44100
const channels = doc.value?.currentFile?.channels ?? 1

const remembered = getSaveSettings(docId)
const initial = remembered ? normalizeSettings(remembered, channels) : defaultSaveSettings(source, docRate, channels)
const format = ref(initial.format)
const fileName = ref(toSaveFileName(doc.value?.name ?? 'untitled', initial.format))
const bitDepth = ref(initial.bitDepth)
const sampleRate = ref(initial.sampleRate)
const bitrate = ref(initial.bitrate)
const rateOptions = computed(() => sampleRateOptions(format.value, source, docRate))
const depthOptions = computed(() => BIT_DEPTHS.filter(d => FORMATS[format.value].depths.includes(d.id)))

/**
 * Switch format: the name takes the new extension, and a depth or rate the
 * new format cannot write moves to the nearest one it can (32-bit float →
 * 24-bit for FLAC, 96 kHz → 48 kHz for MP3). Switching back does not restore
 * them — the readout always shows what will be written.
 */
function setFormat(next) {
  if (isSaving.value || !formatAvailable(next, channels)) return
  const fixed = normalizeSettings({
    format: next, bitDepth: bitDepth.value, sampleRate: sampleRate.value, bitrate: bitrate.value,
  }, channels)
  format.value = fixed.format
  bitDepth.value = fixed.bitDepth
  sampleRate.value = fixed.sampleRate
  bitrate.value = fixed.bitrate
  fileName.value = toSaveFileName(fileName.value, fixed.format)
}

// A destination picked with Change…. Editing the name afterwards drops it: the
// handle names one file, and saving it under another name would write to the
// file the user just typed over.
const chosenHandle = ref(null)
watch(fileName, name => {
  if (chosenHandle.value && toSaveFileName(name, format.value) !== chosenHandle.value.name) chosenHandle.value = null
})

const plan = computed(() => savePlan({
  supportsInPlace, chosenHandle: chosenHandle.value, anchorHandle: anchor,
  fileName: fileName.value, format: format.value,
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
  if (source.container === 'mp3') parts.push(source.bitrate ? `${source.bitrate} kbps` : 'VBR')
  if (source.sampleRate) parts.push(formatRate(source.sampleRate))
  if (source.channels) parts.push(source.channels === 1 ? 'mono' : source.channels === 2 ? 'stereo' : `${source.channels} ch`)
  return parts.join(' · ')
})

const settings = computed(() => ({
  format: format.value, bitDepth: bitDepth.value, sampleRate: sampleRate.value, bitrate: bitrate.value,
}))

const warning = computed(() => qualityLossWarning(settings.value, source))

const size = computed(() => {
  const d = doc.value ? getTimelineDuration(doc.value.segments) : 0
  return estimateSaveBytes(d, channels, settings.value)
})
// Only WAV has 32-bit size fields; FLAC counts samples in 36 bits and MP3 has
// no length field at all.
const tooBig = computed(() => format.value === 'wav' && size.value.bytes > WAV_SIZE_LIMIT)

const summary = computed(() => {
  const f = FORMATS[format.value]
  const detail = format.value === 'mp3' ? `${bitrate.value} kbps CBR` : bitDepthById(bitDepth.value).label
  return `${f.label} · ${detail} · ${formatRate(sampleRate.value)} · ${size.value.approx ? '≈ ' : ''}${formatSize(size.value.bytes)}`
})

const STAGE_LABELS = { render: 'Rendering', resample: 'Converting rate', encode: 'Encoding', write: 'Writing' }
const progressText = computed(() => {
  const p = saveProgress.value
  if (!p) return 'Saving…'
  const label = p.stage === 'encode' ? `Encoding ${FORMATS[format.value].label}` : STAGE_LABELS[p.stage] ?? 'Saving'
  return p.stage === 'render' || p.stage === 'write' ? `${label}…` : `${label}… ${Math.round(p.fraction * 100)}%`
})

const nameValid = computed(() => fileName.value.trim().replace(/\.[a-z0-9]+$/i, '').length > 0)
const canSave = computed(() => !!doc.value && nameValid.value && !tooBig.value && !isSaving.value)

function close() {
  if (isSaving.value) return
  appState.saveDialog = null
}

async function changeLocation() {
  if (isSaving.value) return
  try {
    const handle = await pickSaveTarget(fileName.value, chosenHandle.value ?? anchor, format.value)
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
    ...settings.value,
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
      <div class="relative pl-5 pr-12 pt-[18px] pb-[14px] border-b border-[rgba(255,255,255,.07)]">
        <div id="save-dialog-title" class="text-[15px] font-bold text-[#eaf6f8]">Save</div>
        <div v-if="sourceText" class="mt-[3px] text-[11.5px] text-[rgba(255,255,255,.42)]">
          Original: <span class="font-['JetBrains_Mono'] font-semibold">{{ sourceText }}</span>
        </div>
        <button
          class="absolute top-[14px] right-[14px] w-[28px] h-[28px] rounded-[8px] flex items-center justify-center transition-colors hover:bg-[rgba(255,255,255,.1)] disabled:opacity-40 disabled:hover:bg-transparent"
          style="color:rgba(255,255,255,.6)"
          aria-label="Close"
          title="Close"
          :disabled="isSaving"
          @click="close"
        >
          <svg viewBox="0 0 24 24" class="w-[14px] h-[14px] fill-none stroke-current" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
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
        <div class="flex flex-col gap-[6px]">
          <span class="sd-label">Format</span>
          <div class="sd-seg" role="radiogroup" aria-label="Format">
            <button
              v-for="id in FORMAT_IDS"
              :key="id"
              :class="{ on: format === id }"
              role="radio"
              :aria-checked="format === id"
              :disabled="isSaving || !formatAvailable(id, channels)"
              :title="formatAvailable(id, channels) ? '' : 'MP3 carries mono or stereo only'"
              @click="setFormat(id)"
            >{{ FORMATS[id].label }}</button>
          </div>
        </div>

        <div class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-[6px] items-end">
          <span class="sd-label">{{ format === 'mp3' ? 'Bitrate' : 'Bit depth' }}</span>
          <span class="sd-label">Sample rate</span>

          <select
            v-if="format === 'mp3'"
            v-model.number="bitrate"
            class="sd-field pr-2"
            aria-label="Bitrate"
            :disabled="isSaving"
          >
            <option v-for="b in MP3_BITRATES" :key="b" :value="b">{{ b }} kbps CBR{{ b === 192 ? ' (ACX)' : '' }}</option>
          </select>
          <div v-else class="sd-seg" role="radiogroup" aria-label="Bit depth">
            <button
              v-for="d in depthOptions"
              :key="d.id"
              :class="{ on: bitDepth === d.id }"
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
          This file would be {{ formatSize(size.bytes) }} — over the 4 GB a WAV's own size fields can
          address. Pick FLAC, a lower depth or rate, or split it.
        </div>
      </div>

      <!-- Footer -->
      <div class="px-5 py-[13px] border-t border-[rgba(255,255,255,.07)]">
        <div class="mb-[10px] text-[11px] leading-snug text-[rgba(255,255,255,.5)]">
          {{ planText }}
          <span class="font-['JetBrains_Mono'] font-semibold text-[rgba(255,255,255,.35)]">· {{ summary }}</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="flex-1"></div>
          <BaseButton size="sm" color="ghost" :pill="false" :disabled="isSaving" @click="close">Cancel</BaseButton>
          <BaseButton size="md" :pill="false" :disabled="!canSave" @click="save">
            {{ isSaving ? progressText : plan === 'replace' ? 'Save & replace' : plan === 'pick' ? 'Save…' : 'Save' }}
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
.sd-seg {
  display: flex;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.1);
}
.sd-seg button {
  flex: 1;
  padding: 7px 0;
  font-size: 11.5px;
  font-weight: 700;
  color: rgba(255,255,255,.6);
  transition: background-color .15s, color .15s;
}
.sd-seg button.on {
  background: #35d3e6;
  color: #08161a;
}
.sd-seg button:disabled:not(.on) {
  color: rgba(255,255,255,.25);
  cursor: not-allowed;
}
select.sd-field option {
  background: #14181d;
}
</style>
