export default {
  summary: 'A vocal dynamics chain in one panel: a 1176 trims the peaks, an LA-2A levels the voice, a de-esser cleans up, a parallel copy adds density',

  whenToUse: [
    'Narration or dialogue that jumps between quiet and loud',
    'A take whose loudest syllables and plosives stick out',
    'You want the classic 1176-into-LA-2A vocal chain without staging the compressors by hand',
  ],

  controls: [
    {
      label: 'Peak reduction',
      text: 'How hard the 1176 catches the loudest peaks, 0–100: every 10 is about 1 dB off them on typical narration, at any recording level. The ring is green while the stage leaves the voice alone, amber once it starts touching it and red when it is compressing the voice itself. 0 takes the stage out',
    },
    {
      label: 'Attack / release',
      text: 'How fast the 1176 grabs and lets go: AUTO (the default) lets go slowly enough for this voice\'s pitch that the gain does not ripple; NORMAL, FAST and FASTER are fixed timings, faster catching more and risking ripple on low voices. The down arrow steps through them. It also times the parallel copy when Density uses the 1176',
    },
    {
      label: 'Knee',
      text: 'SOFT (4:1, the default) is a gentle peak compressor; HARD (12:1) is a limiter that holds the loudest peaks down hard',
    },
    {
      label: 'Body leveler',
      text: 'How hard the LA-2A levels the voice, 0–100. Its ring turns amber past about 4 dB of average leveling and red past 6. 0 takes the stage out',
    },
    {
      label: 'De-ess',
      text: 'Amount takes down the sibilance the compressors brought up. Band moves it between a wide-band turn-down of the whole "s" (keeps its tone) and a split-band cut of the top end only. 0 takes the stage out',
    },
    {
      label: 'Density',
      text: 'Parallel compression: a compressed copy blended under the voice, so the loudest peaks stay put and the quieter parts come up. Mix sets how much of the copy is blended in (0 takes it out), Drive how hard the copy is compressed, and the switch picks a smooth LA-2A copy (the default) or a fast 1176 copy',
    },
    {
      label: 'Lo Detail',
      text: 'The Cambridge Inflator, anchored at the source\'s peak: lifts the body of the voice under the same peak, with odd harmonics on the loudest syllables. Off by default',
    },
    {
      label: 'Output level',
      text: 'Where the output peak lands: ORIG (the source\'s own peak), −1 dBFS (podcast / streaming) or −3 dBFS (ACX). Makeup is automatic, so there is no output trim',
    },
    {
      label: 'Meter',
      text: 'The needle shows one stage\'s gain reduction at a time: pick PEAK, BODY or DENSITY on the drum, or click a stage\'s title or area. The line under it says what that stage did on this file: how much it took off the loudest peaks and the voice, the average leveling, or the parallel copy\'s makeup',
    },
  ],

  steps: [
    'Select the passage and leave the knobs where they open',
    'Raise Peak reduction until the loudest syllables stop jumping out, keeping the knob in the green',
    'Raise Body leveler until the level stops wandering. Expect it louder than bypass: what the compressors take off the peaks comes back as level',
    'Add Density to taste, and pick the Output level your delivery needs',
  ],

  notes: [
    'The output never goes over the chosen ceiling: each stage makes up its own level and a lookahead limiter holds the peak',
    'The readings under the meter are measured on the selection (up to 30 s while you adjust). "Remeasuring…" shows while a change is being measured',
    'Development stage: Air is not built yet',
  ],
}
