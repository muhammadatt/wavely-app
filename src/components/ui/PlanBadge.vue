<script setup>
import { computed } from 'vue'
import { useEntitlements } from '../../composables/useEntitlements.js'
import { FEATURES, PLAN_LABELS } from '../../auth/plans.js'

/**
 * The PRO tag on a registry row whose `feature` the user's plan lacks.
 * Renders nothing when the plan covers it, or when accounts are off.
 */
const props = defineProps({ feature: { type: String, default: null } })
const entitlements = useEntitlements()
const label = computed(() => {
  if (!props.feature || entitlements.can(props.feature)) return ''
  return (PLAN_LABELS[FEATURES[props.feature]?.requires] ?? 'Pro').toUpperCase()
})
</script>

<template>
  <span
    v-if="label"
    class="shrink-0 font-['JetBrains_Mono'] text-[8.5px] font-bold tracking-[0.1em] px-[5px] py-[3px] rounded-[4px]"
    style="color:#14100e;background:#e0b84a"
    :title="entitlements.hint(feature) + ' — preview is free'"
  >{{ label }}</span>
</template>
