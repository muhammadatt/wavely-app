<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useOperationDispatch } from '../composables/useOperationDispatch.js'
import { operationsIn } from '../ui/registry.js'
import Icon from './ui/Icon.vue'

/**
 * Right-click menu on the waveform.
 *
 * Renders the Edit category straight from the registry, so it can never drift
 * from the rail or the command palette — the same entries, the same
 * preconditions, the same dispatch. This is the payoff for having a registry:
 * a whole new surface costs one component and no new knowledge of operations.
 */
const { state, closeContextMenu } = useEditorState()
const { dispatch, isDisabled } = useOperationDispatch()

const menuEl = ref(null)
// Start at the click point; corrected after mount once the size is known.
const pos = ref({ x: state.contextMenu?.x ?? 0, y: state.contextMenu?.y ?? 0 })

const groups = computed(() => {
  const out = []
  const byName = new Map()
  for (const op of operationsIn('edit')) {
    let bucket = byName.get(op.group)
    if (!bucket) {
      bucket = { group: op.group, operations: [] }
      byName.set(op.group, bucket)
      out.push(bucket)
    }
    bucket.operations.push(op)
  }
  return out
})

onMounted(async () => {
  await nextTick()
  clampToViewport()
  menuEl.value?.focus()
  // Capture phase: a menu item's own click must still land, but any other
  // pointerdown anywhere dismisses, including inside a floating window.
  window.addEventListener('pointerdown', onOutsidePointer, true)
  window.addEventListener('resize', closeContextMenu)
  window.addEventListener('wheel', closeContextMenu, { passive: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onOutsidePointer, true)
  window.removeEventListener('resize', closeContextMenu)
  window.removeEventListener('wheel', closeContextMenu)
})

function clampToViewport() {
  const el = menuEl.value
  if (!el) return
  const { width, height } = el.getBoundingClientRect()
  const margin = 8
  // Flip rather than slide when the menu would overflow, so the cursor never
  // ends up sitting on top of an item.
  if (pos.value.x + width > window.innerWidth - margin) {
    pos.value.x = Math.max(margin, pos.value.x - width)
  }
  if (pos.value.y + height > window.innerHeight - margin) {
    pos.value.y = Math.max(margin, pos.value.y - height)
  }
}

function onOutsidePointer(e) {
  if (!menuEl.value?.contains(e.target)) closeContextMenu()
}

function run(op) {
  if (isDisabled(op)) return
  closeContextMenu()
  dispatch(op)
}

function onKeydown(e) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  closeContextMenu()
}
</script>

<template>
  <div
    ref="menuEl"
    class="ctx-menu fixed min-w-[196px] py-[6px] rounded-[12px] outline-none"
    :style="{ left: pos.x + 'px', top: pos.y + 'px', zIndex: 650 }"
    role="menu"
    aria-label="Waveform actions"
    tabindex="-1"
    @keydown="onKeydown"
    @contextmenu.prevent
  >
    <template v-for="(g, gi) in groups" :key="g.group">
      <div v-if="gi > 0" class="ctx-sep my-[5px]"></div>

      <button
        v-for="op in g.operations"
        :key="op.id"
        class="ctx-item w-full flex items-center gap-[9px] px-[11px] py-[7px] bg-transparent border-none cursor-pointer text-left"
        role="menuitem"
        :disabled="isDisabled(op)"
        @click="run(op)"
      >
        <Icon :name="op.icon" :size="14" class="shrink-0" />
        <span class="text-[12px] font-semibold">{{ op.label }}</span>
        <Icon
          v-if="op.surface !== 'immediate'"
          name="chevronRight" :size="13" :stroke-width="2.5"
          class="ml-auto shrink-0 opacity-45"
        />
      </button>
    </template>
  </div>
</template>

<style scoped>
.ctx-menu {
  background: linear-gradient(180deg, #1a2029, #12161d);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  animation: ctxIn 0.12s ease-out both;
}

.ctx-sep {
  height: 1px;
  background: var(--color-border-1);
}

.ctx-item {
  color: var(--color-text-soft);
  transition: background-color 0.1s ease, color 0.1s ease;
}
.ctx-item:hover:not(:disabled),
.ctx-item:focus-visible:not(:disabled) {
  background: color-mix(in srgb, var(--color-accent) 15%, transparent);
  color: var(--color-accent-bright);
  outline: none;
}
.ctx-item:disabled {
  color: var(--color-text-faint);
  cursor: default;
}

@keyframes ctxIn {
  from { opacity: 0; transform: scale(0.97); }
  to   { opacity: 1; transform: scale(1); }
}
</style>
