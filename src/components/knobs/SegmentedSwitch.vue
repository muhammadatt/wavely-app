<script setup>
import { computed } from 'vue'
import { faceInk } from '../faceplate.js'

/**
 * Hardware-style switch bank — the panel equivalent of a row of latching
 * push-buttons (COMP/LIMIT, the 1176's ratio buttons, sidechain filter).
 *
 * Values are compared with String() so numeric and string option values can
 * be mixed freely with whatever the caller keeps in state.
 */
const props = defineProps({
  modelValue: { type: [String, Number], required: true },
  // [{ value, label, title? }]
  options: { type: Array, required: true },
  accent: { type: String, default: '#f5a623' },
  // Faceplate the bank is mounted on — see components/faceplate.js.
  face: { type: String, default: 'dark' }, // 'dark' | 'light'
  disabled: { type: Boolean, default: false },
  // Caption under the bank, e.g. the selected setting's plain-English effect.
  caption: { type: String, default: '' },
  paddingX: { type: Number, default: 14 },
})

const emit = defineEmits(['update:modelValue'])

const ink = computed(() => faceInk(props.face, props.accent))

// On a bright faceplate the bank needs a body of its own — a lighter well
// under the buttons — or the unlit positions dissolve into the metal.
const bankStyle = computed(() => ({
  border: `1px solid ${ink.value.line}`,
  background: ink.value.light ? 'rgba(255,255,255,.5)' : 'transparent',
  boxShadow: ink.value.light ? 'inset 0 1px 2px rgba(16,22,29,.14)' : 'none',
}))
</script>

<template>
  <div class="flex flex-col gap-[7px]">
    <div class="flex rounded-full overflow-hidden" :style="bankStyle">
      <button
        v-for="opt in options" :key="String(opt.value)"
        class="cursor-pointer border-none py-[7px] transition-colors disabled:cursor-default"
        :style="{
          paddingLeft: paddingX + 'px',
          paddingRight: paddingX + 'px',
          background: String(modelValue) === String(opt.value) ? ink.accentWash : 'transparent',
          color: String(modelValue) === String(opt.value) ? ink.accentInk : ink.muted,
          font: `700 9px 'JetBrains Mono',monospace`,
          letterSpacing: '.12em',
        }"
        :disabled="disabled"
        :title="opt.title"
        @click="emit('update:modelValue', opt.value)"
      >{{ opt.label }}</button>
    </div>
    <span v-if="caption" class="text-center"
          :style="{ font: `600 8.5px 'Inter',system-ui`, letterSpacing: '.08em', color: ink.faint }">
      {{ caption }}
    </span>
  </div>
</template>
