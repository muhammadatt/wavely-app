export default {
  summary: 'Finds each sibilant in the selection and turns it down on its own, the way an editor would with clip gain.',

  intro: [
    'The Sibilance Editor finds each S and F in the selection and turns it down on its own, the way an editor would with clip gain. Because it changes the level of the whole sibilant rather than filtering it, the tone of the S is left exactly as it was.',
    'Use it when sibilance is harsh in a few places rather than everywhere, or when it got worse after adding air or compression.',
  ],

  quickStart: [
    'Select the passage and press Analyse.',
    'Read the status line: it says how many of the events it found are being turned down.',
    'Lower /S/ CEILING until the events you can hear are counted, then set AMOUNT until they stop poking out.',
    'Compare against bypass — if the take now sounds lispy, lower AMOUNT or MAX CUT rather than the ceiling.',
    'Apply to the selection.',
  ],

  controls: [
    {
      label: 'IN',
      shot: 'in-meter',
      text: 'The input level, in dBFS.',
    },
    {
      label: 'GAIN REDUCTION',
      shot: 'reduction',
      text: 'How far the audio at the playhead is being turned down right now, in dB.',
      details: [
        'Its scale runs to 12 dB, where de-essing lives, so a few dB of cut fills a useful part of the bar.',
      ],
    },
    {
      label: 'Analyse',
      shot: 'analyse',
      text: 'Finds the sibilant events in the selection and measures each one.',
      details: [
        'Detection runs once on the server. For every event it measures how loud it peaks and how loud the speech around it sits, and every control below works from those two numbers, so turning them is instant and never re-detects.',
        'It needs a selection, and a free account. Applying the result needs Pro.',
        'Editing the audio, or moving the selection outside the analysed span, makes the analysis stale: press Analyse again.',
      ],
    },
    {
      label: 'Status line',
      shot: 'status',
      text: 'Says how many of the events found are being turned down, the deepest cut, and how many sit under their ceiling.',
      details: [
        'It also tells you when there is nothing to analyse yet, when no sibilants were found, and when the analysis no longer matches the selection.',
      ],
    },
    {
      label: 'OUT',
      shot: 'out-meter',
      text: 'The output level, in dBFS.',
    },
    {
      label: '/S/ CEILING',
      shot: 's-ceiling',
      text: 'How far above the surrounding voice a strident sibilant (S, SH, Z) may peak before it is turned down.',
      details: [
        'The ceiling is measured against the speech around each event, not against a fixed level, so the same setting works on a quiet passage and a loud one.',
        'Lower it to treat more events. An event at or under its ceiling is left exactly as it is.',
      ],
      range: '−12.0 to +18.0 dB in 0.5 dB steps',
      default: '+6.0 dB',
    },
    {
      label: '/F/ CEILING',
      shot: 'f-ceiling',
      text: 'The same ceiling for the softer non-strident sounds (F, TH), which sit lower than an S and need their own.',
      range: '−18.0 to +12.0 dB in 0.5 dB steps',
      default: '−4.0 dB',
    },
    {
      label: 'AMOUNT',
      shot: 'amount',
      text: 'How much of an event’s excess above its ceiling is taken off.',
      details: [
        'At 50 % an S peaking 6 dB over its ceiling is turned down 3 dB. At 100 % it is brought right down to the ceiling, up to MAX CUT.',
      ],
      range: '0 to 100 % in steps of 1 %',
      default: '50 %',
    },
    {
      label: 'MAX CUT',
      shot: 'max-cut',
      text: 'The deepest any single event is turned down, however far over its ceiling it peaks.',
      range: '0.0 to −24.0 dB in 0.5 dB steps',
      default: '−8.0 dB',
    },
    {
      label: 'FRIC IN',
      shot: 'fric-in',
      text: 'How fast the cut arrives on a fricative (S, SH, F).',
      details: [
        'Each event gets one steady cut across its body, faded in and out with smooth half-cosine ramps so there is never a click at the edges.',
      ],
      range: '0.5 to 20.0 ms in 0.5 ms steps',
      default: '3.0 ms',
    },
    {
      label: 'FRIC OUT',
      shot: 'fric-out',
      text: 'How fast the cut lets go after a fricative.',
      range: '0.5 to 20.0 ms in 0.5 ms steps',
      default: '4.0 ms',
    },
    {
      label: 'AFFR IN',
      shot: 'affr-in',
      text: 'How fast the cut arrives on an affricate (CH, J).',
      details: [
        'Affricates open with a burst, so they get their own, faster timing to have the reduction in place before it.',
      ],
      range: '0.5 to 20.0 ms in 0.5 ms steps',
      default: '1.5 ms',
    },
    {
      label: 'AFFR OUT',
      shot: 'affr-out',
      text: 'How fast the cut lets go after an affricate.',
      range: '0.5 to 20.0 ms in 0.5 ms steps',
      default: '4.5 ms',
    },
  ],

  notes: [
    'Analyse first: the controls stay unavailable until an analysis exists, and Apply until at least one S or F is above its ceiling.',
    'What you hear in preview is exactly what Apply writes.',
  ],
}
