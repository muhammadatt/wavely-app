/**
 * MOCKUP HARNESS — the three in-display focus treatments, side by side.
 *
 * Run it with `npx vite` and open /mockups/focus.html. Nothing here is imported
 * by the app; it exists so the treatments can be judged as pictures against the
 * REAL plot with plausible curves in it.
 */
import '../src/assets/main.css'
import { createApp, h, ref, computed } from 'vue'
import ResonanceSpectrum from '../src/components/meters/ResonanceSpectrum.vue'
import FocusOverlay from './FocusOverlay.vue'
import { makeFrame } from './focusFrame.js'
import { focusThresholdFn, RESONANCE_FOCUS_GLOBAL } from '../src/audio/resonanceFocus.js'

const ACCENT = '#8de0a8'
const H = 280

// A worked patch: one band held back, two worked harder, one bypassed.
const nodes = ref([
  { id: 'a', hz: 205, spanOct: 0.8, biasDb: -9, enabled: true },
  { id: 'b', hz: 1150, spanOct: 1.3, biasDb: 6, enabled: true },
  { id: 'c', hz: 3180, spanOct: 0.5, biasDb: 13, enabled: true },
  { id: 'd', hz: 7000, spanOct: 2.0, biasDb: -5, enabled: false },
])
const selected = ref(2)
const focus = computed(() => ({ global: { ...RESONANCE_FOCUS_GLOBAL }, nodes: nodes.value }))
const frame = computed(() => makeFrame(focus.value))
const thresholdFn = computed(() => focusThresholdFn(focus.value))

const OVERLAYS = { removed: true, spectrum: true, found: true, grid: false, history: false }

const card = (title, note, treatment, plotH = H) => h('div', {
  style: {
    width: '740px', background: '#141618', borderRadius: '16px',
    boxShadow: '0 0 0 1px rgba(255,255,255,.07)', marginBottom: '26px',
  },
}, [
  h('div', {
    style: {
      padding: '11px 26px 9px', borderBottom: '1px solid rgba(255,255,255,.06)',
    },
  }, [
    h('div', {
      style: {
        font: "700 9.5px 'JetBrains Mono',monospace", letterSpacing: '.14em', color: ACCENT,
      },
    }, title),
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
        height: plotH,
        zones: [],
        selectedZone: -1,
        deltaZone: -1,
        overlays: OVERLAYS,
      }),
      h(FocusOverlay, {
        treatment, nodes: nodes.value, selected: selected.value, height: plotH, accent: ACCENT,
      }),
    ]),
  ]),
])

createApp({
  render: () => h('div', { style: { padding: '24px' } }, [
    h('div', {
      style: {
        font: "600 11px 'JetBrains Mono',monospace", letterSpacing: '.1em',
        color: 'rgba(255,255,255,.5)', marginBottom: '18px', width: '740px', lineHeight: '1.7',
      },
    }, 'FOUR FOCUS NODES: 205 Hz −9 (held back) · 1.15k +6 · 3.18k +13 (selected) · 7k −5 (bypassed)'),
    card('A · INSET LANE', 'The rail moved inside the plate, own window, own zero. Honest about the scale — and takes a fourth reserved row from a plot whose own source says there is no free row — so the plot is 46 px taller here, which is what reserving it costs.', 'lane', H + 46),
    card('B · COLUMNS', 'A node is a band across the plot: position and width are spatial, amount is tint depth plus a number. Costs no row, re-uses the zone vocabulary — but you cannot see the shape of the bias.', 'columns'),
    card('D · LANE + TETHERS  (the combination)', 'A, plus a hairline from each node up through the plot to the peak it is aimed at, and the selected node\'s three numbers on the node itself — which is what removes the 44 px plate row as well as the rail.', 'both', H + 46),
    card('C · BOWED RAIL', 'The 0 dB rail itself carries the bias, bowing down where you asked for more work. Costs no new space and is literally the model: the threshold is the datum reduction hangs from. (Trace not re-hung in this mockup.)', 'rail'),
  ]),
}).mount('#app')
