<script setup>
/**
 * MOCKUP ONLY — three candidate treatments for putting the focus nodes INSIDE
 * the display, drawn on a canvas laid over the real ResonanceSpectrum.
 *
 * Not shipped and not imported by the app. An overlay rather than an edit to
 * the plot so the shipping component is untouched while the three are compared;
 * whichever wins gets built into the plot properly.
 *
 * THE CONSTRAINT THAT SHAPES ALL THREE: the plot's vertical axis is dB of
 * REDUCTION, and a node's amount is dB of THRESHOLD OFFSET. Different
 * quantities. This panel has already recorded what happens when two scales
 * share a box without saying so — the old two-lane split, where the bigger lane
 * could not resolve the effect at all. The precedent that DID work is the
 * SPECTRUM overlay: a second quantity may share the plate if it carries its own
 * window, sits behind everything, and nothing invites it onto the main scale.
 *
 * And the plot is already spoken for: reduction takes the top 35%, the FOUND
 * strip the bottom 13%, the spectrum overlay the middle. The source note on
 * FOUND_BAND_FRAC says it plainly — "There is no free row."
 */
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import { bright, tint } from '../src/ui/accent.js'
import { xFromHz, nodePoint, yFromBias } from '../src/components/meters/resonanceFocusRail.js'
import { focusBiasAt } from '../src/audio/resonanceFocus.js'

const props = defineProps({
  treatment: { type: String, default: 'lane' },
  nodes: { type: Array, default: () => [] },
  selected: { type: Number, default: -1 },
  height: { type: Number, default: 280 },
  accent: { type: String, default: '#8de0a8' },
})

const canvasEl = ref(null)
let raf = null

const AXIS_H = 13
const laneH = computed(() => props.height - AXIS_H)
/** The bias rail's own window, in dB, for every treatment that has one. */
const MAX_DB = 18

/** The inset lane's height, when there is one. */
const LANE_H = 46

function hzLabel(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : String(Math.round(hz))
}

function draw() {
  const canvas = canvasEl.value
  if (!canvas) { raf = requestAnimationFrame(draw); return }
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (!w) { raf = requestAnimationFrame(draw); return }
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)

  const axis = { w, minHz: 20, maxHz: 20000 }
  const A = props.accent
  if (props.treatment === 'lane') drawLane(ctx, w, axis, A)
  else if (props.treatment === 'columns') drawColumns(ctx, w, axis, A)
  else if (props.treatment === 'both') { drawTethers(ctx, w, axis, A); drawLane(ctx, w, axis, A, true) }
  else drawRail(ctx, w, axis, A)

  raf = requestAnimationFrame(draw)
}

/**
 * TREATMENT 1 — INSET LANE. The rail as it is today, moved inside the plate as
 * a reserved band along the floor, hairline-separated, with its own zero line.
 *
 * Honest about the scale: its own window, its own datum, visibly a different
 * lane. The cost is the one thing the plot has none of — a fourth reserved
 * band, taken from the region the SPECTRUM overlay uses for its noise floor.
 */
function drawLane(ctx, w, axis, A, withPill = false) {
  const top = laneH.value - LANE_H
  const rail = { h: LANE_H, maxDb: MAX_DB }
  const mid = top + LANE_H / 2

  // Near-opaque: in the real thing this band would be RESERVED, with the other
  // lanes sized around it. The overlay cannot resize them, so it covers them —
  // and the card gives the plot the extra height the reservation would cost.
  ctx.fillStyle = 'rgba(8,10,13,.94)'
  ctx.fillRect(0, top, w, LANE_H)
  ctx.strokeStyle = 'rgba(255,255,255,.10)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, Math.round(top) + 0.5)
  ctx.lineTo(w, Math.round(top) + 0.5)
  ctx.stroke()

  ctx.strokeStyle = 'rgba(255,255,255,.18)'
  ctx.beginPath()
  ctx.moveTo(0, Math.round(mid) + 0.5)
  ctx.lineTo(w, Math.round(mid) + 0.5)
  ctx.stroke()

  const pts = []
  for (let x = 0; x <= w; x++) {
    const hz = axis.minHz * Math.pow(2, (x / w) * Math.log2(axis.maxHz / axis.minHz))
    pts.push({ x, y: top + yFromBias(focusBiasAt(props.nodes, hz), rail) })
  }
  ctx.beginPath()
  ctx.moveTo(0, mid)
  for (const p of pts) ctx.lineTo(p.x, p.y)
  ctx.lineTo(w, mid)
  ctx.closePath()
  ctx.fillStyle = tint(A, 0.22)
  ctx.fill()
  ctx.beginPath()
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
  ctx.strokeStyle = bright(A)
  ctx.lineWidth = 1.5
  ctx.stroke()

  props.nodes.forEach((n, i) => {
    const p = nodePoint(n, axis, rail)
    handle(ctx, p.x, top + p.y, i === props.selected, n.enabled !== false, A)
  })
  // The selected node's numbers, ON the node. This is what replaces the 44 px
  // plate row under the panel: three values, shown for the one node being
  // edited, where the node is.
  if (withPill && props.selected >= 0 && props.nodes[props.selected]) {
    const n = props.nodes[props.selected]
    const p = nodePoint(n, axis, rail)
    const span = n.spanOct < 1 ? `${(n.spanOct * 12).toFixed(0)}st` : `${n.spanOct.toFixed(2)}oct`
    pill(ctx, p.x, top - 13,
      `${hzLabel(n.hz)}  ${span}  ${n.biasDb > 0 ? '+' : ''}${n.biasDb.toFixed(1)}`, A, w)
  }

  ctx.font = "500 8px 'JetBrains Mono',monospace"
  ctx.fillStyle = 'rgba(255,255,255,.30)'
  ctx.textBaseline = 'top'
  ctx.fillText('MORE CUT', 7, top + 4)
  ctx.textBaseline = 'bottom'
  ctx.fillText('LESS CUT', 7, top + LANE_H - 4)
}

