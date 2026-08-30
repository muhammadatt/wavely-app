<script setup>
/**
 * The floating editor for one focus node, opened by clicking it on the plot.
 *
 * ⚠ IT EXISTS BECAUSE WIDTH HAD ONLY A WHEEL. Frequency and amount are on the
 * drag, which is the right gesture for setting them by ear; width was left on
 * the wheel alone, and a wheel is a poor control on a trackpad and no control
 * at all for anyone driving by keyboard or touch. A node's three numbers are
 * now typeable, and the two things you can only do to a node — change its shape
 * and delete it — are here rather than nowhere.
 *
 * ⚠ HTML, NOT CANVAS, AND THAT IS THE POINT. The plot draws the node; this
 * edits it. Real inputs bring focus, selection, typing, tab order and a screen
 * reader's understanding of a spin button for free, none of which a canvas has.
 *
 * It floats over the plot rather than sitting under it, which is what keeps the
 * panel's chrome from growing back: the whole reason the rail and the plate row
 * were deleted is that a control surface beside the picture is a second thing
 * to cross-reference. A card that appears on the node you clicked and closes
 * again is not that.
 */
import { computed } from 'vue'
import { RESONANCE_FOCUS_RANGES } from '../../audio/resonanceFocus.js'
import { bright, tint } from '../../ui/accent.js'
import DeviceField from '../knobs/DeviceField.vue'

const props = defineProps({
  node: { type: Object, required: true },
  index: { type: Number, required: true },
  /**
   * The node's position read LEFT TO RIGHT, which is what gets printed.
   *
   * ⚠ NOT `index`. Nodes are stored in the order they were added, so the array
   * index numbered them by age — the third node placed read "3 OF 4" wherever
   * it sat on the spectrum, which is no help at all in finding it. `index` is
   * still what every edit addresses; this is only what the reader sees.
   */
  rank: { type: Number, default: null },
  count: { type: Number, default: 1 },
  /** Auditioning this node's region alone. Monitoring state, never a parameter. */
  solo: { type: Boolean, default: false },
  accent: { type: String, default: '#8de0a8' },
  /** Sitting in the control row rather than floating over the plot. */
  docked: { type: Boolean, default: false },
})

/**
 * ⚠ DOCKED IS THE SHIPPING SHAPE; FLOATING IS WHAT IT REPLACED. As a card
 * hovering beside its node it competed with the very curve it was editing —
 * `placePanel` put it at the node's own y ± 14, which is the one place
 * guaranteed to cover the thing under the pointer, and at 268 x 92 it was a
 * third of the lane.
 *
 * Docked it takes either the foot of the plate or the slot in the control row
 * that the SELECTED ZONE's settings take under the other model — see
 * ui/focusNodeDock.js. Two differences from the floating card, both chrome: no
 * fixed width, so it fills whichever slot it is in, and no drop shadow, because
 * it is not floating over anything.
 *
 * ⚠ IT KEEPS ITS 268 px WHEREVER IT IS DOCKED. It was `w-full` when docked, on
 * the reflex that a docked thing fills its slot. Wrong on both counts here: at
 * the foot of the plate a full-width panel covers the whole bottom of the
 * display across every frequency, where the same fields centred cover under half
 * of it — and in the control row it made this the one block that stretched,
 * where the zone plate beside it is sized by its contents and centred. Three
 * fields and a chip row have a natural width; stretching them only spreads them
 * out.
 *
 * ⚠ THE CLOSE BUTTON STAYS IN BOTH. It was dropped when this docked, on the
 * argument that selection opens and closes it the way selecting a zone does.
 * True of the control row, where the panel occupies space nothing else wanted;
 * false at the foot of the plate, where it covers the bottom of the display
 * including the FOUND strip. There the reader needs a way to put it down that is
 * not "find empty plate and click it" — and a dismissed panel is not a
 * deselected node, so the `×` emits `close` and leaves the selection alone.
 */
const emit = defineEmits(['patch', 'delete', 'close', 'solo'])

/**
 * Keep presses off whatever is behind the card — except on the grip, which the
 * dock needs in order to start a slide.
 *
 * ⚠ IT WAS A BARE `@pointerdown.stop`, and that swallowed the grip entirely:
 * the dock's handler is on the card's PARENT, so stopping propagation at the
 * card means the parent never hears the press at all.
 */
