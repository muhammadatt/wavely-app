export default {
  summary: 'Takes the thump out of P and B sounds and the spit out of hard T, K and P releases, only where they happen',

  whenToUse: [
    'P and B sounds thump or boom: air from the mouth hit the microphone',
    'T, K and P releases spit or click after the silence before them',
    'You want plosives fixed without a high-pass filter thinning the whole voice',
  ],

  controls: [
    { label: 'Pop Depth', text: 'The deepest a P or B thump is taken down, up to 24 dB. Each pop is cut only as far as it stands above the voice, so a mild one gets less. 0 turns the pop stage off' },
    { label: 'Pop Freq', text: 'Where the thump lives: the band below this is what is detected and turned down, 60–250 Hz. Raise it for a boomy close mic, lower it to keep a deep voice’s weight' },
    { label: 'Pop Sensitivity', text: 'How easily a pop is caught. A pop has to jump suddenly in the low band and stand over the voice above it; higher catches milder ones. A deep voice’s steady low end never jumps, so it is left alone at any setting' },
    { label: 'Pop Release', text: 'How quickly the low end comes back after a pop, 15–300 ms' },
    { label: 'Burst Depth', text: 'How far a caught T, K or P release is turned down above Burst Freq, up to 18 dB. 0 turns the burst stage off' },
    { label: 'Burst Freq', text: 'The band above this is cut on a burst, 1.5–8 kHz. Lower takes more of the release’s body; higher only its hiss' },
    { label: 'Burst Sensitivity', text: 'How sharp an onset must be to count as a release. A burst has to come straight out of a stop’s silence and rise suddenly; higher catches softer ones' },
    { label: 'Burst Length', text: 'How long a caught release is held down, 15–80 ms. It lets go early when the vowel after it arrives' },
    { label: 'Output', text: 'Level after the plugin, for matching against bypass' },
    { label: 'Delta', text: 'Hear only what is being removed, from the button in the title bar' },
  ],

  steps: [
    'Play a passage with P, B and T sounds and turn on Delta',
    'You should hear thumps and short spits, not words; raise each Sensitivity until the plosives you can hear are caught',
    'Set each Depth so the plosive sits naturally; too deep and a P loses its punch',
    'Turn Delta off and compare against bypass',
  ],

  notes: [
    'Where nothing is caught the audio passes through untouched, bit for bit',
    'The scope shades every place it acted: amber for pops, lavender for T, K and P releases. The counters show how many of each it has caught since you reset them',
    'An S that starts very abruptly right after a short silence can be caught as a release; lower Burst Sensitivity if an S sounds dulled',
    'The plugin delays the audio by 8 ms so each cut is in place before the plosive starts; Apply removes the delay',
    'For a constant rumble rather than occasional thumps, use a high-pass filter in the EQ instead',
  ],
}
