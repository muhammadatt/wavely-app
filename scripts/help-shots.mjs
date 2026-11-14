/**
 * Screenshot every effect window for the help pages.
 *
 *   npm run help:shots                      # every effect
 *   npm run help:shots -- de-esser phatass  # only these
 *   HELP_SHOTS_URL=http://localhost:5199/ npm run help:shots -- …   # an already-running dev server
 *
 * For each effect it opens the window the way a user does (command palette,
 * the registry label) on a generated probe file with everything selected, then
 * writes:
 *
 *   public/help/shots/<slug>/panel.jpg      the whole window (the "Interface" image)
 *   public/help/shots/<slug>/<shot>.png     one crop per control that names a `shot`
 *   src/content/help/shots/<id>.json        the manifest the help page reads (and
 *                                           each control's box on the panel, `at`,
 *                                           for the marketing page's hotspots)
 *
 * `<slug>` is the page's product-name URL segment (`la-vintage-2a`), so image
 * URLs never show the old window ids; the manifest stays keyed by window id.
 *
 * A control's `shot` is a `data-help` id: the crop is the element carrying
 * `data-help="<shot>"` inside the window, padded a little. Ids live on the
 * panels rather than as CSS selectors here so a re-laid-out panel keeps its
 * crops, and `test/ui/helpContent.test.js` fails on a shot no panel carries.
 *
 * Re-run it after changing a panel's look. It reads the content files, so add
 * the `shot` there first. Images are a picture of the dev build (dev-only
 * effects included) at a 2x device scale.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HELP, HELP_META, helpSlug } from '../src/content/help/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.HELP_SHOTS_PORT ?? 5198)
const URL_ = process.env.HELP_SHOTS_URL ?? `http://localhost:${PORT}/`
const PAD = 6

const only = process.argv.slice(2)
const ids = (only.length ? only : Object.keys(HELP))
for (const id of ids) if (!HELP[id]) { console.error(`no help entry: ${id}`); process.exit(1) }

/**
 * What to type into the palette. The registry label, except where a shorter
 * query is the one that lands on it first (the smoke script's experience).
 */
const QUERY = { 'saturation-bench': 'Saturation Workbench', 'plugin-chain': 'Effect Chain' }

/** The rack the Effect Chain's help picture shows: picker queries, in order. */
const CHAIN_SAMPLE = ['EQ', 'LA Classic 76', 'LA Vintage 2A', 'De-Esser', 'Air Boost']

function writeProbeWav(path) {
  // Speech-like: a pitched, syllabic tone with sibilant bursts and a click per
  // second, so meters and scopes show something rather than sitting flat.
  const sr = 44100, n = sr * 8, b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const env = (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.7 * t)) ** 2
    const sib = (t % 1.3) > 1.1 ? 0.12 * rnd() : 0
    const k = i % sr
    const click = k < 200 ? 0.8 * Math.exp(-k / 40) : 0
    const v = 0.25 * env * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t) + 0.2 * Math.sin(2 * Math.PI * 3000 * t)) + sib + click
    b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2)
  }
  writeFileSync(path, b)
}

async function waitForServer(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { if ((await fetch(URL_)).ok) return true } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 400))
  }
  return false
}

const wav = join(tmpdir(), 'wavely-help-shots.wav')
writeProbeWav(wav)

let server = null
if (!(await waitForServer(1000))) {
  if (process.env.HELP_SHOTS_URL) { console.error(`no server at ${URL_}`); process.exit(1) }
  // Node + vite's bin, not `npx`: on Windows npx is npx.cmd and spawn without a shell cannot find it.
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  server = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
  if (!(await waitForServer(40000))) { console.error('dev server did not start'); process.exit(1) }
}

const executablePath = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined
const browser = await chromium.launch(executablePath ? { executablePath } : {})
// Tall, so the biggest window fits without its face scrolling.
const page = await browser.newPage({ viewport: { width: 1600, height: 1500 }, deviceScaleFactor: 2 })
await page.addInitScript(() => {
  window.showOpenFilePicker = undefined
  // Dev-only tuning benches (`data-bench`) are not what a user sees.
  addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style')
    s.textContent = '[data-bench]{display:none!important}'
    document.head.appendChild(s)
  })
})

