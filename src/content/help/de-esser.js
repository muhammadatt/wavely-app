export default {
  summary: 'Turns each S, SH and CH down only while it sounds, and puts a little air back on the vowels afterwards',

  intro: [
    'The De-Esser turns down S, SH and CH sounds only while they sound, then puts a little air back on the vowels so the voice does not go dull. A lisp guard stops it from ever pulling an S down far enough to sound like a TH',
    'Use it when sibilance pokes out of an otherwise good recording and a static high cut would dull everything else. The frequency strip shows exactly which band the detector listens to, and the activity scope shows every place it acted',
  ],

  quickStart: [
    'Select the passage and press Preview — the plugin opens engaged',
    'Turn on DELTA and raise AMOUNT until what you hear is sibilance and nothing else',
    'If bright vowels come through in DELTA, drag LOW up until they drop out',
    'Move the WIDE BAND / SPLIT BAND slider to taste: left keeps the tone of each S, right takes only its top end',
    'Turn DELTA off, leave AUTO lit on HF RESTORE, compare against bypass and apply',
  ],

  controls: [
    {
      label: 'LOW',
      shot: 'detect-low',
      text: 'Where the detector starts listening — the lower edge of the shaded band in the frequency strip',
      details: [
        'The detector decides when to cut; it does not decide what is cut. Raise LOW when bright vowels trip the cut',
        'Its gain is compensated, so an ordinary S reads the same at any setting and only vowel top end drops out as you raise it',
        'Drag the handle, or focus it and use the arrow keys: 100 Hz a step, 10 Hz with Shift. Double-click resets it',
        'Behind the handles is the live spectrum of the input, so you can see where the S energy sits',
      ],
      range: '3.0 to 8.0 kHz',
      default: '4.0 kHz',
    },
    {
      label: 'HIGH',
      shot: 'detect-high',
      text: 'Where the detector stops listening — the upper edge of the shaded band',
      details: [
        'Lower it to keep air and breath noise out of the detector. At the top of its travel it reads OFF and the detector hears everything above LOW',
        'It always stays at least 1.25 times LOW, so the band never closes',
      ],
      range: '4.0 to 20 kHz, with 20 kHz shown as OFF',
      default: 'OFF',
    },
    {
      label: 'LIVE / MONITOR',
      shot: 'monitor',
      text: 'Chooses between the processed audio and only what the detector hears',
      details: [
        'MONITOR plays the shaded band on its own, so a vowel or breath leaking into it is obvious',
        'It is for listening only. Apply always renders the processed audio',
      ],
      range: 'LIVE, MONITOR',
      default: 'LIVE',
    },
    {
      label: 'OUT',
      shot: 'out-meter',
      text: 'The output level after de-essing, in dBFS',
    },
    {
      label: 'DE-ESS lamp',
      group: 'DE-ESS',
      shot: 'deess-lamp',
      text: 'The lamp beside DE-ESS lights while either stage is cutting',
      details: [
        'It is held for a moment so a short S still shows, and is fully lit at 3 dB of cut',
      ],
    },
    {
      label: 'AMOUNT',
      group: 'DE-ESS',
      shot: 'amount',
      text: 'How much de-essing you get, shared between the two cutting stages by the slider under it',
      details: [
        'The wide band stage turns the whole S down while it lasts, keeping its shape and tone. At full strength it reaches a 4:1 ratio and up to 12 dB of cut',
        'The split band stage then cuts only the top end above 4.5 kHz, on whatever the wide band stage left hot. At full strength it reaches 6:1 and up to 24 dB',
        'Threshold, ratio and depth rise together as you turn it up. The thresholds follow the whole file’s gated RMS, so a setting does the same job on a quiet recording and a hot one',
        'Drag the knob to read its value. Double-click resets it',
      ],
      range: '0 to 100 % in steps of 1',
      default: '60 %',
    },
    {
      label: 'WIDE BAND / SPLIT BAND',
      group: 'DE-ESS',
      shot: 'split',
      text: 'Decides where AMOUNT goes: to the wide band stage, the split band stage, or a mix of the two',
      details: [
        'All the way left, every S is turned down whole and keeps its timbre — usually the most natural sound',
        'All the way right, only the top end of each S is cut, which keeps more of its level but changes its colour',
        'The two stages work in series, so the split band stage only takes what the wide band stage did not',
      ],
      range: 'ALL WIDE to ALL SPLIT, in steps of 1 %',
      default: '67 / 33 (wide / split)',
    },
    {
      label: 'HF RESTORE',
      shot: 'hf-restore',
      text: 'Adds a little top end back after the cut, on the vowels only',
      details: [
        'Removing sibilance makes the whole file sound duller even when no vowel changed, because the S carried most of the file’s top end. This puts some of that impression back',
        'It uses Air Boost’s curve and fades out as each S arrives and in the pauses, so it neither hands the cut back to the sibilants nor lifts room noise',
        'It reads OFF at 0',
      ],
      range: 'OFF to +6.0 dB in 0.1 dB steps',
      default: 'Set by AUTO',
    },
    {
      label: 'AUTO',
      shot: 'air-auto',
      text: 'Lets the plugin set HF RESTORE from a measurement of the selection',
      details: [
        'It measures how much energy above 5 kHz the cut takes off the selection and puts half of it back, so the vowels are not over-brightened to stand in for sibilance that is meant to be gone',
        'It follows every control that changes the cut. Turning the HF RESTORE knob yourself takes over: AUTO goes out and the value stays',
      ],
      range: 'On, Off',
      default: 'On',
    },
    {
      label: 'LISP GUARD',
      shot: 'lisp-guard',
      text: 'Stops any S being pulled further below the voice than a normal S sits, so heavy settings cannot turn S into TH',
      details: [
        'It sets a floor relative to the held voice level (measured between 200 Hz and 3 kHz), from −22 dB at 1 % to −10 dB at 100 %. No cut may take an S below it',
        'It limits the total of both stages. Flatter fricatives such as F, which sit naturally quieter and cannot lisp, get less of it, so a hot F can still be reduced',
        'Higher is stricter, for a naturally dark or lispy voice. Lower lets a hot, strident S go deeper. 0 turns it off and the readout shows OFF',
      ],
      range: 'OFF to 100 % in steps of 1',
      default: '100 % (a −10 dB floor)',
    },
    {
      label: 'REDUCTION',
      shot: 'reduction',
      text: 'How much the plugin just took off an S, in total and split into DUCK (the wide band stage) and EQ (the split band stage)',
      details: [
        'Each figure holds its peak for a second and then falls at 6 dB per second, so a 30 ms S stays on screen long enough to read',
        'SOFT reads OFF: the onset softener is not in use on this panel',
      ],
    },
    {
      label: 'Activity scope',
      shot: 'scope',
      text: 'The output waveform around the playhead, shaded wherever the plugin de-essed',
      details: [
        'The playhead is at the centre: what has played is to its left, what is coming to its right. How strongly a region is shaded follows how deep the cut went',
        'A white bar along the bottom marks where the lisp guard held a cut back',
        'It freezes on what last played while the transport is stopped, and starts over if playback resumes somewhere else. Click it to start playback',
      ],
    },
    {
      label: 'DELTA',
      text: 'Plays only what is being removed, from the button in the title bar',
      details: [
        'It should sound like sibilance and nothing else. Vowels or breath in it mean AMOUNT is too high or LOW too low',
        'It never includes the HF RESTORE lift, and it is for listening only: Apply always renders the processed audio',
      ],
      range: 'On, Off',
      default: 'Off',
    },
  ],

  notes: [
    'Below threshold the cut sits at exactly 0 dB, so quiet material passes through untouched',
    'The cut lets go within about 10 ms as each vowel starts, so the sound after an S keeps its top end',
    'A sibilant alone in a gap is treated a little harder than one inside a word: the threshold rises slightly with the surrounding vowel energy',
    'There is no added latency: the preview and the applied result are sample-identical',
  ],
}
