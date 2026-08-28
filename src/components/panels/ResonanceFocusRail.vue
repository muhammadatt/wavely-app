<script setup>
/**
 * THE FOCUS RAIL — the node editor for the prototype targeting model.
 *
 * A strip under the spectrum plot carrying one curve: the SENSITIVITY BIAS, in
 * signed dB, zero on a centre line. Above the line the detector works harder
 * than the global setting; below it, less. See src/audio/resonanceFocus.js for
 * the model and src/components/meters/resonanceFocusRail.js for the arithmetic
 * — this file draws and dispatches, and owns no geometry of its own.
 *
 * ── Why it is a separate strip and not an overlay ───────────────────────────
 *
 * Two failures already on record, and this shape avoids both.
 *
 * The discarded Gaussian nodes put their handles on the threshold line, which
 * is `reference + selectivity` and moves with the audio at ~46 frames a second.
 * Reported from use as a control bouncing three or four times a second and
 * impossible to aim. A BIAS CURVE IS A STATIC FUNCTION OF FREQUENCY — it has no
 * audio in it at all — so the handles hold still by construction rather than by
 * smoothing.
 *
 * And a bell drawn over a spectrum borrows the parametric-EQ gesture, which
 * promises "pinpoint this frequency and notch it". A node never notches
 * anything: it moves a detection threshold, so over a clean part of the
 * spectrum it does nothing at any setting. On its own rail, with dB of
 * SENSITIVITY on the vertical axis and the word SENSITIVITY on it, the gesture
 * promises what it delivers.
 *
 * ── The axis comes from the same frame the plot drew ────────────────────────
 *
 * `dataFn` rather than a pair of props. The plot derives its range from the
 * kernel's own frame; a second copy of that arithmetic here could disagree by a
 * frame or by a sample rate, and a rail whose frequencies are half an octave
 * off the plot above it is worse than no rail. One source, both axes.
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { bright, tint } from '../../ui/accent.js'
import {
  NODE_R,
  addNode,
  biasCurvePoints,
  canAddFocusNode,
  hzFromX,
  makeFocusNode,
  moveNode,
  nodeAt,
  nodePoint,
  removeNode,
  scaleNodeSpan,
  setNodeParam,
  toggleNode,
  xFromHz,
} from '../meters/resonanceFocusRail.js'
import {
  RESONANCE_FOCUS_MAX_NODES,
  RESONANCE_FOCUS_RANGES,
} from '../../audio/resonanceFocus.js'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  /** Index of the node the controls strip is editing, or -1. */
  selected: { type: Number, default: -1 },
  /** The plot's own frame source — see the note above on why. */
  dataFn: { type: Function, default: null },
  accent: { type: String, default: '#8de0a8' },
  height: { type: Number, default: 58 },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:nodes', 'update:selected'])

const canvasEl = ref(null)
const hoverNode = ref(-1)
let raf = null
let nextId = 1
/**
 * Index being dragged, or -1.
 *
 * A ref rather than a plain `let` because the TEMPLATE reads it, for the
 * grabbing cursor. A module-scope variable in `<script setup>` is exposed to the
 * template but is not reactive, so the cursor would latch on whatever it was at
 * the first render — a cursor that never changes is indistinguishable from one
 * that was never wired.
 */
const dragIndex = ref(-1)

/** The axis the last frame was drawn against. Read by the pointer handlers. */
const axis = { w: 600, minHz: 20, maxHz: 20000 }
/**
 * The rail's vertical scale.
 *
 * `maxDb` is the parameter's own maximum rather than a display choice, so a
 * node dragged to the top of the strip is a node at the top of its range —
 * there is no position on this rail that means "past the end", and no travel
 * that does nothing.
 */
const RAIL_MAX_DB = RESONANCE_FOCUS_RANGES.biasDb.max
function railRect() {
  return { h: props.height, maxDb: RAIL_MAX_DB }
}

const PLATE = '#080a0d'
const PLATE_RING = 'rgba(255,255,255,.06)'
const RADIUS = 10

function commit(next) {
  if (next !== props.nodes) emit('update:nodes', next)
}

function select(i) {
  if (i !== props.selected) emit('update:selected', i)
}

// ── Drawing ─────────────────────────────────────────────────────────────────

