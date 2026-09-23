<script setup>
import { computed } from 'vue'

/**
 * Illuminated push button from the Classic 76 face: a dark bezel around an
 * amber lens that sinks and lights when on.
 *
 * Drawn at its native 36 px and scaled, so the three sizes on the face are one
 * drawing rather than three hand-fitted ones.
 */
const props = defineProps({
  on: { type: Boolean, default: false },
  size: { type: Number, default: 36 },
  /** The outer halo and glow — only the free-standing Auto Makeup lamp has them. */
  halo: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  title: { type: String, default: '' },
})
defineEmits(['click'])

const NATIVE = 36
const scale = computed(() => props.size / NATIVE)
const depth = computed(() => (props.on ? 3 : 0))
const capShadow = computed(() => (depth.value > 1
  ? `inset 0 ${Math.round(depth.value * 1.4)}px ${Math.round(depth.value * 1.8)}px rgba(0,0,0,.6),inset 0 -1px 0 rgba(255,255,255,.08)`
  : 'inset 0 -3px 6px rgba(0,0,0,.45),0 2px 4px rgba(0,0,0,.55)'))
</script>

<template>
  <button
    type="button"
    class="lamp-btn"
    :class="{ 'is-on': on }"
    :style="{ width: size + 'px', height: size + 'px' }"
    :title="title"
    :aria-label="title"
    :aria-pressed="on"
    :disabled="disabled"
    @click="$emit('click')"
  >
    <span class="lamp-body" :style="{ transform: `scale(${scale})` }">
      <span v-if="halo" class="l halo" :style="{ opacity: on ? .6 : 0 }" />
      <span class="l bezel" />
      <span v-if="halo" class="l glow" :style="{ opacity: on ? .85 : 0 }" />
      <span class="l ring" />
      <span class="l well" />
      <span class="l lens-clip">
        <span class="l side" :style="{ transform: `translateY(${Math.max(0, depth - 1)}px)` }" />
        <span class="l cap" :style="{ transform: `translateY(${depth}px)`, boxShadow: capShadow }">
          <span class="l lit" :style="{ opacity: on ? 1 : 0 }" />
          <span class="l bloom" :style="{ opacity: on ? 1 : 0 }" />
          <span class="l mesh" :style="{ opacity: on ? .92 : .12 }" />
          <span class="l lens-shade" />
        </span>
      </span>
      <span class="l rim" :style="{ opacity: on ? .9 : 0 }" />
      <span class="l gloss" />
    </span>
  </button>
</template>

<style scoped>
.lamp-btn {
  position: relative; padding: 0; border: 0; background: none; cursor: pointer;
  outline: none; -webkit-tap-highlight-color: transparent; flex: 0 0 auto;
}
.lamp-btn:disabled { cursor: default; }
.lamp-btn:focus-visible { border-radius: 50%; box-shadow: 0 0 0 2px rgba(255,164,53,.55); }
.lamp-body {
  position: absolute; left: 0; top: 0; width: 36px; height: 36px;
  transform-origin: 0 0; transition: translate 90ms ease-out;
}
.lamp-btn:not(:disabled):active .lamp-body { translate: 0 1px; }
.l { position: absolute; display: block; border-radius: 50%; }
.halo { inset: -4px; pointer-events: none; background: radial-gradient(closest-side,rgba(255,96,22,.3) 0%,rgba(255,60,10,.1) 46%,rgba(255,40,0,0) 74%); filter: blur(5px); transition: opacity 260ms ease; }
.bezel { inset: 0; background: linear-gradient(160deg,#403e3f 0%,#262526 34%,#181718 66%,#0d0c0d 100%); box-shadow: inset 0 1px 0 rgba(255,255,255,.2), inset 1px 0 0 rgba(255,255,255,.07), inset 0 -2px 4px rgba(0,0,0,.85), 0 8px 14px rgba(0,0,0,.75), 0 2px 5px rgba(0,0,0,.6); }
.glow { inset: 0; pointer-events: none; transition: opacity 260ms ease; box-shadow: 0 0 8px 0 rgba(255,88,22,.45), 0 0 16px 2px rgba(255,64,10,.18); }
.ring { inset: 4px; background: linear-gradient(180deg,#090809 0%,#1c1b1c 60%,#2a2829 100%); box-shadow: inset 0 2px 4px rgba(0,0,0,.95), inset 0 -1px 0 rgba(255,255,255,.12); }
.well { inset: 6px; background: linear-gradient(180deg,#120a08 0%,#060303 100%); box-shadow: inset 0 3px 6px rgba(0,0,0,.9); }
.lens-clip { inset: 6px; overflow: hidden; }
.side { inset: 0; background: linear-gradient(180deg,#26120d 0%,#150807 50%,#0a0403 100%); transition: transform 130ms cubic-bezier(.3,.8,.4,1); }
.cap { inset: 0; overflow: hidden; background: linear-gradient(180deg,#341410 0%,#1b0908 46%,#0f0503 100%); transition: transform 130ms cubic-bezier(.3,.8,.4,1), box-shadow 200ms ease; }
.cap > .l { border-radius: 0; inset: 0; }
.lit { transition: opacity 260ms ease; background: radial-gradient(78% 66% at 50% 42%,#ffeec4 0%,#ffa435 17%,#f6690f 40%,#c72b05 70%,#61100230 100%); }
.bloom { transition: opacity 260ms ease; background: radial-gradient(120% 90% at 50% 120%,rgba(255,232,196,.5) 0%,rgba(255,150,60,0) 45%); }
.mesh { transition: opacity 260ms ease; background-image: radial-gradient(circle at 50% 50%,rgba(78,18,0,.5) 0 .8px,rgba(0,0,0,0) 1.1px), radial-gradient(circle at 50% 50%,rgba(255,232,195,.2) 0 .6px,rgba(0,0,0,0) 1px); background-size: 5px 5px, 5px 5px; background-position: 0 0, 2.5px 2.8px; }
.lens-shade { background: linear-gradient(180deg,rgba(255,255,255,.14) 0%,rgba(255,255,255,0) 14%), linear-gradient(0deg,rgba(0,0,0,.5) 0%,rgba(0,0,0,0) 26%), linear-gradient(90deg,rgba(0,0,0,.4) 0%,rgba(0,0,0,0) 16%,rgba(0,0,0,0) 84%,rgba(0,0,0,.4) 100%); }
.rim { inset: 6px; pointer-events: none; transition: opacity 260ms ease; box-shadow: inset 0 0 7px 1px rgba(255,124,38,.8); }
.gloss { inset: 0; pointer-events: none; background: linear-gradient(205deg,rgba(255,255,255,.08) 0%,rgba(255,255,255,0) 40%); }
</style>
