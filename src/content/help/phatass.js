export default {
  summary: 'Adds tape saturation and low-end warmth to the selection, rounding its peaks and top end without raising its peak level',

  whenToUse: [
    'A voice sounds thin or clinical and you want body without an EQ boost',
    'You want peaks rounded off the way tape does it, and the level given back as loudness',
    'You want the gentle, energy-driven top-end sag of tape rather than a fixed high cut',
    'You want added density that never eats into your headroom',
  ],

  quickStart: [
    'Select the passage and play it. The plugin opens engaged, with DRIVE and WARMTH off',
    'Raise WARMTH to about 5 for body, and pick ROUND or TIGHT for its character',
    'Raise DRIVE a dB or two to round the peaks, and choose CLEAN or PHAT',
    'Pick a TAPE SPEED: 30 barely touches the top end, 7.5 darkens bright passages',
    'Watch the SATURATION meter and pull MIX back if it is too much, then Apply',
  ],

  controls: [
    {
      label: 'SATURATION',
      shot: 'saturation',
      text: 'Shows how much TAPE and WARMTH are adding to the signal right now, against the clean signal',
      details: [
        'It measures the energy of everything the two stages add, averaged over about 150 ms and divided by the energy of the clean signal, and moves on a spring like a VU needle',
        'The scale is linear in dB: 0 % is −40 dB (barely there) and 100 % is as much added as the signal itself. The reading turns red above 80 %',
        'WARMTH reads far higher than TAPE, because its low layers reshape the whole low band rather than only adding harmonics, so with WARMTH up the meter mostly shows WARMTH',
        'The top-end sag, MIX and Output are level changes, not saturation, and are not counted. It reads OFF while the plugin is bypassed',
      ],
    },
    {
      label: 'DRIVE',
      group: 'TAPE',
      shot: 'drive',
      text: 'How many dB tape saturation takes off the selection’s loudest peak',
      details: [
        'The knob is calibrated on the selection’s own peak, so −2.0 dB means the loudest peak comes out 2 dB lower before makeup, on a quiet recording or a hot one',
        'It is a waveshaper, not a compressor: the top of each wave is rounded off while material more than about 9 dB under the peak passes untouched. A sibilant peak loses somewhat less than the number, because its harmonics land above the audible band and are filtered out',
        'Makeup is automatic. What DRIVE actually took off the peak is measured over the whole selection and given back straight after it, so the peak returns to where it started and the reduction becomes loudness — about +1.2 to +1.7 dB at −2 dB of DRIVE on narration',
        'DRIVE comes first in the chain, so WARMTH works on the already-rounded signal. Turning it up also drives the top end harder into the tape speed’s sag and brings in the speed’s head bump',
        'The price is odd harmonics: roughly 2 % at 1 dB, 4 % at 2 dB and 9 % at 3.5 dB on narration. Past about 3.5 dB on CLEAN the very top is clipped flat, which suits dense drums more than voice',
      ],
      range: 'OFF to 12 dB of peak reduction in 0.1 dB steps',
      default: 'OFF',
    },
    {
      label: 'CLEAN / PHAT',
      group: 'TAPE',
      shot: 'tape-type',
      text: 'Chooses which tape curve DRIVE pushes into',
      details: [
        'CLEAN is a soft clipper: it rounds off only the top of each wave, adding mostly the third harmonic, and clips flat past about 3.5 dB',
        'PHAT is magnetic tape’s own hysteresis loop, with memory: low, heavy hits such as kicks are squashed about twice as hard as snares, and peaks round off without a hard clip. It uses about three times the processor, and its makeup takes a little longer to measure',
        'The switch is greyed out while DRIVE is off',
      ],
      range: 'CLEAN, PHAT',
      default: 'CLEAN',
    },
    {
      label: 'TAPE SPEED (IPS)',
      group: 'TAPE',
      shot: 'tape-speed',
      text: 'Sets the tape speed, which decides how the top end sags on bright, hot passages and where the head bump sits',
      details: [
        'The treble sags as it gets louder: the more bright energy there is, the more of it is turned down and the lower the loss reaches. Slower tape has less high-frequency headroom, so it sags sooner, deeper and lower — at most about 4 dB at 30 IPS, 6 dB at 15 and 9 dB at 7.5',
        'It listens to energy, not peaks, and does not look ahead, so attacks and short S sounds stay bright while sustained brightness darkens. Its threshold follows the file’s own voice level, so it means the same on a quiet take and a hot one',
        'While DRIVE is up, each speed also brings the playback head’s low-end bump, fitted to a Studer A800 at 30 IPS: about +1.2 to +1.5 dB at 40–50 Hz with a roll-off below. Each slower speed moves it an octave lower',
        'The reel turns at the selected speed while the plugin is on and the transport runs. It is decoration only',
      ],
      range: '30, 15, 7.5 IPS',
      default: '30 IPS',
    },
    {
      label: 'WARMTH',
      group: 'HARMONICS',
      shot: 'warmth',
      text: 'Adds low-end body: how much of what two low-band saturators produce is mixed in',
      details: [
        'An even (quartic) and an odd (cubic) saturator work on the lows, below about 250 Hz. They thicken and lift roughly 120–250 Hz rather than adding fizz, and leave everything above their band alone',
        'Each saturator is calibrated on this file’s own level in its band, so a knob position does the same on any recording level. The knob is linear in amplitude, so each step adds about the same amount of body',
        'WARMTH never raises the selection’s peak. A guard with a few milliseconds of lookahead turns down only the added warmth, only where it would push past the selection’s own peak; the voice itself is never touched',
        'Some added density and loudness is expected — about +1.4 LU at WARMTH 5 on narration. The peak is what stays put',
      ],
      range: 'OFF to 10 in steps of 0.1',
      default: 'OFF',
    },
    {
      label: 'ROUND / TIGHT',
      group: 'HARMONICS',
      shot: 'character',
      text: 'Sets the character of WARMTH by balancing its two saturators',
      details: [
        'ROUND leans toward the even saturator for a rounder, fuller low end. TIGHT leans toward the odd one for a firmer sound with more edge',
        'The band levels barely change between the two; the difference is the harmonic character. The switch is greyed out while WARMTH is off',
      ],
      range: 'ROUND, TIGHT',
      default: 'ROUND',
    },
    {
      label: 'MIX',
      shot: 'mix',
      text: 'Blends the processed signal with the dry one',
      details: [
        'The dry path is delayed by exactly the plugin’s latency, so a blend never combs',
        'At 100 % the output is the processed signal alone. Double-click the fader to return to 100 %',
      ],
      range: '0 to 100 % in 1 % steps',
      default: '100 %',
    },
    {
      label: 'IN',
      group: 'LEVELS',
      shot: 'in',
      text: 'The input meter, with the Input trim under it',
      details: [
        'Input is a drive, not a level match: DRIVE, WARMTH and the tape speed’s sag stay calibrated on the untouched selection, so turning Input up pushes the signal further into all three',
        'DRIVE’s makeup follows it, so the peak lands where the driven signal’s peak was, and the WARMTH guard’s ceiling moves with it',
        'Double-click the trim to reset it',
      ],
      range: '−12 to +12 dB in 0.1 dB steps',
      default: '0 dB',
    },
    {
      label: 'OUT',
      group: 'LEVELS',
      shot: 'out',
      text: 'The output meter, with the Output trim under it',
      details: [
        'Output is a plain level trim on the whole plugin, after MIX. Use it to match the level against bypass before you judge the change',
        'Double-click the trim to reset it',
      ],
      range: '−12 to +12 dB in 0.1 dB steps',
      default: '0 dB',
    },
  ],

  notes: [
    'With DRIVE and WARMTH off the audio is untouched except for the tape speed’s top-end sag, which at 30 IPS only reaches the brightest passages',
    'The top-end sag is not a limiter: it reacts to how much bright energy there is, with no lookahead, so a single click or S gets through. For a hard top-end ceiling use Hi-Freq Limiter',
    'DRIVE’s makeup is measured on the selection. While a new measurement runs the preview holds a conservative makeup, and Apply always uses an exact one',
    'The plugin delays the audio by a few milliseconds internally; preview and Apply both compensate for it',
    'The onset softener that used to live here is now Soften in the De-Esser',
  ],
}
