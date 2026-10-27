<script setup>
import { computed, ref, watch, onMounted } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileSave } from '../composables/useFileSave.js'
import { useWorkingFolder } from '../composables/useWorkingFolder.js'
import { getTimelineDuration } from '../audio/operations.js'
import { formatSize, WAV_SIZE_LIMIT } from '../audio/exportPlan.js'
import { isCancellation, pickSaveTarget } from '../audio/fileSave.js'
import {
  BIT_DEPTHS, FORMATS, FORMAT_IDS, MP3_BITRATES, sampleRateOptions,
  defaultSaveSettings, normalizeSettings, formatAvailable, qualityLossWarning,
  formatRate, estimateSaveBytes, savePlan, toSaveFileName, formatFolderPath,
  splitAudioName, formatForExtension, extensionFor,
} from '../audio/saveFormat.js'
import BaseButton from './ui/BaseButton.vue'

/**
 * The Save dialog: name, location, format (WAV / FLAC / MP3), bit depth or
 * bitrate, and sample rate, before anything is written. Opens on the first
 * Save of a document and on every Save As; later Saves reuse what was
 * confirmed here (useFileSave).
 *
 * ⚠ A WEB PAGE IS NEVER TOLD AN ABSOLUTE PATH. With a WORKING FOLDER set
 * (useWorkingFolder) the location is shown relative to it — "Ch Audiobook ›
 * Raw takes" — and a Save there writes straight in with no system dialog.
 * Outside it, "Location" stays a description (the original's folder, a folder
 * chosen with Change…, the downloads folder) and a new name goes through the
 * system save dialog, opened in the original's folder.
 */

const { appState, getDocument, showToast, getSaveTarget, getSaveSettings } = useEditorState()
const { confirmSave, anchorHandleFor, isSaving, saveProgress, canSaveInPlace } = useFileSave()
const wf = useWorkingFolder()
const folderName = wf.folderName

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
}

// A destination picked with Browse…. Editing the name afterwards drops it:
// the handle names one file, and saving it under another name would write to
// the file the user just typed over.
const chosenHandle = ref(null)

// The name is edited WITHOUT its extension; the format supplies that, so
// switching format never rewrites what was typed. The extension keeps the
// case of the file it would replace ("Chapter01.WAV").
const nameInput = ref(null)
const baseName = ref(splitAudioName(doc.value?.name ?? '').base || 'untitled')
const extension = computed(() => extensionFor(format.value, chosenHandle.value?.name, anchor?.name))
const fileName = computed(() => baseName.value.trim().replace(/[.\s]+$/, '') + extension.value)

/**
 * Tidy the typed name on blur / Enter: an audio extension typed into it is
 * taken off, and if it names a format ("take.flac"), the format follows.
 */
function commitName() {
  const { base, ext } = splitAudioName(baseName.value)
  if (!ext) return
  baseName.value = base
  const f = formatForExtension(ext)
  if (f && f !== format.value) setFormat(f)
}

watch(fileName, name => {
  if (chosenHandle.value && name !== chosenHandle.value.name) chosenHandle.value = null
})

onMounted(() => {
  nameInput.value?.focus()
  nameInput.value?.select()
})

// ── Working folder ──────────────────────────────────────────────────────────
const folderSupported = supportsInPlace && wf.supported
// Where the original (or the last save) and a Change… destination sit inside
// the working folder, as directory names; null when outside it or unknown.
const anchorInFolder = ref(null)
const chosenInFolder = ref(null)
// "Save to <folder> instead", for an original that lives outside it.
const useFolderRoot = ref(false)
watch(wf.folder, async () => {
  useFolderRoot.value = false
  anchorInFolder.value = anchor ? await wf.locate(anchor) : null
  chosenInFolder.value = chosenHandle.value ? await wf.locate(chosenHandle.value) : null
}, { immediate: true })
watch(chosenHandle, async h => { chosenInFolder.value = h ? await wf.locate(h) : null })

const folderTarget = computed(() => {
  if (!folderSupported || !wf.folder.value || chosenHandle.value) return null
  if (useFolderRoot.value) return { segments: [], explicit: true }
  if (anchorInFolder.value) return { segments: anchorInFolder.value, explicit: false }
  if (!anchor) return { segments: [], explicit: false }
  return null
})

const plan = computed(() => savePlan({
  supportsInPlace, chosenHandle: chosenHandle.value, anchorHandle: anchor, folderTarget: folderTarget.value,
  fileName: fileName.value, format: format.value,
}))

// Whether a 'folder' Save would land on a file that is already there — said
// out loud, since it overwrites with no system dialog to warn about it.
const replacesInFolder = ref(false)
let existsSeq = 0
watch([plan, folderTarget, fileName, format], async () => {
  const seq = ++existsSeq
  if (plan.value !== 'folder') { replacesInFolder.value = false; return }
  let exists = false
  try {
    const dir = await wf.directoryAt(folderTarget.value.segments)
    exists = !!await wf.existingFile(dir, toSaveFileName(fileName.value, format.value))
  } catch {
    // No read permission yet this visit: unknown, and the Save will ask.
  }
  if (seq === existsSeq) replacesInFolder.value = exists
}, { immediate: true })

