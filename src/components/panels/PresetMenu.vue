<script setup>
/**
 * The preset menu that lives in a plugin window's header.
 *
 * Replaces the mock dropdown that shipped on OptoSmooth — a button that
 * displayed four names and changed nothing. Everything here is real: the
 * factory collection comes from the plugin's registration, the user's own
 * presets persist, and the label says when the knobs have moved off the
 * preset that is lit.
 *
 * Deliberately generic. It knows a plugin id and two functions; it knows
 * nothing about knobs, params or which plugin it is in.
 */
import { computed, onBeforeUnmount, onMounted, nextTick, ref } from 'vue'

const props = defineProps({
  /** The composable instance from usePluginPresets(). */
  presets: { type: Object, required: true },
  accent: { type: String, default: '#f5a623' },
  /**
   * A menu on a bypassed plugin can still be opened and read — what it must
   * not do is silently accept a click. Same failure the ceiling presets and
   * FIT TO VOICE both shipped once: the press was taken and discarded with
   * nothing saying so.
   */
  disabled: { type: Boolean, default: false },
  disabledHint: { type: String, default: '' },
})

/**
 * ⚠ THE MENU IS TELEPORTED TO THE BODY AND POSITIONED IN VIEWPORT
 * COORDINATES, AND THAT IS NOT A STYLE PREFERENCE.
 *
 * `win-frame` is `overflow-hidden` — it has to be, for the rounded corners —
 * so a menu absolutely positioned inside the header is CLIPPED BY THE PANEL.
 * Measured in a real browser on the OptoSmooth faceplate: five presets with
 * their descriptions is about 430 px of menu opening below a header on a
 * window barely taller than that, so the last two rows and the Save item were
 * cut off. Reading the template would not have shown it; the panel had to be
 * rendered. (Same lesson the soft clipper's faceplate records: screenshot the
 * panel, do not review it from its markup.)
 *
 * The consequences of leaving the frame are that the menu has to carry its own
 * coordinates, flip above the button when there is no room below, and cap its
 * own height — all three below.
 */
const open = ref(false)
const pos = ref({ left: 0, top: 0, flip: false, maxHeight: 420 })

/** Width is fixed so a long description wraps the same way every time. */
const MENU_W = 268
const MENU_GAP = 6
const VIEWPORT_MARGIN = 12

/**
 * Above every floating window (WindowLayer stacks from 500) rather than one
 * above its own.
 *
 * Once the menu has left the frame it is no longer covered by its own window's
 * stacking, and pinning it just above that window would put it under any
 * window focused afterwards. A flat ceiling is safe here because the menu
 * cannot outlive a click elsewhere: the capture-phase pointerdown closes it
 * before that click reaches whatever it landed on.
 */
const MENU_Z = 4000

function place() {
  const el = trigger.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const below = window.innerHeight - r.bottom - MENU_GAP - VIEWPORT_MARGIN
  const above = r.top - MENU_GAP - VIEWPORT_MARGIN
  const flip = below < 240 && above > below
  pos.value = {
    // Centred on the trigger, then pulled back inside the viewport — a menu
    // half off the screen edge is worse than one not quite centred.
    left: Math.max(
      VIEWPORT_MARGIN,
      Math.min(window.innerWidth - MENU_W - VIEWPORT_MARGIN, r.left + r.width / 2 - MENU_W / 2)
    ),
    top: flip ? r.top - MENU_GAP : r.bottom + MENU_GAP,
    flip,
    maxHeight: Math.max(180, flip ? above : below),
  }
}
const saving = ref(false)
const draftName = ref('')
const error = ref('')
const root = ref(null)
const trigger = ref(null)
const menu = ref(null)
const nameInput = ref(null)

const items = computed(() => props.presets.presets.value)
const factory = computed(() => items.value.filter(p => p.source === 'factory'))
const user = computed(() => items.value.filter(p => p.source === 'user'))

async function toggle() {
  open.value = !open.value
  if (!open.value) { closeSaveForm(); return }
  place()
  await nextTick()
  place()
}

function closeMenu() {
  open.value = false
  closeSaveForm()
}

function closeSaveForm() {
  saving.value = false
  draftName.value = ''
  error.value = ''
}

function choose(id) {
  if (props.disabled) return
  props.presets.select(id)
  closeMenu()
}

async function startSave() {
  saving.value = true
  error.value = ''
  // Seed with the active name so overwriting one's own preset is a click
  // through rather than retyping it exactly.
  const active = props.presets.activePreset.value
  draftName.value = active && active.source === 'user' ? active.name : ''
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
}

function commitSave() {
  const name = draftName.value.trim()
  if (!name) { error.value = 'Give the preset a name.'; return }
  try {
    props.presets.save(name)
    closeMenu()
  } catch (err) {
    error.value = err?.message ?? 'Could not save that preset.'
  }
}

function removePreset(id) {
  props.presets.remove(id)
}

function onDocPointerDown(e) {
  if (!open.value) return
  // The menu is no longer a descendant of the trigger, so "outside" has to
  // mean outside BOTH — testing only the trigger would close the menu on
  // every click inside it, including the name field.
  const inTrigger = root.value?.contains(e.target)
  const inMenu = menu.value?.contains(e.target)
  if (!inTrigger && !inMenu) closeMenu()
}

/**
 * A window drag or a scroll moves the trigger and leaves the menu behind, so
 * the menu closes rather than following. Following would mean tracking a
 * moving anchor for a control the user has stopped looking at.
 */
function onViewportChange() {
  if (open.value) closeMenu()
}

