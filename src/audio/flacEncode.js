/**
 * FLAC encoding — lossless, in plain JS, no dependency.
 *
 * FLAC is an open, fully specified format (RFC 9639) and a correct encoder for
 * it is small: fixed linear predictors of order 0–4 with partitioned Rice
 * coding of the residual, plus stereo decorrelation. That is the whole of what
 * this writes. It leaves out LPC subframes (libFLAC's main advantage), so files
 * come out a few percent larger than `flac -5` would make them — every byte
 * still decodes to exactly the samples that went in, which is what a narrator
 * keeping a master needs. A ~1 MB Emscripten build of libFLAC would buy those
 * few percent.
 *
 * Pure and dependency-free so `node --test` can round-trip it through a
 * decoder in the test suite.
 *
 * What is written:
 *   - 'fLaC' + one STREAMINFO block (MD5 left zero, which the spec defines as
 *     "not computed")
 *   - fixed-blocksize frames of 4096 samples (the last one shorter)
 *   - per channel: CONSTANT, VERBATIM or FIXED order 0–4, whichever is
 *     estimated smallest
 *   - stereo: independent, left/side, right/side or mid/side per frame,
 *     whichever is estimated smallest
 *   - residual: Rice (4-bit parameters) or Rice2 (5-bit) when a partition
 *     needs a parameter above 14, partition order 0–8 chosen per subframe
 */
import { toIntSamples } from './wavEncode.js'

export const FLAC_BLOCK_SIZE = 4096
const MAX_PARTITION_ORDER = 8

// ── Bit writer ──────────────────────────────────────────────────────────────

class BitWriter {
  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(capacity)
    this.pos = 0
    this.acc = 0
    this.nacc = 0
  }

  grow(extra) {
    let cap = this.buf.length * 2
    while (cap < this.pos + extra) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
  }

  /** Up to 16 bits; `v` must already fit in `n` bits. */
  put(v, n) {
    if (this.pos + 4 > this.buf.length) this.grow(4)
    this.acc = (this.acc << n) | v
    this.nacc += n
    while (this.nacc >= 8) {
      this.nacc -= 8
      this.buf[this.pos++] = (this.acc >>> this.nacc) & 0xff
    }
    this.acc &= (1 << this.nacc) - 1
  }

  /** Up to 32 bits, unsigned. */
  bits(v, n) {
    if (n > 16) {
      const lo = n - 16
      this.put(Math.floor(v / 2 ** lo) & 0xffff, 16)
      this.put(v % 2 ** lo, lo)
    } else if (n > 0) {
      this.put(v, n)
    }
  }

  /** Two's complement in `n` bits. */
  signed(v, n) {
    this.bits(v < 0 ? v + 2 ** n : v, n)
  }

  unary(q) {
    while (q >= 16) { this.put(0, 16); q -= 16 }
    this.put(1, q + 1)
  }

  alignByte() {
    if (this.nacc > 0) this.put(0, 8 - this.nacc)
  }

  bytes() {
    return this.buf.slice(0, this.pos)
  }
}

// ── CRCs ────────────────────────────────────────────────────────────────────

const CRC8 = new Uint8Array(256)
const CRC16 = new Uint16Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let b = 0; b < 8; b++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff
  CRC8[i] = c
  let d = i << 8
  for (let b = 0; b < 8; b++) d = (d & 0x8000) ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff
  CRC16[i] = d
}

function crc8(buf, start, end) {
  let c = 0
  for (let i = start; i < end; i++) c = CRC8[c ^ buf[i]]
  return c
}

function crc16(buf, start, end) {
  let c = 0
  for (let i = start; i < end; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ buf[i]]
  return c
}

// ── Prediction and Rice cost ────────────────────────────────────────────────

