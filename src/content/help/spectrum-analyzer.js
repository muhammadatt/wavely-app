export default {
  summary: 'Shows what is in the audio, frequency by frequency, as it plays',

  intro: [
    'The Spectrum Analyzer shows what is in the audio, frequency by frequency, as it plays. It reads the output of the effect chain, so it shows the sound you are hearing, processing included',
    'Use it to find where a problem you can hear actually sits, such as a whistle, a ring or mains hum, or to see whether a change did what you expected',
  ],

  quickStart: [
    'Open the window and play the file. It starts reading straight away and has nothing to switch on',
    'Hover the plot to read the frequency, note and level under the pointer',
    'Use PEAK HOLD to catch a brief noise, and FREEZE to stop the display on a moment',
    'Raise RESOLUTION to 16K to separate hum harmonics, or drop it to 1K to follow fast changes',
  ],

  controls: [
    {
      label: 'FREEZE',
      shot: 'freeze',
      text: 'Holds the display where it is, so you can read a moment that has gone past',
      details: [
        'The audio keeps playing; only the picture stops. The pointer readout still works on the frozen trace',
      ],
      range: 'On, Off',
      default: 'Off',
    },
    {
      label: 'PEAK HOLD',
      shot: 'peak-hold',
      text: 'Draws an outline at the highest level each frequency has reached, so a brief noise is still findable',
      details: [
        'Turning it on starts a fresh hold, so switch it off and on to clear the outline',
      ],
      range: 'On, Off',
      default: 'On',
    },
    {
      label: 'Spectrum',
      shot: 'display',
      text: 'The spectrum of everything you are hearing, on a logarithmic frequency axis from 20 Hz to 20 kHz',
      details: [
        'The top of the plot is 0 dBFS and the bottom is the FLOOR. The scale never rescales itself, so “the hiss got quieter” reads as a real drop instead of everything appearing to move',
        'Hover the plot for a crosshair naming the frequency, the nearest musical note and the level of the trace under the pointer. A room mode or a hum harmonic is often easier to act on by note than by hertz',
        'The PEAK line under the plot names the loudest frequency on screen, with its note and level, as selectable text you can copy into a filter. It shows a dash when nothing is above the FLOOR',
      ],
    },
    {
      label: 'RESOLUTION',
      shot: 'resolution',
      text: 'Sets the FFT size: how finely the spectrum is divided',
      details: [
        'Larger sizes separate close frequencies but react more slowly. At 44.1 kHz the bins are about 43 Hz wide at 1K, 11 Hz at 4K and 3 Hz at 16K — fine enough to tell the harmonics of mains hum apart',
      ],
      range: '1K, 2K, 4K, 8K, 16K',
      default: '4K',
    },
    {
      label: 'TILT dB/oct',
      shot: 'tilt',
      text: 'Tilts the display around 1 kHz so a naturally falling spectrum reads flat',
      details: [
        'At 3 dB per octave pink noise draws as a level line; 4.5 does the same for typical speech and music, and 6 emphasises the top end. OFF shows the raw level of each bin',
        'It changes only the picture. The readouts report the tilted trace, as drawn',
      ],
      range: 'OFF, 3, 4.5, 6 dB per octave',
      default: '4.5',
    },
    {
      label: 'AVERAGING',
      shot: 'averaging',
      text: 'How much each frame is averaged with the previous ones: higher is steadier, lower follows faster',
      details: [
        'Click the value to type an exact one. Double-click the knob to reset it',
      ],
      range: '0 to 95 % in 1 % steps',
      default: '72 %',
    },
    {
      label: 'FLOOR',
      shot: 'floor',
      text: 'Sets the bottom of the plot’s level range',
      details: [
        'Lower it to see quiet noise in the pauses, raise it to give the loud part of the spectrum more of the screen. Anything below it reads as below the FLOOR rather than as a number',
        'Click the value to type an exact one. Double-click the knob to reset it',
      ],
      range: '−140 to −40 dB in 5 dB steps',
      default: '−100 dB',
    },
  ],

  notes: [
    'It reads the output of the whole effect chain, which is what your ears are hearing, rather than any one plugin',
    'A narrow peak that stays put across a passage is usually hum or a resonance; broadband haze that fills the pauses is noise',
    'This window only looks — it changes nothing and has nothing to apply',
    'The settings are kept while the editor is open, so the window reopens the way you left it',
  ],
}
