export default {
  summary: 'A 1176 trims the voice peaks, then an LA-2A levels the voice — both listening through a voice detector',

  whenToUse: [
    'Narration or dialogue that jumps between quiet and loud',
    'A take whose loudest syllables and plosives stick out',
    'You want the classic 1176-into-LA-2A vocal chain without staging two compressors by hand',
  ],

  controls: [
    {
      label: 'Peaks',
      text: 'How hard the 1176 catches the loudest peaks, 0–10: about that many dB off them on typical narration, at any recording level. A peakier voice gives up more; the note under it says what it took on this file. 0 takes the stage out',
    },
    {
      label: 'Body',
      text: 'The LA-2A\'s Peak Reduction, aligned the same way. The note under it says how many dB of average leveling it does on the voice. 0 takes the stage out',
    },
    {
      label: 'Listen',
      text: 'Hear what each compressor listens to instead of the output: rumble turned down for both, and for the LA-2A plosives and sibilance too',
    },
    {
      label: 'Output',
      text: 'Trim after everything. Makeup is automatic: the output peak goes back to where the source peak was',
    },
  ],

  steps: [
    'Select the passage and leave Peaks and Body where they open',
    'Raise Peaks until the loudest syllables stop jumping out. If the note under it turns amber, the 1176 is reaching into the voice',
    'Raise Body until the level stops wandering. Expect it louder than bypass: what the compressors take off the peaks comes back as level',
  ],

  notes: [
    'The output peak lands where the source peak was, so the voice comes out louder by roughly what Peaks took (about 3 dB at the default on narration)',
    'Peaks always goes where you turn it. When it starts lowering the voice itself, not just the peaks, the note under it turns amber and says by how much',
    'Development stage: this window covers the compressor core only',
  ],
}
