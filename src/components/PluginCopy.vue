<script setup>
/**
 * Tells everything inside a plugin window which copy of the plugin it edits —
 * the solo copy or the chain's (see composables/pluginCopies.js). Renders its
 * slot and nothing else.
 */
import { provide } from 'vue'
import { PLUGIN_COPY_KEY } from '../composables/pluginCopies.js'

const props = defineProps({ copy: { type: String, required: true } })
provide(PLUGIN_COPY_KEY, props.copy)
</script>

<template>
  <slot />
</template>
