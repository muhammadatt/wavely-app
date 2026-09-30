export default {
  summary: 'Holds the top end at a ceiling, so brightness, harshness and sharp edges never get past it',

  whenToUse: [
    'A voice or a whole file is too bright or harsh in places, not everywhere',
    'Sibilance, hiss or clicks spike above an otherwise good top end',
    'You want a brightness ceiling rather than a static high cut that dulls everything',
  ],

  controls: [
    { label: 'Freq', text: 'Where bright starts: the band above it is what the limiter listens to and turns down' },
    { label: 'Threshold', text: 'The ceiling for that band, in dB relative to the file’s voice level, so one setting does the same thing on a quiet recording and a hot one' },
    { label: 'Range', text: 'The deepest the shelf may cut, up to 24 dB. Keeps a hard S from turning into a lisp; 0 takes the shelf out' },
    { label: 'Release', text: 'How quickly the top comes back after a bright moment, 5–300 ms' },
    { label: 'Transient', text: 'Adds an acceleration limiter after the shelf: a ceiling that tightens 12 dB per octave and acts inside the waveform, for edges too short for any gain to catch. At 1 it only touches the sharpest; at 100 it shares the shelf’s threshold. 0 takes it out. The lamp lights while it acts' },
    { label: 'Output', text: 'Level after the limiter, for matching against bypass' },
    { label: 'Delta', text: 'Hear only what is being removed, from the button in the title bar' },
  ],

  steps: [
    'Play a bright passage and turn on Delta',
    'Lower Threshold until the delta is the harshness and nothing else',
    'Set Range so heavy moments stay natural, and Release so the top does not pump',
    'Add Transient if clicks or sharp S onsets still stand out',
    'Turn Delta off and compare against bypass at matched level',
  ],

  notes: [
    'Below the threshold the audio passes through untouched, bit for bit',
    'The shelf is linear-phase, so the cut never rings or smears the voice',
    'The curve shows the cut being applied right now, with the deepest Range allows dashed behind it',
    'For sibilance on its own, HF Softener knows more about voices; this is the general-purpose ceiling',
  ],
}
