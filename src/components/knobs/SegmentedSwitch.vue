<script setup>
/**
 * Hardware-style switch bank — the panel equivalent of a row of latching
 * push-buttons (COMP/LIMIT, the 1176's ratio buttons, sidechain filter).
 *
 * Values are compared with String() so numeric and string option values can
 * be mixed freely with whatever the caller keeps in state.
 */
defineProps({
  modelValue: { type: [String, Number], required: true },
  // [{ value, label, title? }]
  options: { type: Array, required: true },
  accent: { type: String, default: '#f5a623' },
  disabled: { type: Boolean, default: false },
  // Caption under the bank, e.g. the selected setting's plain-English effect.
  caption: { type: String, default: '' },
  paddingX: { type: Number, default: 14 },
})

const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <div class="flex flex-col gap-[7px]">
    <div class="flex rounded-full overflow-hidden" style="border:1px solid rgba(255,255,255,.1)">
      <button
        v-for="opt in options" :key="String(opt.value)"
        class="cursor-pointer border-none py-[7px] transition-colors disabled:cursor-default"
        :style="{
          paddingLeft: paddingX + 'px',
          paddingRight: paddingX + 'px',
          background: String(modelValue) === String(opt.value)
            ? `color-mix(in srgb, ${accent} 18%, transparent)`
            : 'transparent',
          color: String(modelValue) === String(opt.value)
            ? `color-mix(in srgb, ${accent} 65%, #ffffff)`
            : 'rgba(255,255,255,.4)',
          font: `700 9px 'JetBrains Mono',monospace`,
          letterSpacing: '.12em',
        }"
        :disabled="disabled"
        :title="opt.title"
        @click="emit('update:modelValue', opt.value)"
      >{{ opt.label }}</button>
    </div>
    <span v-if="caption" class="text-center" style="font:600 8.5px 'Inter',system-ui;letter-spacing:.08em;color:rgba(255,255,255,.35)">
      {{ caption }}
    </span>
  </div>
</template>
