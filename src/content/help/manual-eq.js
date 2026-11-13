export default {
  summary: 'Shapes the tone of the selection by hand, with up to eight bands drawn over a live analyzer.',

  intro: [
    'EQ is a parametric equaliser for shaping tone by hand, with up to eight bands drawn over a live analyzer of the audio as it plays. Each band can be a bell, shelf or filter, and you can drag its node on the graph or type exact values.',
    'Use it make many precise cuts or boosts anywhere across the frequency spectrum.',
  ],

  quickStart: [
    'Select the passage and play it. The EQ opens engaged with four flat bands, so nothing changes until you move one.',
    'Raise a band’s GAIN well up and sweep its FREQ to find the offending spot, then turn GAIN down to cut it.',
    'Narrow the WIDTH for a resonance, widen it for a broad tonal change.',
    'Click the plot to add a band where you need one, up to eight.',
    'Compare against bypass, matching the level with Output if the change made it louder, then Apply.',
  ],

  controls: [
    {
      label: 'ANALYZER',
      shot: 'analyzer',
      text: 'Draws the live spectrum of the audio behind the curve.',
      details: [
        'Reading your curve against what is actually in the audio is the quickest way to see where a band should go.',
      ],
      range: 'On, Off',
      default: 'On',
    },
    {
      label: 'Band count',
      text: 'Says how many bands are changing the sound, or flat when none is.',
      details: [
        'A band counts once it is on and has gain, or is a notch, high-pass or low-pass. Apply stays unavailable while the EQ is flat.',
      ],
    },
    {
      label: 'Reset',
      shot: 'reset',
      text: 'Puts the EQ back to the four flat bands it opened with.',
      details: [
        'Those are a low shelf at 80 Hz, bells at 300 Hz and 3 kHz, and a high shelf at 10 kHz, all at 0 dB.',
      ],
    },
    {
      label: 'EQ plot',
      shot: 'plot',
      text: 'Shows the combined response of every band, with a dot for each one you can drag.',
      details: [
        'Click an empty part of the plot to add a bell there. Drag a dot to move its band in frequency and gain, scroll over it to widen or narrow it, double-click it to remove it, and Alt-click it to turn it on or off.',
        'Hovering a strip highlights its dot and hovering a dot highlights its strip. The frequency under the pointer is shown faintly at the top of the plot.',
        'The ±6, AUTO and ±30 buttons in the corner set the gain axis. AUTO starts at ±12 dB and widens to ±21 dB as bands grow, so the whole curve always fits.',
        'The curve is drawn from the same filters that run, so it is the true response. The EQ runs at twice the file’s sample rate, so a bell at 10 kHz keeps the shape it has at 1 kHz instead of narrowing as it nears the top of the band.',
      ],
      range: 'Gain axis ±6 dB, AUTO, ±30 dB',
      default: 'AUTO',
    },
    {
      label: 'IN',
      shot: 'in',
      text: 'The input meter, with the Input trim under it.',
      details: [
        'Input is gain ahead of the EQ, for when boosts would push a hot file into clipping. Double-click the trim to reset it.',
      ],
      range: '−12 to +12 dB in 0.1 dB steps',
      default: '0 dB',
    },
    {
      label: 'GAIN',
      group: 'BAND STRIP',
      shot: 'band-gain',
      text: 'How much the band lifts or cuts.',
      details: [
        'Each band has its own strip, numbered and ordered low to high to match the plot. The order holds still while you drag, so a strip never jumps out from under the pointer.',
        'A notch is a full cut and a high-pass or low-pass has no gain of its own, so for those shapes the knob reads full cut or no gain and does not move.',
        'Click the value under the knob to type an exact one. Double-click the knob to return it to 0 dB.',
      ],
      range: '−18 to +18 dB in 0.1 dB steps',
      default: '0 dB',
    },
    {
      label: 'Shape',
      group: 'BAND STRIP',
      shot: 'band-shape',
      text: 'Picks the kind of filter the band is, shown as a picture of its curve.',
      details: [
        'Bell (bump or dip) and notch (kill one narrow tone) are available on every band. The lowest band also offers a low shelf and a high-pass, and the highest band a high shelf and a low-pass, so cuts and shelves always sit at the ends.',
        'A band keeps its shape if another band moves past it.',
      ],
      range: 'Bell, low shelf, high shelf, high-pass, low-pass, notch',
      default: 'Bell for a band you add',
    },
    {
      label: 'FREQ',
      group: 'BAND STRIP',
      shot: 'band-freq',
      text: 'Where the band sits.',
      details: [
        'The knob is logarithmic. Values round to 1 Hz below 1 kHz, 10 Hz up to 10 kHz and 100 Hz above. You can type 2.4k as well as 2400.',
      ],
      range: '20 Hz to 20 kHz',
      default: 'Where you clicked on the plot',
    },
    {
      label: 'WIDTH',
      group: 'BAND STRIP',
      shot: 'band-width',
      text: 'How much of the spectrum either side comes with the band, as Q — higher is narrower.',
      details: [
        'On a shelf it sets how sharp the corner is. On a high-pass or low-pass it sets the resonance at the corner.',
      ],
      range: 'Q 0.3 to 10 for bells and pass filters, 0.3 to 2 for shelves, 4 to 30 for a notch',
      default: 'Q 1 for a band you add',
    },
    {
      label: 'ON',
      group: 'BAND STRIP',
      shot: 'band-on',
      text: 'Turns the band on or off without losing its settings.',
      range: 'ON, OFF',
      default: 'ON',
    },
    {
      label: 'S',
      group: 'BAND STRIP',
      shot: 'band-solo',
      text: 'Lets you hear only the part of the spectrum the band works on.',
      details: [
        'A bell or notch solos as a band-pass at the same frequency and width, and a shelf or pass filter as the half of the spectrum it acts on. It is for listening only and is never applied.',
      ],
      range: 'On, Off',
      default: 'Off',
    },
    {
      label: '×',
      group: 'BAND STRIP',
      shot: 'band-remove',
      text: 'Removes the band.',
    },
    {
      label: 'OUT',
      shot: 'out',
      text: 'The output meter, with the Output trim under it.',
      details: [
        'Output is gain after the EQ. Use it to match the level against bypass, so a boost does not win the comparison just by being louder. Double-click the trim to reset it.',
      ],
      range: '−12 to +12 dB in 0.1 dB steps',
      default: '0 dB',
    },
  ],

  notes: [
    'The window holds eight bands. Remove one to add another.',
    'VoiceRx can move its corrections here as ordinary bands you can edit. They are moved, not copied, so nothing is applied twice.',
    'A fixed cut suits a constant resonance. When the resonance comes and goes, reach for Reso Soothe instead.',
  ],
}
