export default {
  summary: 'Evens out the level between phrases, leaving the dynamics inside each phrase alone',

  whenToUse: [
    'Some sentences sit noticeably quieter than others in the same take',
    'You drifted off-mic or changed delivery part-way through a session',
    'A compressor is working too hard because the level going into it wanders',
    'Chapters have to match each other and one of them rides low',
  ],

  quickStart: [
    'Select at least 10 seconds holding at least 5 seconds of speech — usually the whole chapter',
    'Leave WHOLE SELECTION chosen unless the take changes level on purpose, then pick ROLLING',
    'Press Apply to selection. Speech detection, the phrase analysis and the render run in one go and replace the selection in one undoable step',
    'Listen in the editor and read LAST RUN when you reopen the window. Undo puts the original back',
    'If phrases you can hear as uneven were left alone, undo, lower DEADBAND and apply again',
  ],

  controls: [
    {
      label: 'WHOLE SELECTION / ROLLING',
      group: 'TARGET',
      shot: 'target',
      text: 'What each phrase is levelled towards: one level held across the whole selection, or a moving median that follows the delivery',
      details: [
        'WHOLE SELECTION takes the median loudness of every phrase in the selection as the one target. Use it to make a passage, or two separately levelled passages, sit at one level',
        'ROLLING compares each phrase with the median of the speech around it, over the time set by WINDOW, so a deliberate change in delivery across a chapter survives',
        'The line under the tiles describes the chosen target',
      ],
      range: 'WHOLE SELECTION, ROLLING',
      default: 'WHOLE SELECTION',
    },
    {
      label: 'DEADBAND',
      group: 'PHRASES',
      shot: 'deadband',
      text: 'How far a phrase may sit from the target before it is touched at all',
      details: [
        'Inside the band a phrase keeps its level exactly. Outside it, the phrase is moved back to the edge of the band, not all the way to the target, so natural variation survives',
        'If every phrase already sits inside the deadband the leveler declines and changes nothing',
        'Drag the readout, click to type, or double-click to reset',
      ],
      range: '0 to 6 dB in 0.05 dB steps',
      default: '0.75 dB',
    },
    {
      label: 'KNEE',
      group: 'PHRASES',
      shot: 'knee',
      text: 'How gradually the correction fades in past the deadband',
      details: [
        'Across the knee the correction eases in on a smooth curve rather than jumping, so two phrases a fraction of a dB apart do not get very different treatment',
      ],
      range: '0.1 to 6 dB in 0.1 dB steps',
      default: '1.0 dB',
    },
    {
      label: 'WINDOW',
      group: 'PHRASES',
      shot: 'window',
      text: 'How much surrounding speech the rolling median looks at',
      details: [
        'It only applies with ROLLING chosen, and is dimmed under WHOLE SELECTION. A shorter window follows the delivery more closely and levels less',
      ],
      range: '10 to 120 s in 5 s steps',
      default: '60 s',
    },
    {
      label: 'MAX BOOST',
      group: 'LIMITS',
      shot: 'max-boost',
      text: 'The most any phrase is lifted',
      range: '0 to 18 dB in 0.5 dB steps',
      default: '10.0 dB',
    },
    {
      label: 'MAX CUT',
      group: 'LIMITS',
      shot: 'max-cut',
      text: 'The most any phrase is turned down',
      range: '0 to 18 dB in 0.5 dB steps',
      default: '10.0 dB',
    },
    {
      label: 'FLOOR',
      group: 'LIMITS',
      shot: 'floor',
      text: 'The room-tone level a boost is not allowed to push past',
      details: [
        'Lifting a quiet phrase lifts the room tone under it too. The selection’s noise floor is measured during speech detection, and boosts are capped so the room tone stays under this level — which can hold the boost below MAX BOOST',
        'At the default the room tone stays within the ACX limit of −60 dBFS',
      ],
      range: '−80 to −40 dBFS in 1 dB steps',
      default: '−60 dBFS',
    },
    {
      label: 'LAST RUN',
      shot: 'last-run',
      text: 'What the last Apply did, measured on the levelled audio',
      details: [
        'PHRASES is how many phrases were levelled. SPREAD is how far apart their loudness was before and after, as a standard deviation in dB. GAIN is the largest cut and the largest boost applied',
        'When the leveler declines it says why: a selection under 10 seconds, under 5 seconds of speech, only one phrase, or everything already inside the deadband',
        'When the floor capped the boost it says by how much',
      ],
    },
  ],

  notes: [
    'Gain is flat within a phrase, so the dynamics you performed inside a sentence survive exactly. Gain changes happen in 30 ms crossfades placed at the quietest point between phrases',
    'Phrases come from speech detection on the server; a long phrase is split where its level drops by 6 dB or more for at least half a second',
    'Where two neighbouring phrases would end up more than 6 dB apart, both are given their average instead — a step that large is usually the analysis being wrong about where a phrase ended',
    'Run it before compression, not after — it hands the compressor a steady input',
    'It is an offline process: there is no preview, and it cannot go in the Plugin Chain',
    'Auto Leveler is a Pro feature',
  ],
}
