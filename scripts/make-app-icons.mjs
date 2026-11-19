/**
 * Renders the home-screen icons in public/icons/ from the favicon's design:
 * an orange "fm" (Inter 600) on the dark rounded square of public/favicon.png.
 *
 *   node scripts/make-app-icons.mjs
 *
 * Re-run it when the mark changes. Each icon's glyph is sized by its INK width
 * (the drawn letters, not the font box) as a share of the icon:
 *   - icon-192 / icon-512 ("any"): rounded corners like the favicon, glyph 67 %.
 *   - icon-maskable-512: full bleed, glyph 52 %, so Android's crop to a circle
 *     or squircle (the inner 80 % safe zone) never touches the letters.
 *   - apple-touch-icon (180): full bleed, no transparency (iOS rounds it and
 *     would show transparent corners as black), glyph 60 %.
 * The sizes must match public/manifest.webmanifest; test/ui/audioSession.test.js
 * checks them.
 *
 * Needs Playwright's Chromium and the Inter font installed where it runs
 * (the font is looked up by name; without it the canvas falls back silently).
 */
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../public/icons/', import.meta.url))
const BACKGROUND = 'rgb(27,22,18)'  // sampled from public/favicon.png
const GLYPH = 'rgb(246,114,43)'

const ICONS = [
  { name: 'icon-192.png', size: 192, rounded: true, glyph: 0.67 },
  { name: 'icon-512.png', size: 512, rounded: true, glyph: 0.67 },
  { name: 'icon-maskable-512.png', size: 512, rounded: false, glyph: 0.52 },
  { name: 'apple-touch-icon.png', size: 180, rounded: false, glyph: 0.6 },
]

mkdirSync(OUT, { recursive: true })
// The cloud sandbox's preinstalled Chromium, as scripts/help-shots.mjs finds it.
const executablePath = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined
const browser = await chromium.launch(executablePath ? { executablePath } : {})
try {
  const page = await browser.newPage()
  await page.setContent('<canvas id="c"></canvas>')
  for (const icon of ICONS) {
    const base64 = await page.evaluate(async ({ size, rounded, glyph, background, color }) => {
      await document.fonts.load('600 100px Inter')
      const canvas = document.getElementById('c')
      canvas.width = canvas.height = size
      const g = canvas.getContext('2d')
      g.clearRect(0, 0, size, size)
      g.fillStyle = background
      if (rounded) {
        g.beginPath()
        g.roundRect(0, 0, size, size, size * 0.2)
        g.fill()
      } else {
        g.fillRect(0, 0, size, size)
      }
      // Size the font so the INK of "fm" is `glyph` of the icon, then centre the ink box.
      const ink = (m) => m.actualBoundingBoxLeft + m.actualBoundingBoxRight
      g.font = '600 100px Inter'
      const px = (100 * glyph * size) / ink(g.measureText('fm'))
      g.font = `600 ${px}px Inter`
      const m = g.measureText('fm')
      const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
      g.fillStyle = color
      g.fillText('fm', (size - ink(m)) / 2 + m.actualBoundingBoxLeft, (size - h) / 2 + m.actualBoundingBoxAscent)
      return canvas.toDataURL('image/png').split(',')[1]
    }, { ...icon, background: BACKGROUND, color: GLYPH })
    writeFileSync(OUT + icon.name, Buffer.from(base64, 'base64'))
    console.log(`wrote public/icons/${icon.name}`)
  }
} finally {
  await browser.close()
}
