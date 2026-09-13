/**
 * Tube Saturation behind the "Modula" faceplate — the UI evaluation duplicate.
 *
 * Derived from `vocal-saturation.js` rather than copied: the plugin is the
 * same and so is every explanation, only three controls carry different names
 * on this face. Goes with `VocalSaturationModulaWindow.vue`; remove both
 * together.
 */
import base from './vocal-saturation.js'

const RENAMED = {
  'Asymmetry mode': 'Asym Mode',
  'Low Drive': 'Band Drive · Low',
  'Mid Drive': 'Band Drive · Mid',
  'High Drive': 'Band Drive · High',
}

export default {
  summary: 'Tube Saturation in the Modula faceplate — the same saturator, a different face',

  whenToUse: [
    'You want to compare this faceplate against the shipping Tube Sat on the same audio',
    ...base.whenToUse.slice(0, 2),
  ],

  controls: [
    ...base.controls.map(c => ({ label: RENAMED[c.label] ?? c.label, text: c.text })),
    { label: 'Power', text: 'Engages or bypasses the whole unit — the face dims while bypassed' },
  ],

  steps: base.steps,

  notes: [
    'Every setting is shared with the regular Tube Sat window — a change here is a change there',
    'Topology sits in the header because it changes what every other control means',
    ...base.notes,
  ],
}
