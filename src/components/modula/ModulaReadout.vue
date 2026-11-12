<script setup>
/**
 * An inset well holding a number — the kit's readout. Fixed width in `ch` so
 * a value changing length never moves the control it sits beside.
 */
defineProps({
  text: { type: String, default: '' },
  /** 'sm' (11 px, meter readouts) | 'md' (12 px, faders) | 'lg' (15 px). */
  size: { type: String, default: 'md' },
  /** Width in ch, or null to size to the text with a minimum. */
  widthCh: { type: Number, default: null },
  minWidth: { type: Number, default: 0 },
  color: { type: String, default: '' },
})
</script>

<template>
  <div
    class="m-readout"
    :class="`m-readout--${size}`"
    :style="{
      width: widthCh ? `${widthCh}ch` : undefined,
      minWidth: minWidth ? `${minWidth}px` : undefined,
      color: color || undefined,
    }"
  >{{ text }}</div>
</template>

<style scoped>
.m-readout {
  box-sizing: border-box;
  border-radius: 5px;
  text-align: center;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  color: var(--m-ink);
  background: var(--m-well);
  box-shadow: var(--m-shadow-well);
}
.m-readout--sm { padding: 4px 4px; font: 500 11px/1 var(--m-font-mono); }
.m-readout--md { padding: 5px 6px; font: 500 12px/1 var(--m-font-mono); }
.m-readout--lg { padding: 7px 10px; font: 500 15px/1 var(--m-font-mono); border-radius: 6px; }
</style>
