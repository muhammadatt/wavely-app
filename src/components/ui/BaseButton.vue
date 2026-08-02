<script setup>
import { computed } from 'vue'

const props = defineProps({
  size: { type: String, default: 'md' },        // 'xs' | 'sm' | 'md' | 'lg'
  color: { type: String, default: 'primary' },  // 'primary' | 'accent' | 'ghost'
  accent: { type: String, default: null },      // CSS color, used when color="accent"
  textColor: { type: String, default: null },   // override text color, used when color="accent"
  block: { type: Boolean, default: false },     // full width
  pill: { type: Boolean, default: true },       // fully rounded vs. rounded corners
  circle: { type: Boolean, default: false },    // fixed-diameter circular icon button
  square: { type: Boolean, default: false },    // fixed-diameter rounded-square icon button
  toggle: { type: Boolean, default: false },    // on/off appearance driven by `active`
  active: { type: Boolean, default: true },
})

// Radius follows size rather than being chosen per call site, so a row of
// mixed-size controls reads as one scale.
const SIZES = {
  xs: { pad: 'px-[11px] py-[5px]', text: 'text-[10.5px]', gap: 'gap-[5px]', diameter: '34px', radius: '8px' },
  sm: { pad: 'px-3 py-2', text: 'text-[11px]', gap: 'gap-[6px]', diameter: '40px', radius: '8px' },
  md: { pad: 'px-4 py-[10px]', text: 'text-[11.5px]', gap: 'gap-[7px]', diameter: '48px', radius: '10px' },
  lg: { pad: 'px-4 py-[13px]', text: 'text-[12.5px]', gap: 'gap-[7px]', diameter: '58px', radius: '10px' },
}

const sizeTokens = computed(() => SIZES[props.size] ?? SIZES.md)

const isIcon = computed(() => props.circle || props.square)

const radius = computed(() => {
  if (props.circle) return '9999px'
  if (props.square) return sizeTokens.value.radius
  return props.pill ? '9999px' : sizeTokens.value.radius
})

// Hover and focus can't live in an inline style attribute, so every surface is
// published as a custom property and the rules below key off them.
const GHOST = {
  '--btn-bg': 'rgba(255,255,255,.04)',
  '--btn-bg-hover': 'rgba(255,255,255,.10)',
  '--btn-fg': 'rgba(255,255,255,.7)',
  '--btn-border': '1px solid rgba(255,255,255,.09)',
}

// "Off" is not "unavailable". The foreground matches the operation-row title
// in the rail (--color-text) so an unselected tool reads as something you can
// click; at 60% white it was dimmer than the disabled treatment below and the
// whole toolbar looked greyed out. The selected state earns its emphasis from
// the solid accent fill, not from everything else being faded.
const OFF = {
  '--btn-bg': 'transparent',
  '--btn-bg-hover': 'rgba(255,255,255,.09)',
  '--btn-fg': 'var(--color-text-soft)',
  '--btn-border': '1px solid transparent',
}

const onStyle = computed(() => {
  if (props.color === 'ghost') return GHOST
  if (props.color === 'accent') {
    return {
      '--btn-bg': props.accent,
      '--btn-bg-hover': props.accent,
      '--btn-fg': props.textColor ?? '#08161a',
      '--btn-border': '1px solid transparent',
    }
  }
  return {
    '--btn-bg': '#86e8ff',
    '--btn-bg-hover': '#9beeff',
    '--btn-fg': '#08161a',
    '--btn-border': '1px solid transparent',
  }
})

const buttonStyle = computed(() => ((props.toggle && !props.active) ? OFF : onStyle.value))
</script>

<template>
  <button
    class="base-btn flex items-center justify-center cursor-pointer font-bold tracking-[.02em]"
    :aria-pressed="toggle ? String(active) : undefined"
    :class="[
      isIcon ? '' : [sizeTokens.pad, sizeTokens.text],
      sizeTokens.gap,
      block ? 'w-full' : '',
    ]"
    :style="[
      buttonStyle,
      { borderRadius: radius },
      isIcon ? { width: sizeTokens.diameter, height: sizeTokens.diameter } : {},
    ]"
  >
    <slot />
  </button>
</template>

<style scoped>
.base-btn {
  background: var(--btn-bg);
  color: var(--btn-fg);
  border: var(--btn-border);
  transition: background-color 0.15s ease, opacity 0.15s ease, filter 0.15s ease;
}
.base-btn:hover:not(:disabled) {
  background: var(--btn-bg-hover);
  /* Solid fills carry their own hover colour; this lifts the accent variant,
     whose fill is supplied by the caller. */
  filter: brightness(1.06);
}
.base-btn:active:not(:disabled) {
  filter: brightness(0.96);
}
.base-btn:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 2px;
}
.base-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