function onKeydown(e) {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation()
    closeMenu()
  }
}

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
  <!-- pointerdown is stopped so opening the menu does not start a window drag. -->
  <div ref="root" class="relative" @pointerdown.stop>
    <button
      ref="trigger"
      type="button"
      class="cursor-pointer"
      :style="{
        display: 'flex', alignItems: 'center', gap: '9px', height: '30px',
        padding: '0 18px', border: 'none', borderRadius: '10px',
        background: 'rgba(255,255,255,.11)',
        font: `600 11px 'Inter'`, letterSpacing: '.03em',
        color: presets.dirty.value ? accent : '#f2f6f7',
        opacity: disabled ? 0.5 : 1,
      }"
      :title="disabled ? disabledHint : 'Presets'"
      @click="toggle"
    >
      {{ presets.label.value }} ▾
    </button>

    <Teleport to="body">
    <div
      v-if="open"
      ref="menu"
      class="fixed rounded-lg overflow-y-auto"
      :style="{
        left: `${pos.left}px`,
        top: `${pos.top}px`,
        width: `${MENU_W}px`,
        maxHeight: `${pos.maxHeight}px`,
        transform: pos.flip ? 'translateY(-100%)' : 'none',
        background: '#1d222b',
        border: '1px solid rgba(255,255,255,.1)',
        boxShadow: '0 12px 30px rgba(0,0,0,.5)',
        zIndex: MENU_Z,
      }"
      @pointerdown.stop
    >
      <!-- A menu on a bypassed plugin opens and reads, but says why a click
           will not land rather than taking one and discarding it. -->
      <p v-if="disabled && disabledHint"
         class="px-3.5 py-2 m-0"
         :style="{ font: `600 9.5px 'JetBrains Mono',monospace`, letterSpacing: '.06em', color: accent }"
      >{{ disabledHint }}</p>

      <button
        v-for="p in factory" :key="p.id"
        type="button"
        class="w-full text-left px-3.5 py-2 border-none cursor-pointer block"
        :style="{
          background: p.id === presets.activePreset.value?.id ? 'rgba(255,255,255,.12)' : 'transparent',
          opacity: disabled ? 0.45 : 1,
        }"
        :title="p.description"
        @click="choose(p.id)"
      >
        <span style="font:600 11px 'Inter';color:#eaf6f8">{{ p.name }}</span>
        <span v-if="p.description"
              class="block mt-[2px]"
              style="font:400 9.5px 'Inter';color:rgba(234,246,248,.45)"
        >{{ p.description }}</span>
      </button>

      <div v-if="user.length" style="height:1px;background:rgba(255,255,255,.08)"></div>

      <div
        v-for="p in user" :key="p.id"
        class="flex items-center"
        :style="{ background: p.id === presets.activePreset.value?.id ? 'rgba(255,255,255,.12)' : 'transparent' }"
      >
        <button
          type="button"
          class="flex-1 text-left pl-3.5 pr-2 py-2 border-none bg-transparent cursor-pointer"
          :style="{ opacity: disabled ? 0.45 : 1 }"
          @click="choose(p.id)"
        >
          <span style="font:600 11px 'Inter';color:#eaf6f8">{{ p.name }}</span>
        </button>
        <!-- Deleting a name is not an edit to the sound: the knobs stay where
             they are, so there is nothing to undo and no confirmation. -->
        <button
          type="button"
          class="px-2.5 py-2 border-none bg-transparent cursor-pointer"
          style="font:700 11px 'JetBrains Mono',monospace;color:rgba(234,246,248,.35)"
          title="Delete this preset"
          @click.stop="removePreset(p.id)"
        >×</button>
      </div>

      <div style="height:1px;background:rgba(255,255,255,.08)"></div>

      <button
        v-if="presets.dirty.value"
        type="button"
        class="w-full text-left px-3.5 py-2 border-none bg-transparent cursor-pointer"
        style="font:600 10.5px 'Inter'"
        :style="{ color: accent }"
        @click="presets.revert(); closeMenu()"
      >Revert to {{ presets.activePreset.value?.name }}</button>

      <button
        v-if="!saving"
        type="button"
        class="w-full text-left px-3.5 py-2 border-none bg-transparent cursor-pointer"
        style="font:600 10.5px 'Inter';color:rgba(234,246,248,.7)"
        @click="startSave"
      >Save current settings…</button>

      <div v-else class="px-3 py-2.5">
        <input
          ref="nameInput"
          v-model="draftName"
          type="text"
          placeholder="Preset name"
          class="w-full px-2 py-1.5 rounded"
          style="background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.13);font:600 11px 'Inter';color:#eaf6f8;outline:none"
          @keydown.enter.prevent="commitSave"
          @keydown.esc.prevent.stop="closeSaveForm"
        />
        <p v-if="error" class="mt-1.5 mb-0" style="font:500 9.5px 'Inter';color:#f0806a">{{ error }}</p>
        <div class="flex gap-1.5 mt-2">
          <button
            type="button"
            class="flex-1 py-1 rounded cursor-pointer border-none"
            :style="{ background: accent, color: '#141821', font: `700 10px 'Inter'` }"
            @click="commitSave"
          >Save</button>
          <button
            type="button"
            class="flex-1 py-1 rounded cursor-pointer"
            style="background:transparent;border:1px solid rgba(255,255,255,.13);font:600 10px 'Inter';color:rgba(234,246,248,.7)"
            @click="closeSaveForm"
          >Cancel</button>
        </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>
