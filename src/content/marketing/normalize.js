export default {
  eyebrow: 'Peak normalizer',
  headline: 'Clean, instant level — and nothing else touched.',
  pitch: [
    'One move brings a quiet recording up to full level without changing how it sounds: same voice, same dynamics, just louder.',
  ],
  description: 'Peak normalize audio in your browser: bring a quiet recording up to full level in one clean step, with the sound and dynamics untouched. Free.',
  overviewTitle: 'The cleanest way to get more level',
  overview: [
    'A recording made with lots of headroom sounds small and distant until it is turned up. Peak normalizing turns it up as far as it can go — the loudest moment lands exactly at the level you choose — with one clean change of gain, so the tone, the dynamics and the performance stay exactly as recorded.',
    'Use it to rescue a quiet take, to bring one passage up to sit with the rest, or to set a predictable level before you compress or clip. It is instant, even on a long file.',
  ],
  features: [
    { title: 'Same sound, more level', text: 'the tone and dynamics stay exactly as recorded' },
    { title: 'Exact peak target', text: 'the loudest sample lands right where you set it' },
    { title: 'Rescue quiet takes', text: 'bring a distant recording up to full level in one move' },
    { title: 'Match passages', text: 'lift a quiet section to sit with the rest' },
    { title: 'Turn down too', text: 'bring a recording that is too hot back under your ceiling' },
    { title: 'Ready for processing', text: 'a predictable level before compressing or clipping' },
    { title: 'Instant', text: 'no rendering wait, even on long files' },
    { title: 'Any selection', text: 'a phrase, a chapter or the whole file' },
    { title: 'One undo step', text: 'change your mind and it is gone' },
    { title: 'Free in your browser', text: 'no plugin to buy, no DAW, nothing to install' },
  ],
  samples: [
    {
      id: 'quiet',
      title: 'Quiet recording',
      text: 'A take recorded with too much headroom comes up to full level: the same voice, just louder and closer.',
      settings: {},
      setting: 'Factory default (peak at −1 dB)',
      brief: '20–30 s of narration recorded quietly (peaks around −18 dBFS), otherwise untreated.',
    },
  ],
  hotspots: [
    { shot: 'target-peak' },
  ],
  specs: [
    { label: 'Type', value: 'Peak normalizer (one gain change)' },
    { label: 'Measurement', value: 'Sample peak' },
    { label: 'Preview', value: 'Instant' },
    { label: 'Works with', value: 'WAV, FLAC, MP3, AIFF, M4A — mono or stereo' },
  ],
}
