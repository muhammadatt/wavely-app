<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useOperationDispatch } from '../composables/useOperationDispatch.js'
import { searchOperations, getCategory } from '../ui/registry.js'
import Icon from './ui/Icon.vue'

/**
 * Ctrl+K search over every operation in the registry.
 *
 * The point of this is that the category hierarchy stops being load-bearing:
 * you can reach anything without knowing whether it lives under Edit or
 * Effects, which is what makes it safe to keep adding operations.
 */
const { closeCommandPalette } = useEditorState()
const { dispatch, isDisabled } = useOperationDispatch()

const query = ref('')
const cursor = ref(0)
const inputEl = ref(null)
const listEl = ref(null)

const results = computed(() => searchOperations(query.value))

// Re-searching invalidates whatever the cursor was pointing at.
watch(results, () => { cursor.value = 0 })

onMounted(() => {
  inputEl.value?.focus()
})

function move(delta) {
  const n = results.value.length
  if (!n) return
  // Wrap, so Up from the first entry reaches the last without a long hold.
  cursor.value = (cursor.value + delta + n) % n
  scrollCursorIntoView()
}

async function scrollCursorIntoView() {
  await nextTick()
  listEl.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
}

// An unavailable verb leaves the palette open rather than closing on a no-op —
// the user still has to do something about the missing selection.
function run(op) {
  if (dispatch(op)) closeCommandPalette()
}

function onKeydown(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); run(results.value[cursor.value]) }
  else if (e.key === 'Escape') {
    // Stop here, or the event reaches EditorScreen's global handler, which sees
    // the palette already closed and goes on to close a window underneath it.
    e.preventDefault()
    e.stopPropagation()
    closeCommandPalette()
  }
}

function categoryLabel(op) {
  return getCategory(op.category)?.label ?? ''
}
</script>

<template>
  <div
    class="fixed inset-0 flex items-start justify-center pt-[14vh] px-4"
    style="z-index:700;background:rgba(6,9,12,.55);backdrop-filter:blur(3px)"
    @click.self="closeCommandPalette"
  >
    <div
      class="palette w-full max-w-[540px] rounded-2xl overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Search operations"
    >
      <div class="flex items-center gap-[10px] px-4 h-[52px] border-b border-border-1">
        <Icon name="search" :size="16" class="text-text-faint" />
        <input
          ref="inputEl"
          v-model="query"
          type="text"
          class="palette-input flex-1 bg-transparent border-none text-[14px] font-medium"
          placeholder="Search operations…"
          aria-label="Search operations"
          @keydown="onKeydown"
        />
        <kbd class="font-mono text-[9.5px] font-bold px-[6px] py-[3px] rounded-[5px] text-text-faint" style="background:rgba(255,255,255,.06)">ESC</kbd>
      </div>

      <div ref="listEl" class="max-h-[46vh] overflow-y-auto p-2">
        <button
          v-for="(op, i) in results"
          :key="op.id"
          class="palette-row w-full flex items-center gap-[11px] px-3 py-[10px] rounded-[10px] border-none cursor-pointer text-left"
          :data-active="i === cursor"
          :class="[i === cursor ? 'is-active' : '', isDisabled(op) ? 'opacity-45' : '']"
          @click="run(op)"
          @mousemove="cursor = i"
        >
          <div class="palette-icon w-[30px] h-[30px] rounded-lg flex items-center justify-center shrink-0">
            <Icon :name="op.icon" :size="15" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-[12.5px] font-bold text-text truncate">{{ op.label }}</div>
            <div class="text-[10.5px] font-medium text-text-muted truncate">{{ op.desc }}</div>
          </div>
          <span class="shrink-0 text-[9.5px] font-extrabold uppercase tracking-[.1em] text-text-faint">
            {{ categoryLabel(op) }}
          </span>
          <Icon
            v-if="op.surface === 'window'"
            name="window" :size="13"
            class="shrink-0 text-text-faint"
            title="Opens as a window"
          />
        </button>

        <div v-if="!results.length" class="px-3 py-8 text-center text-[12px] font-medium text-text-faint">
          Nothing matches “{{ query }}”
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.palette {
  background: linear-gradient(180deg, #171d27, #10141a);
  box-shadow: 0 30px 70px rgba(0, 0, 0, 0.6), inset 0 0 0 1px rgba(255, 255, 255, 0.07);
  animation: paletteIn 0.16s cubic-bezier(0.34, 1.4, 0.64, 1) both;
}

.palette-input {
  color: var(--color-text);
}
.palette-input:focus {
  outline: none;
}
.palette-input::placeholder {
  color: var(--color-text-faint);
}

.palette-row {
  background: transparent;
  transition: background-color 0.1s ease;
}
.palette-row.is-active {
  background: color-mix(in srgb, var(--color-accent) 13%, transparent);
}

.palette-icon {
  background: var(--color-surface-1);
  color: var(--color-text-dim);
}
.palette-row.is-active .palette-icon {
  background: color-mix(in srgb, var(--color-accent) 20%, transparent);
  color: var(--color-accent-bright);
}

@keyframes paletteIn {
  from { opacity: 0; transform: translateY(-8px) scale(0.985); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
