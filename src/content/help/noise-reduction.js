export default {
  summary: 'Removes background noise, hiss and room tone in one or two cleaning passes.',

  intro: [
    'Noise Reduction removes steady background noise, hiss and room tone from the selection using neural-network noise removal running on our servers. Clean is the transparent first choice for hiss and fans; Deep Clean takes away more, including lip smacks, clicks and bumps, at some cost to the voice.',
    'Use it on a hiss, fan or air conditioner under the voice, room tone too loud for ACX, or mouth noise left after a first pass. It is an offline process: Process cleans the whole selection, and Undo takes it back.',
  ],

  quickStart: [
    'Select the noisy passage, or the whole file.',
    'Start with CLEAN and leave MAX REDUCTION at HEAVY.',
    'Press Process selection, then listen in the editor. Undo puts the original back.',
    'If lip smacks, clicks or bumps remain, undo, choose BOTH and process again.',
    'If the voice sounds watery or the S sounds are dulled, undo, lower MAX REDUCTION or MIX, and process again.',
  ],

  controls: [
    {
      label: 'CLEAN / DEEP CLEAN / BOTH',
      group: 'MODE',
      shot: 'mode',
      text: 'Which cleaning pass, or passes, run on the selection.',
      details: [
        'CLEAN is the transparent pass and the right first choice: it removes hiss, fans, air conditioning and room tone and leaves the voice alone.',
        'DEEP CLEAN takes away more: lip smacks, mouth noise, throat clicks and mic bumps, along with some of the voice, so it is not for every recording.',
        'BOTH runs Clean first and then Deep Clean on what it leaves, the order the ACX Audiobook preset uses.',
        'The line under the tiles describes the chosen mode, and each pass card reads ACTIVE or OFF to match.',
      ],
      range: 'CLEAN, DEEP CLEAN, BOTH',
      default: 'CLEAN',
    },
    {
      label: 'MAX REDUCTION',
      group: 'CLEAN',
      shot: 'max-reduction',
      text: 'The most Clean may take out at any frequency and moment.',
      details: [
        'A lower cap leaves a little noise but keeps more of the edges of S, F and breath sounds. At MAX the pass is uncapped.',
        'Drag the readout, click to type, or double-click to reset. It is dimmed when the mode leaves Clean out.',
      ],
      range: '3 to 47 dB in 1 dB steps, then MAX (uncapped)',
      default: '18 dB',
    },
    {
      label: 'LIGHT / STD / HEAVY / MAX',
      group: 'CLEAN',
      shot: 'tiers',
      text: 'Sets MAX REDUCTION to one of the mastering presets’ tiers in one click.',
      details: [
        'LIGHT, STD and HEAVY are 6, 12 and 18 dB, and MAX is uncapped. The tier lights when the readout matches it.',
      ],
      range: 'LIGHT (6 dB), STD (12 dB), HEAVY (18 dB), MAX',
      default: 'HEAVY',
    },
    {
      label: 'VOICE GUARD',
      group: 'DEEP CLEAN',
      shot: 'voice-guard',
      text: 'Keeps the original audio where speech is detected but Deep Clean would suppress it.',
      details: [
        'Deep Clean can mistake the soft start of an S, F or breathy onset for noise. With the guard on, a separate speech detector restores the original wherever it hears voice that Deep Clean would cut.',
        'It is dimmed when the mode leaves Deep Clean out.',
      ],
      range: 'ON, OFF',
      default: 'ON',
    },
    {
      label: 'MIX',
      shot: 'mix',
      text: 'How much of the cleaned audio to keep.',
      details: [
        'Below 100 % blends the original back in to mask artefacts, at the cost of some of the noise returning.',
        'The blend happens in your browser after the server returns, so a second Process that changes only MIX commits at once with no wait. The same applies to any change the server does not use, for selections up to 10 minutes.',
        'Turn the knob or drag the readout beside it. Double-click either to reset.',
      ],
      range: '0 to 100 % in 1 % steps',
      default: '100 %',
    },
  ],

  notes: [
    'Run it before compression or loudness normalization, since both bring the noise floor up.',
    'Start with CLEAN. Switch to BOTH only if mouth noise or bumps remain, and listen for the voice thinning.',
    'There is no preview: listen after Process, and use Undo to try other settings. While it runs you can Cancel without changing anything.',
    'Noise Reduction is a Pro feature.',
  ],
}
