export default {
  summary: 'Finds notes and frequencies that ring louder than the rest and holds them down as they occur',

  whenToUse: [
    'Certain words or notes jump out harshly while the rest of the take is fine',
    'A room mode is ringing on the low end',
    'A fixed EQ cut fixes the problem word and dulls everything else',
  ],

  controls: [
    { label: 'Zones', text: 'The spectrum is split into bands, each with its own settings — click a zone on the display to edit it' },
    { label: 'Selectivity', text: 'How far above its neighbours a frequency must sit before this zone treats it — higher is fussier, and at the top the zone does nothing' },
    { label: 'Sharpness', text: 'How closely the reference follows the shape of the spectrum, which decides what counts as a peak' },
    { label: 'Depth', text: 'How much of the excess this zone removes' },
    { label: 'Max Cut', text: 'The most this zone will ever take out, whatever it measures' },
    { label: 'HARMONIC MASK', text: 'Leaves the harmonics of the tracked pitch alone, so the effect works between the partials instead of thinning the voice' },
    { label: 'FIT TO VOICE', text: 'Measures the selection and places the zone boundaries against this speaker’s pitch' },
    { label: 'Attack', text: 'How quickly a cut arrives once a resonance is detected' },
    { label: 'Release', text: 'How quickly it lets go afterwards' },
    { label: 'Mix', text: 'Blends the treated signal against the original' },
    { label: 'Trim', text: 'Output level' },
    { label: 'DELTA', text: 'Plays only what is being removed — per zone, or for the whole effect from the header' },
  ],

  steps: [
    'Select a stretch containing the problem and press FIT TO VOICE so the zones sit against this speaker',
    'Play it and watch the display for which zone is doing the work',
    'Click that zone and lower Selectivity until the ring is caught',
    'Switch its DELTA on — you should hear the ring and very little voice',
    'Raise Selectivity back until voice stops appearing in the delta',
  ],

  notes: [
    'The display shows removal only: what hangs off the top rail is what is being taken out',
    'DELTA is monitoring — Apply always renders the processed audio, never the difference',
    'Slow settings suit this effect: the defaults are 300 ms and 1500 ms because the same average cut spread evenly is far less audible than momentary deep notches',
    'The ceiling presets and FIT TO VOICE measure the selected region, so they need a selection to act on',
  ],
}
