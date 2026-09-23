<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import LcdSpinner from './LcdSpinner.vue'
import LampButton from './LampButton.vue'
import { formatSignedDb } from './hardwareDial.js'

/**
 * Input alignment, kept off the faceplate: a small engraved readout of the
 * offset in effect, which opens a popover holding the override.
 *
 * ⚠ THE READOUT IS NOT DECORATION. The offset is a property of the FILE, and a
 * user who cannot see it fixes a mis-measured file with Input instead — which
 * is right for this file and then travels into every preset they save. So the
 * number stays visible, and an override is loud about being one: amber, and
 * labelled MANUAL, because a forgotten hand-set offset is the real cost of
 * hiding the control.
 *
 * The popover is teleported to the body for the same reason the preset menu
 * is: `win-frame` is `overflow-hidden`, so anything positioned inside it is
 * clipped by the panel. It closes on a click outside, Escape, a scroll or a
 * resize, rather than chasing a moving anchor.
 */
const props = defineProps({
  /** The offset in effect, dB. */
  modelValue: { type: Number, required: true },
  /** Whether the offset is the automatic measurement. */
  auto: { type: Boolean, required: true },
  min: { type: Number, required: true },
  max: { type: Number, required: true },
  step: { type: Number, default: 0.5 },
  /** Opens and reads while disabled, but will not take a change. */
  disabled: { type: Boolean, default: false },
  disabledHint: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'update:auto'])

const open = ref(false)
const trigger = ref(null)
const pop = ref(null)
const pos = ref({ left: 0, top: 0, flip: false })

const POP_W = 236
const GAP = 8
const MARGIN = 12
// Above every floating window, like the preset menu: it cannot outlive a
// click elsewhere, so a flat ceiling is safe.
const POP_Z = 4000

const text = computed(() => `ALIGN ${formatSignedDb(props.modelValue)}${props.auto ? '' : ' · MANUAL'}`)
const title = computed(() => (props.auto
  ? 'Input alignment, measured from this file. Click to adjust.'
  : 'Input alignment, set by hand for this file. Click to adjust or return to auto.'))

function place() {
  const r = trigger.value?.getBoundingClientRect()
  if (!r) return
  const h = pop.value?.offsetHeight ?? 150
  const below = window.innerHeight - r.bottom - GAP - MARGIN
  const flip = below < h && r.top - GAP - MARGIN > below
  pos.value = {
    left: Math.max(MARGIN, Math.min(window.innerWidth - POP_W - MARGIN, r.left + r.width / 2 - POP_W / 2)),
    top: flip ? r.top - GAP : r.bottom + GAP,
    flip,
  }
}

async function toggle() {
  open.value = !open.value
  if (!open.value) return
  place()
  await nextTick()
  place()
  pop.value?.focus({ preventScroll: true })
}

function close({ refocus = false } = {}) {
  if (!open.value) return
  open.value = false
  if (refocus) trigger.value?.focus({ preventScroll: true })
}

function setOffset(db) {
  if (props.disabled) return
  emit('update:modelValue', db)
}

function toggleAuto() {
  if (props.disabled) return
  emit('update:auto', !props.auto)
}

function onDocPointerDown(e) {
  if (!open.value) return
  if (trigger.value?.contains(e.target) || pop.value?.contains(e.target)) return
  close()
}
function onKeydown(e) {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation()
    close({ refocus: true })
  }
}
function onViewportChange() { close() }

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})
</script>

<template>
  <!-- pointerdown is stopped so opening it does not start a window drag. -->
  <button
    ref="trigger"
    type="button"
    class="align-readout"
    :class="{ 'is-manual': !auto, 'is-open': open }"
    :title="title"
    aria-haspopup="dialog"
    :aria-expanded="open"
    @pointerdown.stop
    @click="toggle"
  >{{ text }}</button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="pop"
      class="align-pop"
      role="dialog"
      aria-label="Input alignment"
      tabindex="-1"
      :style="{
        left: pos.left + 'px', top: pos.top + 'px', width: POP_W + 'px', zIndex: POP_Z,
        transform: pos.flip ? 'translateY(-100%)' : 'none',
      }"
      @pointerdown.stop
    >
      <div class="align-pop-title">Input Alignment</div>
      <div class="align-pop-row">
        <LcdSpinner
          :model-value="modelValue"
          @update:model-value="setOffset"
          :min="min" :max="max" :step="step"
          :dim="auto"
          :disabled="disabled"
          label="Input alignment"
          :format="formatSignedDb"
        />
        <div class="align-pop-auto">
          <LampButton
            :on="auto"
            :size="22"
            :disabled="disabled"
            :title="auto ? 'Measured from the file. Click to set it by hand.' : 'Set by hand. Click to measure it from the file.'"
            @click="toggleAuto"
          />
          <span class="align-pop-label">Auto</span>
        </div>
      </div>
      <p class="align-pop-note">
        Matches the compressor to this file's level, so an Input setting does the same
        on a quiet file as on a hot one. Stepping it takes over from AUTO; it applies to
        this file only and is not saved in presets.
      </p>
      <p v-if="disabled && disabledHint" class="align-pop-note align-pop-hint">{{ disabledHint }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.align-readout {
  padding: 2px 5px; border: 0; border-radius: 3px; background: none; cursor: pointer; outline: none;
  font: 400 9px/1 Oswald, 'Inter', system-ui, sans-serif; letter-spacing: .14em; white-space: nowrap;
  color: #8f8b84; transition: color .15s ease, background-color .15s ease;
}
.align-readout:hover, .align-readout.is-open { color: #c9c5be; background: rgba(255,255,255,.05); }
.align-readout:focus-visible { box-shadow: 0 0 0 1.5px rgba(255,164,53,.55); }
.align-readout.is-manual { color: #d9a060; text-shadow: 0 0 4px rgba(255,140,40,.25); }
.align-readout.is-manual:hover, .align-readout.is-manual.is-open { color: #f0b876; }

.align-pop {
  position: fixed; box-sizing: border-box; padding: 12px 14px 12px; border-radius: 6px; outline: none;
  font-family: Oswald, 'Inter', system-ui, sans-serif;
  background: linear-gradient(180deg,#2e2e2c 0%,#232322 100%);
  border: 1px solid rgba(0,0,0,.7);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.12), 0 14px 32px rgba(0,0,0,.6);
}
.align-pop-title {
  font-size: 10px; font-weight: 500; letter-spacing: .2em; text-transform: uppercase;
  color: #f2f0ec; text-shadow: 0 1px 0 rgba(0,0,0,.9);
}
.align-pop-row { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
.align-pop-auto { display: flex; align-items: center; gap: 7px; }
.align-pop-label {
  font-size: 9px; letter-spacing: .18em; text-transform: uppercase; color: #f2f0ec;
  text-shadow: 0 1px 0 rgba(0,0,0,.9);
}
.align-pop-note {
  margin: 10px 0 0; font: 400 10.5px/1.45 'Inter', system-ui, sans-serif; color: #a8a49d; letter-spacing: 0;
}
.align-pop-hint { margin-top: 6px; color: #d9a060; }
</style>
