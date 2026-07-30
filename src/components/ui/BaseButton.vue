<script setup>
import { computed } from 'vue'

const props = defineProps({
  size: { type: String, default: 'md' },       // 'sm' | 'md' | 'lg'
  color: { type: String, default: 'primary' },  // 'primary' | 'accent'
  accent: { type: String, default: null },      // CSS color, used when color="accent"
  textColor: { type: String, default: null },   // override text color, used when color="accent"
  block: { type: Boolean, default: false },     // full width
  pill: { type: Boolean, default: true },       // fully rounded vs. rounded corners
  circle: { type: Boolean, default: false },    // fixed-diameter circular icon button
  toggle: { type: Boolean, default: false },    // on/off appearance driven by `active`
  active: { type: Boolean, default: true },
})

const SIZES = {
  sm: { pad: 'px-3 py-2', text: 'text-[11px]', gap: 'gap-[6px]', diameter: '40px' },
  md: { pad: 'px-4 py-[10px]', text: 'text-[12.5px]', gap: 'gap-[7px]', diameter: '48px' },
  lg: { pad: 'px-4 py-[13px]', text: 'text-[12.5px]', gap: 'gap-[7px]', diameter: '58px' },
}

const sizeTokens = computed(() => SIZES[props.size] ?? SIZES.md)

const shapeClass = computed(() => {
  if (props.circle) return 'rounded-full'
  return props.pill ? 'rounded-full' : 'rounded-[10px]'
})

const onStyle = computed(() => {
  if (props.color === 'accent') {
    return {
      background: props.accent,
      color: props.textColor ?? '#08161a',
    }
  }
  return {
    background: '#86e8ff',
    color: '#08161a',
  }
})

const offStyle = {
  background: 'transparent',
  color: 'rgba(255,255,255,.6)',
}

const buttonStyle = computed(() => (props.toggle && !props.active) ? offStyle : onStyle.value)
</script>

<template>
  <button
    class="flex items-center justify-center border-none cursor-pointer font-bold tracking-[.02em] transition-opacity disabled:opacity-40 disabled:cursor-default"
    :class="[
      shapeClass,
      circle ? '' : [sizeTokens.pad, sizeTokens.text],
      sizeTokens.gap,
      block ? 'w-full' : '',
    ]"
    :style="[buttonStyle, circle ? { width: sizeTokens.diameter, height: sizeTokens.diameter } : {}]"
  >
    <slot />
  </button>
</template>
