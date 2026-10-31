/**
 * Synthetic narration for the VoxPressor tests: phrases of syllables (a
 * harmonic voice with a formant-ish tilt, onsets and decays), pauses between
 * phrases, optional plosive thumps at word starts and sibilant noise bursts.
 *
 * Deterministic (seeded PRNG) so every test sees the same material. Not a
 * voice — a stand-in with the properties the detector and the solves care
 * about: a crest factor in speech's range, level that moves syllable to
 * syllable and phrase to phrase, low-frequency bursts that are LOUDER than the
 * vowels around them, and energy above 5 kHz that is not voiced.
 */
export function narration(sampleRate, {
  seconds = 8, f0 = 120, levelDb = -20, plosives = true, sibilants = true, seed = 1,
} = {}) {
  let s = seed >>> 0
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  const n = Math.round(seconds * sampleRate)
  const x = new Float32Array(n)
  // Plosives and sibilants go in their own buffer and are left out of the
  // level scaling, so switching them on adds them to the SAME voice.
  const ev = new Float32Array(n)
  const harmonics = []
  for (let k = 1; k * f0 < Math.min(5000, sampleRate / 2.2); k++) {
    const f = k * f0
    // A formant-ish envelope: peaks near 500 Hz and 1.5 kHz, falling above.
    const g = 1 / (1 + ((f - 500) / 350) ** 2) + 0.5 / (1 + ((f - 1500) / 500) ** 2) + 0.05
    harmonics.push({ k, g, ph: rand() * 2 * Math.PI })
  }
  let t = 0.05
  while (t < seconds - 0.5) {
    const phraseLen = 1.2 + rand() * 1.4
    const phraseEnd = Math.min(seconds - 0.3, t + phraseLen)
    const phraseGain = 0.6 + rand() * 0.8
    while (t < phraseEnd) {
      const syl = 0.12 + rand() * 0.14
      const start = Math.round(t * sampleRate)
      const len = Math.round(syl * sampleRate)
      const sylGain = phraseGain * (0.4 + rand() * 0.9)
      const vib = 1 + (rand() - 0.5) * 0.1
      for (let i = 0; i < len && start + i < n; i++) {
        const tt = i / sampleRate
        const env = Math.min(1, tt / 0.012) * Math.exp(-3 * tt / syl)
        let v = 0
        for (const h of harmonics) v += h.g * Math.sin(2 * Math.PI * h.k * f0 * vib * tt + h.ph)
        x[start + i] += sylGain * env * v
      }
      // The random draws happen whether or not the event is rendered, so the
      // switches change ONLY the plosives / sibilants and leave every syllable
      // where it was — the with/without comparison depends on it.
      const pDraw = rand()
      const pF = 60 + rand() * 50
      if (plosives && pDraw < 0.12) {
        // A "p": a 60-110 Hz pop of ~30 ms, louder than the vowel it starts.
        const f = pF
        const amp = 2.5 * sylGain
        for (let i = 0; i < Math.round(0.1 * sampleRate) && start + i < n; i++) {
          const tt = i / sampleRate
          ev[start + i] += amp * Math.exp(-tt / 0.03) * Math.sin(2 * Math.PI * f * tt)
        }
      }
      const sDraw = rand()
      const sLenS = 0.08 + rand() * 0.06
      if (sibilants && sDraw < 0.15) {
        // An "s": high-passed noise after the syllable, from its own generator
        // so its length does not shift the syllables that follow.
        let ns = (start * 2654435761) >>> 0
        const nrand = () => {
          ns = (ns * 1664525 + 1013904223) >>> 0
          return ns / 4294967296
        }
        let prev = 0
        const sStart = start + len
        const sLen = Math.round(sLenS * sampleRate)
        for (let i = 0; i < sLen && sStart + i < n; i++) {
          const w = nrand() * 2 - 1
          const hp = w - prev
          prev = w
          const env = Math.sin(Math.PI * i / sLen)
          ev[sStart + i] += 0.9 * sylGain * env * hp
        }
      }
      t += syl + 0.02 + rand() * 0.05
    }
    t = phraseEnd + 0.25 + rand() * 0.5
  }
  // Scale to the requested gated level: RMS of the voice's non-silent 50 ms
  // blocks (events excluded, see `ev`).
  const W = Math.round(0.05 * sampleRate)
  let sum = 0
  let cnt = 0
  for (let o = 0; o + W <= n; o += W) {
    let e = 0
    for (let i = 0; i < W; i++) e += x[o + i] * x[o + i]
    if (e / W > 1e-6) { sum += e; cnt += W }
  }
  const g = Math.pow(10, levelDb / 20) / Math.sqrt(sum / Math.max(1, cnt))
  for (let i = 0; i < n; i++) x[i] = (x[i] + ev[i]) * g
  return x
}
