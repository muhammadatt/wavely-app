/**
 * HARNESS — the focus targeting model in the REAL plot, driven by a synthetic
 * frame. `npx vite`, then /mockups/focus.html.
 *
 * It was three overlay mockups while the treatment was being chosen; now that
 * the curve lives in ResonanceSpectrum itself, it renders the shipping
 * components and the nodes are genuinely draggable. Nothing here is imported by
 * the app.
 *
 * ⚠ IT ANIMATES. A still frame cannot show the one thing that decided this
 * design — how far the threshold line travels — and it is the reason the
 * focus curve hangs off a static datum rather than off the threshold itself.
 * Press STOPPED and watch the dotted staircase against the solid focus curve.
 */
import '../src/assets/main.css'
import { createApp, h, ref, computed, onMounted } from 'vue'
import ResonanceSpectrum from '../src/components/meters/ResonanceSpectrum.vue'
import ResonanceFocusControls from '../src/components/panels/ResonanceFocusControls.vue'
import Knob from '../src/components/knobs/Knob.vue'
import { makeFrame } from './focusFrame.js'
import { focusThresholdFn, RESONANCE_FOCUS_GLOBAL } from '../src/audio/resonanceFocus.js'

const ACCENT = '#8de0a8'
const H = 280

const focus = ref({
  global: { ...RESONANCE_FOCUS_GLOBAL, protect: true },
  nodes: [
    { id: 'a', hz: 205, spanOct: 0.8, biasDb: -9, enabled: true },
    { id: 'b', hz: 1150, spanOct: 1.3, biasDb: 6, enabled: true },
    { id: 'c', hz: 3180, spanOct: 0.5, biasDb: 13, enabled: true },
    { id: 'd', hz: 7000, spanOct: 2.0, biasDb: -5, enabled: false },
  ],
})
const empty = ref({ global: { ...RESONANCE_FOCUS_GLOBAL }, nodes: [] })
const selected = ref(2)
const emptySel = ref(-1)
const playing = ref(true)
const clock = ref(0)

const OVERLAYS = { removed: true, spectrum: true, found: true, grid: false, history: false }

function panel(title, note, patch, sel) {
  const thresholdFn = focusThresholdFn(patch.value)
  const frame = makeFrame(patch.value, 192, clock.value)
  return h('div', {
    style: {
      width: '740px', background: '#141618', borderRadius: '16px',
      boxShadow: '0 0 0 1px rgba(255,255,255,.07)', marginBottom: '26px',
    },
  }, [
    h('div', { style: { padding: '11px 26px 9px', borderBottom: '1px solid rgba(255,255,255,.06)' } }, [
      h('div', { style: { font: "700 9.5px 'JetBrains Mono',monospace", letterSpacing: '.14em', color: ACCENT } }, title),
      h('div', {
        style: {
          font: "500 9.5px 'JetBrains Mono',monospace", color: 'rgba(255,255,255,.42)',
          marginTop: '4px', lineHeight: '1.5',
        },
      }, note),
    ]),
    h('div', { class: 'px-[26px] pt-[16px] pb-[18px]' }, [
      h(ResonanceSpectrum, {
        dataFn: () => frame,
        selectivityFn: thresholdFn,
        focusNodes: patch.value.nodes,
        selectedFocusNode: sel.value,
        reductionDb: -3.4,
        accent: ACCENT,
        height: H,
        zones: [],
        selectedZone: -1,
        deltaZone: -1,
        overlays: OVERLAYS,
        'onUpdate:focusNodes': v => { patch.value = { ...patch.value, nodes: v } },
        'onUpdate:selectedFocusNode': v => { sel.value = v },
      }),
      h('div', { class: 'flex items-center gap-[10px] mt-[11px]' }, [
        h('div', { class: 'w-[60px] shrink-0' }, h(Knob, {
          modelValue: 300, min: 12, max: 400, step: 5, valueFontPx: 11,
          label: 'Attack', accent: ACCENT, formatValue: v => `${Math.round(v)}ms`,
        })),
        h('div', { class: 'w-[60px] shrink-0' }, h(Knob, {
          modelValue: 1500, min: 25, max: 2000, step: 10, valueFontPx: 11,
          label: 'Release', accent: ACCENT, formatValue: v => `${Math.round(v)}ms`,
        })),
        h('div', { class: 'flex-1 min-w-0' }, h(ResonanceFocusControls, {
          focus: patch.value, accent: ACCENT, pitchRangeCaption: '70–400 Hz',
          'onUpdate:focus': v => { patch.value = v },
        })),
        h('div', { class: 'w-[60px] shrink-0' }, h(Knob, {
          modelValue: 1, min: 0, max: 1, step: 0.01, valueFontPx: 11,
          label: 'Mix', accent: ACCENT, formatValue: v => `${Math.round(v * 100)}%`,
        })),
        h('div', { class: 'w-[60px] shrink-0' }, h(Knob, {
          modelValue: 0, min: -12, max: 12, step: 0.5, valueFontPx: 11, bipolar: true,
          label: 'Trim', accent: ACCENT, formatValue: v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`,
        })),
      ]),
    ]),
  ])
}

const App = {
  setup() {
    onMounted(() => {
      let t0 = performance.now()
      const tick = (now) => {
        if (playing.value) clock.value += (now - t0) / 1000
        t0 = now
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return () => h('div', { style: { padding: '24px' } }, [
      h('div', {
        style: {
          width: '740px', marginBottom: '18px', display: 'flex',
          alignItems: 'center', justifyContent: 'space-between', gap: '16px',
        },
      }, [
        h('div', {
          style: {
            font: "600 10.5px 'JetBrains Mono',monospace", letterSpacing: '.1em',
            color: 'rgba(255,255,255,.5)',
          },
        }, 'DRAG A HANDLE · WHEEL FOR WIDTH · DOUBLE-CLICK TO ADD OR REMOVE'),
        h('button', {
          style: {
            font: "700 9px 'JetBrains Mono',monospace", letterSpacing: '.12em',
            padding: '6px 12px', borderRadius: '999px', cursor: 'pointer',
            color: playing.value ? '#0d0f12' : ACCENT,
            background: playing.value ? ACCENT : 'rgba(255,255,255,.04)',
            border: `1px solid ${ACCENT}66`,
          },
          onClick: () => { playing.value = !playing.value },
        }, playing.value ? 'PLAYING' : 'STOPPED'),
      ]),
      panel('WORKED PATCH', 'Four nodes: 205 Hz −9 held back, 1.15k +6, 3.18k +13 selected, 7k −5 bypassed. One line, edge to edge, on a datum that does not move.', focus, selected),
      panel('EMPTY DEFAULT', 'No nodes. The line sits flat on its datum and the detector runs at its global setting everywhere — an offset with a true zero, so an untouched patch is visibly untouched.', empty, emptySel),
    ])
  },
}

createApp(App).mount('#app')