let failures = 0
try {
  // Not 'networkidle': a cold dev server streams modules (and the app may poll) for longer than it allows.
  await page.goto(URL_, { waitUntil: 'load', timeout: 120000 })
  await page.getByText('Choose audio files').waitFor({ timeout: 120000 })
  const chooser = page.waitForEvent('filechooser')
  await page.getByText('Choose audio files').click()
  await (await chooser).setFiles(wav)
  await page.waitForTimeout(4000)
  await page.getByText('Select All', { exact: false }).first().click()
  await page.waitForTimeout(600)

  for (const id of ids) {
    const entry = HELP[id]
    await page.keyboard.press('Control+k'); await page.waitForTimeout(250)
    await page.keyboard.type(QUERY[id] ?? HELP_META[id].title); await page.waitForTimeout(450)
    await page.keyboard.press('Enter'); await page.waitForTimeout(3500)
    let frame = page.locator('.win-frame').last()
    if (!(await frame.count())) { console.log(`FAIL  ${id}: window did not open`); failures++; continue }

    // An empty chain does not show what it is for: fill it with a typical vocal rack first.
    if (id === 'plugin-chain') {
      frame = page.locator('.win-frame').filter({ hasText: 'EFFECT CHAIN' }).first()
      for (const label of CHAIN_SAMPLE) {
        await frame.getByRole('button', { name: 'Add effect', exact: true }).dispatchEvent('click'); await page.waitForTimeout(300)
        await page.keyboard.type(label); await page.waitForTimeout(250)
        await page.keyboard.press('Enter'); await page.waitForTimeout(2000)
      }
      // Each added effect opened its window beside the chain; the slots keep running without them.
      const members = page.locator('.win-frame').filter({ hasNotText: 'EFFECT CHAIN' })
      for (let i = 0; i < CHAIN_SAMPLE.length + 2 && await members.count(); i++) {
        await members.last().locator('[aria-label="Close window"]').first().click().catch(() => {})
        await page.waitForTimeout(300)
      }
      const rows = await frame.locator('.pc-name').allInnerTexts()
      console.log(`      chain rows: ${rows.join(' → ')}`)
      if (rows.length !== CHAIN_SAMPLE.length) { console.log(`FAIL  ${id}: expected ${CHAIN_SAMPLE.length} slots`); failures++ }
    }

    // Measurements and meters settle; nothing should be mid-animation.
    await page.mouse.move(0, 0)
    await page.waitForTimeout(1500)

    const slug = helpSlug(id)
    const outDir = join(ROOT, 'public/help/shots', slug)
    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(outDir, { recursive: true })
    const manifest = { panel: null, controls: {} }

    const box = await frame.boundingBox()
    await page.screenshot({ path: join(outDir, 'panel.jpg'), clip: box, type: 'jpeg', quality: 88 })
    manifest.panel = { src: `/help/shots/${slug}/panel.jpg`, w: Math.round(box.width), h: Math.round(box.height) }

    const missing = []
    for (const c of entry.controls) {
      if (!c.shot || manifest.controls[c.shot]) continue
      const el = frame.locator(`[data-help="${c.shot}"]`).first()
      // The union of the element and every visible descendant: a lamp or
      // label positioned outside its wrapper's box still belongs in the crop.
      const b = (await el.count()) ? await el.evaluate((node) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const n of [node, ...node.querySelectorAll('*')]) {
          const r = n.getBoundingClientRect()
          const cs = getComputedStyle(n)
          if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none') continue
          x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top)
          x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom)
        }
        return x0 === Infinity ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      }) : null
      if (!b || b.width < 2 || b.height < 2) { missing.push(c.shot); continue }
      const clip = {
        x: Math.max(0, b.x - PAD), y: Math.max(0, b.y - PAD),
        width: b.width + 2 * PAD, height: b.height + 2 * PAD,
      }
      await page.screenshot({ path: join(outDir, `${c.shot}.png`), clip })
      manifest.controls[c.shot] = {
        src: `/help/shots/${slug}/${c.shot}.png`, w: Math.round(clip.width), h: Math.round(clip.height),
        // Where the control sits on panel.jpg, in its CSS pixels (unpadded):
        // the marketing page's interactive screenshot places a hotspot here.
        at: {
          x: Math.round(b.x - box.x), y: Math.round(b.y - box.y),
          w: Math.round(b.width), h: Math.round(b.height),
        },
      }
    }

    mkdirSync(join(ROOT, 'src/content/help/shots'), { recursive: true })
    writeFileSync(join(ROOT, 'src/content/help/shots', `${id}.json`), JSON.stringify(manifest, null, 2) + '\n')
    if (missing.length) failures++
    console.log(`${missing.length ? 'FAIL' : 'ok  '}  ${id.padEnd(22)} ${Object.keys(manifest.controls).length} crops${missing.length ? `; not found: ${missing.join(', ')}` : ''}`)

    await page.keyboard.press('Escape'); await page.waitForTimeout(500)
    // A window that ignores Escape (focus elsewhere) must not leak into the next shot.
    while (await page.locator('.win-frame').count()) {
      await page.locator('.win-frame').last().locator('[aria-label="Close window"]').first().click().catch(() => {})
      await page.waitForTimeout(300)
      if (await page.locator('.win-frame').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
      break
    }
  }
} finally {
  await browser.close()
  if (server) server.kill()
}
process.exit(failures ? 1 : 0)
