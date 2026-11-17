export default {
  eyebrow: 'Dynamic resonance suppressor',
  headline: 'Smooth away harsh, ringing frequencies — automatically.',
  pitch: [
    'Nasal honks, boxy tones and harsh edges turned down only while they ring, so the voice comes out smooth, balanced and natural.',
  ],
  description: 'Dynamic resonance suppression in your browser: smooth out harsh, nasal and boxy frequencies only while they ring, and keep the voice natural. Free.',
  overviewTitle: 'Smooth, balanced, natural',
  overview: [
    'Some voices and rooms have a note that rings: a nasal honk, a boxy tone, a harsh edge that appears on certain words. An EQ cut fixes those words and hollows out the rest. Dynamic resonance suppression finds the ringing frequencies and turns each down only while it rings, so the voice sounds smooth, balanced and natural.',
    'Reso Tame does it frequency by frequency in real time and shows every cut as it happens. Threshold and Depth set how much, Sharp sets how narrowly it works, and Mix blends the original back for a subtler touch.',
  ],
  features: [
    { title: 'Smooth, balanced voice', text: 'harsh edges gone, character kept' },
    { title: 'Harshness tamed', text: 'piercing notes turned down only while they ring' },
    { title: 'Nasal and boxy tones', text: 'room and voice resonances smoothed out' },
    { title: 'Nothing hollowed out', text: 'no fixed cut dulling the words that were fine' },
    { title: 'Frequency by frequency', text: 'every resonance handled on its own' },
    { title: 'See every cut', text: 'a live display of what it is doing' },
    { title: 'Focus', text: 'aim it at the region that needs help' },
    { title: 'Sharp and depth', text: 'from broad and gentle to narrow and firm' },
    { title: 'Attack and release', text: 'quick and precise or smooth and slow' },
    { title: 'Mix and delta', text: 'blend it in, or hear only what it removes' },
    { title: 'Free in your browser', text: 'no plugin to buy, no DAW, nothing to install' },
  ],
  samples: [
    {
      id: 'voice',
      title: 'Harsh, ringing voice',
      text: 'The harsh and nasal moments smooth out; the voice keeps its tone everywhere else.',
      settings: {
        focus: {
          global: { depth: 1, sharpness: 0.8, selectivity: 20, maxCut: 36, protect: false, protectCeilHz: 5000 },
          nodes: [{ id: 'n1', shape: 'bell', hz: 2600, spanOct: 1, biasDb: 6, enabled: true }],
        },
      },
      setting: 'One Focus node: Bell at 2.6 kHz, Amount +6 dB, Width 1 oct; everything else at default',
      brief: '20–30 s of narration with a harsh or nasal ring on some words, or a boxy room. Untreated.',
    },
  ],
  hotspots: [
    { shot: 'overlays' },
    { shot: 'display' },
    { shot: 'attack' },
    { shot: 'release' },
    { shot: 'threshold' },
    { shot: 'sharp' },
    { shot: 'depth' },
    { shot: 'mix' },
    { shot: 'trim' },
  ],
  specs: [
    { label: 'Type', value: 'Dynamic, multiband resonance suppression' },
    { label: 'Controls', value: 'Threshold, Depth, Sharp, Attack, Release, Mix, Trim' },
    { label: 'Display', value: 'Live per-frequency cuts' },
    { label: 'Presets', value: 'Factory and your own' },
    { label: 'Works with', value: 'WAV, FLAC, MP3, AIFF, M4A — mono or stereo' },
  ],
}
