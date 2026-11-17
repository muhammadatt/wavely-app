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
 *   public/help/shots/<slug>/face.jpg       the faceplate alone, no header / footer
 *                                           (the marketing pages' product shot)
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
 *
 * ── LIVE SHOTS ──────────────────────────────────────────────────────────────
 * Every window is shot WHILE AUDIO PLAYS through it (looped, whole file
 * selected), so meters, scopes and gain-reduction displays are lit (owner,
 * November 2026: idle panels read as dead). The audio is a real recording when
 * one is present — `scripts/help-shots-audio/voice.wav` for most effects and
 * `drums.wav` for the ones in DRUM_IDS (gitignored: the owner's clips, for
 * screenshots only, NEVER the marketing pages' Hear it audio) — and the
 * generated probe otherwise.
 *
 * ── RE-BOXING ───────────────────────────────────────────────────────────────
 *   npm run help:shots -- --rebox opto-smooth
 * Re-measures each control's box and re-cuts its crop from the panel.jpg
 * already on disk, keeping panel.jpg and face.jpg. For a fix to how boxes are
 * measured (`lib/controlBox.mjs`) without the owner's clips: a full run without
 * them would replace the live pictures with probe-lit ones. The panel's layout
 * must be the one the pictures show — it refuses when the window size differs.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HELP, HELP_META, helpSlug } from '../src/content/help/index.js'
import { measureControlBox } from './lib/controlBox.mjs'
import { MARKETING } from '../src/content/marketing/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.HELP_SHOTS_PORT ?? 5198)
const URL_ = process.env.HELP_SHOTS_URL ?? `http://localhost:${PORT}/`
const PAD = 6

const REBOX = process.argv.includes('--rebox')
const only = process.argv.slice(2).filter(a => !a.startsWith('--'))
const ids = (only.length ? only : Object.keys(HELP))
for (const id of ids) if (!HELP[id]) { console.error(`no help entry: ${id}`); process.exit(1) }

/**
 * What to type into the palette. The registry label, except where a shorter
 * query is the one that lands on it first (the smoke script's experience).
 */
const QUERY = { 'saturation-bench': 'Saturation Workbench', 'plugin-chain': 'Effect Chain' }

/** Effects shot on the drum loop rather than the voice (tape and density read best on drums). */
const DRUM_IDS = new Set(['phatass', 'inflator'])

/**
 * Settings dialled in before a window opens, for effects whose factory default
 * does nothing visible on these clips (PHATaSS idles at Drive 0 / Warmth 0, the
 * EQ is flat). Taken from the marketing page's sample where one fits, through
 * the same writer a preset or the try-out link uses.
 */
const sampleSettings = (id, sample) => MARKETING[id]?.samples.find(s => s.id === sample)?.settings ?? {}
const SHOT_SETTINGS = {
  phatass: { ...sampleSettings('phatass', 'drums'), warmth: 5 },
  'manual-eq': sampleSettings('manual-eq', 'voice'),
  // A lower threshold, so the Resonance view shows the voice being treated.
  'resonance-suppressor': { focus: { global: { selectivity: 13 } } },
  // The default (12 kHz, −8 dB) barely touches this vocal's top end.
  'hf-limiter': { freq: 5000, threshold: -14 },
}

/** How long audio runs through an open window before it is shot. */
const PLAY_SETTLE_MS = 3000
/** Windows that measure before they act (VoxPressor's stages wait for their makeups). */
const SETTLE_MS = { 'vox-pressor': 10000 }
/** A button pressed before playing, so the panel shows what it found. */
const PRESS_FIRST = { 'hum-remover': 'Analyse' }

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

// Real clips when present: the voice drives most windows, the drums the DRUM_IDS.
const AUDIO_DIR = join(ROOT, 'scripts/help-shots-audio')
const findClip = name => ['wav', 'flac', 'mp3', 'aif', 'aiff', 'm4a']
  .map(e => join(AUDIO_DIR, `${name}.${e}`)).find(existsSync) ?? null
const voiceClip = findClip('voice')
const drumClip = findClip('drums')
const clips = voiceClip ? [voiceClip, ...(drumClip ? [drumClip] : [])] : [wav]
/** The tab (file name without its extension) an effect is shot on. */
const tabFor = id => {
  const file = DRUM_IDS.has(id) && drumClip ? drumClip : clips[0]
  return file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
}
console.log(`audio: ${clips.map(c => c.split(/[\\/]/).pop()).join(', ')}${voiceClip ? '' : ' (generated probe — add scripts/help-shots-audio/voice.wav for real audio)'}`)

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

/** Bring a file's tab to the front by its name (shown without the extension). */
async function selectTab(name) {
  const tab = page.getByRole('tab', { name, exact: false }).first()
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(800) }
}

/**
 * Play through the window the way a user auditions it: its footer's Preview
 * (which reads Stop while it runs). An offline process has no preview and no
 * live meters, so it is shot idle.
 */
