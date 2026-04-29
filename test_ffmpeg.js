import { runFfmpeg } from './server/lib/exec-ffmpeg.js';

async function test() {
  const inPath = 'impulse.wav';
  const padded = 'impulse_pad.wav';
  const trimmed = 'impulse_trim.wav';

  await runFfmpeg(['-y', '-i', inPath, '-af', 'adelay=delays=10:all=1', '-acodec', 'pcm_f32le', '-ar', '44100', padded]);
  console.log('Padded');
  await runFfmpeg(['-y', '-i', padded, '-af', 'atrim=start=0.010', '-acodec', 'pcm_f32le', '-ar', '44100', trimmed]);
  console.log('Trimmed');
}
test().catch(console.error);
