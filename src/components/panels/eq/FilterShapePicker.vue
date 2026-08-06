<script setup>
import { ref, computed, watch, onBeforeUnmount } from 'vue'

/**
 * Filter type as a picture of what the filter does.
 *
 * The names are the problem this solves. "Bell", "shelf" and "notch" are trade
 * vocabulary — a narrator has no reason to know them, and a dropdown of six
 * such words is six words to look up. The curve each one draws is the thing
 * being chosen, so the curve is what the control shows.
 *
 * Plain-language captions appear in the open picker as a second channel, but
 * never on the faceplate: the strip stays a picture.
 */

const props = defineProps({
  modelValue: { type: String, required: true },
  /** Shapes on offer here — see shapesForBand(). Ordered for display. */
  options: { type: Array, required: true },
  accent: { type: String, default: '#8fd18f' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

/**
 * One path per type, drawn in a 30×14 box with the flat line at y=7.
 * These are caricatures, not renders of the actual response — the point is that
 * the six are unmistakable from each other at 30 px wide.
 */
const SHAPES = {
  peaking: { d: 'M1 11 L8 11 Q15 -1 22 11 L29 11', caption: 'Bump or dip' },
  lowshelf: { d: 'M1 3 L9 3 Q14 3 16 8 L20 11 L29 11', caption: 'Lift or drop the lows' },
  highshelf: { d: 'M1 11 L10 11 L14 8 Q16 3 21 3 L29 3', caption: 'Lift or drop the highs' },
  highpass: { d: 'M1 13 L7 12 Q13 11 16 5 L20 3 L29 3', caption: 'Remove the lows' },
  lowpass: { d: 'M1 3 L10 3 L14 5 Q17 11 23 12 L29 13', caption: 'Remove the highs' },
  notch: { d: 'M1 4 L13 4 L15 13 L17 4 L29 4', caption: 'Kill one narrow tone' },
}

const open = ref(false)
const current = computed(() => SHAPES[props.modelValue] ?? SHAPES.peaking)

function choose(type) {
  emit('update:modelValue', type)
  open.value = false
}

function toggle() {
  if (props.disabled) return
  open.value = !open.value
}

// Click-away. Registered only while open so the panel is not paying for a
// document listener per band for the 99% of the time nobody is choosing.
function onDocPointerDown(e) {
  if (!e.target.closest?.('[data-shape-picker]')) open.value = false
}

watch(open, (isOpen) => {
  if (isOpen) document.addEventListener('pointerdown', onDocPointerDown, true)
  else document.removeEventListener('pointerdown', onDocPointerDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
})
</script>

<template>
  <div class="relative" data-shape-picker>
    <button
      type="button"
      class="w-full flex items-center justify-center rounded-[3px] py-[3px] transition-colors"
      :style="{
        border: `1px solid ${open ? accent : 'rgba(255,255,255,.12)'}`,
        background: open ? `color-mix(in srgb, ${accent} 14%, transparent)` : 'rgba(0,0,0,.25)',
        opacity: disabled ? 0.4 : 1,
      }"
      :title="`Shape: ${current.caption}`"
      :aria-label="`Filter shape: ${current.caption}. Click to change.`"
      :disabled="disabled"
      @click="toggle"
    >
      <svg width="30" height="14" viewBox="0 0 30 14" aria-hidden="true">
        <path
          :d="current.d" fill="none" :stroke="accent"
          stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
        />
      </svg>
    </button>

    <!-- Opens downward over the frequency knob. The window clips at its own
         edge, so this stays narrow and anchored rather than escaping to the
         body — a portal would be clipped just the same. -->
    <div
      v-if="open"
      class="absolute left-1/2 -translate-x-1/2 top-[calc(100%+4px)] z-30 p-[5px] rounded-[4px]"
      style="width:150px;background:#141a1f;border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 24px rgba(0,0,0,.6)"
      role="listbox"
    >
      <button
        v-for="type in options"
        :key="type"
        type="button"
        role="option"
        :aria-selected="type === modelValue"
        class="w-full flex items-center gap-[7px] px-[5px] py-[4px] rounded-[3px] text-left"
        :style="{
          background: type === modelValue
            ? `color-mix(in srgb, ${accent} 20%, transparent)` : 'transparent',
        }"
        @click="choose(type)"
      >
        <svg width="30" height="14" viewBox="0 0 30 14" class="shrink-0" aria-hidden="true">
          <path
            :d="SHAPES[type].d" fill="none"
            :stroke="type === modelValue ? accent : 'rgba(255,255,255,.55)'"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
          />
        </svg>
        <span
          style="font:500 9px/1.2 'Inter'"
          :style="{ color: type === modelValue ? accent : 'rgba(255,255,255,.6)' }"
        >{{ SHAPES[type].caption }}</span>
      </button>

      <!-- Says why the menu is short, so a missing shape reads as a rule rather
           than as something broken. -->
      <p
        v-if="options.length < 4"
        class="px-[5px] pt-[4px] pb-[1px]"
        style="font:500 8px/1.35 'Inter';color:rgba(255,255,255,.34);border-top:1px solid rgba(255,255,255,.08)"
      >
        Cuts and shelves act on everything past their corner, so they are
        offered on the lowest and highest bands.
      </p>
    </div>
  </div>
</template>
