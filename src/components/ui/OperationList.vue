<script setup>
import { ref, computed } from 'vue'
import { groupedOperations, searchOperations, operationsIn } from '../../ui/registry.js'
import { useWindows, CHAIN_WINDOW_ID } from '../../composables/useWindows.js'
import { useEditorState } from '../../composables/useEditorState.js'
import Icon from './Icon.vue'
import PlanBadge from './PlanBadge.vue'

/**
 * The searchable, grouped list of operations in a category.
 *
 * Replaces both the six-section accordion in EffectsPanel and the four-up icon
 * grid in EditPanel. Every row behaves the same way — clicking emits `select`,
 * and the category decides what that means. The search box is what lets the
 * rail keep working as the number of operations grows past what fits on screen.
 */
const props = defineProps({
  categoryId: { type: String, required: true },
  // Predicate from useOperationDispatch — whether a row should render as dead.
  isDisabled: { type: Function, default: () => false },
  // Show the search field. Hidden for short lists where it's just clutter.
  searchable: { type: Boolean, default: true },
})

const emit = defineEmits(['select'])

const query = ref('')

const groups = computed(() => {
  if (!query.value.trim()) return groupedOperations(props.categoryId)

  // While searching, group headings would mostly be one row each — a flat list
  // of hits reads better and keeps the result order meaningful.
  const hits = searchOperations(query.value, { categoryId: props.categoryId })
  return hits.length ? [{ group: '', operations: hits }] : []
})

// A category holding plugins that can take a chain slot ends with a door to the
// Plugin Chain: the rail is where a new user goes looking for effects, and the
// chain is how to run several of them at once. Opening it closes the rail
// (usePluginChain.js), so the two lists are never on screen together.
const offersChain = computed(() => operationsIn(props.categoryId).some(op => op.chain))
const { openWindow } = useWindows()
const { closeRail } = useEditorState()
function openChain() {
  closeRail()
  openWindow(CHAIN_WINDOW_ID)
}

function select(op) {
  if (props.isDisabled(op)) return
  emit('select', op)
}
</script>

<template>
  <div class="p-4 flex flex-col gap-[10px]">
    <div v-if="searchable" class="relative">
      <Icon
        name="search" :size="13"
        class="absolute left-[11px] top-1/2 -translate-y-1/2 text-text-faint pointer-events-none"
      />
      <input
        v-model="query"
        type="search"
        class="op-search w-full pl-[31px] pr-3 py-[9px] rounded-[10px] text-[12px] font-medium"
        placeholder="Search…"
        aria-label="Search operations"
      />
    </div>

    <div v-for="g in groups" :key="g.group" class="flex flex-col gap-[6px]">
      <div
        v-if="g.group"
        class="px-1 pt-[6px] text-[9.5px] font-extrabold uppercase tracking-[.11em] text-text-faint"
      >
        {{ g.group }}
      </div>

      <button
        v-for="op in g.operations"
        :key="op.id"
        class="op-row w-full flex items-center gap-[10px] px-[13px] py-3 rounded-[12px] border cursor-pointer text-left select-none"
        :class="isDisabled(op) ? 'op-row--disabled' : ''"
        :disabled="isDisabled(op)"
        @click="select(op)"
      >
        <div class="op-icon w-[34px] h-[34px] rounded-[10px] flex items-center justify-center shrink-0">
          <Icon :name="op.icon" :size="16" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-bold text-text truncate">{{ op.label }}</div>
          <!-- No RENDER tag here (owner, November 2026): in a 300 px rail it
               took the description's room. The window still carries it. -->
          <div class="text-[11px] font-medium text-text-muted truncate mt-[2px]">{{ op.desc }}</div>
        </div>
        <PlanBadge :feature="op.feature" />
        <!-- A chevron promises "this opens something", so the verbs that just
             run don't get one. -->
        <Icon
          v-if="op.surface !== 'immediate'"
          name="chevronRight" :size="16" :stroke-width="2.5" class="text-text-faint"
        />
      </button>
    </div>

    <div v-if="!groups.length" class="px-1 py-6 text-center text-[11.5px] font-medium text-text-faint">
      No operations match “{{ query }}”
    </div>

    <button
      v-if="offersChain && !query.trim()"
      type="button"
      class="chain-door w-full flex items-center gap-[10px] px-[13px] py-3 mt-[6px] rounded-[12px] cursor-pointer text-left select-none"
      @click="openChain"
    >
      <div class="chain-door-icon w-[34px] h-[34px] rounded-[10px] flex items-center justify-center shrink-0">
        <Icon name="chain" :size="16" />
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-bold text-text">Use several at once?</div>
        <div class="text-[11px] font-medium text-text-muted">Stack them in the Effect Chain and apply in one pass</div>
      </div>
      <Icon name="chevronRight" :size="16" :stroke-width="2.5" class="chain-door-chevron" />
    </button>
  </div>
</template>

<style scoped>
.op-search {
  background: var(--color-surface-1);
  border: 1px solid var(--color-border-2);
  color: var(--color-text);
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.op-search::placeholder {
  color: var(--color-text-faint);
}
.op-search:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
  background: var(--color-surface-2);
}

.op-row {
  background: transparent;
  border-color: var(--color-border-2);
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.op-row:hover {
  background: var(--color-surface-1);
  border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
}
.op-row:focus-visible {
  outline: 2px solid var(--color-accent-bright);
  outline-offset: 2px;
}
/* Reserved for rows that genuinely cannot be clicked, so dimming keeps meaning
   "unavailable" rather than "this one needs a selection". */
.op-row--disabled {
  opacity: 0.45;
  cursor: default;
}
.op-row--disabled:hover {
  background: transparent;
  border-color: var(--color-border-2);
}
.op-row--disabled:hover .chain-door {
  border: 1px dashed rgba(232, 163, 61, 0.45);
  background: rgba(232, 163, 61, 0.05);
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.chain-door:hover {
  border-color: #e8a33d;
  background: rgba(232, 163, 61, 0.1);
}
.chain-door:focus-visible {
  outline: 2px solid #e8a33d;
  outline-offset: 2px;
}
.chain-door-icon {
  background: rgba(232, 163, 61, 0.16);
  color: #e8a33d;
}
.chain-door-chevron {
  color: #e8a33d;
}

.op-icon {
  background: var(--color-surface-1);
  color: var(--color-text-dim);
}

.op-icon {
  background: var(--color-surface-1);
  color: var(--color-text-dim);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.op-row:hover .op-icon {
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  color: var(--color-accent-bright);
}
</style>
