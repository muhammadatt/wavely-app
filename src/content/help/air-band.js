export default {
  summary: 'Lifts the top end with a wide, gentle shelf shaped from five overlapping bells',

  whenToUse: [
    'A voice sounds dull or closed-in after noise reduction',
    'You want presence and air without the hardness a narrow high boost gives',
    'The recording is fine but sits behind the listener rather than in front of them',
  ],

  quickStart: [
    'Select the passage and open Air Boost — it opens engaged',
    'Play, and raise Air until the voice opens up',
    'Pull Output down until the OUT meter matches the IN meter, then compare against bypass',
    'Back Air off if sibilance or hiss comes forward with the air',
    'Apply to selection',
  ],

  controls: [
    {
      label: 'IN',
      shot: 'in-meter',
      text: 'Shows the level going into the effect',
    },
    {
      label: 'Response curve',
      shot: 'curve',
      text: 'Draws the lift being applied, from 100 Hz to 20 kHz',
      details: [
        'It is computed from the same filter coefficients the effect runs, at your file’s sample rate, so what is on screen is the filter you are hearing',
      ],
    },
    {
      label: 'Air',
      shot: 'air',
      text: 'Sets how much the top end is lifted',
      details: [
        'One knob scales the whole curve: a wide high shelf plus five bells, modelled on the slow, roughly four-octave rise of a Maag-style Air Band rather than the steep corner of an ordinary shelf',
        'The number is the lift at the top of the band. At the default +6 dB the curve gives about +1 dB at 2 kHz, +3.6 dB at 5 kHz, +5.2 dB at 10 kHz and +6.2 dB at 20 kHz',
        'Below about 1 kHz the voice is untouched, and the effect never cuts anywhere',
        'Double-click to reset; click the value to type one',
      ],
      range: '0 to +12 dB in 0.1 dB steps',
      default: '+6.0 dB',
    },
    {
      label: 'OUT',
      shot: 'out-meter',
      text: 'Shows the level coming out, after Output',
    },
    {
      label: 'Output',
      shot: 'output',
      text: 'The small trim knob under the OUT meter: a level change after the shelf, for a level-matched comparison',
      details: [
        'Brighter almost always sounds better at first, so pull Output down until the two meters match before you judge the result',
        'Double-click to reset',
      ],
      range: '−12 to +12 dB in 0.1 dB steps',
      default: '0.0 dB',
    },
  ],

  notes: [
    'It only ever lifts — reach for the EQ if you need to cut up there',
    'Boosting the top end also lifts hiss, so run it after noise reduction rather than before',
    'It adds no latency and no distortion: it is a fixed set of filters whose gains follow the Air knob',
  ],
}
