/**
 * Save's encoder, off the main thread: resample, then WAV / FLAC / MP3.
 * A 30-minute chapter takes seconds to tens of seconds to encode, and on the
 * main thread that froze the page — playback, meters and the dialog's own
 * progress — for the whole of it.
 *
 * In:  { channelData: Float32Array[], fromRate, settings }   (buffers transferred)
 * Out: { type: 'progress', stage, fraction } … then
 *      { type: 'done', bytes, mime } (bytes transferred) or { type: 'error', message }
 */
import { encodeAudio } from '../audio/encodeAudio.js'
import mp3WasmUrl from 'wasm-media-encoders/wasm/mp3?url'

self.onmessage = async ({ data }) => {
  const { channelData, fromRate, settings } = data
  let last = 0
  try {
    const { bytes, mime } = await encodeAudio(channelData, fromRate, settings, {
      wasm: new URL(mp3WasmUrl, self.location.href),
      onProgress: (stage, fraction) => {
        // ≤ ~20 messages a second is plenty for a progress readout.
        const now = Date.now()
        if (fraction < 1 && now - last < 50) return
        last = now
        self.postMessage({ type: 'progress', stage, fraction })
      },
    })
    self.postMessage({ type: 'done', bytes, mime }, [bytes.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) })
  }
}
