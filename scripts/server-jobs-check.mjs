/**
 * Server jobs that outlive their tab, end to end in a real browser, against a
 * mocked API (uploads, /api/spot/noise_reduction, /api/jobs):
 *   1. open a file (no edits) and start Noise Reduction on it;
 *   2. reload while the server is still running the job, and check the new tab
 *      picks it up and session autosave kept the (unedited) file;
 *   3. once the server is done, the result offers to open as a new file until
 *      the file is restored, then Apply lands it on the file as an undo step;
 *   4. a job the server no longer has says so; a result whose file is gone
 *      opens as a new file.
 *
 *   npm run jobs:check
 *
 * Starts `vite` on PORT unless a server already answers there.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.PORT ?? 5243)
const URL_ = `http://localhost:${PORT}/`

function wavBytes(seconds, amp = 8000, RATE = 48000) {
  const n = Math.round(seconds * RATE)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * 220 * i / RATE)), 44 + i * 2)
  return b
}

async function waitForServer(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { if ((await fetch(URL_)).ok) return true } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 400))
  }
  return false
}

const wav = join(tmpdir(), 'wavely-jobs-check.wav')
writeFileSync(wav, wavBytes(10))

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
page.on('console', m => { if (process.env.DEBUG && m.type() !== 'debug') console.log('[page]', m.text()) })
const toasts = []
await page.exposeFunction('__toast', t => toasts.push(t))
await page.addInitScript(() => new MutationObserver(m => m.forEach(r => r.addedNodes.forEach(n =>
  n.nodeType === 1 && /^(status|alert)$/.test(n.getAttribute('role') ?? '') && window.__toast(n.innerText),
))).observe(document, { childList: true, subtree: true }))

// ── The mocked server ────────────────────────────────────────────────────────
const server_ = { done: new Set(), downloads: 0, submitted: 0 }
let uploaded = 0
await context.route(url => url.pathname.startsWith('/api/'), async (route) => {
  const req = route.request()
  const path = new URL(req.url()).pathname
  const method = req.method()
  if (path === '/api/uploads' && method === 'POST') {
    uploaded = 0
    return route.fulfill({ status: 201, headers: { Location: '/api/uploads/u1', 'Tus-Resumable': '1.0.0' } })
  }
  if (path === '/api/uploads/u1' && method === 'PATCH') {
    uploaded += req.postDataBuffer()?.length ?? 0
    return route.fulfill({ status: 204, headers: { 'Upload-Offset': String(uploaded), 'Tus-Resumable': '1.0.0' } })
  }
  if (path.startsWith('/api/uploads/')) return route.fulfill({ status: 204 })
  if (path === '/api/spot/noise_reduction' && method === 'POST') {
    const jobId = `nr-${++server_.submitted}`
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId }) })
  }
  const status = /^\/api\/jobs\/([^/]+)$/.exec(path)
  if (status) {
    const id = status[1]
    if (id === 'gone') return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Job not found or expired"}' })
    const body = server_.done.has(id)
      ? { status: 'done', report: null }
      : { status: 'processing', progress: 'Denoising…', queuePosition: null }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  }
  if (/^\/api\/jobs\/[^/]+\/download$/.test(path)) {
    server_.downloads++
    // The selection's length (2 s) at the rate it was sent, quiet: easy to tell from the source.
    const rate = server_.rate ?? 44100
    return route.fulfill({ status: 200, contentType: 'audio/wav', body: wavBytes(2, 100, rate) })
  }
  return route.fulfill({ status: 404, body: '{}' })
})

const failures = []
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures.push(what) }
const records = () => page.evaluate(() => JSON.parse(localStorage.getItem('wavely:server-jobs') ?? '[]'))
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(250) }
  return false
}
const notice = page.locator('[data-testid=resumed-jobs]')
/** Peak of the active file's audio over [a, b) seconds. */
const peak = (a, b) => page.evaluate(async ([a, b]) => {
  const { useEditorState } = await import('/src/composables/useEditorState.js')
  const { renderRegionToBuffer } = await import('/src/audio/processing.js')
  const { state } = useEditorState()
  const [ch] = renderRegionToBuffer(state.segments, a, b, state.currentFile.sampleRate, 1)
  let p = 0
  for (const v of ch) p = Math.max(p, Math.abs(v))
  return p
}, [a, b])

