/**
 * MOCKUP HARNESS — the focus targeting nodes drawn INSIDE the display.
 *
 * `npx vite`, then /mockups/focus.html. Nothing here is imported by the app.
 *
 * ⚠ IT ANIMATES, deliberately. A still frame cannot answer the only question
 * that decides this design — how far the threshold line TRAVELS — and the whole
 * reason the earlier Gaussian-node attempt was abandoned was motion that a
 * screenshot cannot show. Watch the bottom card.
 */
import '../src/assets/main.css'
import { createApp, h, ref, computed, onMounted } from 'vue'
import ResonanceSpectrum from '../src/components/meters/ResonanceSpectrum.vue'
import FocusOverlay from './FocusOverlay.vue'
import { makeFrame } from './focusFrame.js'
import { focusThresholdFn, RESONANCE_FOCUS_GLOBAL } from '../src/audio/resonanceFocus.js'

const ACCENT = '#8de0a8'
const H = 280

const nodes = ref([
  { id: 'a', hz: 205, spanOct: 0.8, biasDb: -9, enabled: true },
  { id: 'b', hz: 1150, spanOct: 1.3, biasDb: 6, enabled: true },
  { id: 'c', hz: 3180, spanOct: 0.5, biasDb: 13, enabled: true },
  { id: 'd', hz: 7000, spanOct: 2.0, biasDb: -5, enabled: false },
])
const selected = ref(2)
const playing = ref(true)
const clock = ref(0)

const focus = computed(() => ({ global: { ...RESONANCE_FOCUS_GLOBAL }, nodes: nodes.value }))
const frame = computed(() => makeFrame(focus.value, 192, clock.value))
const thresholdFn = computed(() => focusThresholdFn(focus.value))

const OVERLAYS = { removed: true, spectrum: true, found: true, grid: false, history: false }

const card = (title, note, treatment) => h('div', {
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
    h('div', { style: { position: 'relative' } }, [
      h(ResonanceSpectrum, {
        dataFn: () => frame.value,
        selectivityFn: thresholdFn.value,
        reductionDb: -3.4,
        accent: ACCENT,
        height: H,
        zones: [],
        selectedZone: -1,
        deltaZone: -1,
        overlays: OVERLAYS,
      }),
      h(FocusOverlay, {
        treatment,
        nodes: nodes.value,
        selected: selected.value,
        frame: frame.value,
        globalThresholdDb: RESONANCE_FOCUS_GLOBAL.selectivity,
        height: H,
        accent: ACCENT,
      }),
    ]),
  ]),
])

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
            color: 'rgba(255,255,255,.5)', lineHeight: '1.7',
          },
        }, 'NODES: 205 Hz −9 · 1.15k +6 · 3.18k +13 (selected) · 7k −5 (bypassed)'),
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
      card('C4 · LOBES — drawn only where it departs from neutral',
        'The same curve, broken at 0.3 dB the way the reduction trace already is. A bias is flat almost everywhere, so drawn edge to edge it paints a full-width horizontal line — and a full-width horizontal line is a rail whatever it is called. What is left is a lobe per node, on the material it is aimed at.', 'lobes'),
      card('C1 · OVER THE SPECTRUM, MID DATUM',
        'One curve over the material, bowing down where you asked for more cut. No rail, no reserved band, no second picture. Its datum is fixed, so nothing here moves unless a knob does.', 'over-mid'),
      card('C2 · OVER THE SPECTRUM, HIGH DATUM',
        'The same curve sitting where the threshold usually sits — above the peaks — so it reads as the decision boundary rather than as an annotation floating in the middle of the material.', 'over-top'),
      card('C3 · ON THE LIVE THRESHOLD  (the naive reading — watch it move)',
        'Handles on the actual threshold staircase, which is the line a node really biases. Measured on this probe: the line at 3.18k travels 43 px in two seconds and up to 7 px between frames, on a band 139 px tall. Press STOPPED to see why it looks fine in a screenshot.', 'over-live'),
      card('REFERENCE · BOWED RAIL AT THE TOP',
        'The earlier C, for orientation — same idea, wrong place: it bows the 0 dB reduction rail, which is not the threshold, and it fights the reduction trace.', 'rail'),
    ])
  },
}

createApp(App).mount('#app')