function draw() {
  const canvas = canvasEl.value
  if (!canvas) { raf = requestAnimationFrame(draw); return }
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0) { raf = requestAnimationFrame(draw); return }
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  // The plot's range, read from the same frame it drew — see the header note.
  const frame = props.dataFn?.() ?? null
  axis.w = w
  axis.minHz = frame?.minHz ?? 20
  axis.maxHz = frame?.maxHz ?? 20000

  const r = { h, maxDb: RAIL_MAX_DB }
  const mid = h / 2
  const A = props.accent
  const dim = props.disabled ? 0.35 : 1

  ctx.clearRect(0, 0, w, h)
  ctx.save()
  ctx.beginPath()
  roundRect(ctx, 0, 0, w, h, RADIUS)
  ctx.clip()
  ctx.fillStyle = PLATE
  ctx.fillRect(0, 0, w, h)

  // ⚠ TICKS AT THE EDGES, NOT FULL-HEIGHT RULES. Drawn full height they cross
  // the zero line and the two axis words, and the strip renders as a TABLE —
  // eight cells with headers in the left one. Only visible by rendering it; the
  // markup reads identically either way. Ticks give the same alignment against
  // the plot's numerals above and leave the middle of the strip to the curve.
  ctx.strokeStyle = 'rgba(255,255,255,.10)'
  ctx.lineWidth = 1
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xFromHz(hz, axis)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, 4)
    ctx.moveTo(x, h - 4)
    ctx.lineTo(x, h)
    ctx.stroke()
  }

  // The zero line. THE MOST IMPORTANT MARK ON THE STRIP: it is what says the
  // control has a neutral position, which is the whole difference between this
  // model and zones. Drawn brighter than the grid for that reason.
  ctx.strokeStyle = 'rgba(255,255,255,.20)'
  ctx.beginPath()
  ctx.moveTo(0, Math.round(mid) + 0.5)
  ctx.lineTo(w, Math.round(mid) + 0.5)
  ctx.stroke()

  // The bias curve, filled back to the zero line rather than to an edge, so the
  // sign is legible as a direction rather than as a height.
  const pts = biasCurvePoints(props.nodes, axis, r, 1)
  const anyBias = pts.some(p => Math.abs(p.db) > 0.05)
  if (anyBias) {
    ctx.beginPath()
    ctx.moveTo(0, mid)
    for (const p of pts) ctx.lineTo(p.x, p.y)
    ctx.lineTo(w, mid)
    ctx.closePath()
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, tint(A, 0.34 * dim))
    grad.addColorStop(0.5, tint(A, 0.06 * dim))
    grad.addColorStop(1, tint(A, 0.34 * dim))
    ctx.fillStyle = grad
    ctx.fill()

    ctx.beginPath()
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.strokeStyle = props.disabled ? 'rgba(255,255,255,.2)' : bright(A)
    ctx.lineWidth = 1.6
    ctx.shadowColor = tint(A, 0.5 * dim)
    ctx.shadowBlur = 8
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  // Handles. A ring for an idle node, filled for the selected one — the same
  // vocabulary the zone dots and the resonance marks use one layer up, so a dot
  // means the same thing everywhere on this panel.
  props.nodes.forEach((n, i) => {
    const p = nodePoint(n, axis, r)
    const on = n.enabled !== false
    const sel = i === props.selected

    // The selected node's SPAN, as a shaded width at its own height. Shown only
    // for the selected node: span is the field being edited, and drawing every
    // node's span turns the strip into overlapping washes that say nothing.
    if (sel) {
      const x0 = xFromHz(n.hz * Math.pow(2, -n.spanOct / 2), axis)
      const x1 = xFromHz(n.hz * Math.pow(2, n.spanOct / 2), axis)
      ctx.fillStyle = tint(A, 0.10 * dim)
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h)
      ctx.strokeStyle = tint(A, 0.28 * dim)
      ctx.setLineDash([2, 3])
      ctx.lineWidth = 1
      for (const x of [x0, x1]) {
        ctx.beginPath()
        ctx.moveTo(Math.round(x) + 0.5, 0)
        ctx.lineTo(Math.round(x) + 0.5, h)
        ctx.stroke()
      }
      ctx.setLineDash([])
    }

    // A stem to the zero line, so a node reads as an excursion FROM neutral
    // rather than as a free-floating dot at a height.
    ctx.strokeStyle = tint(A, (sel ? 0.55 : 0.3) * dim)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(Math.round(p.x) + 0.5, mid)
    ctx.lineTo(Math.round(p.x) + 0.5, p.y)
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(p.x, p.y, sel ? NODE_R + 1.5 : NODE_R, 0, Math.PI * 2)
    if (!on) {
      // A bypassed node keeps its position and loses its fill — it is still
      // where you put it, and it is still the thing the controls are editing.
      ctx.strokeStyle = 'rgba(255,255,255,.30)'
      ctx.lineWidth = 1.2
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(p.x - NODE_R, p.y + NODE_R)
      ctx.lineTo(p.x + NODE_R, p.y - NODE_R)
      ctx.stroke()
    } else if (sel) {
      ctx.fillStyle = bright(A)
      ctx.shadowColor = tint(A, 0.6)
      ctx.shadowBlur = 8
      ctx.fill()
      ctx.shadowBlur = 0
    } else {
      ctx.fillStyle = PLATE
      ctx.fill()
      ctx.strokeStyle = tint(A, 0.75 * dim)
      ctx.lineWidth = 1.4
      ctx.stroke()
    }
  })

  ctx.restore()
  ctx.beginPath()
  roundRect(ctx, 0.5, 0.5, w - 1, h - 1, RADIUS - 0.5)
  ctx.strokeStyle = PLATE_RING
  ctx.lineWidth = 1
  ctx.stroke()

  // ⚠ THEY NAME THE EFFECT, NOT THE THRESHOLD. Bare "MORE"/"LESS" on a strip
  // that biases a THRESHOLD is ambiguous in the one direction that matters —
  // more threshold is less cut. The knob below is Threshold and it runs
  // backwards; this rail must not be readable as running the same way.
  //
  // Two words rather than a scale: the strip is 58 px tall, and numerals down
  // the side would cost width the frequency axis needs and say less than the
  // direction does.
  ctx.font = "500 8px 'JetBrains Mono',monospace"
  ctx.fillStyle = 'rgba(255,255,255,.30)'
  ctx.textBaseline = 'top'
  ctx.fillText('MORE CUT', 7, 5)
  ctx.textBaseline = 'bottom'
  ctx.fillText('LESS CUT', 7, h - 5)

  if (props.nodes.length === 0 && !props.disabled) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(255,255,255,.30)'
    ctx.font = "600 8.5px 'JetBrains Mono',monospace"
    // The empty state IS the design — see DEFAULT_RESONANCE_FOCUS. It has to
    // say how to leave it, or a panel with nothing on it reads as a panel that
    // has not loaded.
    ctx.fillText('DOUBLE-CLICK TO FOCUS A FREQUENCY', w / 2, h / 2 - 8)
    ctx.textAlign = 'left'
  }

  raf = requestAnimationFrame(draw)
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

