import { readFileSync } from 'node:fs'
const R = new URL('../src/audio/', import.meta.url).href
const { toKernelParams, PHATASS_DEFAULTS, WARMTH_LAYERS } = await import(R + 'phatassParams.js')
const { processSaturationBenchBuffer } = await import(R + 'dsp/saturationLayers.js')
const OS = await import(R + 'dsp/oversample.js')
const { measureBandSpectrum, bandRefPeakDb } = await import(R + 'saturationBenchAnalysis.js')
const SR = 44100
const load = p => { const b = readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.length / 4) }
// node scripts/phatass-warmth-oversample.mjs <dir of mono f32le 44.1 kHz clips: the three named below>
const D = process.argv[2]
const files = {
  'bright narration': load(D + '/617c795d-Messy_and_Bright_-_Clip.wav.f32'),
  'narration B': load(D + '/776c9139-art_test_clip_orig.wav.f32'),
  drums: load(D + '/730ad75b-AllTape_Drums_dry_v1.m4a.f32'),
}
const variants = [['1x', false], ['2x', OS.COMPRESSOR_OVERSAMPLE_2X], ['4x', true], ['8x', OS.COMPRESSOR_OVERSAMPLE_8X]]
const db = v => 10 * Math.log10(v)
for (const [fname, x] of Object.entries(files)) {
  const T = x.length / SR
  const seg = [{ outputStart: 0, sourceStart: 0, sourceEnd: T, sourceBuffer: { numberOfChannels: 1, getChannelData: () => x } }]
  const spec = measureBandSpectrum(seg, 0, T, SR, 1)
  const refs = WARMTH_LAYERS.map(l => bandRefPeakDb(spec, l.loHz, l.hiHz))
  for (const warmth of [5, 10]) {
    const layers = toKernelParams({ ...PHATASS_DEFAULTS, warmth, oddEven: 50, warmthRefPeaksDb: refs }).warmthLayers
    for (const li of [2, 3]) {
      const layer = layers[li]
      const adds = {}, times = {}
      for (const [name, os] of variants) {
        const pad = new Float32Array(x.length + 4096); pad.set(x)
        const t = performance.now()
        const r = processSaturationBenchBuffer([pad], SR, { layers: [layer] }, { slots: 1, oversample: [os] })
        times[name] = (performance.now() - t) * 10 / T
        const L = r.latencySamples
        const y = r.channelData[0]
        const a = new Float64Array(x.length)
        for (let i = 0; i < x.length; i++) a[i] = y[i + L] - x[i]
        adds[name] = a
      }
      const ref = adds['8x']
      let er = 0, ex = 0
      for (let i = 0; i < x.length; i++) { er += ref[i] * ref[i]; ex += x[i] * x[i] }
      const row = variants.filter(([n]) => n !== '8x').map(([n]) => {
        let e = 0; const a = adds[n]; for (let i = 0; i < x.length; i++) e += (a[i] - ref[i]) ** 2
        return `${n} ${db(e / er).toFixed(1)} (${db(e / ex).toFixed(1)})`
      })
      console.log(`${fname.padEnd(17)} W${warmth} layer ${li === 2 ? 'full-band quartic' : '3k+ tanh        '} | added ${db(er / ex).toFixed(1)} dB re signal | err vs 8x, re added (re signal): ${row.join(' | ')} | ms/10s ${variants.map(([n]) => n + ' ' + times[n].toFixed(0)).join(' ')}`)
    }
  }
}