/**
 * TREATMENT 2 — COLUMNS. A node is a soft vertical band across the whole plot,
 * width = its span, tint = its direction, depth of tint = its amount. The
 * handle rides a FIXED datum near the top and carries the number.
 *
 * Costs no reserved row at all, and re-uses the vocabulary the zone columns
 * already taught: a span of the spectrum is a vertical band. Its weakness is
 * that amount has almost no spatial encoding — you cannot see the shape of the
 * bias profile, only where it is and roughly how strong.
 */
function drawColumns(ctx, w, axis, A) {
  const datum = 15
  props.nodes.forEach((n, i) => {
    const x = xFromHz(n.hz, axis)
    const x0 = xFromHz(n.hz * Math.pow(2, -n.spanOct / 2), axis)
    const x1 = xFromHz(n.hz * Math.pow(2, n.spanOct / 2), axis)
    const on = n.enabled !== false
    const strength = Math.min(1, Math.abs(n.biasDb) / MAX_DB)
    // Amber for "leave this alone", accent for "work harder" — the panel's own
    // two inks, and the only cue for a sign that has no vertical direction here.
    const ink = n.biasDb >= 0 ? A : '#ffb27a'
    const g = ctx.createLinearGradient(x0, 0, x1, 0)
    g.addColorStop(0, tint(ink, 0))
    g.addColorStop(0.5, tint(ink, on ? 0.06 + 0.16 * strength : 0.03))
    g.addColorStop(1, tint(ink, 0))
    ctx.fillStyle = g
    ctx.fillRect(x0, 0, x1 - x0, laneH.value)

    ctx.strokeStyle = tint(ink, on ? 0.35 : 0.15)
    ctx.lineWidth = 1
    ctx.setLineDash([2, 4])
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, datum)
    ctx.lineTo(Math.round(x) + 0.5, laneH.value)
    ctx.stroke()
    ctx.setLineDash([])

    handle(ctx, x, datum, i === props.selected, on, ink)
    if (i === props.selected) pill(ctx, x, datum + 18, `${hzLabel(n.hz)}  ${n.biasDb > 0 ? '+' : ''}${n.biasDb.toFixed(1)}`, ink, w)
  })
}

/**
 * TREATMENT 3 — BOWED RAIL. The plot already draws a flat 0 dB rail along the
 * top, and the reduction trace hangs from it. Here the RAIL ITSELF carries the
 * bias: it bows down where you have asked for more work and up where you have
 * asked for less, and the trace hangs from the bowed line.
 *
 * The appeal is that it is literally true of the model — the threshold IS the
 * datum reduction is measured from — so the targeting stops being a second
 * picture beside the first and becomes the datum of the first. It costs no new
 * space; it re-purposes a line already on the plate.
 *
 * ⚠ In this mockup the reduction trace is NOT re-hung from the bowed rail (the
 * overlay cannot redraw the plot beneath it). Read the bowed line and imagine
 * the trace hanging from it; that is the whole question this treatment asks.
 */
