export default {
  summary: 'Notches out mains hum and its harmonics',

  whenToUse: [
    'A steady low buzz runs under the whole recording',
    'Noise reduction thinned the voice and the hum is still there',
    'You can see a hard line at 50 or 60 Hz in the analyzer',
  ],

  controls: [
    { label: 'IN SOURCE', text: 'Which mains frequency to look for — 60 Hz in North America and Japan, 50 Hz across most of the rest of the world' },
    { label: 'Harmonic toggles', text: 'Which multiples of the fundamental get notched, so you can treat only the ones that are actually present' },
    { label: 'Width Q', text: 'How narrow each notch is — narrower removes less of the voice around it' },
    { label: 'Depth dB', text: 'How much each notch takes out' },
  ],

  steps: [
    'Pick the mains frequency for where the recording was made',
    'Play the selection and switch harmonics on one at a time, keeping the ones that make an audible difference',
    'Widen Width Q only if a notch is missing the hum, since a wide notch takes voice with it',
  ],

  notes: [
    'Hum is steady, so a narrow permanent notch is the right tool — this is not the effect for a rumble that comes and goes',
    'The higher harmonics fall inside the voice, so treating every one of them costs more than it removes',
  ],
}