/** Fixed-predictor residual of `x` at `order`, for indices order..n-1. */
function fixedResidual(x, order, out) {
  const n = x.length
  switch (order) {
    case 0: for (let i = 0; i < n; i++) out[i] = x[i]; break
    case 1: for (let i = 1; i < n; i++) out[i - 1] = x[i] - x[i - 1]; break
    case 2: for (let i = 2; i < n; i++) out[i - 2] = x[i] - 2 * x[i - 1] + x[i - 2]; break
    case 3: for (let i = 3; i < n; i++) out[i - 3] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break
    case 4: for (let i = 4; i < n; i++) out[i - 4] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]; break
  }
  return n - order
}

/** Best Rice parameter and its approximate cost in bits for `count` values summing to `sum`. */
function riceParam(sum, count) {
  if (count === 0) return { k: 0, bits: 0 }
  if (sum === 0) return { k: 0, bits: count }
  const est = Math.max(0, Math.floor(Math.log2(sum / count)))
  let best = null
  for (let k = Math.max(0, est - 1); k <= Math.min(30, est + 1); k++) {
    const bits = count * (k + 1) + Math.floor(sum / 2 ** k)
    if (!best || bits < best.bits) best = { k, bits }
  }
  return best
}

/**
 * Choose the partition order and per-partition parameters for a residual.
 * `u` holds zigzagged residuals for block indices order..blockSize-1.
 */
function planResidual(u, count, blockSize, order) {
  let maxP = 0
  while (maxP < MAX_PARTITION_ORDER
    && blockSize % (1 << (maxP + 1)) === 0
    && (blockSize >> (maxP + 1)) > order) maxP++

  // Sums at the finest order, then merged pairwise for each coarser one.
  const parts = 1 << maxP
  const size = blockSize >> maxP
  let sums = new Float64Array(parts)
  let counts = new Int32Array(parts)
  let idx = 0
  for (let p = 0; p < parts; p++) {
    const n = p === 0 ? size - order : size
    let s = 0
    for (let i = 0; i < n; i++) s += u[idx++]
    sums[p] = s
    counts[p] = n
  }

  let best = null
  for (let p = maxP; p >= 0; p--) {
    const ks = new Int32Array(sums.length)
    let bits = 0
    let rice2 = false
    for (let j = 0; j < sums.length; j++) {
      const r = riceParam(sums[j], counts[j])
      ks[j] = r.k
      bits += r.bits
      if (r.k > 14) rice2 = true
    }
    bits += 6 + sums.length * (rice2 ? 5 : 4)
    if (!best || bits < best.bits) best = { order: p, ks, bits, rice2 }
    if (p > 0) {
      const ns = new Float64Array(sums.length / 2)
      const nc = new Int32Array(sums.length / 2)
      for (let j = 0; j < ns.length; j++) {
        ns[j] = sums[2 * j] + sums[2 * j + 1]
        nc[j] = counts[2 * j] + counts[2 * j + 1]
      }
      sums = ns
      counts = nc
    }
  }
  return best
}

/**
 * Pick the cheapest subframe for one channel of a block.
 * @returns {{ type: 'constant'|'verbatim'|'fixed', bits: number, order?: number, u?: Uint32Array, plan?: object }}
 */
function analyzeSubframe(x, sbps, scratch) {
  const n = x.length
  let constant = true
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break }
  if (constant) return { type: 'constant', bits: 8 + sbps }

  const verbatim = { type: 'verbatim', bits: 8 + n * sbps }
  if (n <= 4) return verbatim

  // Order by summed |residual| over a common range, as libFLAC does.
  let bestOrder = 0
  let bestSum = Infinity
  for (let order = 0; order <= 4; order++) {
    const m = fixedResidual(x, order, scratch)
    let s = 0
    for (let i = 4 - order; i < m; i++) s += Math.abs(scratch[i])
    if (s < bestSum) { bestSum = s; bestOrder = order }
  }

  const m = fixedResidual(x, bestOrder, scratch)
  const u = new Uint32Array(m)
  for (let i = 0; i < m; i++) {
    const r = scratch[i]
    u[i] = r >= 0 ? 2 * r : -2 * r - 1
  }
  const plan = planResidual(u, m, n, bestOrder)
  const fixed = { type: 'fixed', order: bestOrder, u, plan, bits: 8 + bestOrder * sbps + plan.bits }
  return fixed.bits < verbatim.bits ? fixed : verbatim
}