async function pickFolder() {
  if (isSaving.value) return
  try {
    await wf.chooseFolder(chosenHandle.value ?? anchor)
  } catch (err) {
    console.error('Folder picker failed:', err)
    showToast("Couldn't open the folder picker")
  }
}

const locationText = computed(() => {
  if (!supportsInPlace) return 'Your downloads folder'
  if (chosenHandle.value) {
    return chosenInFolder.value ? formatFolderPath(folderName.value, chosenInFolder.value) : 'The folder you chose'
  }
  if (folderTarget.value) return formatFolderPath(folderName.value, folderTarget.value.segments)
  // The outcome line under it names the file, so this does not repeat it.
  if (anchor) return anchorIsLastSave ? 'Same folder as the last save' : 'Same folder as the original'
  return 'Chosen in the next step'
})

// Whether this Save writes over a file that exists — the one consequence
// worth colour, since 'replace' and 'folder' do it with no system dialog.
const overwrites = computed(() => plan.value === 'replace' || (plan.value === 'folder' && replacesInFolder.value))

const planText = computed(() => {
  switch (plan.value) {
    case 'replace': return `Replaces ${anchor.name}`
    case 'chosen': return `Saves as ${chosenHandle.value.name}`
    case 'folder': return replacesInFolder.value
      ? `Replaces ${fileName.value} in this folder`
      : 'Saves straight into this folder'
    case 'download': return 'Downloads — this browser can’t write files directly'
    default: return anchor
      ? 'You’ll confirm in the system dialog, opened in this folder'
      : 'You’ll choose the folder in the system dialog'
  }
})

// "Save to <folder> instead", offered for an original outside the folder.
const canSwitchToFolder = computed(() => !!folderName.value && !!anchor && !anchorInFolder.value && !chosenHandle.value)

