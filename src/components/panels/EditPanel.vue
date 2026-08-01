<script setup>
import { ref, computed } from 'vue'
import TrimPanel from './TrimPanel.vue'
import SilencePanel from './SilencePanel.vue'
import FadePanel from './FadePanel.vue'
import VolumePanel from './VolumePanel.vue'

// Module scope, not setup scope: ContextPanel mounts this behind a v-if, so a
// setup-level ref would reset to Trim every time the panel is reopened. The
// user's last sub-tool survives closing and reopening the panel.
const activeSub = ref('trim')

const subTools = [
  {
    id: 'trim', label: 'Trim', component: TrimPanel,
    desc: 'Remove audio outside or inside your selection',
    icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  },
  {
    id: 'silence', label: 'Silence', component: SilencePanel,
    desc: 'Replace the selected region with silence',
    icon: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>',
  },
  {
    id: 'fade', label: 'Fade', component: FadePanel,
    desc: 'Shape the volume curve at the selection edges',
    icon: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  },
  {
    id: 'volume', label: 'Volume', component: VolumePanel,
    desc: 'Adjust the volume of the selected region',
    icon: '<rect x="3" y="8" width="18" height="8" rx="2"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="22"/>',
  },
]

const active = computed(() => subTools.find(t => t.id === activeSub.value) ?? subTools[0])
</script>

<template>
  <div class="font-['Inter']">
    <!-- One header for the group. The four child panels used to carry their own
         and have had them removed, so the sub-tool name lives here instead. -->
    <div class="px-5 pt-5 pb-[14px] border-b border-[rgba(255,255,255,.06)]">
      <div class="text-[15px] font-bold text-[#eaf6f8]">Edit</div>
      <div class="mt-[4px] text-[11.5px] leading-[1.4] text-[rgba(255,255,255,.42)]">
        {{ active.desc }}
      </div>
    </div>

    <!-- Sub-tool switcher -->
    <div class="px-4 pt-4">
      <div class="grid grid-cols-4 gap-[6px]">
        <button
          v-for="sub in subTools"
          :key="sub.id"
          class="flex flex-col items-center gap-[5px] py-[10px] px-1 rounded-[12px] border text-[10px] font-semibold cursor-pointer transition-all"
          :style="activeSub === sub.id
            ? 'border-color:rgba(53,211,230,.5);background:rgba(53,211,230,.12);color:#7fe9f6'
            : 'border-color:rgba(255,255,255,.07);background:rgba(255,255,255,.03);color:rgba(255,255,255,.5)'"
          :aria-pressed="activeSub === sub.id"
          @click="activeSub = sub.id">
          <svg viewBox="0 0 24 24" width="15" height="15" class="fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="sub.icon"></svg>
          {{ sub.label }}
        </button>
      </div>
    </div>

    <!-- Not <KeepAlive>: each child holds only unapplied parameter state (fade
         curve, gain), and carrying that across a switch the user made
         deliberately is more surprising than resetting it. -->
    <component :is="active.component" />
  </div>
</template>
