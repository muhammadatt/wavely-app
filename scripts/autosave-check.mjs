/**
 * Session autosave, end to end in a real browser:
 *   1. open a file and edit it (a cut, then a Volume apply — a source buffer
 *      and an apply's output, the two ways audio is stored);
 *   2. reload, as a crashed or closed tab would, and check the offer;
 *   3. Restore, and check the file comes back unsaved, at the edited length;
 *   4. reload again and Discard, and check browser storage is emptied.
 *
 *   npm run autosave:check
 *
 * Starts `vite` on PORT unless a server already answers there. Uses the
 * sandbox's preinstalled Chromium when present, as scripts/help-shots.mjs does.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.PORT ?? 5241)
const URL_ = `http://localhost:${PORT}/`

/** 10 s of a 220 Hz tone, mono 16-bit 48 kHz. */
function writeWav(path, seconds = 10, rate = 48000) {
  const n = seconds * rate
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 220 * i / rate)), 44 + i * 2)
  writeFileSync(path, b)
}

async function waitForServer(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { if ((await fetch(URL_)).ok) return true } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 400))
  }
  return false
}

const wav = join(tmpdir(), 'wavely-autosave-check.wav')
writeWav(wav)

let server = null
if (!(await waitForServer(1000))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
  if (!(await waitForServer(40000))) { console.error('dev server did not start'); process.exit(1) }
}

const executablePath = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
await page.addInitScript(() => { window.showOpenFilePicker = undefined })
const errors = []
page.on('pageerror', e => errors.push(e.message))
const toasts = []
await page.exposeFunction('__toast', t => toasts.push(t))
await page.addInitScript(() => new MutationObserver(m => m.forEach(r => r.addedNodes.forEach(n =>
  n.nodeType === 1 && /^(status|alert)$/.test(n.getAttribute('role') ?? '') && window.__toast(n.innerText),
))).observe(document, { childList: true, subtree: true }))

/** What is in the autosave store: manifests (with their file names) and buffer files. */
const storage = () => page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  let dir
  try { dir = await root.getDirectoryHandle('wavely-autosave') } catch { return { sessions: [], buffers: [] } }
  const list = async (d) => { const out = []; for await (const [name, h] of d.entries()) out.push([name, h]); return out }
  const sessions = []
  for (const [name, h] of await list(await dir.getDirectoryHandle('sessions'))) {
    const m = JSON.parse(await (await h.getFile()).text())
    sessions.push({ name, files: m.docs.map(d => d.name) })
  }
  const buffers = []
  for (const [name, h] of await list(await dir.getDirectoryHandle('buffers'))) {
    buffers.push({ name, bytes: (await h.getFile()).size })
  }
  return { sessions, buffers }
})

const failures = []
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures.push(what) }
const clock = () => page.locator('.selection-bar').innerText().catch(() => '')

try {
  await page.goto(URL_, { waitUntil: 'networkidle' })
  check((await page.locator('[data-testid=recovery]').count()) === 0, 'a fresh browser offers nothing to restore')

  const chooser = page.waitForEvent('filechooser')
  await page.getByText('Choose audio files').click()
  await (await chooser).setFiles(wav)
  await page.waitForTimeout(2500)

  // A cut: select 2–4 s by dragging and delete it.
  const box = await page.locator('canvas.waveform-canvas').boundingBox()
  const x = f => box.x + box.width * f
  const y = box.y + box.height / 2
  await page.mouse.move(x(0.2), y); await page.mouse.down(); await page.mouse.move(x(0.4), y, { steps: 8 }); await page.mouse.up()
  await page.keyboard.press('Delete')
  await page.waitForTimeout(3000)

  const afterCut = await storage()
  check(afterCut.sessions.length === 1 && afterCut.sessions[0].files[0] === 'wavely-autosave-check.wav', 'after a cut, the file is in this tab\'s manifest')
  const bin = afterCut.buffers.find(b => b.name.endsWith('.bin'))
  check(bin?.bytes === 960044, `the opened file is kept as its own bytes, the WAV itself (${bin?.bytes} bytes), not decoded samples`)

  // An apply: −3 dB over everything, which makes a new buffer.
  await page.getByRole('button', { name: /^Level/ }).first().click()
  await page.getByText('Volume', { exact: true }).first().click()
  await page.getByRole('button', { name: '-3 dB' }).click()
  await page.locator('canvas.waveform-canvas').click({ position: { x: 5, y: 40 } })
  await page.keyboard.press('Control+a')
  await page.getByRole('button', { name: /Apply Volume Change/ }).click()
  await page.waitForTimeout(4000)

  const before = await storage()
  check(before.buffers.some(b => b.name.endsWith('.f32')), 'the apply\'s output is kept as samples (.f32)')
  check(!before.buffers.some(b => b.name.endsWith('.bin')), 'the original\'s bytes are dropped once no unsaved timeline plays them')

  // A second tab, while this one is still open, must not offer its work.
  const other = await context.newPage()
  await other.goto(URL_, { waitUntil: 'networkidle' })
  await other.waitForTimeout(800)
  check(await other.locator('[data-testid=recovery]').count() === 0, 'another open tab does not offer this tab\'s live work')
  await other.close()

  // 2. Reload, as a closed or crashed tab would.
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  const offer = page.locator('[data-testid=recovery]')
  check(await offer.count() === 1, 'the reloaded editor offers the work back')
  check((await offer.innerText()).includes('wavely-autosave-check.wav'), 'the offer names the file')
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })

  // 3. Restore.
  await offer.getByRole('button', { name: 'Restore' }).click()
  await page.waitForTimeout(3000)
  check(toasts.some(t => /Restored 1 file/.test(t)), 'a toast confirms the restore')
  const tab = page.locator('[role=tab]', { hasText: 'wavely-autosave-check' })
  check(await tab.count() === 1, 'the file is open again')
  // 10 s with 2 s cut out.
  await page.locator('canvas.waveform-canvas').click({ position: { x: 5, y: 40 } })
  await page.keyboard.press('Control+a')
  await page.waitForTimeout(300)
  const sel = await clock()
  check(/8[.:,]0/.test(sel) || /0:08/.test(sel), `the restored timeline is the edited length (${sel.replace(/\s+/g, ' ')})`)
  await page.waitForTimeout(2500)
  const afterRestore = await storage()
  check(afterRestore.sessions.length === 1, 'one manifest remains: this tab\'s, now naming the restored file')

  // 4. Reload and Discard.
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  await page.locator('[data-testid=recovery]').getByRole('button', { name: 'Discard' }).click()
  await page.getByRole('button', { name: 'Discard for good' }).click()
  await page.waitForTimeout(1500)
  check(await page.locator('[data-testid=recovery]').count() === 0, 'Discard removes the offer')
  const afterDiscard = await storage()
  check(afterDiscard.sessions.length === 0 && afterDiscard.buffers.length === 0, `Discard empties the store (${afterDiscard.sessions.length} manifests, ${afterDiscard.buffers.length} buffers left)`)
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
  server?.kill()
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nsession autosave checks passed')
