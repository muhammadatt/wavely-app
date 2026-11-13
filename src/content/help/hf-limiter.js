export default {
  summary: 'Holds the top end at a ceiling, providing firm control of brightness, harshness and sharp edges.',

  intro: [
    'The Hi-Freq Limiter is an adaptive, transparent, high-frequency attenuator that tames harshness while preserving tone. Brightness, harshness, sibilance and sharp clicks are held down only at the loudest moments, while preserving full detail below the threshold. TIGHT mode provides nearly transparent HF reduction, while WARM mode offers a subtle warm, natural curve based a well-known analog compressor emulation.',
    'Use it to control bright transients or sibilant spikes without causing dullness or drastic changes in overall tone.',
  ],

  quickStart: [
    'Select a bright passage and open the window — it opens engaged.',
    'Active DELTA mode so you can hear the audio being removed.', 
    'Play the audio and lower the Threshold until you can hear the harshness being removed.',
    'Use FREQ to adjust the frequency cutoff and RANGE to determine the depth of the attenuation.',
    'Raise the Transient knob in necessary to provide additional softening on fast attacks or consonant onsets.',
    'Turn DELTA off, use ON/BYPASS to compare before and after, then Apply to selection.',
  ],

  controls: [
    {
      label: 'Threshold',
      shot: 'threshold',
      text: 'The ceiling for the band above Freq, in dB relative to your file’s voice level.',
      details: [
        'The voice level is the whole file’s gated RMS, measured when the window opens, so one setting does the same job on a quiet recording and a hot one.',
        'When the band rises above the threshold the shelf turns it down just enough to hold it there. Below the threshold, with Transient off, the audio passes through untouched, bit for bit.',
        'The detector looks 1 ms ahead, so the cut is in place before a bright moment arrives and nothing overshoots the ceiling.',
        'Drag the knob or click the amber value under it to type one.',
      ],
      range: '−30 to +12 dB in 0.5 dB steps',
      default: '−8.0 dB',
    },
    {
      label: 'Shape',
      shot: 'shape',
      text: 'Chooses how the band is split from the rest of the voice.',
      details: [
        'TIGHT is a one-octave, linear-phase split: a true ceiling on the band above Freq that leaves everything below it alone and never rings or smears the voice.',
        'WARM is a gentle 6 dB per octave split, the tilt of a Fatso-style Warmth control: the whole top end leans down, starting an octave or more below Freq.',
        'WARM listens to more of the spectrum than TIGHT, so at the same Threshold it cuts more often. Switching shape never moves the audio in time.',
      ],
      range: 'TIGHT, WARM',
      default: 'WARM',
    },
    {
      label: 'HF REDUCTION',
      shot: 'meter',
      text: 'Shows how far the shelf is cutting right now, on a scale to −24 dB, with the reading in dB above it.',
    },
    {
      label: 'Curve',
      shot: 'curve',
      text: 'Draws the shelf being applied right now, with the deepest cut Range allows dashed behind it.',
      details: [
        'The dashed vertical line marks Freq. The axis runs from 500 Hz to 20 kHz.',
        'Drag the amber node: left and right set Freq, up and down set Range.',
      ],
    },
    {
      label: 'Freq',
      shot: 'freq',
      text: 'Where bright starts: the band above it is what the limiter listens to and turns down.',
      details: [
        'Around 5 to 8 kHz catches sibilance and harshness; higher settings leave the voice’s presence alone and work only on hiss and air.',
        'Type a value as 6500 or 6.5k.',
      ],
      range: '2.00 to 12.0 kHz in 10 Hz steps',
      default: '12.0 kHz',
    },
    {
      label: 'Range',
      shot: 'range',
      text: 'The deepest the shelf may cut, however far the band goes over Threshold.',
      details: [
        'It keeps a hard S from turning into a lisp. At 0 the shelf is out and only Transient can act.',
      ],
      range: 'OFF to −24 dB in 0.5 dB steps',
      default: '−12.0 dB',
    },
    {
      label: 'Transient',
      shot: 'transient',
      text: 'Extra cut on sudden bright onsets — clicks, lip smacks, T, K and P bursts — even ones below Threshold.',
      details: [
        'It reacts to how suddenly the top end rises, not how loud it is, so a steady S is left to the shelf, and it lets go within milliseconds.',
        'It stacks on top of the shelf: Range limits only the shelf, so the two together can briefly cut deeper than Range.',
        'It ignores anything more than 24 dB below Threshold. The lamp beside the name lights while it acts.',
      ],
      range: 'OFF to −12 dB in 0.5 dB steps',
      default: 'OFF',
    },
    {
      label: 'Release',
      shot: 'release',
      text: 'How quickly the top end comes back after a bright moment.',
      details: [
        'Short settings recover between syllables; long ones hold the top down across a phrase and are less likely to pump.',
      ],
      range: '5 to 300 ms in 1 ms steps',
      default: '60 ms',
    },
    {
      label: 'Output',
      shot: 'output',
      text: 'A level trim after the limiter, for matching against bypass.',
      range: '−12 to +12 dB in 0.1 dB steps',
      default: '0.0 dB',
    },
    {
      label: 'IN / OUT',
      shot: 'in-out',
      text: 'Show the level going into and coming out of the effect.',
    },
    {
      label: 'DELTA',
      text: 'The pill in the title bar plays only what is being removed.',
      details: [
        'It should sound like hiss, sibilance and edges, not voice. It is for listening only; Apply always renders the processed audio.',
      ],
      range: 'On, Off',
      default: 'Off',
    },
  ],

  notes: [
    'Click any amber value to type an exact one, and double-click a knob to reset it.',
    'For sibilance on its own, the De-Esser is the better tool. Use this as a general-purpose ceiling on the top end.',
    'If an S that starts abruptly after silence sounds blunted, lower Transient.',
    'For a Fatso-style Warmth sound, start from WARM, Freq 2.30 kHz, Threshold −1.0 dB, Range −16.0 dB, Release 30 ms and Output +0.7 dB.',
  ],
}
