<script setup>
import { computed } from 'vue'
import { useWindows } from '../composables/useWindows.js'
import { baseId, copyOfId } from '../composables/pluginCopies.js'
import { WINDOW_COMPONENTS } from '../ui/registry.js'
import PluginCopy from './PluginCopy.vue'

/**
 * Renders every open floating window, stacked in the manager's order.
 *
 * This is the whole of App.vue's involvement with windows. Adding one is a
 * registry entry — no boolean, no v-if, no new branch in the Escape handler.
 *
 * A plugin's chain copy (`<id>@chain`, see pluginCopies.js) is the same
 * component as its solo window, told which copy it edits.
 */
const { windows } = useWindows()

// A window id with no component (an operation hidden from this build, see
// `release` in the registry) renders nothing rather than an empty <component>.
const shown = computed(() => windows.filter(id => WINDOW_COMPONENTS[baseId(id)]))

// Windows stack upward from the base so the most recently focused is on top.
const BASE_Z = 500
</script>

<template>
  <PluginCopy v-for="(id, i) in shown" :key="id" :copy="copyOfId(id)">
    <component :is="WINDOW_COMPONENTS[baseId(id)]" :z="BASE_Z + i" />
  </PluginCopy>
</template>
