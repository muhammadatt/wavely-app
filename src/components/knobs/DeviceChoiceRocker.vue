<script setup>
/**
 * 1g — Choice rocker. Two named positions with no dominant one.
 *
 * THE CASE THIS EXISTS FOR IS THE ONE THE OTHER BINARY CONTROLS CANNOT STATE.
 * A lamp pill and an on/off rocker both mean "engaged / not engaged", so putting
 * COMP and LIMIT — or THICK and PRESENCE — on one is a claim that one of them is
 * the absence of the other. They are peers. Here the lit cap simply travels to
 * the side you picked and takes the dark ink with it, and both engravings stay
 * readable the whole time.
 *
 * ⚠ ITS SECOND USE IS AN ON/OFF SETTING THAT STANDS ALONE, and that is not a
 * contradiction of the above — it is the same property from the other side.
 * ResoTame's harmonic protection was a lit pill once and was reported as
 * unreadable: with no sibling to compare against, one slightly brighter object
 * says "there is a button here", not "the thing this controls is on". Drawing ON
 * and OFF at all times answers it from the one control. So the question is not
 * "are these peers?" but "can the reader tell which position I am in without
 * looking at anything else?" — and where the answer is no, this is the control
 * even for on and off.
 *
 * ⚠ IT IS ALSO NOT A TRAVEL SLIDE, and that distinction is load-bearing for the
 * soft clipper in particular: a thumb sliding along a track reads as one process
 * turned up or down, and CLIP vs LIMIT are two different mechanisms rather than
 * two strengths of one. `DeviceTravelSlide` is for ordered ranges you scan.
 *
 * ⚠ EACH HALF IS ITS OWN RADIO, WHICH IS A DELIBERATE DEPARTURE FROM THE DESIGN'S
 * SINGLE TOGGLING BUTTON. On a 92 px control the halves are 44 px targets and
 * people aim at the label they want; a toggle turns a click on the ALREADY
 * ACTIVE label into a switch away from it, which is the one outcome that click
 * cannot have been asking for. It also gives the control real radiogroup
 * semantics — arrow keys and a screen reader that can name both positions —
 * where a lone button would need the state spelled into an aria-label.
 *
 * ⚠ IT SIZES TO ITS LABELS RATHER THAN SITTING AT THE DESIGN'S FIXED 92 px, and
 * that was found by rendering it. 92 px leaves each half 44, which fits five
 * characters of 9 px mono at .12em tracking and clips eight: Scheps' PRESENCE
 * came out cut off against a hard `overflow: hidden`. The halves are two equal
 * grid tracks with a 46 px floor each, so short pairs are the design's own 92 px
 * to the pixel and longer ones grow instead of truncating.
 */
import { computed, nextTick, ref } from 'vue'
import { ROCKER_BODY, litCap, capInk } from './switchChrome.js'

const props = defineProps({
  modelValue: { type: [String, Number], required: true },
  /** Exactly two: [{ value, label, title? }]. Extras are ignored. */
  options: { type: Array, required: true },
  accent: { type: String, default: '#f5a623' },
  disabled: { type: Boolean, default: false },
  /** Plain-English effect of the current position, printed underneath. */
  caption: { type: String, default: '' },
  /** Names the control for assistive tech, e.g. "Peak control". */
  label: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue'])

const btns = ref([])
const pair = computed(() => props.options.slice(0, 2))
// -1 while the bound value matches neither option, which hides the cap rather
// than throwing. Nothing reads as selected, which is honest — and it is a real
// state: the soft clipper's admin knob can sit between its two named modes.
const index = computed(() =>
  pair.value.findIndex(o => String(o.value) === String(props.modelValue)))

const body = computed(() => ({
  ...ROCKER_BODY,
  // ⚠ GRID, NOT FLEX, AND THAT IS THE SECOND ATTEMPT. `flex: 1 1 0` looks like
  // it makes two equal halves and does not: a flex item's default `min-width:
  // auto` floors it at its own content, so THICK/PRESENCE settled at 56/68 px
  // while the cap went on splitting at 50% and covered the P. Two `1fr` tracks
  // are equal BY CONSTRUCTION and still size to the wider label, so the cap's
  // 50% is always the real boundary. The 46 px floor is what keeps a short pair
  // at the design's 92 px.
  display: 'inline-grid',
  gridTemplateColumns: 'repeat(2, minmax(46px, 1fr))',
  alignItems: 'stretch',
  overflow: 'hidden',
  cursor: 'default',
  opacity: props.disabled ? 0.45 : 1,
}))

// Inset 2 px on its outer edge and flush to the centre line, so the two
// positions are symmetric at any width.
const cap = computed(() => ({
  position: 'absolute',
  top: '2px',
  bottom: '2px',
  left: index.value === 1 ? '50%' : '2px',
  right: index.value === 1 ? '2px' : '50%',
  borderRadius: '6px',
  transition: 'left .15s ease, right .15s ease',
  pointerEvents: 'none',
  zIndex: 0,
  opacity: index.value < 0 ? 0 : 1,
  ...litCap(props.accent),
}))

function half(i) {
  const active = index.value === i
  return {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 8px',
    border: 'none',
    background: 'none',
    whiteSpace: 'nowrap',
    font: `700 9px 'JetBrains Mono',monospace`,
    letterSpacing: '.12em',
    color: active ? capInk(props.accent) : 'rgba(255,255,255,.4)',
    transition: 'color .15s ease',
  }
}

function pick(i) {
  const opt = pair.value[i]
  if (opt && String(opt.value) !== String(props.modelValue)) {
    emit('update:modelValue', opt.value)
  }
}

/** Arrow keys walk the pair, as a radiogroup is expected to. */
async function onKeyDown(e) {
  if (props.disabled) return
  const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp'
  const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown'
  if (!back && !fwd) return
  e.preventDefault()
  const next = back ? 0 : 1
  pick(next)
  await nextTick()
  btns.value[next]?.focus()
}
</script>

<template>
  <div class="flex flex-col items-center gap-[7px]">
    <div role="radiogroup" :aria-label="label" :style="body" @keydown="onKeyDown">
      <span :style="cap" />
      <button
        v-for="(opt, i) in pair" :key="String(opt.value)"
        ref="btns"
        type="button"
        role="radio"
        :aria-checked="index === i"
        :tabindex="index === i || (index < 0 && i === 0) ? 0 : -1"
        :title="opt.title"
        :disabled="disabled"
        class="cursor-pointer disabled:cursor-default"
        :style="half(i)"
        @click="pick(i)"
      >{{ opt.label }}</button>
    </div>
    <span
      v-if="caption"
      style="font:600 8.5px 'Inter',system-ui;letter-spacing:.08em;color:var(--color-text-faint)"
    >{{ caption }}</span>
  </div>
</template>
