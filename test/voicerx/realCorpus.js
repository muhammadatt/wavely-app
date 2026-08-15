/**
 * The real-audio corpus: loading, excerpting, and what to expect from it.
 *
 * WHAT THESE FILES ARE FOR. The synthetic corpus can plant a defect and know
 * the exact right answer, which is why it exists — but it can only be as clean
 * as the voice model, and that model has already been wrong twice in ways only
 * a more sensitive detector caught (a fixed F4 at Q 23, then F3 clustered inside
 * a fifth of an octave). A commercially mastered recording cannot be wrong about
 * what a voice looks like. It carries real formant motion, real room tone, real
 * breath and sibilance, and whatever fine structure a mastering chain leaves —
 * all the things that made a detector scoring well on synthetics emit ten bands
 * on a real clip.
 *
 * WHAT "EXPECT NOTHING" DOES AND DOES NOT MEAN. These files are finished to
 * commercial standard, so the working assumption is that a correction offered
 * on one is a correction that should not have been offered. That assumption is
 * strong but not absolute, and it fails in two specific ways worth keeping in
 * mind while reading any number this produces:
 *
 *  - A mastering engineer applied deliberate tonal shaping. A detector flagging
 *    it is arguably wrong — the professional left it there — but it is a
 *    judgement, not a fact.
 *  - Some finished files contain surgical cuts. The clip that started this whole
 *    investigation is an artist's test file with a 17.6 dB notch at 5 kHz. A
 *    file like that is a NOTCH case, not a clean control, and a detector
 *    reporting the notch is right rather than wrong.
 *
 * So this reports what each detector claims and leaves the reading to a person.
 * It deliberately does not score a pass or a fail.
 *
 * Audio lives in data/corpus/voicerx/, which is gitignored — the same
 * arrangement referenceEQ uses for its own corpus. Commercial audiobook audio
 * must never be committed; only numbers derived from it may be.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readWav } from './wav.js'

export const CORPUS_DIR = 'data/corpus/voicerx'

/**
 * Seconds trimmed from each end before excerpting.
 *
 * ACX requires room tone padding at the head and tail — 0.75 s and up to 5 s —
 * and many finished files open on a title card or a beat of silence. Analysing
 * from sample zero would feed the detector a window that is mostly room tone,
 * whose F0 tracker finds nothing and whose noise floor is the whole signal.
 * Ten seconds clears the padding on any file long enough to matter.
 */
const EDGE_TRIM_SECONDS = 10

/**
 * List the corpus. Empty array when the directory does not exist, so a caller
 * can print instructions rather than crash.
 */
export function listCorpus(dir = CORPUS_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => /\.wav$/i.test(f))
    .sort()
    .map(f => ({ name: f, path: join(dir, f) }))
}

/**
 * Cut evenly spaced excerpts from one file.
 *
 * MORE THAN ONE WINDOW PER FILE, on purpose. A single excerpt from a
 * thirty-minute chapter is one sample of a passage, and a narrator's tone
 * genuinely moves across a session. If a detector says different things about
 * minute 2 and minute 20 of the same finished file, that is a finding about the
 * detector's stability on real material — the same question the split-half
 * confidence term asks inside a single analysis, asked at a scale the analysis
 * cannot see.
 *
 * Falls back to one centred window when the file is too short to divide.
 */
export function excerpts(file, { seconds = 45, windows = 3 } = {}) {
  const audio = readWav(file.path)
  const { mono, sampleRate } = audio
  const trim = Math.min(EDGE_TRIM_SECONDS * sampleRate, Math.floor(mono.length * 0.1))
  const usableStart = trim
  const usableEnd = mono.length - trim
  const want = Math.round(seconds * sampleRate)

  const out = []
  if (usableEnd - usableStart < want) {
    // Too short to divide: take the middle of whatever there is.
    const len = Math.min(mono.length, want)
    const start = Math.max(0, Math.floor((mono.length - len) / 2))
    out.push({ index: 0, startSeconds: start / sampleRate, audio: mono.subarray(start, start + len) })
  } else {
    const span = usableEnd - usableStart
    const n = Math.max(1, Math.min(windows, Math.floor(span / want)))
    for (let i = 0; i < n; i++) {
      // Evenly spaced by window CENTRE, so the excerpts sample the file's whole
      // span rather than bunching at its opening.
      const centre = usableStart + (span * (i + 0.5)) / n
      const start = Math.round(Math.max(usableStart, Math.min(usableEnd - want, centre - want / 2)))
      out.push({ index: i, startSeconds: start / sampleRate, audio: mono.subarray(start, start + want) })
    }
  }

  return { audio, windows: out }
}

/**
 * Level of the quietest frames, in dBFS.
 *
 * The mask is a RATIO — voiced spectrum over pause spectrum — and a ratio
 * cannot tell you whether its denominator is real room tone or silence someone
 * edited in. Those two want opposite treatment: real room tone makes the SNR
 * measurement meaningful, while gated or replaced silence makes it enormous and
 * meaningless, and a mask reading 100% live everywhere is then not a finding
 * about the recording but a symptom of having nothing to compare against.
 *
 * ACX permits noise floors down to -60 dBFS and requires room tone rather than
 * digital silence, so a floor far below that is evidence the pauses were
 * processed.
 */
export function quietLevelDbfs(audio, frameSize = 2048, hop = 512) {
  const energies = []
  for (let s = 0; s + frameSize <= audio.length; s += hop) {
    let sumSq = 0
    for (let i = 0; i < frameSize; i++) sumSq += audio[s + i] * audio[s + i]
    energies.push(Math.sqrt(sumSq / frameSize))
  }
  if (!energies.length) return NaN
  energies.sort((a, b) => a - b)
  const p15 = energies[Math.floor(energies.length * 0.15)]
  return Math.round(20 * Math.log10(p15 + 1e-12) * 10) / 10
}

/**
 * How the SNR mask behaved — the thing to check before trusting any other
 * number from mastered material.
 *
 * v2 decides which frequencies carry voice by subtracting the pause-frame
 * spectrum from the voiced-frame spectrum. Mastering compresses and limits
 * hard, which lifts the noise floor in the pauses, so the measured SNR on a
 * finished file is smaller than on a raw one by an amount nobody has measured.
 * If it collapses far enough the mask starts excluding real voice, and every
 * number downstream is then describing a spectrum with holes punched in it.
 *
 * ACX mandates room tone and a floor below -60 dBFS, so the pauses should be
 * there. That is a reason to expect this to work, not a reason to skip checking.
 */
export function maskHealth(analysis) {
  if (!analysis?.ok) return null

  const { freqsHz, mask, snrDb, noiseFloorMeasured } = analysis
  let live = 0
  let total = 0
  let topLiveHz = 0
  const speechBandSnr = []

  for (let i = 0; i < freqsHz.length; i++) {
    const f = freqsHz[i]
    if (f < 60 || f > 16000) continue
    total++
    if (mask[i]) {
      live++
      topLiveHz = f
      if (f >= 200 && f <= 6000 && Number.isFinite(snrDb[i])) speechBandSnr.push(snrDb[i])
    }
  }

  speechBandSnr.sort((a, b) => a - b)
  return {
    noiseFloorMeasured,
    liveFraction: total ? live / total : 0,
    topLiveHz: Math.round(topLiveHz),
    medianSpeechSnrDb: speechBandSnr.length
      ? Math.round(speechBandSnr[speechBandSnr.length >> 1] * 10) / 10
      : null,
  }
}