const saveLabel = computed(() => {
  if (isSaving.value) return progressText.value
  if (overwrites.value) return 'Replace'
  return plan.value === 'pick' ? 'Save…' : 'Save'
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

const sizeText = computed(() => `${size.value.approx ? '≈ ' : ''}${formatSize(size.value.bytes)}`)

const STAGE_LABELS = { render: 'Rendering', resample: 'Converting rate', encode: 'Encoding', write: 'Writing' }
const progressText = computed(() => {
  const p = saveProgress.value
  if (!p) return 'Saving…'
  const label = p.stage === 'encode' ? `Encoding ${FORMATS[format.value].label}` : STAGE_LABELS[p.stage] ?? 'Saving'
  return p.stage === 'render' || p.stage === 'write' ? `${label}…` : `${label}… ${Math.round(p.fraction * 100)}%`
})

const nameValid = computed(() => splitAudioName(baseName.value).base.trim().replace(/[.\s]+$/, '').length > 0)
const canSave = computed(() => !!doc.value && nameValid.value && !tooBig.value && !isSaving.value)

function close() {
  if (isSaving.value) return
  appState.saveDialog = null
}

async function browse() {
  if (isSaving.value) return
  commitName()
  try {
    const handle = await pickSaveTarget(fileName.value, chosenHandle.value ?? anchor ?? wf.folder.value, format.value)
    // The system dialog lets any name through; an extension of another
    // format switches the format rather than writing it under a wrong one.
    const { base, ext } = splitAudioName(handle.name)
    const f = formatForExtension(ext)
    if (!f) { showToast('Choose a name ending in .wav, .flac or .mp3'); return }
    if (f !== format.value) setFormat(f)
    chosenHandle.value = handle
    baseName.value = base
  } catch (err) {
    if (isCancellation(err)) return
    console.error('Save picker failed:', err)
    showToast("Couldn't open the save dialog")
  }
}

async function save() {
  commitName()
  if (!canSave.value) return
  const ok = await confirmSave(docId, {
    fileName: fileName.value,
    ...settings.value,
    chosenHandle: chosenHandle.value,
    folderTarget: folderTarget.value,
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

      <div class="px-5 pt-4 pb-5 flex flex-col gap-[16px]">
        <!-- Name: edited without its extension, which follows the format -->
        <div class="flex flex-col gap-[6px]">
          <label for="sd-name" class="sd-label">File name</label>
          <div class="sd-field sd-name flex items-center gap-[2px]" :class="{ disabled: isSaving }">
            <input
              id="sd-name"
              ref="nameInput"
              v-model="baseName"
              class="flex-1 min-w-0 bg-transparent outline-none"
              spellcheck="false"
              autocomplete="off"
              :disabled="isSaving"
              @blur="commitName"
              @keydown.enter.prevent="save"
            />
            <span class="sd-ext" aria-label="Extension">{{ extension }}</span>
          </div>
        </div>

        <!-- Location, and what saving there will do -->
        <div class="flex flex-col gap-[6px]">
          <span class="sd-label">Location</span>
          <div class="flex items-center gap-2">
            <div class="flex-1 min-w-0 flex items-center gap-[8px] text-[12.5px] font-semibold text-[#eaf6f8]" :title="locationText">
              <svg viewBox="0 0 24 24" class="w-[15px] h-[15px] text-[rgba(255,255,255,.4)] shrink-0 fill-none stroke-current" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
              <span class="truncate">{{ locationText }}</span>
            </div>
            <BaseButton
              v-if="supportsInPlace"
              size="sm" color="ghost" :pill="false"
              :disabled="isSaving"
              title="Choose a location in the system dialog"
              @click="browse"
            >Browse…</BaseButton>
          </div>
          <div class="sd-outcome" :class="{ warn: overwrites }">
            <svg v-if="overwrites" viewBox="0 0 24 24" class="w-[13px] h-[13px] shrink-0 fill-none stroke-current" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>
            <span class="min-w-0">{{ planText }}</span>
            <button
              v-if="canSwitchToFolder"
              class="sd-link ml-auto shrink-0"
              :disabled="isSaving"
              @click="useFolderRoot = !useFolderRoot"
            >{{ useFolderRoot ? 'Use the original’s folder' : `Save to ${folderName} instead` }}</button>
          </div>
        </div>

        <!-- Format -->
        <div class="flex flex-col gap-[8px]">
          <div class="flex items-baseline justify-between">
            <span class="sd-label">Format</span>
            <span class="sd-size" title="Estimated file size">{{ sizeText }}</span>
          </div>
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

          <div class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-[6px] items-end mt-[4px]">
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

          <div v-if="warning" class="sd-note warn">{{ warning }}</div>
          <div v-if="tooBig" class="sd-note error">
            This file would be {{ formatSize(size.bytes) }} — over the 4 GB a WAV's own size fields can
            address. Pick FLAC, a lower depth or rate, or split it.
          </div>
        </div>
      </div>

      <!-- Footer: the working folder (an app setting) on the left, actions right -->
      <div class="px-5 py-[12px] border-t border-[rgba(255,255,255,.07)] flex items-center gap-2">
        <div v-if="folderSupported" class="flex-1 min-w-0 flex items-center gap-[7px] text-[11px] text-[rgba(255,255,255,.45)]">
          <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] shrink-0 fill-none stroke-current" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
          <template v-if="folderName">
            <span class="truncate" :title="`Working folder: ${folderName}`">
              <span class="sr-only">Working folder: </span><span class="font-semibold text-[rgba(255,255,255,.7)]">{{ folderName }}</span>
            </span>
            <button class="sd-link shrink-0" :disabled="isSaving" title="Choose a different working folder" @click="pickFolder">Change</button>
            <button
              class="sd-icon shrink-0"
              :disabled="isSaving"
              aria-label="Remove working folder"
              title="Remove working folder"
              @click="wf.clearFolder()"
            >
              <svg viewBox="0 0 24 24" class="w-[11px] h-[11px] fill-none stroke-current" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </template>
          <button
            v-else
            class="sd-link truncate"
            :disabled="isSaving"
            title="Show where files go, and save into the folder without the system dialog"
            @click="pickFolder"
          >Set working folder</button>
        </div>
        <div v-else class="flex-1"></div>
        <BaseButton size="sm" color="ghost" :pill="false" :disabled="isSaving" @click="close">Cancel</BaseButton>
        <BaseButton size="md" :pill="false" :disabled="!canSave" @click="save">{{ saveLabel }}</BaseButton>
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
.sd-field:focus,
.sd-name:focus-within {
  box-shadow: inset 0 0 0 1px #35d3e6;
}
.sd-name.disabled {
  opacity: .6;
}
.sd-ext {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11.5px;
  color: rgba(255,255,255,.4);
  user-select: none;
}
.sd-outcome {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 18px;
  font-size: 11px;
  line-height: 1.35;
  color: rgba(255,255,255,.5);
}
.sd-outcome.warn {
  color: #e0b84a;
  font-weight: 600;
}
.sd-size {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  font-weight: 600;
  color: rgba(255,255,255,.4);
}
.sd-note {
  font-size: 11px;
  font-weight: 600;
  line-height: 1.35;
}
.sd-note.warn { color: #e0b84a; }
.sd-note.error { color: #ff8a80; }
.sd-icon {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: rgba(255,255,255,.5);
}
.sd-icon:hover:not(:disabled) {
  background: rgba(255,255,255,.1);
  color: rgba(255,255,255,.8);
}
.sd-link:focus-visible,
.sd-icon:focus-visible,
.sd-seg button:focus-visible {
  outline: 2px solid #35d3e6;
  outline-offset: 1px;
  border-radius: 4px;
}
.sd-seg button:focus-visible {
  outline-offset: -2px;
}
.sd-link {
  color: #35d3e6;
  font-weight: 600;
}
.sd-link:hover:not(:disabled) {
  text-decoration: underline;
}
.sd-link:disabled {
  opacity: .4;
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
/* A divider between items, drawn as an inset shadow so it takes no width.
   None on either side of the selected item: its fill is the edge there. */
.sd-seg button + button {
  box-shadow: inset 1px 0 0 rgba(255,255,255,.1);
}
.sd-seg button.on,
.sd-seg button.on + button {
  box-shadow: none;
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