async function setPlaying(frame, on) {
  const button = frame.getByRole('button', { name: on ? 'Preview' : 'Stop', exact: true }).first()
  if (await button.count() && await button.isEnabled()) { await button.click(); await page.waitForTimeout(300) }
}

/**
 * `--rebox`: measure every control's box on the open window and cut its crop
 * from the panel.jpg on disk (2x), keeping the live pictures. Returns the
 * updated manifest, or null when the window no longer matches the picture.
 */
async function rebox(id, frame) {
  const file = join(ROOT, 'src/content/help/shots', `${id}.json`)
  if (!existsSync(file)) { console.log(`FAIL  ${id}: --rebox needs an existing manifest`); return null }
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const box = await frame.boundingBox()
  if (Math.round(box.width) !== manifest.panel.w || Math.round(box.height) !== manifest.panel.h) {
    console.log(`FAIL  ${id}: the window is ${Math.round(box.width)}×${Math.round(box.height)}, panel.jpg ${manifest.panel.w}×${manifest.panel.h} — re-shoot instead`)
    return null
  }
  const slug = helpSlug(id)
  const outDir = join(ROOT, 'public/help/shots', slug)
  // Written only once every control has passed, so a refusal leaves nothing half-done.
  const writes = []
  for (const c of HELP[id].controls) {
    if (!c.shot) continue
    const el = frame.locator(`[data-help="${c.shot}"]`).first()
    const b = (await el.count()) ? await el.evaluate(measureControlBox) : null
    if (!b) { console.log(`FAIL  ${id}: ${c.shot} not found`); return null }
    const at = { x: Math.round(b.x - box.x), y: Math.round(b.y - box.y), w: Math.round(b.width), h: Math.round(b.height) }
    const clip = {
      x: Math.max(0, at.x - PAD), y: Math.max(0, at.y - PAD),
      w: Math.min(manifest.panel.w, at.x + at.w + PAD) - Math.max(0, at.x - PAD),
      h: Math.min(manifest.panel.h, at.y + at.h + PAD) - Math.max(0, at.y - PAD),
    }
    // Cut from the picture on disk, at its own (2x) resolution, in the page.
    const png = await page.evaluate(async ([src, c, cssW]) => {
      const img = new Image(); img.src = src; await img.decode()
      const k = img.naturalWidth / cssW
      const cv = document.createElement('canvas')
      cv.width = Math.round(c.w * k); cv.height = Math.round(c.h * k)
      cv.getContext('2d').drawImage(img, c.x * k, c.y * k, c.w * k, c.h * k, 0, 0, cv.width, cv.height)
      return cv.toDataURL('image/png').split(',')[1]
    }, [`${manifest.panel.src}?rebox=${Date.now()}`, clip, manifest.panel.w])
    writes.push([join(outDir, `${c.shot}.png`), Buffer.from(png, 'base64')])
    const old = manifest.controls[c.shot]?.at
    // Re-measuring only ever trims a box: one that reaches past its old box
    // means the panel moved since the pictures were taken.
    const SLACK = 2
    if (old && (at.x < old.x - SLACK || at.y < old.y - SLACK || at.x + at.w > old.x + old.w + SLACK || at.y + at.h > old.y + old.h + SLACK)) {
      console.log(`FAIL  ${id}: ${c.shot} moved (${old.w}×${old.h} at ${old.x},${old.y} → ${at.w}×${at.h} at ${at.x},${at.y}) — re-shoot instead`)
      return null
    }
    if (old && (old.w !== at.w || old.h !== at.h || old.x !== at.x || old.y !== at.y)) {
      console.log(`      ${c.shot}: ${old.w}×${old.h} at ${old.x},${old.y} → ${at.w}×${at.h} at ${at.x},${at.y}`)
    }
    manifest.controls[c.shot] = { src: `/help/shots/${slug}/${c.shot}.png`, w: clip.w, h: clip.h, at }
  }
  for (const [path, data] of writes) writeFileSync(path, data)
  console.log(`ok    ${id.padEnd(22)} reboxed`)
  return manifest
}

