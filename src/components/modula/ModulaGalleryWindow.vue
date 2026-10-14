<script setup>
/**
 * MODULA KIT — every control-surface component on one page, live, for review
 * against docs/design/modula/Plugin_UI_Kit.dc.html.
 *
 * DEV ONLY: registered under DEV_TUNING_PANELS and stubbed out of production
 * builds by vite.config.js's DEV_ONLY_MODULES. The meters here are driven by a
 * wandering test signal, not audio.
 */
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import FloatingWindow from '../panels/FloatingWindow.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import ModulaKnob from './ModulaKnob.vue'
import ModulaFader from './ModulaFader.vue'
import ModulaFillSlider from './ModulaFillSlider.vue'
import ModulaSegmented from './ModulaSegmented.vue'
import ModulaSwitch from './ModulaSwitch.vue'
import ModulaLedPill from './ModulaLedPill.vue'
import ModulaPad from './ModulaPad.vue'
import ModulaSteps from './ModulaSteps.vue'
import ModulaDetent from './ModulaDetent.vue'
import ModulaButton from './ModulaButton.vue'
import ModulaBarMeter from './ModulaBarMeter.vue'
import ModulaMiniLadder from './ModulaMiniLadder.vue'
import ModulaVuTube from './ModulaVuTube.vue'
import ModulaCorrelation from './ModulaCorrelation.vue'
import ModulaHistory from './ModulaHistory.vue'
import ModulaScope from './ModulaScope.vue'
import { CONSOLE_TAPER, CONSOLE_MARKS } from './faderTaper.js'

defineProps({ z: { type: Number, default: 500 } })

const v = reactive({
  gain: 0, drive: 42, attack: 10, release: 300, tone: 1.5, mix: 80,
  thr: -18, pan: 0, freq: 1200, ratio: 4,
  fin: -6, fout: -12, xover: 400, step: 4, tile: 'spec',
  swA: true, swB: false, mute: false, solo: true, link: true, phase: false, loop: false,
  input: 0, sendA: -10, sendB: -20, output: -3, mixF: 1, tape: 'phat', speed: 'ips15', inTrim: 0, outTrim: 0,
  pill: true,
})
const dbFmt = x => `${x > 0.05 ? '+' : ''}${x.toFixed(1)} dB`
const fader = x => (x === -Infinity || x <= -80 ? '-∞ dB' : dbFmt(x))