function drawRail(ctx, w, axis, A) {
  const rail = { h: 64, maxDb: MAX_DB }
  const base = 3
  const pts = []
  for (let x = 0; x <= w; x++) {
    const hz = axis.minHz * Math.pow(2, (x / w) * Math.log2(axis.maxHz / axis.minHz))
    // Positive bias (more cut) bows the rail DOWN, because it lowers the
    // threshold — the datum drops toward the material.
    pts.push({ x, y: base + (rail.h / 2) - yFromBias(focusBiasAt(props.nodes, hz), rail) })
  }

  // The flat rail it departs from, so the bow is readable as a departure.
  ctx.strokeStyle = 'rgba(255,255,255,.10)'
  ctx.setLineDash([3, 4])
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, base + 0.5)
  ctx.lineTo(w, base + 0.5)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.beginPath()
  ctx.moveTo(0, base)
  for (const p of pts) ctx.lineTo(p.x, p.y)
  ctx.lineTo(w, base)
  ctx.closePath()
  ctx.fillStyle = tint(A, 0.13)
  ctx.fill()

  ctx.beginPath()
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
  ctx.strokeStyle = bright(A)
  ctx.lineWidth = 1.8
  ctx.shadowColor = tint(A, 0.5)
  ctx.shadowBlur = 8
  ctx.stroke()
  ctx.shadowBlur = 0

  props.nodes.forEach((n, i) => {
    const x = xFromHz(n.hz, axis)
    const y = base + rail.h / 2 - yFromBias(n.biasDb, rail)
    handle(ctx, x, y, i === props.selected, n.enabled !== false, A)
    if (i === props.selected) pill(ctx, x, y + 16, `${hzLabel(n.hz)}  ${n.biasDb > 0 ? '+' : ''}${n.biasDb.toFixed(1)}`, A, w)
  })
}

/**
 * Faint tethers from each node up through the plot, in the columns' vocabulary.
 *
 * What the lane alone cannot say: WHICH resonance a node is aimed at. The lane
 * has the shape and the numbers; a hairline at the node's own frequency, run up
 * past the trace and the spectrum, ties it to the peak it is about — which is
 * the question actually being asked while a node is dragged.
 */
function drawTethers(ctx, w, axis, A) {
  props.nodes.forEach((n, i) => {
    const x = xFromHz(n.hz, axis)
    const x0 = xFromHz(n.hz * Math.pow(2, -n.spanOct / 2), axis)
    const x1 = xFromHz(n.hz * Math.pow(2, n.spanOct / 2), axis)
    const on = n.enabled !== false
    const sel = i === props.selected
    const ink = n.biasDb >= 0 ? A : '#ffb27a'
    if (sel && on) {
      const g = ctx.createLinearGradient(x0, 0, x1, 0)
      g.addColorStop(0, tint(ink, 0))
      g.addColorStop(0.5, tint(ink, 0.09))
      g.addColorStop(1, tint(ink, 0))
      ctx.fillStyle = g
      ctx.fillRect(x0, 0, x1 - x0, laneH.value)
    }
    ctx.strokeStyle = tint(ink, on ? (sel ? 0.4 : 0.2) : 0.1)
    ctx.lineWidth = 1
    ctx.setLineDash(sel ? [] : [2, 4])
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, 0)
    ctx.lineTo(Math.round(x) + 0.5, laneH.value - LANE_H)
    ctx.stroke()
    ctx.setLineDash([])
  })
}

function handle(ctx, x, y, selected, on, ink) {
  ctx.beginPath()
  ctx.arc(x, y, selected ? 5.5 : 4, 0, Math.PI * 2)
  if (!on) {
    ctx.strokeStyle = 'rgba(255,255,255,.32)'
    ctx.lineWidth = 1.2
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x - 4, y + 4)
    ctx.lineTo(x + 4, y - 4)
    ctx.stroke()
    return
  }
  if (selected) {
    ctx.fillStyle = bright(ink)
    ctx.shadowColor = tint(ink, 0.65)
    ctx.shadowBlur = 9
    ctx.fill()
    ctx.shadowBlur = 0
  } else {
    ctx.fillStyle = '#080a0d'
    ctx.fill()
    ctx.strokeStyle = tint(ink, 0.8)
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
}

function pill(ctx, x, y, text, ink, w) {
  ctx.font = "600 9px 'JetBrains Mono',monospace"
  const tw = ctx.measureText(text).width + 14
  const px = Math.max(2, Math.min(w - tw - 2, x - tw / 2))
  ctx.fillStyle = 'rgba(10,14,16,.86)'
  ctx.beginPath()
  const r = 5
  ctx.moveTo(px + r, y - 9)
  ctx.arcTo(px + tw, y - 9, px + tw, y + 9, r)
  ctx.arcTo(px + tw, y + 9, px, y + 9, r)
  ctx.arcTo(px, y + 9, px, y - 9, r)
  ctx.arcTo(px, y - 9, px + tw, y - 9, r)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = tint(ink, 0.4)
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = bright(ink)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, px + tw / 2, y)
  ctx.textAlign = 'left'
}

onMounted(() => { raf = requestAnimationFrame(draw) })
onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf) })
</script>

<template>
  <canvas
    ref="canvasEl"
    class="block w-full absolute pointer-events-none"
    :style="{ height: `${height}px`, left: '3px', top: '3px', right: '3px', width: 'calc(100% - 6px)' }"
  ></canvas>
</template>