try {
  await page.goto(URL_, { waitUntil: 'networkidle' })

  // 1. Open a file, select 1–3 s, and start Noise Reduction on it.
  const chooser = page.waitForEvent('filechooser')
  await page.getByText('Choose audio files').click()
  await (await chooser).setFiles(wav)
  await page.waitForTimeout(2000)
  await page.evaluate(async () => {
    const { useEditorState } = await import('/src/composables/useEditorState.js')
    useEditorState().state.selection = { start: 1, end: 3 }
  })
  await page.getByRole('button', { name: /^Fix/ }).first().click()
  await page.getByText('Noise Reduction', { exact: true }).first().click()
  await page.getByRole('button', { name: /Process/ }).last().click()
  check(await until(async () => (await records()).length === 1), 'the job is recorded once the server accepts it')
  const [rec] = await records()
  server_.rate = rec?.sampleRate
  check(rec?.jobId === 'nr-1' && rec.kind === 'noiseReduction' && rec.start === 1 && rec.end === 3, 'the record names the job and the region')

  // Autosave keeps the file even though it has no edits: a job is working on it.
  await page.waitForTimeout(3000)
  const kept = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const dir = await (await root.getDirectoryHandle('wavely-autosave')).getDirectoryHandle('sessions')
    const names = []
    for await (const [name] of dir.entries()) names.push(name)
    return names.length
  }).catch(() => 0)
  check(kept > 0, 'session autosave keeps the unedited file while its job runs')

  // 2. Reload while the server is still working.
  await page.reload({ waitUntil: 'networkidle' })
  check(await until(async () => (await notice.count()) === 1), 'the reloaded tab picks the job up')
  check(await until(async () => /Denoising/.test(await notice.innerText().catch(() => ''))), 'it shows the server\'s progress')
  const adopted = await records()
  check(adopted.length === 1 && adopted[0].owner !== rec.owner, 'the record now belongs to the new tab')
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace(/\.png$/, '-running.png') })

  // 3. The server finishes. Before the file is restored the result can only open as a new file.
  server_.done.add('nr-1')
  check(await until(async () => /Finished/.test(await notice.innerText())), 'the notice says the job finished')
  check(await notice.getByRole('button', { name: 'Open as new file' }).count() === 1, 'with the file not open, it offers a new file')
  check(server_.downloads === 0, 'nothing is downloaded before the user asks')

  await page.locator('[data-testid=recovery]').getByRole('button', { name: 'Restore' }).click()
  check(await until(async () => (await notice.getByRole('button', { name: 'Apply' }).count()) === 1), 'once the file is restored, the result offers to apply to it')
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
  const before = await peak(1.2, 2.8)
  await notice.getByRole('button', { name: 'Apply' }).click()
  check(await until(async () => toasts.some(t => /Noise reduced/.test(t))), 'a toast confirms it landed')
  if (process.env.DEBUG) console.log('notice:', await notice.innerText().catch(() => ''), toasts)
  const after = await peak(1.2, 2.8)
  check(before > 0.2 && after < 0.01, `the region is the server's result (peak ${before.toFixed(3)} → ${after.toFixed(4)})`)
  check((await peak(4, 6)) > 0.2, 'audio outside the region is untouched')
  check(await notice.count() === 0, 'the notice is gone')
  check((await records()).length === 0, 'the record is removed')
  const canUndo = await page.evaluate(async () => (await import('/src/composables/useEditorState.js')).useEditorState().canUndo.value)
  check(canUndo, 'it is one undo step')

  // 4. A job the server no longer has, and a result whose file is gone.
  await page.evaluate(([a, b]) => localStorage.setItem('wavely:server-jobs', JSON.stringify([a, b])), [
    { ...rec, jobId: 'gone', owner: 'dead-tab', startedAt: Date.now() },
    { ...rec, jobId: 'nr-2', owner: 'dead-tab', startedAt: Date.now(), timeline: '[]', name: 'Old take.wav' },
  ])
  server_.done.add('nr-2')
  await page.reload({ waitUntil: 'networkidle' })
  check(await until(async () => /no longer has this result/.test(await notice.innerText().catch(() => ''))), 'an expired job says so')
  check(await until(async () => (await notice.getByRole('button', { name: 'Open as new file' }).count()) === 1), 'a result with no file offers a new file')
  await notice.getByRole('button', { name: 'Open as new file' }).click()
  check(await until(async () => (await page.locator('[role=tab]', { hasText: 'Old take (denoised)' }).count()) === 1), 'it opens as "Old take (denoised)"')
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  check(await until(async () => (await notice.count()) === 0), 'Dismiss clears the last card')
  check((await records()).length === 0, 'no records are left')

  // 5. The ordinary case: a job that finishes in its own tab lands and leaves no record.
  // On the file just opened (2 s long; the server's mock answers 2 s).
  server_.done.add('nr-2')
  await page.evaluate(async () => {
    const { useEditorState } = await import('/src/composables/useEditorState.js')
    useEditorState().state.selection = { start: 0, end: 2 }
  })
  toasts.length = 0
  await page.getByRole('button', { name: /^Fix/ }).first().click()
  await page.getByText('Noise Reduction', { exact: true }).first().click()
  await page.getByRole('button', { name: /Process/ }).last().click()
  check(await until(async () => toasts.some(t => /Noise reduced with/.test(t))), 'a job in its own tab still lands as before')
  check((await records()).length === 0, 'and leaves no record behind')
  check(await notice.count() === 0, 'and never shows in the picked-up notice')
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} finally {
  await browser.close()
  server?.kill()
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nserver job checks passed')