function writeSubframe(w, x, sbps, a) {
  if (a.type === 'constant') {
    w.put(0b00000000, 8)
    w.signed(x[0], sbps)
    return
  }
  if (a.type === 'verbatim') {
    w.put(0b00000010, 8)
    for (let i = 0; i < x.length; i++) w.signed(x[i], sbps)
    return
  }
  // 0 | 001 ooo | 0 (no wasted bits)
  w.put((0b001000 | a.order) << 1, 8)
  for (let i = 0; i < a.order; i++) w.signed(x[i], sbps)

  const { plan, u } = a
  w.put(plan.rice2 ? 1 : 0, 2)
  w.put(plan.order, 4)
  const paramBits = plan.rice2 ? 5 : 4
  let idx = 0
  const parts = 1 << plan.order
  const size = x.length >> plan.order
  for (let p = 0; p < parts; p++) {
    const k = plan.ks[p]
    w.put(k, paramBits)
    const count = p === 0 ? size - a.order : size
    const mask = (1 << k) - 1
    for (let i = 0; i < count; i++) {
      const v = u[idx++]
      w.unary(v >>> k)
      if (k > 0) w.bits(v & mask, k)
    }
  }
}

// ── Frame header pieces ─────────────────────────────────────────────────────

const RATE_CODES = new Map([
  [88200, 1], [176400, 2], [192000, 3], [8000, 4], [16000, 5], [22050, 6],
  [24000, 7], [32000, 8], [44100, 9], [48000, 10], [96000, 11],
])
const DEPTH_CODES = new Map([[8, 1], [12, 2], [16, 4], [20, 5], [24, 6]])

/** The UTF-8-style variable-length integer FLAC uses for the frame number. */
function writeUtf8Number(w, n) {
  if (n < 0x80) { w.put(n, 8); return }
  let len = n < 0x800 ? 2 : n < 0x10000 ? 3 : n < 0x200000 ? 4 : n < 0x4000000 ? 5 : 6
  const lead = (0xff00 >> len) & 0xff
  w.put(lead | (n >>> (6 * (len - 1))), 8)
  for (let i = len - 2; i >= 0; i--) w.put(0x80 | ((n >>> (6 * i)) & 0x3f), 8)
}

// ── Encoder ─────────────────────────────────────────────────────────────────

/**
 * @param {Float32Array[]} channelData one array per channel, equal lengths
 * @param {number} sampleRate
 * @param {{ bits?: 16|24, onProgress?: (fraction: number) => void }} [options]
 * @returns {Uint8Array}
 */
