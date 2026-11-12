<script setup>
/**
 * The value that rises over a control while it is being dragged — the kit's
 * drag tip. Invisible at rest, so a faceplate carries no number it does not
 * need; the pointer is the only thing that summons it.
 */
defineProps({
  text: { type: String, default: '' },
  show: { type: Boolean, default: false },
  /** 'lg' (15 px, the large knobs) | 'sm' (12 px). */
  size: { type: String, default: 'lg' },
  /** Distance above the control's top edge, px. */
  offset: { type: Number, default: 14 },
})
</script>

<template>
  <div
    class="m-tip"
    :class="size === 'sm' ? 'm-tip--sm' : ''"
    :style="{ top: `-${offset}px`, opacity: show ? 1 : 0, transform: `translate(-50%, ${show ? -4 : 2}px)` }"
    aria-hidden="true"
  >{{ text }}</div>
</template>

<style scoped>
.m-tip {
  position: absolute;
  left: 50%;
  z-index: 5;
  pointer-events: none;
  padding: 7px 11px;
  border-radius: 6px;
  white-space: nowrap;
  font: 500 15px/1 var(--m-font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--m-ink);
  background: var(--m-well);
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(0, 0, 0, 0.6), 0 8px 16px -6px rgba(0, 0, 0, 0.9);
  transition: opacity 140ms ease, transform 140ms ease;
}
.m-tip--sm {
  padding: 5px 8px;
  font-size: 12px;
}
</style>
