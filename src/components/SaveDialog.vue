<script setup>
import { computed, ref, watch, onMounted } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useFileSave } from '../composables/useFileSave.js'
import { useWorkingFolder } from '../composables/useWorkingFolder.js'
import { useModalFocus } from '../composables/useModalFocus.js'
import { getTimelineDuration } from '../audio/operations.js'
import { formatSize, WAV_SIZE_LIMIT } from '../audio/exportPlan.js'
import { isCancellation, pickSaveTarget } from '../audio/fileSave.js'
import {
  BIT_DEPTHS, FORMATS, FORMAT_IDS, MP3_BITRATES, sampleRateOptions,
  defaultSaveSettings, normalizeSettings, formatAvailable, qualityLossWarning,
  formatRate, estimateSaveBytes, savePlan, toSaveFileName, formatFolderPath,
  splitAudioName, formatForExtension, extensionFor, nextFreeBaseName,
} from '../audio/saveFormat.js'
import BaseButton from './ui/BaseButton.vue'

/**
 * The Save dialog: name, location, format (WAV / FLAC / MP3), bit depth or
 * bitrate, and sample rate, before anything is written. Opens on the first
 * Save of a document and on every Save As; later Saves reuse what was
 * confirmed here (useFileSave).
 *
 * Laid out as design 1a, "Refined classic" (docs/design/save-dialog/): a name
 * that would overwrite is resolved RIGHT UNDER THE NAME (Replace / Keep both)
 * rather than in a warning under the format controls, far from its cause;
 * formats are cards that carry their own estimated size; and every value that
 * matches the original carries a quiet green dot, so what a Save changes is
 * visible without reading the header.
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
 *
 * ⚠ ONLY AFTER THE USER TYPED. The name the dialog opens with, and one the
 * system dialog returned, are stems already — a file called "take.mp3.wav"
 * opens with the stem "take.mp3", and reading that as an extension switched
 * the format to MP3 on the first blur with no edit at all. Clearing the flag
 * after one pass also makes blur-then-Save idempotent: a second pass cannot
 * strip a second suffix.
 */
const nameEdited = ref(false)
function commitName() {
  if (!nameEdited.value) return
  nameEdited.value = false
  const { base, ext } = splitAudioName(baseName.value)
  if (!ext) return
  baseName.value = base
  const f = formatForExtension(ext)
  if (f && f !== format.value) setFormat(f)
}

watch(fileName, name => {
  if (chosenHandle.value && name !== chosenHandle.value.name) chosenHandle.value = null
})

// Focus stays inside while the dialog is open and returns to the opener on
// close. Registered BEFORE the hook below so it records the opener first.
const root = ref(null)
const { trapTab } = useModalFocus(root)

