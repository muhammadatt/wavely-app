<script setup>
import { computed } from 'vue'
import { useWindows } from '../composables/useWindows.js'
import { WINDOW_COMPONENTS } from '../ui/registry.js'

/**
 * Renders every open floating window, stacked in the manager's order.
 *
 * This is the whole of App.vue's involvement with windows. Adding one is a
 * registry entry — no boolean, no v-if, no new branch in the Escape handler.
 */
const { windows } = useWindows()

// A window id with no component (an operation hidden from this build, see
// `release` in the registry) renders nothing rather than an empty <component>.
const shown = computed(() => windows.filter(id => WINDOW_COMPONENTS[id]))

// Windows stack upward from the base so the most recently focused is on top.
const BASE_Z = 500
</script>

<template>
  <component
    v-for="(id, i) in shown"
    :key="id"
    :is="WINDOW_COMPONENTS[id]"
    :z="BASE_Z + i"
  />
</template>
