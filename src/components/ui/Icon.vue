<script setup>
import { computed } from 'vue'
import { getIcon } from '../../ui/icons.js'

/**
 * Renders a named glyph from the icon map. The paths are authored as stroked
 * 24x24 outlines, so colour follows `currentColor` and fill is always none.
 */
const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 16 },
  strokeWidth: { type: [Number, String], default: 2 },
})

const path = computed(() => getIcon(props.name))
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    :width="size" :height="size"
    class="fill-none stroke-current shrink-0"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="path"
  ></svg>
</template>
