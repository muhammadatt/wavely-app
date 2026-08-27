export default {
  summary: 'Measures a voice recording and corrects the tonal problems it finds',

  whenToUse: [
    'A recording sounds wrong and you cannot name which frequency is at fault',
    'You want a starting point before shaping tone by hand',
    'You are checking a take for problems before mastering it',
  ],

  controls: [
    { label: 'ANALYZE', text: 'Measures the selection and applies what it finds' },
    { label: 'Findings list', text: 'One switch per correction — each can be turned off, and soloed to hear it alone' },
    { label: 'APPLY ALL', text: 'Turns every suggested correction back on' },
    { label: 'CLEAR', text: 'Turns them all off, leaving the analysis in place' },
    { label: 'TRANSFER TO EQ', text: 'Moves the corrections into the EQ plugin, where they become ordinary bands' },
  ],

  steps: [
    'Select a stretch that is representative of the whole take, including some pauses',
    'Press ANALYZE — the corrections are applied immediately, so the first thing you hear is the corrected version',
    'Switch individual findings off if you disagree with them',
    'Apply, or transfer to the EQ if you want to shape them further',
  ],

  notes: [
    'Nothing touches the file until you apply — the findings are live monitoring until then',
    'It reports what it measured rather than a score, and a finding is a suggestion rather than a fault',
    'It is deliberately conservative: it would rather miss a problem than invent one on a recording that is already fine',
    'Transferring to the EQ moves the bands rather than copying them, so the same correction cannot be applied twice',
  ],
}
