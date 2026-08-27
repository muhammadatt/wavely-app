export default {
  summary: 'Scales the selection so its loudest peak lands where you set it',

  whenToUse: [
    'A passage is quieter or louder than the rest of the file and you want it to match',
    'You want a predictable peak level before compressing or clipping',
    'A recording is generally quiet and you want more level without changing its dynamics',
  ],

  controls: [
    {
      label: 'Target Peak',
      text: 'Where the loudest sample in the selection ends up, in dBFS',
    },
  ],

  notes: [
    'This is one multiplication applied to every sample, so nothing about the balance of the selection changes — only how loud all of it is',
    'It cannot make a quiet passage sound closer to a loud one, because the gap between them moves with everything else — reach for Opto Comp for that',
    'Mastering re-normalizes the whole file at the end, so a spot normalize is for evening out an edit rather than for hitting a delivery target',
  ],
}