function onKeydown(e) {
  trapTab(e)
  // The editor's shortcuts listen on window; none belong to a form.
  e.stopPropagation()
  if (e.key === 'Escape') { e.preventDefault(); close() }
  // …but with propagation stopped, Ctrl+S would reach the browser's own
  // "save page" instead.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') e.preventDefault()
}

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
// THREE states: true / false / null = not known (the lookup is in flight, or
// there is no read permission yet this visit). Unknown is never treated as
// absent: confirmSave re-checks once it can see, and hands an unwarned
// overwrite back ('exists') instead of writing it.
const replacesInFolder = ref(null)
let existsSeq = 0
watch([plan, folderTarget, fileName, format], async () => {
  const seq = ++existsSeq
  if (plan.value !== 'folder') { replacesInFolder.value = false; return }
  replacesInFolder.value = null
  let exists = null
  try {
    const dir = await wf.directoryAt(folderTarget.value.segments)
    exists = !!await wf.existingFile(dir, toSaveFileName(fileName.value, format.value))
  } catch {
    // No read permission yet this visit: stays unknown.
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
const overwrites = computed(() => plan.value === 'replace' || (plan.value === 'folder' && replacesInFolder.value === true))

const planText = computed(() => {
  switch (plan.value) {
    case 'replace': return `Replaces ${anchor.name}`
    case 'chosen': return `Saves as ${chosenHandle.value.name}`
    case 'folder': return replacesInFolder.value === true
      ? `Replaces ${fileName.value} in this folder`
      : replacesInFolder.value === false ? 'Saves straight into this folder' : 'Saves into this folder'
    case 'download': return 'Downloads — this browser can’t write files directly'
    default: return anchor
      ? 'You’ll confirm in the system dialog, opened in this folder'
      : 'You’ll choose the folder in the system dialog'
  }
})

/**
 * "Keep both": rename to the first free "Name (2)", "Name (3)"… so the
 * existing file stays. In the working folder the folder itself is asked; for
 * the original's own name the only file known to be there is the original —
 * the new name then goes through the system dialog, which warns on its own
 * if that one exists too.
 */
const resolvingConflict = ref(false)
async function keepBoth() {
  if (isSaving.value || resolvingConflict.value) return
  commitName()
  resolvingConflict.value = true
  try {
    const ext = extension.value
    let taken
    if (plan.value === 'folder') {
      const dir = await wf.directoryAt(folderTarget.value.segments)
      taken = async b => !!await wf.existingFile(dir, toSaveFileName(b + ext, format.value))
    } else {
      taken = async b => toSaveFileName(b + ext, format.value) === anchor?.name
    }
    baseName.value = await nextFreeBaseName(baseName.value, taken)
  } catch (err) {
    console.error('Keep both failed:', err)
    showToast("Couldn't find a free name — type a new one")
  } finally {
    resolvingConflict.value = false
  }
}

// "Save to <folder> instead", offered for an original outside the folder.
const canSwitchToFolder = computed(() => !!folderName.value && !!anchor && !anchorInFolder.value && !chosenHandle.value)

const saveLabel = computed(() => {
  if (isSaving.value) return progressText.value
  if (overwrites.value) return 'Replace'
  return plan.value === 'pick' ? 'Save…' : 'Save'
})

const sourceText = computed(() => {
  if (!source) return null
  const parts = ['Original', source.container.toUpperCase()]
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

// ── Same as the original ───────────────────────────────────────────────────
// A quiet dot on each value the original already has. Only what the header
// could tell us: a lossy original has no bit depth to match, and a depth or
// bitrate is only compared within its own family.
const originalDepth = computed(() => {
  if (!source || source.lossy || !source.bitDepth) return null
  if (source.float || source.bitDepth > 24) return '32f'
  return source.bitDepth > 16 ? '24' : '16'
})
const matchesFormat = id => source?.container === id
const matchesDepth = id => originalDepth.value === id
const matchesRate = computed(() => !!source?.sampleRate && source.sampleRate === sampleRate.value)
const matchesBitrate = computed(() => source?.container === 'mp3' && source.bitrate === bitrate.value)
const showMatchLegend = computed(() => !!source)

// Each format card's caption: what kind of file and how big it would be,
// with the depth / rate the switch would actually write (setFormat's rules).
const formatCards = computed(() => {
  const d = doc.value ? getTimelineDuration(doc.value.segments) : 0
  return FORMAT_IDS.map((id) => {
    const est = estimateSaveBytes(d, channels, normalizeSettings({ ...settings.value, format: id }, channels))
    return {
      id,
      label: FORMATS[id].label,
      kind: FORMATS[id].lossy ? 'Compressed' : 'Lossless',
      size: `${est.approx ? '≈ ' : ''}${formatSize(est.bytes)}`,
      available: formatAvailable(id, channels),
    }
  })
})

/**
 * Warnings that belong to the format controls: quality loss and the WAV size
 * ceiling. An overwrite is resolved under the name field, where it starts.
 */
const notices = computed(() => {
  const list = []
  if (warning.value) list.push({ kind: 'warn', text: warning.value.replace(/\.$/, '') })
  if (tooBig.value) {
    list.push({
      kind: 'error',
      text: `This file would be ${formatSize(size.value.bytes)}, over the 4 GB a WAV can address — pick FLAC, a lower depth or rate, or split it`,
    })
  }
  return list
})

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
    // Only an overwrite the dialog actually showed counts as agreed to.
    replaceAcknowledged: overwrites.value,
  })
  if (ok === 'exists') {
    // The file was there all along and the dialog could not see it (no read
    // permission until this click). Nothing was written: show the warning and
    // let the next click be the one that agrees to replace it.
    existsSeq++
    replacesInFolder.value = true
    return
  }
  if (ok === true && appState.saveDialog?.docId === docId) appState.saveDialog = null
}

// The document can close underneath the dialog (the files panel stays usable);
// there is nothing left to save then.
watch(doc, d => { if (!d) appState.saveDialog = null })
</script>

<template>
  <div
    ref="root"
    tabindex="-1"
    class="fixed inset-0 z-[450] flex items-start justify-center pt-[10vh] px-4 dialog-scrim outline-none"
    @click.self="close"
    @keydown="onKeydown"
  >
    <div
      class="w-full max-w-[500px] flex flex-col rounded-[18px] overflow-hidden font-['Inter'] dialog-surface"
      style="animation:bounceIn .28s cubic-bezier(.34,1.4,.64,1) both"
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-dialog-title"
    >
      <!-- Header: the original's spec, the reference every green dot points at -->
      <div class="relative pl-[22px] pr-12 pt-5 pb-4 border-b border-[rgba(255,255,255,.06)]">
        <div id="save-dialog-title" class="text-[15px] font-bold text-[#eaf6f8]">Save</div>
        <div v-if="sourceText" class="mt-[5px] sd-mono text-[11px] text-[rgba(255,255,255,.5)]">{{ sourceText }}</div>
        <button
          class="absolute top-[16px] right-[16px] w-[28px] h-[28px] rounded-[8px] flex items-center justify-center transition-colors hover:bg-[rgba(255,255,255,.1)] disabled:opacity-40 disabled:hover:bg-transparent"
          style="color:rgba(255,255,255,.6)"
          aria-label="Close"
          title="Close"
          :disabled="isSaving"
          @click="close"
        >
          <svg viewBox="0 0 24 24" class="w-[14px] h-[14px] fill-none stroke-current" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      <div class="px-[22px] pt-5 pb-[22px] flex flex-col gap-5">
        <!-- Name, edited without its extension (the format supplies it). A
             name that would overwrite is settled right here. -->
        <div class="flex flex-col gap-2">
          <label for="sd-name" class="sd-label">File name</label>
          <div class="sd-field sd-name flex items-center gap-[2px]" :class="{ disabled: isSaving, conflict: overwrites }">
            <input
              id="sd-name"
              ref="nameInput"
              v-model="baseName"
              class="flex-1 min-w-0 bg-transparent outline-none"
              spellcheck="false"
              autocomplete="off"
              :disabled="isSaving"
              :aria-describedby="overwrites ? 'sd-conflict' : undefined"
              @input="nameEdited = true"
              @blur="commitName"
              @keydown.enter.prevent="save"
            />
            <span class="sd-ext" aria-label="Extension">{{ extension }}</span>
          </div>
          <div v-if="overwrites" class="flex items-center justify-between gap-3" aria-live="polite">
            <div id="sd-conflict" class="sd-conflict-text">
              <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] shrink-0 fill-none stroke-current" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>
              <span class="min-w-0">{{ plan === 'replace' ? 'This is the original filename' : 'A file with this name already exists' }}</span>
            </div>
            <div class="sd-toggle" role="radiogroup" aria-label="What to do with the existing file">
              <button
                type="button" role="radio" aria-checked="true" class="on"
                :disabled="isSaving"
                title="Write over the existing file"
              >Replace</button>
              <button
                type="button" role="radio" aria-checked="false"
                :disabled="isSaving || resolvingConflict"
                title="Save under a new name and leave the existing file alone"
                @click="keepBoth"
              >Keep both</button>
            </div>
          </div>
        </div>

        <!-- Location, and what saving there does -->
        <div class="flex items-center gap-[10px]">
          <svg viewBox="0 0 24 24" class="w-[16px] h-[16px] shrink-0 text-[rgba(255,255,255,.6)] fill-none stroke-current" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
          <div class="flex-1 min-w-0 flex flex-col gap-[3px]">
            <span class="text-[12.5px] font-semibold text-[#eaf6f8] truncate" :title="locationText">{{ locationText }}</span>
            <span v-if="!overwrites || canSwitchToFolder" class="sd-outcome">
              <span v-if="!overwrites" class="truncate" :title="planText">{{ planText }}</span>
              <button
                v-if="canSwitchToFolder"
                class="sd-link shrink-0"
                :class="{ 'ml-auto': !overwrites }"
                :disabled="isSaving"
                @click="useFolderRoot = !useFolderRoot"
              >{{ useFolderRoot ? 'Use the original’s folder' : `Save to ${folderName} instead` }}</button>
            </span>
          </div>
          <BaseButton
            v-if="supportsInPlace"
            size="sm" color="ghost" :pill="false"
            :disabled="isSaving"
            title="Choose a location in the system dialog"
            @click="browse"
          >Browse…</BaseButton>
        </div>

        <!-- Format: cards that carry what each would weigh -->
        <div class="flex flex-col gap-2">
          <span class="sd-label">Format</span>
          <div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Format">
            <button
              v-for="c in formatCards"
              :key="c.id"
              type="button"
              class="sd-card"
              :class="{ on: format === c.id }"
              role="radio"
              :aria-checked="format === c.id"
              :disabled="isSaving || !c.available"
              :title="c.available ? `${c.label} — estimated ${c.size}` : 'MP3 carries mono or stereo only'"
              @click="setFormat(c.id)"
            >
              <span class="flex items-center justify-between">
                <span class="sd-card-name">{{ c.label }}</span>
                <span v-if="matchesFormat(c.id)" class="sd-dot" title="Same as the original"><span class="sr-only">(original)</span></span>
              </span>
              <span class="sd-card-sub">{{ c.kind }} · {{ c.size }}</span>
            </button>
          </div>
        </div>

        <!-- Depth (or bitrate) and rate -->
        <div class="grid grid-cols-[minmax(0,1fr)_128px] gap-3">
          <div class="flex flex-col gap-2 min-w-0">
            <span class="sd-label">{{ format === 'mp3' ? 'Bitrate' : 'Bit depth' }}</span>
            <div v-if="format === 'mp3'" class="sd-select">
              <select v-model.number="bitrate" aria-label="Bitrate" :disabled="isSaving">
                <option v-for="b in MP3_BITRATES" :key="b" :value="b">{{ b }} kbps CBR{{ b === 192 ? ' (ACX)' : '' }}</option>
              </select>
              <span v-if="matchesBitrate" class="sd-dot sd-select-dot" title="Same as the original"></span>
            </div>
            <div v-else class="sd-toggle sd-toggle--wide" role="radiogroup" aria-label="Bit depth">
              <button
                v-for="d in depthOptions"
                :key="d.id"
                type="button"
                :class="{ on: bitDepth === d.id }"
                role="radio"
                :aria-checked="bitDepth === d.id"
                :disabled="isSaving"
                @click="bitDepth = d.id"
              >
                {{ d.label.replace(' PCM', '') }}
                <span v-if="matchesDepth(d.id)" class="sd-dot" title="Same as the original"><span class="sr-only">(original)</span></span>
              </button>
            </div>
          </div>
          <div class="flex flex-col gap-2">
            <span class="sd-label">Sample rate</span>
            <div class="sd-select">
              <select v-model.number="sampleRate" aria-label="Sample rate" :disabled="isSaving">
                <option v-for="r in rateOptions" :key="r" :value="r">{{ formatRate(r) }}</option>
              </select>
              <span v-if="matchesRate" class="sd-dot sd-select-dot" title="Same as the original"></span>
            </div>
          </div>
        </div>

        <div v-if="showMatchLegend || notices.length" class="flex flex-col gap-[6px] -mt-[6px]">
          <div v-if="showMatchLegend" class="sd-legend"><span class="sd-dot"></span>Same as the original</div>
          <ul v-if="notices.length" class="flex flex-col gap-[5px]" aria-live="polite">
            <li v-for="n in notices" :key="n.text" class="sd-note" :class="n.kind">
              <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] shrink-0 mt-[1px] fill-none stroke-current" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>
              <span class="min-w-0">{{ n.text }}</span>
            </li>
          </ul>
        </div>
      </div>

      <!-- Footer: the working folder (an app setting) on the left, actions right -->
      <div class="px-[22px] py-[14px] border-t border-[rgba(255,255,255,.06)] flex items-center gap-2">
        <div v-if="folderSupported" class="flex-1 min-w-0 flex items-center gap-[7px] text-[11px] text-[rgba(255,255,255,.45)]">
          <template v-if="folderName">
            <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] shrink-0 fill-none stroke-current" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
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
            class="sd-link truncate text-[12px]"
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
.sd-mono { font-family: 'JetBrains Mono', monospace; font-weight: 500; }
.sd-label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: .11em;
  text-transform: uppercase;
  color: rgba(255,255,255,.42);
}
.sd-field {
  background: rgba(255,255,255,.04);
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,.1);
  padding: 10px 13px;
  font-size: 13px;
  font-weight: 600;
  color: #eaf6f8;
  outline: none;
  transition: border-color .15s;
}
.sd-name:focus-within { border-color: #35d3e6; }
.sd-name.conflict,
.sd-name.conflict:focus-within { border-color: rgba(224,184,74,.55); }
.sd-name.disabled { opacity: .6; }
.sd-ext {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: rgba(255,255,255,.42);
  user-select: none;
}
.sd-conflict-text {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-size: 11.5px;
  font-weight: 500;
  color: #e0b84a;
}

/* A small segmented choice: Replace / Keep both, and the bit depths. */
.sd-toggle {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: rgba(255,255,255,.04);
  border: 1px solid rgba(255,255,255,.09);
}
.sd-toggle button {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  color: rgba(255,255,255,.65);
  transition: background-color .15s, color .15s;
}
.sd-toggle button:hover:not(:disabled):not(.on) { background: rgba(255,255,255,.06); color: #eaf6f8; }
.sd-toggle button.on { background: rgba(224,184,74,.14); color: #e0b84a; cursor: default; }
.sd-toggle--wide {
  gap: 3px;
  padding: 3px;
  border-radius: 10px;
  background: rgba(255,255,255,.03);
  border-color: rgba(255,255,255,.07);
}
.sd-toggle--wide button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 0;
  border-radius: 8px;
  font-size: 11.5px;
  color: rgba(255,255,255,.75);
}
.sd-toggle--wide button.on {
  background: linear-gradient(180deg, #7ef0ff, #5ce3f8);
  color: #08161a;
}
.sd-toggle--wide button.on .sd-dot { background: #08161a; opacity: .5; }

.sd-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255,255,255,.03);
  border: 1px solid rgba(255,255,255,.07);
  text-align: left;
  transition: background-color .15s, border-color .15s;
}
.sd-card:hover:not(:disabled):not(.on) { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.14); }
.sd-card.on { background: rgba(53,211,230,.10); border-color: rgba(53,211,230,.5); }
.sd-card:disabled:not(.on) { opacity: .4; cursor: not-allowed; }
.sd-card-name { font-size: 13px; font-weight: 700; color: rgba(255,255,255,.85); }
.sd-card.on .sd-card-name { color: #7fe9f6; }
.sd-card-sub {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  font-weight: 500;
  color: rgba(255,255,255,.42);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sd-card.on .sd-card-sub { color: rgba(255,255,255,.55); }

/* A native select (for its keyboard and phone pickers) in the field's skin,
   with room on the left of the chevron for the "matches" dot. */
.sd-select { position: relative; }
.sd-select select {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  padding: 8px 30px 8px 10px;
  border-radius: 10px;
  background: rgba(255,255,255,.04) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,.6)' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E") no-repeat right 10px center / 12px;
  border: 1px solid rgba(255,255,255,.09);
  font: 600 12px 'JetBrains Mono', monospace;
  color: #eaf6f8;
  outline: none;
  cursor: pointer;
}
.sd-select select:focus-visible { border-color: #35d3e6; }
.sd-select select:disabled { opacity: .6; cursor: default; }
.sd-select option { background: #14181d; font-family: 'Inter', sans-serif; }
.sd-select-dot { position: absolute; right: 28px; top: 50%; transform: translateY(-50%); pointer-events: none; }

.sd-dot {
  display: inline-block;
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  border-radius: 9px;
  background: #5fd39a;
}
.sd-card .sd-dot { width: 6px; height: 6px; }
.sd-legend {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: rgba(255,255,255,.42);
}
.sd-outcome {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 11px;
  line-height: 1.35;
  color: rgba(255,255,255,.45);
}
.sd-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
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
.sd-icon:hover:not(:disabled) { background: rgba(255,255,255,.1); color: rgba(255,255,255,.8); }
.sd-link { color: #7fe9f6; font-weight: 600; }
.sd-link:hover:not(:disabled) { text-decoration: underline; }
.sd-link:disabled { opacity: .4; }
.sd-link:focus-visible,
.sd-icon:focus-visible,
.sd-card:focus-visible,
.sd-toggle button:focus-visible {
  outline: 2px solid #35d3e6;
  outline-offset: 1px;
}
</style>
