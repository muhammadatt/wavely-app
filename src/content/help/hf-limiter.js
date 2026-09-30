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
    { label: 'Tail', text: 'A slow second release stage, 40–600 ms. A sustained bright passage charges it and the top comes back slowly; a single click hardly does and recovers at the Release speed. Fully down is off' },
    { label: 'Shape', text: 'TIGHT is a ceiling on the band above Freq and leaves everything below it alone. WARM is a gentle 6 dB per octave tilt that starts an octave or more below Freq, the way the EL7 Fatso’s Warmth does' },
    { label: 'Transient', text: 'Extra cut, 0–12 dB, on sudden bright onsets: clicks, lip smacks, T, K and P bursts, even ones below Threshold. It reacts to how suddenly the top end rises, not how loud it is, so a steady S is left to the shelf, and it lets go within milliseconds. It stacks on top of the shelf, and a sharper onset gets more of it. 0 is off. The lamp lights while it acts' },
    { label: 'Output', text: 'Level after the limiter, for matching against bypass' },
    { label: 'Delta', text: 'Hear only what is being removed, from the button in the title bar' },
  ],

  steps: [
    'Play a bright passage and turn on Delta',
    'Lower Threshold until the delta is the harshness and nothing else',
    'Set Range so heavy moments stay natural, and Release so the top does not pump',
    'Add Transient if clicks, lip smacks or hard T and K sounds still stand out',
    'Turn Delta off and compare against bypass at matched level',
  ],

  notes: [
    'Below the threshold the audio passes through untouched, bit for bit',
    'The shelf is linear-phase, so the cut never rings or smears the voice',
    'The curve shows the cut being applied right now, with the deepest Range allows dashed behind it',
    'For sibilance on its own, HF Softener knows more about voices; this is the general-purpose ceiling',
    'An S that starts very abruptly after silence can catch a little Transient in its first millisecond; if an S sounds blunted, lower Transient',
    'For a Fatso Warmth sound, start from WARM, Freq 2.3 kHz, Threshold −1 dB, Range 16 dB, Release 30 ms, Tail off and Output +0.7 dB',
    'WARM hears more of the spectrum than TIGHT, so at the same Threshold it cuts more often',
  ],
}
