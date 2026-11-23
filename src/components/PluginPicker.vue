<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { searchOperations, chainPlugins, CATEGORIES } from '../ui/registry.js'
import Icon from './ui/Icon.vue'

/**
 * The Plugin Chain's Add picker — the Search Operations palette (Ctrl+K),
 * narrowed to the plugins that can take a slot.
 *
 * Same look, same fuzzy ranking, same keys (type to filter, ↑/↓, Enter, Esc),
 * so adding to the chain is a gesture the user already knows. A plugin already
 * in the chain is marked with how many slots it has, and can be added again —
 * each slot is a copy of its own (composables/pluginCopies.js).
 *
 * Grouped under the toolbar's category headers (Dynamics, Tone, Fix), in the
 * toolbar's order, so the list reads like the menus the user already knows
 * rather than one long run. While searching the groups stay, each holding its
 * matches in rank order, the group with the best match first; ↑/↓ walk the
 * visible rows straight through.
 *
 * Also the phone's Effects menu (mobile/MobileEffectsMenu.vue): the same list
 * over every released effect, with its own wording, no autofocus (a phone's
 * keyboard would cover the list) and its own tags per row (the `tag` slot).
 * With no props it is the chain's Add picker.
 */
const props = defineProps({
  /** Window ids of the plugins already in the chain, once per slot. */
  inChain: { type: Array, default: () => [] },
  /** The operations to list; the chainable plugins by default. */
  pool: { type: Array, default: null },
  /** Category order for the group headers; the toolbar's by default. */
  categoryOrder: { type: Array, default: null },
  label: { type: String, default: 'Add a plugin to the chain' },
  placeholder: { type: String, default: 'Add a plugin to the chain…' },
  /** The search field's accessible name. */
  searchLabel: { type: String, default: 'Search plugins' },
  icon: { type: String, default: 'chain' },
  /** Focus the search field on open. */
  autofocus: { type: Boolean, default: true },
})
const emit = defineEmits(['pick', 'close'])

const query = ref('')
const cursor = ref(0)
const inputEl = ref(null)
const listEl = ref(null)

const slotCounts = computed(() => {
  const counts = new Map()
  for (const id of props.inChain) counts.set(id, (counts.get(id) ?? 0) + 1)
  return counts
})
const ranked = computed(() => searchOperations(query.value, { pool: props.pool ?? chainPlugins() }))
const orderedCategories = computed(() => props.categoryOrder
  ? props.categoryOrder.map(id => CATEGORIES.find(c => c.id === id)).filter(Boolean)
  : CATEGORIES)

// Ranked matches bucketed by category, categories in toolbar order.
const groups = computed(() => {
  const byCategory = new Map(orderedCategories.value.map(c => [c.id, { id: c.id, label: c.label, operations: [] }]))
  const other = { id: 'other', label: 'Other', operations: [] }
  for (const op of ranked.value) (byCategory.get(op.category) ?? other).operations.push(op)
  const list = [...byCategory.values(), other].filter(g => g.operations.length)
  // Searching, the group holding the best match goes first, so the row Enter
  // picks (the first one drawn) is still the best match.
  if (query.value.trim()) {
    const rank = op => ranked.value.indexOf(op)
    list.sort((x, y) => rank(x.operations[0]) - rank(y.operations[0]))
  }
  return list
})
// The rows in the order they are drawn — what the cursor walks.
const results = computed(() => groups.value.flatMap(g => g.operations))
const indexOf = op => results.value.indexOf(op)
const inChainCount = op => slotCounts.value.get(op.id) ?? 0

// Re-searching invalidates whatever the cursor was pointing at.
watch(results, () => { cursor.value = 0 }, { immediate: true })

onMounted(() => {
  if (props.autofocus) inputEl.value?.focus()
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

function pick(op) {
  if (op) emit('pick', op.id)
}

function onKeydown(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); pick(results.value[cursor.value]) }
}

// Escape anywhere inside the picker — the search field or a result button
// tabbed to — closes the picker and nothing else. Stopped here, or
// EditorScreen's global handler goes on to close the window underneath.
function onEscape(e) {
  e.preventDefault()
  e.stopPropagation()
  emit('close')
}
</script>

