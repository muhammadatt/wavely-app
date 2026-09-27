export default {
  summary: 'Up to four layers of saturation in series, each with its own curve, band and drive',

  whenToUse: [
    'A voice needs density or warmth without sounding processed',
    'Vowels sound dull after de-essing and you want harmonic brightness rather than EQ',
    'You want to audition saturation curves against each other at matched strength',
  ],

  controls: [
    { label: 'Layer', text: 'Switches the layer in. Layers run top to bottom, each shaping what the one above left' },
    { label: 'Curve', text: 'The saturation shape. Quartic adds second harmonic for warmth; the odd curves (Tanh, Atan, Algebraic, Cubic) add edge and are the ones that excite' },
    { label: 'Drive', text: 'dB above the matched point. At 0 dB every curve makes the same small amount of distortion on this band, so switching curves compares character, not strength' },
    { label: 'Low / High', text: 'The band the layer works on. Fully out at either end leaves that side open. What the curve adds stays inside the band' },
    { label: 'Emph', text: 'OPTO pushes the highs into the curve and takes them back out after, which trims the harmonics it makes up top — the smoothest on a voice. REV is the mirror and lifts them' },
    { label: 'Mode', text: 'Voiced shapes the vowels only, so nothing is added to sibilants or room tone. Full shapes everything' },
    { label: 'Delta', text: 'Hear only what the layers add' },
  ],

  steps: [
    'Start from the two factory layers: Warmth (Quartic, OPTO, full band) and Exciter (Tanh, REV, 3 kHz up, Voiced)',
    'Solo a layer by switching the others off, and use Delta to hear exactly what it adds',
    'Raise Drive until you can just hear it, then back off a little — small amounts from several layers sound more natural than a lot from one',
  ],

  notes: [
    'Drive is calibrated on this file: each layer measures how loud its band is here, so the same setting means the same thing on a quiet recording and a hot one',
    'A high band sits far below the voice, so 0 dB there is barely audible. An exciter layer wants +12 to +24 dB',
    'On a high band Emph works mostly like extra or less drive: REV needs about 10 dB more to brighten as much as OFF, OPTO about 10 dB less',
    'The Quartic does not excite: its harmonics are even and weak at high-band levels. Use an odd curve for brightness',
    'Every layer slot adds a fixed 1.1 ms of latency, on or off, so switching layers never shifts the audio. It is compensated when you apply',
  ],
}
