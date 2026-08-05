<script setup>
import { computed, onMounted } from 'vue'
import { useManualEq } from '../../composables/useManualEq.js'
import { useEditorState } from '../../composables/useEditorState.js'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'
import ApplyAction from '../ui/ApplyAction.vue'
import GeneralView from './eq/GeneralView.vue'
import VoxDocView from './eq/VoxDocView.vue'

/**
 * The EQ faceplate — one plugin, two views.
 *
 * Both registry entries ("EQ" and "VoxDoc") open this same window; the mode is
 * a view flag on the shared composable, not a second instance. That is what
 * makes the spec's §2.1 promise structural: there is only one band pool, and
 * switching views cannot alter it because neither view writes on entry.
 */

defineProps({ z: { type: Number, default: 500 } })

const eq = useManualEq()
const { state } = useEditorState()

const ACCENT = '#8fd18f'

// Default to engaged when the panel opens, matching the other plugin windows.
onMounted(() => {
  if (!eq.eqPreview.value) eq.togglePreview()
})

const sampleRate = computed(() => state.currentFile?.sampleRate ?? 44100)

const activeBandCount = computed(() => eq.bands.value.filter(b => b.enabled).length)

function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

function close() {
  eq.teardown()
}

async function applyAndClose() {
  await eq.apply()
  eq.teardown()
  eq.closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="manual-eq"
    :z="z"
    :width="720"
    :accent="ACCENT"
    brand-lead="EQ"
    :brand-tail="eq.mode.value === 'voxdoc' ? 'VOXDOC' : 'GENERAL'"
    :engaged="eq.eqPreview.value"
    @toggle-engaged="eq.togglePreview()"
    @close="close"
  >
    <div class="px-[22px] pt-[18px] pb-[22px]">
      <!-- Mode switch -->
      <div class="flex items-center justify-between mb-[14px]">
        <div
          class="inline-flex rounded-[3px] overflow-hidden"
          style="border:1px solid rgba(255,255,255,.1)"
          role="tablist"
        >
          <button
            v-for="m in [{ id: 'general', label: 'GENERAL' }, { id: 'voxdoc', label: 'VOXDOC' }]"
            :key="m.id"
            type="button"
            role="tab"
            :aria-selected="eq.mode.value === m.id"
            class="px-[14px] py-[5px]"
            :style="{
              font: '700 9px/1 Inter',
              letterSpacing: '.1em',
              background: eq.mode.value === m.id
                ? `color-mix(in srgb, ${ACCENT} 26%, transparent)` : 'transparent',
              color: eq.mode.value === m.id ? ACCENT : 'rgba(255,255,255,.4)',
            }"
            @click="eq.setMode(m.id)"
          >{{ m.label }}</button>
        </div>

        <div class="flex items-center gap-[14px]">
          <span
            v-if="activeBandCount > 0"
            style="font:600 9px/1 'JetBrains Mono',monospace;color:rgba(255,255,255,.3)"
          >{{ activeBandCount }} band{{ activeBandCount === 1 ? '' : 's' }}</span>
          <button
            v-if="eq.bands.value.length > 0"
            type="button"
            class="px-[8px] py-[4px] rounded-[3px]"
            style="font:600 9px/1 'Inter';letter-spacing:.06em;border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.4)"
            @click="eq.clearBands()"
          >RESET</button>
        </div>
      </div>

      <div class="flex gap-[16px]">
        <LevelMeter :db="eq.inputDb.value" label="IN" :height="200" />

        <div class="flex-1 min-w-0">
          <GeneralView
            v-if="eq.mode.value === 'general'"
            :eq="eq" :accent="ACCENT" :sample-rate="sampleRate"
          />
          <VoxDocView
            v-else
            :eq="eq" :accent="ACCENT" :sample-rate="sampleRate"
          />
        </div>

        <LevelMeter :db="eq.outputDb.value" label="OUT" :height="200" />
      </div>

      <div class="mt-[16px] pt-[14px]" style="border-top:1px solid rgba(255,255,255,.06)">
        <ApplyAction
          size="md"
          show-preview
          previewable
          :previewing="state.isPlaying"
          :accent="ACCENT"
          text-color="#0a1410"
          :met="eq.hasSelection.value"
          message="Make a selection to equalise"
          label="Apply EQ"
          :disabled="!eq.eqPreview.value || activeBandCount === 0"
          :disabled-hint="activeBandCount === 0
            ? 'Add a band before applying'
            : 'Turn the EQ on to apply it'"
          @toggle-preview="togglePlayback"
          @apply="applyAndClose"
        />
      </div>
    </div>
  </FloatingWindow>
</template>
