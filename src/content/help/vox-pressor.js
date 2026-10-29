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
      text: 'How many dB the 1176 takes off the loudest voice peaks. Solved for this file, so 3 dB means 3 dB on any recording level. 0 takes the stage out',
    },
    {
      label: 'Body',
      text: 'How many dB of average leveling the LA-2A does on the voice. Also solved for this file. 0 takes the stage out',
    },
    {
      label: 'Listen',
      text: 'Hear what each compressor listens to instead of the output: rumble and sibilance turned down, and for the LA-2A plosives too',
    },
    {
      label: 'Output',
      text: 'Trim after everything. The output is already level-matched to the input',
    },
  ],

  steps: [
    'Select the passage and leave Peaks and Body where they open',
    'Raise Peaks until the loudest syllables stop jumping out; if the note under it turns amber, the 1176 is reaching into the voice',
    'Raise Body until the level stops wandering, then compare against bypass — both should be about equally loud',
  ],

  notes: [
    'The output is matched to the input\'s level, so the peaks come out lower: that headroom is for Loudness Normalize to use',
    'Peaks always goes where you turn it. When it starts lowering the voice itself, not just the peaks, the note under it turns amber and says by how much',
    'Development stage: this window covers the compressor core only',
  ],
}
