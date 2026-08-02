/**
 * Minimal ZIP writer — store method only, no compression.
 *
 * Deliberately dependency-free. WAV PCM barely compresses (a few percent at
 * best) and DEFLATE on several hundred MB of audio in the main thread would
 * cost far more than it saves, so "store" is the right method here anyway.
 * That makes the whole format a header, a per-file record, and a central
 * directory — about a hundred lines, versus pulling in a zip library.
 *
 * Zip64 is not implemented: sizes and offsets are 32-bit, so the archive and
 * every file in it must stay under 4 GB. Callers should check before building.
 */

/** Largest archive this writer can address without zip64. */
export const ZIP_SIZE_LIMIT = 0xffffffff

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS date/time, which is what the zip format stores. */
function dosDateTime(date) {
  const time =
    (Math.floor(date.getSeconds() / 2) & 0x1f) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getHours() & 0x1f) << 11)
  const day =
    (date.getDate() & 0x1f) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    ((Math.max(0, date.getFullYear() - 1980) & 0x7f) << 9)
  return { time, day }
}

/**
 * Build a ZIP archive.
 * @param {{ name: string, data: ArrayBuffer|Uint8Array }[]} files
 * @returns {Blob}
 */
export function createZip(files) {
  const encoder = new TextEncoder()
  const { time, day } = dosDateTime(new Date())

  const parts = []          // Blob parts, in order
  const central = []        // central directory records
  let offset = 0

  for (const file of files) {
    const nameBytes = encoder.encode(file.name)
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data)
    const crc = crc32(data)

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)   // signature
    lv.setUint16(4, 20, true)           // version needed
    // Bit 11 marks the filename as UTF-8, so non-ASCII names survive.
    lv.setUint16(6, 0x0800, true)
    lv.setUint16(8, 0, true)            // method: store
    lv.setUint16(10, time, true)
    lv.setUint16(12, day, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true) // compressed size
    lv.setUint32(22, data.length, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)           // extra field length
    local.set(nameBytes, 30)

    parts.push(local, data)

    // Central directory record for this entry
    const cd = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)   // signature
    cv.setUint16(4, 20, true)           // version made by
    cv.setUint16(6, 20, true)           // version needed
    cv.setUint16(8, 0x0800, true)       // UTF-8 flag
    cv.setUint16(10, 0, true)           // method: store
    cv.setUint16(12, time, true)
    cv.setUint16(14, day, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)           // extra field length
    cv.setUint16(32, 0, true)           // comment length
    cv.setUint16(34, 0, true)           // disk number
    cv.setUint16(36, 0, true)           // internal attributes
    cv.setUint32(38, 0, true)           // external attributes
    cv.setUint32(42, offset, true)      // offset of local header
    cd.set(nameBytes, 46)
    central.push(cd)

    offset += local.length + data.length
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0)

  // End of central directory
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(4, 0, true)                 // disk number
  ev.setUint16(6, 0, true)                 // disk with central directory
  ev.setUint16(8, files.length, true)      // entries on this disk
  ev.setUint16(10, files.length, true)     // total entries
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)           // central directory offset
  ev.setUint16(20, 0, true)                // comment length

  return new Blob([...parts, ...central, end], { type: 'application/zip' })
}
