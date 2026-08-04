<script setup>
/**
 * Developer tuning panel for the sibilance detector.
 *
 * Gated by DEV_TUNING_PANELS at the call site — it is not rendered, and not
 * present in a production bundle at all. Deliberately plain: bare number
 * inputs under their wire names, because the audience is someone sweeping a
 * constant against a real recording, not someone de-essing an audiobook.
 *
 * Every control here invalidates the analysis, so nothing is pushed live —
 * changes are staged and take effect on the next Analyse.
 *
 * Collapsed by default. Fifteen parameters is a lot of window, and most of the
 * time it is open you are watching the event count rather than the grid, so the
 * header keeps the changed count and RE-ANALYSE visible either way.
 */
import { computed } from 'vue'
import { SIBILANCE_TUNING_GROUPS, SIBILANCE_TUNING_DEFAULTS } from '../../audio/sibilanceTuning.js'

const props = defineProps({
  tuning: { type: Object, required: true },
  accent: { type: String, default: '#7ec8ff' },
  dirty: { type: Boolean, default: false },
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['update', 'reset', 'reanalyze', 'toggle'])

// `tuning` carries overrides only, so its own keys ARE the changed set.
const changed = computed(() => new Set(Object.keys(props.tuning)))

/** Displayed value: the override if one exists, otherwise the shipped default. */
function valueOf(key) {
  return props.tuning[key] ?? SIBILANCE_TUNING_DEFAULTS[key]
}

function onInput(key, event) {
  const v = parseFloat(event.target.value)
  if (Number.isFinite(v)) emit('update', key, v)
}
</script>

<template>
  <div
    class="mt-[16px] pt-[14px]"
    style="border-top:1px dashed rgba(126,200,255,.35)"
  >
    <div class="flex items-center justify-between" :class="open ? 'mb-[10px]' : ''">
      <button
        class="flex items-center gap-[7px] cursor-pointer text-left"
        :aria-expanded="open"
        aria-controls="sibilance-tuning-body"
        :title="open ? 'Collapse detection tuning' : 'Expand detection tuning'"
        @click="emit('toggle')"
      >
        <svg
          viewBox="0 0 24 24" class="w-[10px] h-[10px] shrink-0"
          fill="none" :stroke="accent" stroke-width="3"
          stroke-linecap="round" stroke-linejoin="round"
          :style="{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }"
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span
          :style="{
            font: `700 8.5px 'JetBrains Mono',monospace`,
            letterSpacing: '.14em',
            color: accent,
          }"
        >DETECTION TUNING · DEV</span>
        <span
          v-if="open"
          style="font:500 9px 'Inter';color:rgba(255,255,255,.3)"
        >re-analyse to apply · not shipped to users</span>
      </button>
      <div class="flex items-center gap-[8px]">
        <span
          v-if="changed.size > 0"
          style="font:600 8.5px 'JetBrains Mono',monospace;color:#ffb27a"
        >{{ changed.size }} changed</span>
        <button
          v-if="open"
          class="px-[10px] py-[5px] rounded cursor-pointer"
          style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.1em;
                 background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);
                 color:rgba(255,255,255,.6)"
          @click="emit('reset')"
        >RESET</button>
        <button
          class="px-[10px] py-[5px] rounded cursor-pointer"
          :style="{
            font: `700 8.5px 'JetBrains Mono',monospace`,
            letterSpacing: '.1em',
            background: dirty ? 'rgba(255,178,122,.18)' : 'rgba(126,200,255,.14)',
            border: `1px solid ${dirty ? 'rgba(255,178,122,.5)' : 'rgba(126,200,255,.4)'}`,
            color: dirty ? '#ffb27a' : accent,
          }"
          @click="emit('reanalyze')"
        >RE-ANALYSE</button>
      </div>
    </div>

    <div v-if="open" id="sibilance-tuning-body" class="grid grid-cols-2 gap-x-[22px] gap-y-[10px]">
      <div v-for="group in SIBILANCE_TUNING_GROUPS" :key="group.label">
        <div
          style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.12em;
                 color:rgba(255,255,255,.4)"
        >{{ group.label.toUpperCase() }}</div>
        <div
          class="mb-[5px]"
          style="font:500 8.5px/1.4 'Inter';color:rgba(255,255,255,.26)"
        >{{ group.hint }}</div>

        <div
          v-for="p in group.params" :key="p.key"
          class="flex items-center justify-between gap-[8px] py-[2px]"
        >
          <label
            :for="`tune-${p.key}`"
            :title="p.key"
            style="font:500 9.5px 'Inter';color:rgba(255,255,255,.55);white-space:nowrap"
          >{{ p.label }}<span
            v-if="p.unit"
            style="color:rgba(255,255,255,.28)"
          > ({{ p.unit }})</span></label>
          <input
            :id="`tune-${p.key}`"
            type="number"
            :value="valueOf(p.key)"
            :min="p.min" :max="p.max" :step="p.step"
            class="w-[74px] px-[6px] py-[3px] rounded text-right"
            :style="{
              font: `600 10px 'JetBrains Mono',monospace`,
              background: 'rgba(0,0,0,.3)',
              border: `1px solid ${changed.has(p.key) ? 'rgba(255,178,122,.55)' : 'rgba(255,255,255,.12)'}`,
              color: changed.has(p.key) ? '#ffb27a' : 'rgba(255,255,255,.8)',
            }"
            @input="onInput(p.key, $event)"
          />
        </div>
      </div>
    </div>
  </div>
</template>
