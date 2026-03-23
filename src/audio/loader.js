/**
 * Audio file loader — decodes audio files to AudioBuffer.
 */
export async function decodeAudioFile(file, audioContext) {
  const arrayBuffer = await file.arrayBuffer()
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
  return audioBuffer
}

/**
 * Supported file extensions.
 */
export const SUPPORTED_FORMATS = ['mp3', 'wav', 'ogg', 'm4a', 'flac']

/**
 * Check if a file is a supported audio format.
 */
export function isSupportedFormat(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  return SUPPORTED_FORMATS.includes(ext)
}