let failures = 0
const manifests = {}
try {
  // Not 'networkidle': a cold dev server streams modules (and the app may poll) for longer than it allows.
  await page.goto(URL_, { waitUntil: 'load', timeout: 120000 })
  await page.getByText('Choose audio files').waitFor({ timeout: 120000 })
  const chooser = page.waitForEvent('filechooser')
  await page.getByText('Choose audio files').click()
  await (await chooser).setFiles(clips)
  await page.waitForTimeout(4000 + 2000 * (clips.length - 1))
  // Every file: everything selected and Loop on, so playback runs as long as the shots take.
  for (const clip of clips) {
    await selectTab(clip.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''))
    await page.getByText('Select All', { exact: false }).first().click()
    await page.waitForTimeout(600)
    const loop = page.getByRole('button', { name: 'Loop playback' })
    if ((await loop.getAttribute('aria-pressed')) !== 'true') await loop.click()
    await page.waitForTimeout(200)
  }

  for (const id of ids) {
    const entry = HELP[id]
    await selectTab(tabFor(id))
    if (SHOT_SETTINGS[id]) {
      // The app's own module instance (the dev server serves one URL per module).
      const ok = await page.evaluate(async ([pluginId, settings]) => {
        const m = await import('/src/composables/pluginSettings.js')
        const io = m.pluginSettingsIO(pluginId, 'solo')
        // Deep, so a nested group (Reso Tame's focus.global) keeps its other keys.
        const merge = (a, b) => (b && typeof b === 'object' && !Array.isArray(b) && a && typeof a === 'object' && !Array.isArray(a))
          ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k, k in b ? merge(a[k], b[k]) : a[k]]))
          : b
        return !!io && m.writePluginSettings(pluginId, 'solo', merge(io.read(), settings))
      }, [id, SHOT_SETTINGS[id]])
      if (!ok) console.log(`warn  ${id}: shot settings not applied`)
    }
    await page.keyboard.press('Control+k'); await page.waitForTimeout(250)
    await page.keyboard.type(QUERY[id] ?? HELP_META[id].title); await page.waitForTimeout(450)
    await page.keyboard.press('Enter'); await page.waitForTimeout(3500)
    let frame = page.locator('.win-frame').last()
    if (!(await frame.count())) {
      const snap = join(tmpdir(), `help-shots-fail-${id}.png`)
      await page.screenshot({ path: snap })
      console.log(`FAIL  ${id}: window did not open (screen: ${snap})`); failures++; continue
    }

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


    // Play through the open window so meters, scopes and reduction displays are
    // lit; measurements settle while it runs.
    if (PRESS_FIRST[id]) {
      await frame.getByRole('button', { name: PRESS_FIRST[id], exact: true }).first().click().catch(() => {})
      await page.waitForTimeout(4000)
    }
    await page.mouse.move(0, 0)
    if (REBOX) {
      const r = await rebox(id, frame)
      if (r) manifests[id] = r; else failures++
      await page.keyboard.press('Escape'); await page.waitForTimeout(500)
      while (await page.locator('.win-frame').count()) {
        await page.locator('.win-frame').last().locator('[aria-label="Close window"]').first().click().catch(() => {})
        await page.waitForTimeout(300)
        break
      }
      continue
    }
    await setPlaying(frame, true)
    await page.waitForTimeout(SETTLE_MS[id] ?? PLAY_SETTLE_MS)

    const slug = helpSlug(id)
    const outDir = join(ROOT, 'public/help/shots', slug)
    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(outDir, { recursive: true })
    const manifest = { panel: null, controls: {} }

    const box = await frame.boundingBox()
    await page.screenshot({ path: join(outDir, 'panel.jpg'), clip: box, type: 'jpeg', quality: 88 })
    manifest.panel = { src: `/help/shots/${slug}/panel.jpg`, w: Math.round(box.width), h: Math.round(box.height) }

    // The faceplate alone, without the window's header (name, presets, ON, ✕)
    // and footer (selection readout, Preview, Apply): the marketing page's
    // product shot. `x` / `y` are its offset inside panel.jpg, so a control's
    // `at` box maps onto it by subtraction.
    const faceEl = frame.locator('.win-face').first()
    const faceBox = (await faceEl.count()) ? await faceEl.boundingBox() : null
    if (faceBox) {
      await page.screenshot({ path: join(outDir, 'face.jpg'), clip: faceBox, type: 'jpeg', quality: 90 })
      manifest.face = {
        src: `/help/shots/${slug}/face.jpg`,
        w: Math.round(faceBox.width), h: Math.round(faceBox.height),
        x: Math.round(faceBox.x - box.x), y: Math.round(faceBox.y - box.y),
      }
    }

    const missing = []
    for (const c of entry.controls) {
      if (!c.shot || manifest.controls[c.shot]) continue
      const el = frame.locator(`[data-help="${c.shot}"]`).first()
      // The union of the element and every visible descendant: a lamp or
      // label positioned outside its wrapper's box still belongs in the crop.
      // The visible union of the element and its descendants (`lib/controlBox.mjs`).
      const b = (await el.count()) ? await el.evaluate(measureControlBox) : null
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

    // Written after the browser closes: a file under src/ changing makes the dev
    // server reload the editor, losing the loaded audio mid-run.
    manifests[id] = manifest
    if (missing.length) failures++
    console.log(`${missing.length ? 'FAIL' : 'ok  '}  ${id.padEnd(22)} ${Object.keys(manifest.controls).length} crops${missing.length ? `; not found: ${missing.join(', ')}` : ''}`)

    await setPlaying(frame, false)
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
  mkdirSync(join(ROOT, 'src/content/help/shots'), { recursive: true })
  for (const [id, manifest] of Object.entries(manifests)) {
    writeFileSync(join(ROOT, 'src/content/help/shots', `${id}.json`), JSON.stringify(manifest, null, 2) + '\n')
  }
}
process.exit(failures ? 1 : 0)