<template>
  <div
    class="fixed inset-0 flex items-start justify-center pt-[14vh] px-4 compact:pt-3 compact:px-3"
    style="z-index:700;background:rgba(6,9,12,.55);backdrop-filter:blur(3px)"
    @click.self="emit('close')"
    @keydown.esc="onEscape"
  >
    <div
      class="picker w-full max-w-[540px] rounded-2xl overflow-hidden"
      role="dialog"
      aria-modal="true"
      :aria-label="label"
    >
      <div class="flex items-center gap-[10px] px-4 h-[52px] border-b border-border-1">
        <Icon :name="icon" :size="16" class="text-text-faint" />
        <input
          ref="inputEl"
          v-model="query"
          type="text"
          class="picker-input flex-1 bg-transparent border-none text-[14px] font-medium"
          :placeholder="placeholder"
          :aria-label="searchLabel"
          @keydown="onKeydown"
        />
        <kbd class="compact:hidden font-mono text-[9.5px] font-bold px-[6px] py-[3px] rounded-[5px] text-text-faint" style="background:rgba(255,255,255,.06)">ESC</kbd>
        <!-- On a phone the list fills the screen, leaving almost no backdrop
             to tap and no Escape key: a close button stands in for the hint. -->
        <button
          type="button"
          class="picker-close hidden compact:grid"
          aria-label="Close"
          data-testid="picker-close"
          @click="emit('close')"
        ><Icon name="close" :size="13" :stroke-width="2.5" /></button>
      </div>

      <!-- On a phone the list takes the screen's height (see the CSS). -->
      <div ref="listEl" class="picker-list max-h-[46vh] overflow-y-auto p-2">
        <section v-for="g in groups" :key="g.id" :aria-label="g.label">
          <div class="picker-group px-3 pt-[10px] pb-[6px] font-mono text-[9.5px] font-bold uppercase tracking-[.16em]">{{ g.label }}</div>
          <button
            v-for="op in g.operations"
            :key="op.id"
            type="button"
            class="picker-row w-full flex items-center gap-[11px] px-3 py-[10px] rounded-[10px] border-none cursor-pointer text-left"
            :data-active="indexOf(op) === cursor"
            :class="indexOf(op) === cursor ? 'is-active' : ''"
            @click="pick(op)"
            @mousemove="cursor = indexOf(op)"
          >
            <div class="picker-icon w-[30px] h-[30px] rounded-lg flex items-center justify-center shrink-0">
              <Icon :name="op.icon" :size="15" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-[12.5px] font-bold text-text truncate">{{ op.label }}</div>
              <div class="text-[10.5px] font-medium text-text-muted truncate">{{ op.desc }}</div>
            </div>
            <slot name="tag" :op="op">
              <span
                class="shrink-0 text-[9.5px] font-extrabold uppercase tracking-[.1em]"
                :class="inChainCount(op) ? 'picker-member' : 'text-text-faint'"
              >{{ inChainCount(op) > 1 ? `In chain ×${inChainCount(op)}` : inChainCount(op) ? 'In chain' : op.group }}</span>
            </slot>
          </button>
        </section>

        <div v-if="!results.length" class="px-3 py-8 text-center text-[12px] font-medium text-text-faint">
          Nothing matches “{{ query }}”
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The palette's styling, kept in step with CommandPalette.vue by hand. */
.picker {
  background: linear-gradient(180deg, #171d27, #10141a);
  box-shadow: 0 30px 70px rgba(0, 0, 0, 0.6), inset 0 0 0 1px rgba(255, 255, 255, 0.07);
  animation: pickerIn 0.16s cubic-bezier(0.34, 1.4, 0.64, 1) both;
}

.picker-input {
  color: var(--color-text);
}
.picker-input:focus {
  outline: none;
}
.picker-input::placeholder {
  color: var(--color-text-faint);
}

.picker-row {
  background: transparent;
  transition: background-color 0.1s ease;
}
.picker-row.is-active {
  background: color-mix(in srgb, var(--color-accent) 13%, transparent);
}

.picker-icon {
  background: var(--color-surface-1);
  color: var(--color-text-dim);
}
.picker-row.is-active .picker-icon {
  background: color-mix(in srgb, var(--color-accent) 20%, transparent);
  color: var(--color-accent-bright);
}

.picker-group {
  color: var(--color-text-faint);
}
section + section .picker-group {
  margin-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

@media (max-height: 520px), (max-width: 640px) {
  .picker-list { max-height: calc(100dvh - 76px); }
}

.picker-close {
  width: 32px;
  height: 32px;
  flex: none;
  place-items: center;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.7);
}

.picker-member {
  color: #e8a33d;
}

@keyframes pickerIn {
  from { opacity: 0; transform: translateY(-8px) scale(0.985); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