function onRootPointerDown(e) {
  if (e.target.closest?.('[data-dock-grip]')) return
  e.stopPropagation()
}

const R = RESONANCE_FOCUS_RANGES

/**
 * Shape as a picture of where the attention goes, not as a word.
 *
 * ⚠ BELL / LOW / HIGH WERE THE WRONG KIND OF LABEL, for the reason the EQ's own
 * shape picker already records: "bell" is trade vocabulary a narrator has no
 * reason to know, and LOW and HIGH read as which END OF THE SPECTRUM rather than
 * which SIDE OF THIS NODE — which is the actual question, since every one of
 * these is anchored at the node's own frequency. The curve each one draws says
 * it without a word.
 *
 * Same 30x14 box, the same flat line at y=7 and the same 1.6 px stroke as
 * `eq/FilterShapePicker`, so the two read as one vocabulary rather than two
 * dialects of it. They are caricatures, not renders of the weighting: the point
 * is that three are unmistakable from each other at 30 px.
 *
 * ⚠ THE PLAIN-LANGUAGE SENTENCE STAYS, in the title and the accessible name. A
 * picture with no name is unusable to a screen reader, and these buttons are the
 * only place the LOW/HIGH distinction is explained at all — a wide bell cannot
 * say "everything below here", because it falls away on both sides.
 */
const SHAPES = [
  {
    id: 'bell',
    label: 'Bell',
    d: 'M1 11 L8 11 Q15 -1 22 11 L29 11',
    title: 'Work harder around this frequency.',
  },
  {
    id: 'low',
    label: 'Low side',
    d: 'M1 3 L9 3 Q14 3 16 8 L20 11 L29 11',
    title: 'Work harder on everything BELOW this frequency. A wide bell cannot say this — it falls away on both sides.',
  },
  {
    id: 'high',
    label: 'High side',
    d: 'M1 11 L10 11 L14 8 Q16 3 21 3 L29 3',
    title: 'Work harder on everything ABOVE this frequency.',
  },
]

const shape = computed(() => props.node.shape ?? 'bell')
const bypassed = computed(() => props.node.enabled === false)

const hz = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k` : String(Math.round(v)))
const oct = v => (v < 1 ? `${(v * 12).toFixed(0)}st` : `${v.toFixed(2)}oct`)
const signedDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`

/** Width means "transition" on a shelf and "spread" on a bell — so say which. */
const widthLabel = computed(() => (shape.value === 'bell' ? 'Width' : 'Slope'))

function chip(on, warn = false) {
  const ink = warn ? '#ffb27a' : props.accent
  return {
    font: `600 8px 'JetBrains Mono',monospace`,
    letterSpacing: '.1em',
    color: on ? (warn ? ink : bright(ink)) : 'rgba(255,255,255,.4)',
    background: on ? (warn ? 'rgba(255,178,122,.14)' : tint(ink, 0.14)) : 'rgba(255,255,255,.03)',
    boxShadow: on
      ? `inset 0 0 0 1px ${warn ? 'rgba(255,178,122,.5)' : tint(ink, 0.5)}`
      : 'inset 0 0 0 1px rgba(255,255,255,.07)',
  }
}
</script>