export function encodeFlac(channelData, sampleRate, { bits = 16, onProgress } = {}) {
  if (bits !== 16 && bits !== 24) throw new Error(`unsupported FLAC depth: ${bits}`)
  const channels = channelData.length
  if (channels < 1 || channels > 8) throw new Error('FLAC carries 1–8 channels')
  const total = channelData[0].length
  const ints = channelData.map(ch => toIntSamples(ch, bits))

  const w = new BitWriter(Math.max(1 << 16, Math.ceil(total * channels * bits / 8 * 0.7)))
  // 'fLaC' + STREAMINFO header (last block, type 0, length 34). The body is
  // patched once the frame sizes are known.
  w.bits(0x664c6143, 32)
  w.put(0x80, 8)
  w.bits(34, 24)
  const streamInfoAt = w.pos
  for (let i = 0; i < 34; i++) w.put(0, 8)

  const scratch = new Int32Array(FLAC_BLOCK_SIZE)
  const side = new Int32Array(FLAC_BLOCK_SIZE)
  const mid = new Int32Array(FLAC_BLOCK_SIZE)
  let minFrame = Infinity
  let maxFrame = 0
  let frameNo = 0
  const frames = Math.ceil(total / FLAC_BLOCK_SIZE)

  for (let start = 0; start < total; start += FLAC_BLOCK_SIZE, frameNo++) {
    const n = Math.min(FLAC_BLOCK_SIZE, total - start)
    const block = ints.map(ch => ch.subarray(start, start + n))

    // Channel assignment and the subframes that go with it.
    let assignment = channels - 1
    let subframes
    if (channels === 2) {
      const L = block[0], R = block[1]
      const S = side.subarray(0, n), M = mid.subarray(0, n)
      for (let i = 0; i < n; i++) { S[i] = L[i] - R[i]; M[i] = (L[i] + R[i]) >> 1 }
      const aL = analyzeSubframe(L, bits, scratch)
      const aR = analyzeSubframe(R, bits, scratch)
      const aS = analyzeSubframe(S, bits + 1, scratch)
      const aM = analyzeSubframe(M, bits, scratch)
      const options = [
        { code: 1, bits: aL.bits + aR.bits, subs: [[L, bits, aL], [R, bits, aR]] },
        { code: 8, bits: aL.bits + aS.bits, subs: [[L, bits, aL], [S, bits + 1, aS]] },
        { code: 9, bits: aS.bits + aR.bits, subs: [[S, bits + 1, aS], [R, bits, aR]] },
        { code: 10, bits: aM.bits + aS.bits, subs: [[M, bits, aM], [S, bits + 1, aS]] },
      ]
      const pick = options.reduce((a, b) => (b.bits < a.bits ? b : a))
      assignment = pick.code
      subframes = pick.subs
    } else {
      subframes = block.map(x => [x, bits, analyzeSubframe(x, bits, scratch)])
    }

    const frameStart = w.pos
    w.put(0xfff8, 16) // sync + reserved 0 + fixed blocksize
    const sizeCode = n === FLAC_BLOCK_SIZE ? 0b1100 : 0b0111
    w.put(sizeCode, 4)
    w.put(RATE_CODES.get(sampleRate) ?? 0, 4) // 0 = read it from STREAMINFO
    w.put(assignment, 4)
    w.put(DEPTH_CODES.get(bits), 3)
    w.put(0, 1)
    writeUtf8Number(w, frameNo)
    if (sizeCode === 0b0111) w.put(n - 1, 16)
    w.put(crc8(w.buf, frameStart, w.pos), 8)

    for (const [x, sbps, a] of subframes) writeSubframe(w, x, sbps, a)

    w.alignByte()
    w.put(crc16(w.buf, frameStart, w.pos), 16)
    const frameBytes = w.pos - frameStart
    if (frameBytes < minFrame) minFrame = frameBytes
    if (frameBytes > maxFrame) maxFrame = frameBytes

    if (onProgress && (frameNo & 63) === 63) onProgress((frameNo + 1) / frames)
  }

  // STREAMINFO body.
  const out = w.bytes()
  const si = new BitWriter(34)
  const blockMin = total < FLAC_BLOCK_SIZE ? Math.max(16, total) : FLAC_BLOCK_SIZE
  si.put(blockMin, 16)
  si.put(total < FLAC_BLOCK_SIZE ? Math.max(16, total) : FLAC_BLOCK_SIZE, 16)
  si.bits(frames ? minFrame : 0, 24)
  si.bits(maxFrame, 24)
  si.bits(sampleRate, 20)
  si.put(channels - 1, 3)
  si.put(bits - 1, 5)
  si.bits(Math.floor(total / 2 ** 32), 4)
  si.bits(total % 2 ** 32, 32)
  for (let i = 0; i < 16; i++) si.put(0, 8) // MD5 not computed
  out.set(si.bytes(), streamInfoAt)
  onProgress?.(1)
  return out
}
