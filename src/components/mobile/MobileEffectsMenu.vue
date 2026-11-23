<script setup>
import { OPERATIONS } from '../../ui/registry.js'
import { mobileMenuOperations, MOBILE_MENU_CATEGORY_ORDER } from '../../ui/mobileEffects.js'
import { useOperationDispatch } from '../../composables/useOperationDispatch.js'
import { useMobileSheets } from '../../composables/useMobileSheets.js'
import PluginPicker from '../PluginPicker.vue'
import PlanBadge from '../ui/PlanBadge.vue'
import OfflineBadge from '../ui/OfflineBadge.vue'

/**
 * The phone's Effects menu: ONE list of every released effect, grouped by
 * category with a search field — the Plugin Chain's Add picker
 * (PluginPicker.vue) over a wider pool, in place of a tab and a sheet per
 * category (owner, November 2026). The bottom bar keeps just Effects and
 * Chain.
 *
 * A row goes through useOperationDispatch as the desktop rail's do: a plugin
 * opens its window (the desktop faceplate as a bottom sheet, scaled), a rail
 * view — Trim, Split, Silence, Fade, Volume — opens in the shell's tool
 * sheet. Rows carry the RENDER tag for an offline process and the plan tag.
 */
const { dispatch } = useOperationDispatch()
const { closeEffectsMenu } = useMobileSheets()

const pool = mobileMenuOperations(OPERATIONS)

function pick(id) {
  const op = pool.find(o => o.id === id)
  closeEffectsMenu()
  dispatch(op)
}
</script>

<template>
  <PluginPicker
    :pool="pool"
    :category-order="MOBILE_MENU_CATEGORY_ORDER"
    label="Effects"
    placeholder="Search effects…"
    search-label="Search effects"
    icon="search"
    :autofocus="false"
    data-testid="mobile-effects-menu"
    @pick="pick"
    @close="closeEffectsMenu"
  >
    <template #tag="{ op }">
      <span class="m-fx-tags">
        <OfflineBadge :show="!!op.offline" />
        <PlanBadge :feature="op.feature" />
      </span>
    </template>
  </PluginPicker>
</template>

<style scoped>
.m-fx-tags { display: flex; gap: 4px; flex-shrink: 0; }
</style>