// ── Pointer ─────────────────────────────────────────────────────────────────

function local(e) {
  const r = canvasEl.value.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function onDown(e) {
  if (props.disabled) return
  const { x, y } = local(e)
  const i = nodeAt(props.nodes, x, y, axis, railRect())
  if (i < 0) { select(-1); return }
  select(i)
  dragIndex.value = i
  canvasEl.value.setPointerCapture(e.pointerId)
}

function onMove(e) {
  if (props.disabled) return
  const { x, y } = local(e)
  if (dragIndex.value >= 0) {
    commit(moveNode(props.nodes, dragIndex.value, x, y, axis, railRect()))
    return
  }
  hoverNode.value = nodeAt(props.nodes, x, y, axis, railRect())
}

function onUp(e) {
  if (dragIndex.value >= 0) {
    dragIndex.value = -1
    canvasEl.value?.releasePointerCapture?.(e.pointerId)
  }
}

/**
 * Double-click adds and removes, matching the zone plot's own vocabulary.
 *
 * Deliberately NOT single-click-to-add. On a strip this small an accidental
 * node is easy and a stray one changes the sound; and the plot above already
 * teaches that a double-click is the gesture that changes how many of something
 * there are. Single click selects, which is the other half of that vocabulary.
 */
function onDblClick(e) {
  if (props.disabled) return
  const { x, y } = local(e)
  const i = nodeAt(props.nodes, x, y, axis, railRect())
  if (i >= 0) {
    commit(removeNode(props.nodes, i))
    select(-1)
    return
  }
  if (!canAddFocusNode(props.nodes)) return
  const next = addNode(props.nodes, makeFocusNode(hzFromX(x, axis), `f${Date.now()}${nextId++}`))
  commit(next)
  select(next.length - 1)
}

/** The wheel is span — the third number, and the one not on a drag axis. */
function onWheel(e) {
  if (props.disabled) return
  const { x, y } = local(e)
  const i = nodeAt(props.nodes, x, y, axis, railRect())
  if (i < 0) return
  commit(scaleNodeSpan(props.nodes, i, e.deltaY < 0 ? 1 : -1))
}

/**
 * Every gesture has a keyboard equivalent.
 *
 * Without one the only editor for three parameters is a canvas, which is the
 * one control on this panel some people cannot use at all — the same commitment
 * the zone editor makes.
 */
function onKeyDown(e) {
  if (props.disabled) return
  const n = props.nodes
  const i = props.selected
  const step = e.shiftKey ? 10 : 1

  if (e.key === 'ArrowLeft' && !e.shiftKey && !e.altKey) {
    select(n.length ? (i <= 0 ? n.length - 1 : i - 1) : -1)
  } else if (e.key === 'ArrowRight' && !e.shiftKey && !e.altKey) {
    select(n.length ? (i < 0 || i >= n.length - 1 ? 0 : i + 1) : -1)
  } else if (i < 0) {
    if (e.key === 'Enter' && canAddFocusNode(n)) {
      const next = addNode(n, makeFocusNode(hzFromX(axis.w * 0.5, axis), `f${Date.now()}${nextId++}`))
      commit(next)
      select(next.length - 1)
    } else return
  } else if (e.key === 'ArrowUp') {
    commit(setNodeParam(n, i, 'biasDb', n[i].biasDb + step))
  } else if (e.key === 'ArrowDown') {
    commit(setNodeParam(n, i, 'biasDb', n[i].biasDb - step))
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // Frequency in semitones, because the axis is logarithmic and a fixed Hz
    // step is a different musical distance at either end of it.
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const semis = e.shiftKey ? 12 : 1
    commit(setNodeParam(n, i, 'hz', n[i].hz * Math.pow(2, (dir * semis) / 12)))
  } else if (e.key === '[' || e.key === ']') {
    commit(scaleNodeSpan(n, i, e.key === ']' ? 1 : -1))
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    commit(removeNode(n, i))
    select(-1)
  } else if (e.key === ' ') {
    commit(toggleNode(n, i))
  } else if (e.key === 'Enter' && canAddFocusNode(n)) {
    const next = addNode(n, makeFocusNode(hzFromX(axis.w * 0.5, axis), `f${Date.now()}${nextId++}`))
    commit(next)
    select(next.length - 1)
  } else return
  e.preventDefault()
}

/**
 * The accessible name. A canvas is opaque to a screen reader, and the node
 * frequencies exist nowhere else on the panel.
 */
const summary = computed(() => {
  if (props.nodes.length === 0) return 'Focus rail. No focus nodes — the detector runs at its global setting everywhere.'
  const list = props.nodes.map((n, i) => {
    const hz = n.hz >= 1000 ? `${(n.hz / 1000).toFixed(2)} kilohertz` : `${Math.round(n.hz)} hertz`
    const dir = n.biasDb >= 0 ? 'more' : 'less'
    const off = n.enabled === false ? ', bypassed' : ''
    return `${i + 1}: ${hz}, ${Math.abs(n.biasDb).toFixed(1)} decibels ${dir}, ${n.spanOct.toFixed(2)} octaves wide${off}`
  }).join('. ')
  return `Focus rail, ${props.nodes.length} of ${RESONANCE_FOCUS_MAX_NODES} nodes. ${list}`
})

onMounted(() => { raf = requestAnimationFrame(draw) })
onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf) })
</script>

<template>
  <div
    :style="{
      padding: '3px',
      borderRadius: '13px',
      background: '#080a0d',
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.06), inset 0 2px 12px rgba(0,0,0,.65)',
    }"
  >
    <canvas
      ref="canvasEl"
      class="block w-full"
      tabindex="0"
      role="group"
      :aria-label="summary"
      title="Sensitivity bias. Drag a node for frequency and amount, wheel for width, double-click to add or remove."
      :style="{
        height: `${height}px`,
        borderRadius: '10px',
        cursor: disabled ? 'default' : dragIndex >= 0 ? 'grabbing' : hoverNode >= 0 ? 'grab' : 'crosshair',
      }"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @pointerleave="hoverNode = -1"
      @dblclick="onDblClick"
      @wheel.prevent="onWheel"
      @keydown="onKeyDown"
    ></canvas>
  </div>
</template>
