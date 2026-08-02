<script setup>
import { useWindows } from '../composables/useWindows.js'
import { WINDOW_COMPONENTS } from '../ui/registry.js'

/**
 * Renders every open floating window, stacked in the manager's order.
 *
 * This is the whole of App.vue's involvement with windows. Adding one is a
 * registry entry — no boolean, no v-if, no new branch in the Escape handler.
 */
const { windows } = useWindows()

// Windows stack upward from the base so the most recently focused is on top.
const BASE_Z = 500
</script>

<template>
  <component
    v-for="(id, i) in windows"
    :key="id"
    :is="WINDOW_COMPONENTS[id]"
    :z="BASE_Z + i"
  />
</template>
