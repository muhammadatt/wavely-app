export default {
  summary: 'Shows what is in the file, frequency by frequency, as it plays',

  whenToUse: [
    'You can hear something wrong and want to find where it sits',
    'You are looking for a whistle, a ring or a mains hum',
    'You want to see whether a change did what you expected',
  ],

  controls: [
    { label: 'Resolution', text: 'How finely the spectrum is measured — higher separates close frequencies, lower reacts faster' },
    { label: 'Tilt dB/oct', text: 'Tilts the display so a naturally falling spectrum reads flat — at 3 dB per octave, pink noise draws as a level line' },
    { label: 'Averaging', text: 'How much the trace is smoothed over time' },
    { label: 'Floor', text: 'The bottom of the window, in dB' },
    { label: 'PEAK HOLD', text: 'Leaves a mark at the highest level each frequency reached, so a brief noise is still findable' },
    { label: 'FREEZE', text: 'Holds the display where it is, to read a moment that has gone past' },
  ],

  notes: [
    'It reads the output of the whole effect chain, which is what your ears are hearing, rather than any one plugin',
    'The window does not rescale itself: that is what makes "the hiss got quieter" readable instead of everything appearing to move',
    'A narrow peak that stays put across a passage is usually hum or a resonance; broadband haze that fills the pauses is noise',
    'This window only looks — it changes nothing and has nothing to apply',
  ],
}