// A wandering test signal for the meters.
const levels = ref([{ rmsDb: -20, peakDb: -12 }, { rmsDb: -22, peakDb: -14 }])
const gr = ref(-3)
const sat = ref(0.4)
const vuDb = ref(-10)
const corr = ref(0.4)
const hist = ref(Array.from({ length: 28 }, (_, i) => 0.3 + 0.25 * Math.sin(i / 2.2)))
const scopePos = ref(0.2)
const SCOPE = Array.from({ length: 180 }, (_, i) => {
  const t = i / 179
  const o = Math.max(0.06, Math.min(1, 0.18 + 0.72 * Math.abs(Math.sin(t * Math.PI * 4.3 + 0.4)) ** 0.55))
  const cut = (t > 0.13 && t < 0.22) || (t > 0.6 && t < 0.68)
  return { o, p: cut && o > 0.45 ? o * 0.74 : o }
})
let timer = null
onMounted(() => {
  timer = setInterval(() => {
    const w = x => x + (Math.random() - 0.48) * 4
    levels.value = levels.value.map(l => {
      const r = Math.max(-50, Math.min(-3, w(l.rmsDb)))
      return { rmsDb: r, peakDb: Math.min(0, r + 6 + Math.random() * 4) }
    })
    gr.value = Math.max(-12, Math.min(0, gr.value + (Math.random() - 0.5) * 2))
    sat.value = Math.max(0, Math.min(1, sat.value + (Math.random() - 0.5) * 0.12))
    vuDb.value = Math.max(-30, Math.min(2, vuDb.value + (Math.random() - 0.5) * 4))
    corr.value = Math.max(-1, Math.min(1, corr.value + (Math.random() - 0.5) * 0.1))
    hist.value = [...hist.value.slice(1), Math.random() * 0.4 + 0.3]
    scopePos.value = (scopePos.value + 0.004) % 1
  }, 110)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <FloatingWindow window-id="modula-kit" :z="z" :width="980" design="modula" brand-lead="MODULA KIT" :show-engage="false">
    <div class="kit">
      <section class="card wide">
        <h3>Large knobs · LED ring / tick ring</h3>
        <div class="row">
          <ModulaKnob v-model="v.gain" variant="led" :size="128" :min="-60" :max="12" :step="0.1" :default-value="0" color="var(--m-second)" :format-value="dbFmt" label="Gain" show-value />
          <ModulaKnob v-model="v.drive" variant="ticks" :size="118" :min="0" :max="100" :step="1" :default-value="42" :format-value="x => `${x}%`" label="Drive" show-value />
          <div class="col">
            <h3>Small knobs</h3>
            <div class="row">
              <ModulaKnob v-model="v.attack" :min="0.1" :max="200" scale="log" :default-value="10" :format-value="x => `${x.toFixed(1)} ms`" label="Attack" show-value />
              <ModulaKnob v-model="v.release" :min="10" :max="2000" scale="log" :default-value="300" :format-value="x => `${Math.round(x)} ms`" label="Release" show-value />
              <ModulaKnob v-model="v.tone" :min="-12" :max="12" :step="0.1" :default-value="0" color="var(--m-second)" :format-value="dbFmt" label="Tone" show-value />
              <ModulaKnob v-model="v.mix" :min="0" :max="100" :step="1" :default-value="100" color="var(--m-second)" :format-value="x => `${x}%`" label="Mix" show-value />
            </div>
          </div>
        </div>
      </section>

      <section class="card wide">
        <h3>Knobs · medium (arc + ticks)</h3>
        <div class="row">
          <ModulaKnob v-model="v.thr" variant="arc" :min="-48" :max="0" :step="0.1" :default-value="-18" :format-value="x => x.toFixed(1)" label="Threshold" note="UNIPOLAR" />
          <ModulaKnob v-model="v.pan" variant="arc" bipolar :min="-100" :max="100" :step="1" :default-value="0" color="var(--m-second)" :format-value="x => (x === 0 ? 'C' : (x < 0 ? 'L' : 'R') + Math.abs(x))" label="Pan" note="BIPOLAR" />
          <ModulaKnob v-model="v.freq" variant="arc" scale="log" :min="20" :max="20000" :default-value="1200" :format-value="x => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : Math.round(x))" label="Frequency" note="LOG" />
          <ModulaKnob v-model="v.ratio" variant="arc" :min="1" :max="10" :step="0.1" label="Ratio" note="DISABLED" disabled />
        </div>
      </section>

      <section class="card">
        <h3>Sliders</h3>
        <div class="row" style="align-items:flex-end">
          <ModulaFillSlider v-model="v.fin" :min="-60" :max="12" :step="0.1" :default-value="0" :format-value="dbFmt" label="In" />
          <ModulaFillSlider v-model="v.fout" :min="-60" :max="12" :step="0.1" :default-value="0" color="var(--m-second)" :format-value="dbFmt" label="Out" />
          <div class="col" style="flex:1;gap:24px">
            <ModulaFillSlider v-model="v.xover" orientation="horizontal" :length="260" scale="log" :min="20" :max="20000" :default-value="400" :format-value="x => (x >= 1000 ? `${(x / 1000).toFixed(2)} kHz` : `${Math.round(x)} Hz`)" label="Crossover" :ends="['20 Hz', '20 kHz']" />
            <div class="col"><h3>Stepped / detent</h3><ModulaSteps v-model="v.step" :count="8" aria-label="Steps" /></div>
          </div>
        </div>
      </section>

      <section class="card">
        <h3>Switches</h3>
        <div class="col" style="gap:22px">
          <div class="row">
            <ModulaSwitch v-model="v.swA" label="Sidechain" />
            <ModulaSwitch v-model="v.swB" label="Oversample" color="var(--m-second)" />
          </div>
          <ModulaSegmented v-model="v.tile" variant="tile" :options="[{ value: 'grid', label: 'GRID' }, { value: 'wave', label: 'WAVE' }, { value: 'spec', label: 'SPEC' }, { value: 'clip', label: 'CLIP' }]" />
          <div class="row">
            <ModulaPad v-model="v.mute" label="Mute" color="var(--m-hot)" />
            <ModulaPad v-model="v.solo" label="Solo" />
            <ModulaPad v-model="v.link" label="Link" color="var(--m-second)" />
            <ModulaPad v-model="v.phase" label="Phase" color="#9b8cff" />
          </div>
          <div class="row">
            <ModulaSegmented v-model="v.tape" :options="[{ value: 'clean', label: 'CLEAN' }, { value: 'phat', label: 'PHAT' }]" />
            <ModulaLedPill v-model="v.pill" label="BAND SPLIT" />
            <ModulaDetent v-model="v.speed" :options="[{ value: 'ips7', label: '7.5' }, { value: 'ips15', label: '15' }, { value: 'ips30', label: '30' }]" label="Tape speed (IPS)" />
          </div>
        </div>
      </section>

      <section class="card wide">
        <h3>Meters</h3>
        <div class="row" style="align-items:flex-end;gap:40px">
          <div class="row" style="gap:28px;align-items:flex-start">
            <LevelMeter variant="modula" scale-side="left" :levels="levels" label="IN" :height="168">
              <template #below><ModulaKnob v-model="v.inTrim" variant="trim" :min="-12" :max="12" :step="0.1" :default-value="0" :format-value="dbFmt" show-value aria-label="In trim" /></template>
            </LevelMeter>
            <LevelMeter variant="modula" scale-side="right" :levels="levels" label="OUT" :height="168">
              <template #below><ModulaKnob v-model="v.outTrim" variant="trim" :min="-12" :max="12" :step="0.1" :default-value="0" :format-value="dbFmt" show-value aria-label="Out trim" /></template>
            </LevelMeter>
          </div>
          <ModulaVuTube :db="vuDb" caption="Program level" />
          <div class="col" style="flex:1;min-width:240px;gap:26px">
            <GainReductionBar :reduction-db="gr" accent="#e8a33d" />
            <ModulaCorrelation :value="corr" />
            <ModulaHistory :values="hist" />
          </div>
        </div>
        <div class="row" style="margin-top:22px;align-items:flex-end">
          <div style="flex:1"><ModulaBarMeter title="SATURATION" :value="sat" :reading="`${Math.round(sat * 100)}%`" /></div>
          <ModulaMiniLadder :values="[sat, sat * 0.9]" reading="+2.4 dB" label="LIFT" />
        </div>
      </section>

      <section class="card wide">
        <h3>Console faders · double-click for unity</h3>
        <div class="row" style="align-items:flex-end;gap:34px">
          <ModulaFader v-model="v.input" :taper="CONSOLE_TAPER" :min="-80" :max="6" :length="320" :thickness="52" :marks="CONSOLE_MARKS.map(d => ({ value: d, label: d > 0 ? `+${d}` : String(d) }))" :unity="0" :default-value="0" :format-value="fader" label="Input" />
          <ModulaFader v-model="v.sendA" :taper="CONSOLE_TAPER" :min="-80" :max="6" :length="320" :default-value="0" :format-value="fader" label="Send A" />
          <ModulaFader v-model="v.sendB" :taper="CONSOLE_TAPER" :min="-80" :max="6" :length="320" :default-value="0" :format-value="fader" label="Send B" />
          <ModulaFader v-model="v.output" :taper="CONSOLE_TAPER" :min="-80" :max="6" :length="320" :marks="CONSOLE_MARKS.map(d => ({ value: d, label: d > 0 ? `+${d}` : String(d) }))" :unity="0" :default-value="0" :format-value="fader" label="Output" />
        </div>
        <div class="row" style="margin-top:24px;padding-top:22px;border-top:1px solid rgba(0,0,0,.45)">
          <span class="m-caption">Mix</span>
          <ModulaFader v-model="v.mixF" orientation="horizontal" :length="320" :min="0" :max="1" :step="0.01" :default-value="1" readout="end" :format-value="x => `${Math.round(x * 100)}%`" aria-label="Mix" />
        </div>
      </section>

      <section class="card wide">
        <h3>Buttons · medium</h3>
        <div class="row">
          <ModulaButton variant="primary">✓ Apply</ModulaButton>
          <ModulaButton variant="accent">Render</ModulaButton>
          <ModulaButton variant="secondary">▶ Preview</ModulaButton>
          <ModulaButton variant="ghost">Cancel</ModulaButton>
          <ModulaButton v-model="v.loop" variant="toggle">Loop</ModulaButton>
          <ModulaButton variant="primary" disabled>Apply</ModulaButton>
        </div>
      </section>

      <section class="card wide">
        <h3>Waveform scope · click or drag to scrub</h3>
        <ModulaScope v-model:position="scopePos" :bars="SCOPE" />
      </section>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.kit { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; padding: 6px; }
.card {
  min-width: 0;
  padding: 22px;
  border-radius: 20px;
  background: linear-gradient(180deg, #34383f, #292c31);
  box-shadow: 0 30px 50px -28px rgba(0, 0, 0, .95), inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .55);
}
.wide { grid-column: 1 / -1; }
h3 { margin: 0 0 20px; font: 600 11px/1 var(--m-font-ui); letter-spacing: .14em; text-transform: uppercase; color: #aeb6bd; }
.col h3 { margin-bottom: 14px; }
.row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 26px; }
.col { display: flex; flex-direction: column; }
</style>
