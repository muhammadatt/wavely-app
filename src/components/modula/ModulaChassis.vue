<script setup>
/**
 * The Modula faceplate's outer shell: the graphite chassis, the header row
 * (brand, a centre slot, the state label and the power button) and the body.
 *
 * The body dims and goes inert while the unit is off. That is done here, once,
 * so no control inside has to know whether the unit is engaged — the power
 * button is the one thing that stays live, because it is what brings the face
 * back.
 */
import { computed } from 'vue'
import { glow } from './modulaTheme.js'

const props = defineProps({
  brand: { type: String, required: true },
  sub: { type: String, default: '' },
  engaged: { type: Boolean, default: true },
  accent: { type: String, default: '#ff8b3d' },
  showPower: { type: Boolean, default: true },
  /** Tighter stage and chassis padding, for a window built for economy. */
  compact: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle-power'])

const power = computed(() => {
  const on = props.engaged
  return {
    background: on
      ? 'radial-gradient(circle at 50% 35%, #ff9a4d, #d0491c)'
      : 'linear-gradient(160deg,#3c4047,#24272c)',
    boxShadow: on
      ? `0 0 28px -4px ${glow(props.accent)}, inset 0 2px 3px rgba(255,255,255,.3), inset 0 -8px 14px rgba(120,30,6,.5)`
      : '0 10px 18px -10px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.10), 0 0 0 1px rgba(0,0,0,.65)',
  }
})
const ringColor = computed(() => props.engaged ? '#fff3e9' : '#5d646d')
</script>

<template>
  <div class="mc-stage" :class="{ 'mc-compact': compact }">
    <div class="mc-chassis">
      <div class="mc-head">
        <div class="mc-brand">
          <div class="mc-brand-name">{{ brand }}</div>
          <div v-if="sub" class="mc-brand-sub">{{ sub }}</div>
        </div>
        <div class="mc-center" :class="{ 'mc-off': !engaged }">
          <slot name="center" />
        </div>
        <div class="mc-right">
          <slot name="right" />
          <template v-if="showPower">
            <div class="mc-state">{{ engaged ? 'ENGAGED' : 'BYPASSED' }}</div>
            <div
              class="mc-power"
              :style="power"
              :title="engaged ? 'Bypass' : 'Engage'"
              @click="emit('toggle-power')"
            >
              <div class="mc-power-ring" :style="{ borderColor: ringColor, borderTopColor: 'transparent' }"></div>
            </div>
          </template>
        </div>
      </div>

      <div class="mc-body" :class="{ 'mc-off': !engaged }">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The design named Archivo for the brand mark; the app loads Inter and
   JetBrains Mono, so Archivo falls through to Inter. */
.mc-stage {
  padding: 22px 22px 26px;
  background: radial-gradient(1100px 650px at 50% -10%, #262930 0%, #1a1c20 45%, #141619 100%);
  font-family: 'Archivo', 'Inter', Helvetica, sans-serif;
  color: #c9ced6;
  display: flex;
  justify-content: center;
}
.mc-chassis {
  width: 100%;
  padding: 22px;
  border-radius: 26px;
  background: linear-gradient(180deg, #32353c, #212429);
  box-shadow: 0 60px 90px -50px rgba(0,0,0,1), inset 0 1px 0 rgba(255,255,255,.08), 0 0 0 1px rgba(0,0,0,.6);
  box-sizing: border-box;
}
.mc-head {
  display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between;
  padding: 0 6px 20px;
}
.mc-brand { display: flex; align-items: baseline; gap: 12px; }
.mc-brand-name { font-size: 20px; font-weight: 700; letter-spacing: .2em; color: #e6eaf0; white-space: nowrap; }
.mc-brand-sub { font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: .26em; color: #6d747e; white-space: nowrap; }
.mc-center { display: flex; align-items: center; gap: 12px; }
.mc-right { display: flex; align-items: center; gap: 14px; }
.mc-state { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: .2em; color: #8f97a1; }
.mc-power { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; cursor: pointer; transition: box-shadow .18s, background .18s; }
.mc-power-ring { width: 15px; height: 15px; border-radius: 50%; border: 2px solid; }

.mc-compact { padding: 14px 14px 16px; }
.mc-compact .mc-chassis { padding: 16px; border-radius: 22px; }
.mc-compact .mc-head { padding: 0 4px 14px; }

.mc-off { opacity: .5; }
.mc-body.mc-off *, .mc-center.mc-off * { pointer-events: none; }
</style>
