export default {
  summary: 'Removes background noise, hiss and room tone in one or two cleaning passes',

  whenToUse: [
    'A steady hiss, fan or air conditioner runs under the voice',
    'The room tone between phrases is too loud for ACX',
    'A passage was recorded somewhere noisier than the rest',
  ],

  controls: [
    { label: 'Clean', text: 'The transparent pass and the right first choice: removes hiss, fans, air conditioning and room tone and leaves the voice alone. ON / OFF beside its name' },
    { label: 'Deep Clean', text: 'Takes away more: lip smacks, mouth noise, throat clicks and mic bumps that Clean leaves behind. It also costs more of the voice, so it is not for every recording. With Clean on as well it runs second, as the ACX Audiobook preset does. ON / OFF beside its name' },
    { label: 'Max reduction', text: 'The most Clean may take out at any frequency and moment. Lower keeps more of the edges of S, F and breath sounds; MAX is uncapped' },
    { label: 'Protect consonants', text: 'Keeps the original audio where speech is detected but Deep Clean would suppress it, which is usually the start of an S or F' },
    { label: 'Mix', text: 'How much of the denoised audio to use. Below 100% blends the original back in to hide artefacts, at the cost of some noise' },
    { label: 'Process selection', text: 'Cleans the whole selection on the server and replaces it in one undoable step. While it runs the window shows how far it has got, with a Cancel button' },
  ],

  steps: [
    'Select the noisy passage, or the whole file',
    'Start with Clean on its own. Add Deep Clean if lip smacks, clicks or bumps remain. Then press Process selection',
    'Listen to the result in the editor. Undo puts the original back',
    'If the voice sounds watery or the S sounds are dulled, undo, lower Max reduction or Mix, and process again. If only Mix changed, the second run is instant — the server result is reused',
  ],

  notes: [
    'Noise reduction is an offline process: it runs on the server, so there is no real-time preview and it cannot take a Plugin Chain slot',
    'Run it before compression or loudness normalisation, since both bring the noise floor up',
    'The level is left as the model returned it. It is not re-normalised the way the mastering presets do',
    'Noise Reduction is a Pro feature',
  ],
}
