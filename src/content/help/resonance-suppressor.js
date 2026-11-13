export default {
  summary: 'Finds frequencies that ring louder than the rest of the voice and holds them down only while they occur',

  intro: [
    'Reso Soothe finds frequencies that ring louder than the rest of the voice, harsh notes, nasal peaks, boxy room modes, and turns each down only while it rings. The display shows every cut, frequency by frequency, as it happens',
    'Use it when particular words or notes jump out harshly while the rest of the take is fine, or when a fixed EQ cut fixes the problem word but dulls everything else',
  ],

  quickStart: [
    'Select a stretch containing the problem and play it — the plugin opens engaged with no focus nodes, working evenly across the spectrum',
    'Watch the display: what hangs down from the top is what is being removed, and AVE CUT and MAX CUT say how much',
    'Lower Threshold until the ring is caught, or raise it if voice starts to disappear',
    'If the problem lives in one region, double-click it on the display to add a focus node and drag the node up to work harder there',
    'Switch DELTA on to hear only what is being removed — you want the ring, not the words — then Apply',
  ],

  controls: [
    {
      label: 'RESONANCE / SPECTRO',
      shot: 'overlays',
      text: 'Choose what the display draws: the removal trace, the input spectrum with the detection threshold across it, or both',
      details: [
        'RESONANCE is the suppression trace — the cut hanging down from the top rail, frequency by frequency, as it happens',
        'SPECTRO draws the input level with the threshold line over it, which is what you read when deciding where a focus node should sit',
        'They change only what is drawn, never the audio, and the choice is remembered in this browser',
      ],
      range: 'Each on or off',
      default: 'RESONANCE on, SPECTRO off',
    },
    {
      label: 'Display',
      shot: 'display',
      text: 'The spectrum plot, where you see what is removed and place focus nodes',
      details: [
        'AVE CUT and MAX CUT, printed inside the removal band, are the average and the deepest cut being applied right now',
        'Double-click empty plot to add a focus node there, or double-click a node to remove it. A focus node shifts the threshold over a region of the spectrum: raise it to work harder there, lower it to leave that region alone. Nodes add together, and up to 8 can be placed',
        'Drag a node sideways for frequency and up or down for its amount; scroll over it for its width. With a node selected the arrow keys move it, the bracket keys change its width, Space bypasses it and Delete removes it',
        'Dragging the dotted threshold line sets Threshold, the same as the knob. Hold the pointer still over the plot to read the frequency under it',
        'The window can be resized from its corner; the extra height all goes to the display',
      ],
    },
    {
      label: 'Focus node card',
      text: 'Appears at the foot of the display when you select a node, with that node’s settings',
      details: [
        'Freq places the node (20 Hz to 20 kHz). Width (Slope on a shelf) sets how far it spreads, from 2 semitones to 4 octaves. Amount is how much it moves the threshold: positive works harder there, negative eases off, −18 to +18 dB in 0.5 dB steps. A new node starts at +6 dB over one octave',
        'The three shape buttons choose a bell around the frequency, or a shelf covering everything below or above it',
        'DELTA on the card plays only what that node’s region is removing. ON / BYP bypasses the node without losing its settings, and DEL deletes it. Drag the bar on the card’s top edge to slide it out of the way',
      ],
    },
    {
      label: 'Attack',
      shot: 'attack',
      text: 'How quickly a cut arrives once a resonance is detected',
      details: [
        'Slow settings suit this effect: the same average cut spread evenly is much less audible than momentary deep notches. Below about 50 ms the cut starts to follow individual syllables',
      ],
      range: '12 to 400 ms in 5 ms steps',
      default: '50 ms',
    },
    {
      label: 'Release',
      shot: 'release',
      text: 'How quickly a cut lets go once the resonance has passed',
      details: [
        'Longer releases level a resonance across a phrase instead of chasing it word by word. Past about 500 ms the improvement is small, but an unusually resonant room can still benefit',
      ],
      range: '25 to 2000 ms in 10 ms steps',
      default: '200 ms',
    },
    {
      label: 'Threshold',
      shot: 'threshold',
      text: 'How far above its surroundings a frequency must stand before it is treated',
      details: [
        'Lower catches more and cuts deeper; higher is fussier. Reduction is proportional to how far a peak stands over the threshold, so one knob both widens and deepens the effect',
        'It is the global setting: focus nodes add their offsets to it region by region. From about 34 up the effect removes essentially nothing',
      ],
      range: '3 to 36 in 0.5 steps',
      default: '20',
    },
    {
      label: 'Sharp',
      shot: 'sharp',
      text: 'What shape counts as a resonance — how closely the reference follows the spectrum',
      details: [
        'It decides what the detector considers a narrow peak rather than part of the voice’s overall tone. It is not a node width: Sharp says what to look for, a node says where to look',
      ],
      range: '0 to 100 %',
      default: '80 %',
    },
    {
      label: 'Depth',
      shot: 'depth',
      text: 'How much of what is found gets removed',
      details: [
        'At 100 % each resonance is cut by its full excess over the threshold, up to a 36 dB limit; lower settings take a proportion of it',
      ],
      range: '0 to 100 %',
      default: '100 %',
    },
    {
      label: 'Mix',
      shot: 'mix',
      text: 'Blends the treated signal with the original',
      range: '0 to 100 %',
      default: '100 %',
    },
    {
      label: 'Trim',
      shot: 'trim',
      text: 'Output gain on the treated signal, for a level-matched comparison against bypass',
      range: '−12 to +12 dB in 0.5 dB steps',
      default: '0.0 dB',
    },
    {
      label: 'DELTA',
      text: 'The header switch plays only what is being removed from the whole effect',
      details: [
        'It is monitoring only: Apply always renders the processed audio, never the difference. While it is on, the display is marked DELTA',
      ],
      range: 'On, Off',
      default: 'Off',
    },
  ],

  notes: [
    'The display shows removal only: what hangs from the top rail is what is being taken out',
    'The plugin analyses in 2048-sample frames (about 46 ms at 44.1 kHz). That latency is compensated when you apply, so the processed audio stays in place',
    'With no focus nodes the whole spectrum is treated the same way. Add nodes only where one region needs more, or less, attention',
  ],
}
