/**
 * The one gesture every Modula control shares.
 *
 * Drag along one axis (vertical for knobs and faders, horizontal for the Mix
 * strip), Shift for a fine drag, the wheel for a notch, arrow keys / Page /
 * Home / End from the keyboard, and double-click back to the default — the
 * kit's own "DRAG · DOUBLE-CLICK FOR UNITY". Travel is worked in fraction of
 * range, not in value, so a log control moves under the pointer at the same
 * rate everywhere on its range (the existing Knob's rule; `knobGeometry.js`).
 *
 * Pointer capture rather than window listeners: the gesture survives the
 * pointer leaving the control, and nothing has to be torn down if the
 * component unmounts mid-drag.
 */
import { computed, ref } from 'vue'
import { clamp01, valueToPct, pctToValue } from '../knobs/knobGeometry.js'

const FINE = 0.2

/**
 * @param {object} props  reactive props: modelValue, min, max, step, scale,
 *   quantize, disabled, defaultValue
 * @param {(v:number)=>void} emitValue
 * @param {{ axis?: 'x'|'y', travelPx?: number | (() => number) }} [opts]
 */
export function useModulaDrag(props, emitValue, { axis = 'y', travelPx = 160 } = {}) {
  const dragging = ref(false)
  let start = 0
  let startPct = 0

  // A control may bring its own taper (the console fader's dB law); otherwise
  // the linear / log mapping the existing knobs use.
  const toPct = v => (props.taper ? props.taper.toPct(v) : valueToPct(v, props.min, props.max, props.scale ?? 'linear'))
  const fromPct = p => (props.taper ? props.taper.fromPct(p) : pctToValue(p, props.min, props.max, props.scale ?? 'linear'))
  const pct = computed(() => clamp01(toPct(props.modelValue)))

  function quantize(v) {
    const c = Math.max(props.min, Math.min(props.max, v))
    if (props.quantize) return props.quantize(c)
    const step = props.step
    if (!(step > 0)) return c
    const s = Math.round((c - props.min) / step) * step + props.min
    // Strip float dust (0.30000000000000004) so readouts and presets compare.
    return Math.max(props.min, Math.min(props.max, Number(s.toFixed(6))))
  }

  function setPct(p) {
    const v = quantize(fromPct(clamp01(p)))
    if (v !== props.modelValue) emitValue(v)
  }

  const travel = () => (typeof travelPx === 'function' ? travelPx() : travelPx)

  function onPointerDown(e) {
    if (props.disabled || e.button > 0) return
    e.preventDefault()
    dragging.value = true
    start = axis === 'y' ? e.clientY : e.clientX
    startPct = pct.value
    e.currentTarget.focus?.({ preventScroll: true })
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  function onPointerMove(e) {
    if (!dragging.value) return
    // Fine drag re-anchors so pressing Shift mid-gesture never jumps the value.
    const cur = axis === 'y' ? e.clientY : e.clientX
    const d = (axis === 'y' ? start - cur : cur - start) / Math.max(1, travel())
    setPct(startPct + d * (e.shiftKey ? FINE : 1))
  }

  function onPointerUp(e) {
    if (!dragging.value) return
    dragging.value = false
    try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch { /* not captured */ }
  }

  /** One notch of travel: the step for a linear control, 1 % for a log one. */
  const notch = computed(() => {
    const span = props.max - props.min
    if ((props.scale ?? 'linear') === 'log' || !(props.step > 0)) return 0.01
    return Math.max(props.step / span, 0.002)
  })

  function onWheel(e) {
    if (props.disabled) return
    e.preventDefault()
    setPct(pct.value + (e.deltaY < 0 ? 1 : -1) * notch.value * (e.shiftKey ? 1 : 2))
  }

  function onKeydown(e) {
    if (props.disabled) return
    const big = 0.1
    const map = {
      ArrowUp: notch.value, ArrowRight: notch.value,
      ArrowDown: -notch.value, ArrowLeft: -notch.value,
      PageUp: big, PageDown: -big,
    }
    if (e.key in map) {
      e.preventDefault()
      setPct(pct.value + map[e.key])
    } else if (e.key === 'Home') {
      e.preventDefault()
      setPct(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setPct(1)
    }
  }

  function reset() {
    if (props.disabled || props.defaultValue == null) return
    emitValue(quantize(props.defaultValue))
  }

  // Bare event names: this is spread with `v-on="handlers"`.
  const handlers = {
    pointerdown: onPointerDown,
    pointermove: onPointerMove,
    pointerup: onPointerUp,
    pointercancel: onPointerUp,
    wheel: onWheel,
    keydown: onKeydown,
    dblclick: reset,
  }

  return { dragging, pct, handlers, reset, setPct }
}

/** The shared props every dragged Modula control takes. */
export const DRAG_PROPS = {
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 1 },
  step: { type: Number, default: 0 },
  /** 'linear' | 'log' (log needs a positive min). */
  scale: { type: String, default: 'linear' },
  quantize: { type: Function, default: null },
  /** `{ toPct(v), fromPct(p) }` — a custom travel law; overrides `scale`. */
  taper: { type: Object, default: null },
  /** Double-click returns here; null disables the reset. */
  defaultValue: { type: Number, default: null },
  disabled: { type: Boolean, default: false },
  formatValue: { type: Function, default: v => String(Math.round(v * 10) / 10) },
  /** Accessible name; falls back to `label`. */
  ariaLabel: { type: String, default: '' },
}
