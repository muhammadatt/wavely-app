<script setup>
/**
 * MODULA PRESET BROWSER — the centre of every plugin's header: ‹ name ▾ ›.
 *
 * The arrows step through the collection (factory first, then the user's own),
 * the name opens the list. The list carries a ✓ on the preset the settings
 * are on, a delete on the user's own, Revert while the settings have moved off
 * the lit preset, and Save as.
 *
 * Driven by a `usePluginPresets` instance, so everything about what exists,
 * what is stored and what "modified" means is that composable's — this is
 * only its face. (PresetMenu.vue is the classic chrome's face for the same
 * instance.)
 *
 * ⚠ THE LIST IS TELEPORTED TO THE BODY, for the reason PresetMenu records at
 * length: the window frame is overflow-hidden, so a list positioned inside the
 * header is clipped by the panel. It carries its own coordinates, flips above
 * when there is no room below, and closes when the window moves.
 *
 * ⚠ DISABLED REFUSES ONLY WHAT CHANGES THE SOUND: selecting, stepping and
 * reverting. Saving and deleting stay available — neither touches the audio.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  presets: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
  disabledHint: { type: String, default: '' },
})

const items = computed(() => props.presets.presets.value)
const active = computed(() => props.presets.activePreset.value)
const dirty = computed(() => props.presets.dirty.value)
const name = computed(() => (active.value ? active.value.name : 'Presets'))

function step(d) {
  if (props.disabled || !items.value.length) return
  const i = active.value ? items.value.findIndex(p => p.id === active.value.id) : (d > 0 ? -1 : 0)
  const n = items.value.length
  props.presets.select(items.value[(i + d + n) % n].id)
}

// ── The list ────────────────────────────────────────────────────────────────
const open = ref(false)
const pos = ref({ left: 0, top: 0, width: 220, maxHeight: 360, flip: false })
const trigger = ref(null)
const list = ref(null)
const nameInput = ref(null)
const saving = ref(false)
const draft = ref('')
const error = ref('')
const MENU_Z = 4000

function place() {
  const el = trigger.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const below = window.innerHeight - r.bottom - 16
  const above = r.top - 16
  const flip = below < 200 && above > below
  const width = Math.max(220, r.width)
  pos.value = {
    left: Math.max(12, Math.min(window.innerWidth - width - 12, r.left + r.width / 2 - width / 2)),
    top: flip ? r.top - 4 : r.bottom + 4,
    width,
    maxHeight: Math.max(160, flip ? above : below),
    flip,
  }
}

async function toggle() {
  open.value = !open.value
  if (!open.value) { endSave(); return }
  place()
  await nextTick()
  place()
}
function close() {
  open.value = false
  endSave()
}
function choose(id) {
  if (props.disabled) return
  props.presets.select(id)
  close()
}
function revert() {
  if (props.disabled) return
  props.presets.revert()
  close()
}
async function startSave() {
  if (!props.presets.requestSave()) { close(); return }
  saving.value = true
  error.value = ''
  draft.value = active.value && active.value.source === 'user' ? active.value.name : ''
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
}
function endSave() {
  saving.value = false
  draft.value = ''
  error.value = ''
}
function commitSave() {
  const n = draft.value.trim()
  if (!n) { error.value = 'Give the preset a name.'; return }
  if (!props.presets.canSaveAs(n)) { error.value = 'That name belongs to a factory preset.'; return }
  try {
    props.presets.save(n)
    close()
  } catch (err) {
    error.value = err?.message ?? 'Could not save that preset.'
  }
}

function onDocPointerDown(e) {
  if (!open.value) return
  if (!trigger.value?.contains(e.target) && !list.value?.contains(e.target)) close()
}
function onKeydown(e) {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation()
    close()
  }
}
function onViewportChange() { if (open.value) close() }

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})
</script>

<template>
  <!-- pointerdown is stopped so using the browser never starts a window drag. -->
  <div ref="trigger" class="m-pb" :class="{ 'is-disabled': disabled }" :title="disabled ? disabledHint : undefined" @pointerdown.stop>
    <button type="button" class="m-pb-arrow m-focusable" title="Previous preset" aria-label="Previous preset" :disabled="disabled" @click="step(-1)">‹</button>
    <button
      type="button" class="m-pb-name m-focusable" :aria-expanded="String(open)" aria-haspopup="listbox"
      :title="active?.description || 'Presets'" @click="toggle"
    >
      <span class="m-pb-text" :style="dirty ? { color: 'var(--m-accent)' } : null">{{ name }}{{ dirty ? ' *' : '' }}</span>
      <span class="m-pb-caret"></span>
    </button>
    <button type="button" class="m-pb-arrow m-focusable" title="Next preset" aria-label="Next preset" :disabled="disabled" @click="step(1)">›</button>

  <Teleport to="body">
    <div
      v-if="open" ref="list" class="m-pb-list" role="listbox"
      :style="{
        left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px`, maxHeight: `${pos.maxHeight}px`,
        transform: pos.flip ? 'translateY(-100%)' : 'none', zIndex: MENU_Z,
      }"
    >
      <div
        v-for="p in items" :key="p.id" class="m-pb-item" role="option" :aria-selected="String(active?.id === p.id)"
        :class="{ 'is-on': active?.id === p.id, 'is-disabled': disabled }" :title="p.description || undefined"
        @click="choose(p.id)"
      >
        <span class="m-pb-item-name">{{ p.name }}</span>
        <span class="m-pb-item-end">
          <span v-if="active?.id === p.id" class="m-pb-check">✓</span>
          <button
            v-if="p.source === 'user'" type="button" class="m-pb-del" :aria-label="`Delete ${p.name}`" title="Delete this preset"
            @click.stop="presets.remove(p.id)"
          >×</button>
        </span>
      </div>

      <div class="m-pb-rule"></div>
      <div v-if="dirty && active && !disabled" class="m-pb-item m-pb-action" @click="revert">Revert to {{ active.name }}</div>
      <div v-if="!saving" class="m-pb-item m-pb-action" @click="startSave">{{ presets.saveAllowed.value ? 'Save as…' : 'Sign in to save presets…' }}</div>
      <form v-else class="m-pb-save" @submit.prevent="commitSave">
        <input ref="nameInput" v-model="draft" class="m-pb-input" placeholder="Preset name" maxlength="48" @keydown.esc.stop.prevent="endSave">
        <button type="submit" class="m-pb-save-btn">Save</button>
      </form>
      <div v-if="error" class="m-pb-error">{{ error }}</div>
    </div>
  </Teleport>
  </div>
</template>

<style scoped>
.m-pb {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 30px;
  box-sizing: border-box;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--m-well);
  box-shadow: var(--m-shadow-well);
  min-width: 0;
}
.m-pb-arrow {
  width: 22px;
  height: 22px;
  flex: none;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
  color: var(--m-ink-3);
  font: 600 15px/1 var(--m-font-ui);
}
.m-pb-arrow:hover:not(:disabled) { color: var(--m-ink); background: rgba(255, 255, 255, .06); }
.m-pb-arrow:disabled { opacity: .4; cursor: default; }
.m-pb-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
}
.m-pb-name:hover { background: rgba(255, 255, 255, .04); }
.m-pb-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 11px/1 var(--m-font-ui); letter-spacing: .04em; color: var(--m-ink); }
.m-pb-caret { flex: none; width: 0; height: 0; border-left: 3.5px solid transparent; border-right: 3.5px solid transparent; border-top: 4px solid #a6aeb6; }

.m-pb-list {
  position: fixed;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px;
  border-radius: 8px;
  background: var(--m-well);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .7), inset 0 1px 0 rgba(255, 255, 255, .05), 0 14px 28px -8px rgba(0, 0, 0, .9);
  font-family: var(--m-font-ui);
}
.m-pb-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 5px;
  cursor: pointer;
  font: 600 11px/1 var(--m-font-ui);
  letter-spacing: .04em;
  color: var(--m-ink-3);
}
.m-pb-item:hover { background: rgba(255, 255, 255, .07); }
.m-pb-item.is-on { color: var(--m-ink); background: rgba(255, 255, 255, .05); }
.m-pb-item.is-disabled { cursor: default; }
.m-pb-item-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.m-pb-item-end { display: flex; align-items: center; gap: 6px; }
.m-pb-check { font: 700 10px/1 var(--m-font-ui); color: var(--m-second); }
.m-pb-del { border: none; background: transparent; cursor: pointer; color: var(--m-ink-4); font: 400 14px/1 var(--m-font-ui); padding: 0 2px; }
.m-pb-del:hover { color: var(--m-hot); }
.m-pb-rule { height: 1px; margin: 3px 4px; background: rgba(255, 255, 255, .08); }
.m-pb-action { color: var(--m-ink-2); }
.m-pb-save { display: flex; gap: 6px; padding: 4px; }
.m-pb-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  outline: none;
  background: #111316;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, .8), 0 0 0 1px rgba(255, 255, 255, .08);
  font: 500 11px/1 var(--m-font-ui);
  color: var(--m-ink);
}
.m-pb-input:focus { box-shadow: inset 0 1px 3px rgba(0, 0, 0, .8), 0 0 0 1px var(--m-second); }
.m-pb-save-btn {
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font: 700 11px/1 var(--m-font-ui);
  color: #08161a;
  background: linear-gradient(180deg, #7fe6ef, #3fd0de);
}
.m-pb-error { padding: 2px 9px 6px; font: 500 10px/1.4 var(--m-font-ui); color: #ff9d90; }
.m-focusable:focus-visible { outline: 2px solid #7fe9f6; outline-offset: 1px; }
</style>