<template>
  <div
    class="rounded-[10px] px-[10px] py-[8px]"
    :style="[
      { background: 'rgba(14,18,20,1)', width: '268px' },
      { boxShadow: docked
        ? `inset 0 0 0 1px ${tint(accent, 0.28)}`
        : `inset 0 0 0 1px ${tint(accent, 0.28)}, 0 8px 24px rgba(0,0,0,.6)` },
    ]"
    role="group"
    :aria-label="`Focus node ${(rank ?? index) + 1} of ${count}, low to high`"
    @keydown.esc.stop="emit('close')"
    @pointerdown="onRootPointerDown"
    @dblclick.stop
    @wheel.stop
  >
    <div class="flex items-center justify-between mb-[7px]">
      <!-- ⚠ THE GRIP, AND ONLY THIS. The card sits on the foot of the plate,
           which is over the middle of the spectrum — where the voice is, and
           where the node being edited most often is too. It slides along the
           foot rather than being pinned to the centre, and the label is what
           you slide it by: a card draggable from anywhere would fight every
           field and button on it, and the × in this same row is exactly the
           kind of thing a whole-header grip would swallow.

           The attribute is the whole contract with the plot — see the dock in
           ResonanceSpectrum. It is inert when this card is docked in the
           control row instead, which has no track to slide along. -->
      <span
        data-dock-grip
        class="cursor-grab active:cursor-grabbing select-none"
        title="Drag to slide the card along the bottom of the plot"
        style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.12em"
        :style="{ color: bright(accent) }"
      >NODE {{ (rank ?? index) + 1 }} OF {{ count }}</span>
      <button
        type="button"
        class="px-[5px] leading-none rounded cursor-pointer text-[color:rgba(255,255,255,.45)] hover:text-[color:rgba(255,255,255,.65)]"
        style="font:600 20px 'JetBrains Mono',monospace;"
        aria-label="Close"
        title="Close (Esc)"
        @click="emit('close')"
      >×</button>
    </div>

    <div class="flex items-start justify-center gap-[7px]">
      <DeviceField
        :model-value="node.hz" :min="R.hz.min" :max="R.hz.max" :step="1" log
        label="Freq" unit="Hz" :format-value="hz" :accent="accent" :width="66"
        @update:model-value="emit('patch', { hz: $event })"
      />
      <!-- ⚠ "WIDTH", NEVER "Q". Q belongs to a filter and this is not one — it
           is an area of attention. It is also NOT the same axis as the global
           Sharp knob: sharpness says what shape counts as a resonance, this
           says where you are looking. -->
      <DeviceField
        :model-value="node.spanOct" :min="R.spanOct.min" :max="R.spanOct.max" :step="0.05"
        :label="widthLabel" :format-value="oct"
        :parse="t => (/st$/i.test(t) ? parseFloat(t) / 12 : parseFloat(t))"
        :accent="accent" :width="66"
        @update:model-value="emit('patch', { spanOct: $event })"
      />
      <DeviceField
        :model-value="node.biasDb" :min="R.biasDb.min" :max="R.biasDb.max" :step="0.5"
        label="Amount" unit="dB" :format-value="signedDb" :accent="accent" :width="66"
        @update:model-value="emit('patch', { biasDb: $event })"
      />
    </div>

    <div class="flex items-center gap-[4px] mt-[8px]">
      <button
        v-for="s in SHAPES"
        :key="s.id"
        type="button"
        class="px-[5px] py-[3px] rounded-full flex items-center"
        :aria-pressed="String(shape === s.id)"
        :aria-label="s.label"
        :title="s.title"
        :style="chip(shape === s.id)"
        @click="emit('patch', { shape: s.id })"
      >
        <!-- 22 px rather than the picker's 30: three of these share the row
             with DELTA, ON/BYP and DEL inside a 268 px panel, and at 26 the row
             measured 254 against 248 of usable width. The viewBox is unchanged,
             so the curves are the picker's exactly, drawn smaller. -->
        <svg width="22" height="10" viewBox="0 0 30 14" aria-hidden="true">
          <path
            :d="s.d" fill="none"
            :stroke="shape === s.id ? bright(accent) : 'rgba(255,255,255,.45)'"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
          />
        </svg>
      </button>

      <span class="flex-1"></span>

      <!-- ⚠ DELTA IS A MONITORING STATE AND MUST NEVER BECOME A PARAMETER. It
           is drawn in amber rather than the accent for exactly the reason the
           zone panel drew its own that way: bypass is stored and rendered, this
           is not, and two identical lamps would say they were the same kind of
           control. -->
      <button
        type="button"
        class="px-[7px] py-[3px] rounded-full"
        :aria-pressed="String(solo)"
        title="Hear only what this node's region is removing. Monitoring only — Apply always renders the processed audio."
        :style="chip(solo, true)"
        @click="emit('solo')"
      >DELTA</button>
      <button
        type="button"
        class="px-[7px] py-[3px] rounded-full"
        :aria-pressed="String(bypassed)"
        title="Bypass this node. It keeps its position and its settings."
        :style="chip(bypassed, true)"
        @click="emit('patch', { enabled: bypassed })"
      >{{ bypassed ? 'BYP' : 'ON' }}</button>
      <button
        type="button"
        class="px-[7px] py-[3px] rounded-full"
        title="Delete this node"
        style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.1em;
               color:rgba(255,255,255,.4);box-shadow:inset 0 0 0 1px rgba(255,255,255,.07)"
        @click="emit('delete')"
      >DEL</button>
    </div>
  </div>
</template>
