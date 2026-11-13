import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

/**
 * Developer-only modules, stubbed out of production builds.
 *
 * `DEV_TUNING_PANELS` already makes these unreachable at runtime, but an
 * unreachable dynamic import still gets a chunk emitted — an orphan file that
 * nothing references yet anyone can fetch. Resolving the module to an empty
 * stub when the flag is off means there is no chunk at all, which is what the
 * flag's docstring claims.
 *
 * Keep this list in sync with the guards in src/devFlags.js.
 *
 * The enable check MUST read the same env Vite injects into the client. It used
 * to read process.env directly, which only sees the OS environment — so setting
 * VITE_DEV_PANELS=1 in .env.local (what devFlags.js tells you to do) turned the
 * flag on in the app while this plugin still stripped the module. The async
 * import then resolved to the stub and the panel rendered nothing at all, with
 * no error to explain it. loadEnv reads the .env files exactly as Vite does.
 */
const DEV_ONLY_MODULES = [/SibilanceTuningPanel\.vue$/, /ModulaGalleryWindow\.vue$/]

function stripDevOnlyModules(enabled) {
  const STUB = '\0dev-only-stub'
  return {
    name: 'wavely:strip-dev-only',
    apply: 'build',
    // Must beat @vitejs/plugin-vue to the .vue specifier.
    enforce: 'pre',
    resolveId(source) {
      if (enabled) return null
      if (DEV_ONLY_MODULES.some(re => re.test(source))) return STUB
      return source === STUB ? STUB : null
    },
    load(id) {
      // A component import that resolves to nothing would throw; render nothing.
      return id === STUB ? 'export default { render: () => null }' : null
    },
  }
}

/**
 * The standalone help pages (`help/index.html`, `src/help/`).
 *
 * One HTML entry serves every page; which effect it shows is read from the
 * path. So that `/help/<id>/` works on any static host with no rewrite rule,
 * the build writes a copy of the entry at `help/<id>/index.html` for every
 * published page (the asset URLs in it are absolute, so a copy one level down
 * loads the same bundle), with the effect's name in its <title>. The dev and
 * preview servers rewrite the same paths to the entry.
 */
function helpPages(devPanels) {
  let outDir = 'dist'
  const rewrite = (req, _res, next) => {
    const path = (req.url || '').split('?')[0]
    if (/^\/help(\/[^/.]*)?\/?$/.test(path)) req.url = '/help/index.html'
    next()
  }
  return {
    name: 'wavely:help-pages',
    configResolved(config) {
      outDir = config.build.outDir
    },
    // `public/` is copied wholesale, so the screenshots of effects a production
    // build hides would still be fetchable. Remove them, like their pages.
    async closeBundle() {
      if (devPanels) return
      const { rm } = await import('node:fs/promises')
      const { join, resolve } = await import('node:path')
      const { HELP_META } = await import('./src/content/help/index.js')
      for (const [id, meta] of Object.entries(HELP_META)) {
        if (meta.release === 'dev') await rm(join(resolve(outDir), 'help/shots', id), { recursive: true, force: true })
      }
    },
    configureServer(server) {
      server.middlewares.use(rewrite)
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite)
    },
    // `post`: Vite's own HTML plugin emits the entry in this same hook.
    // The help index is imported HERE, at build time, not at the top of this
    // file: anything the config imports is a config dependency, and Vite
    // restarts the dev server whenever one changes — every edit to a help page.
    generateBundle: { order: 'post', async handler(_options, bundle) {
      const entry = bundle['help/index.html']
      if (!entry) return
      const { HELP_META, publishedHelpIds } = await import('./src/content/help/index.js')
      const html = String(entry.source)
      for (const id of publishedHelpIds(devPanels)) {
        const title = HELP_META[id].title.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        this.emitFile({
          type: 'asset',
          fileName: `help/${id}/index.html`,
          source: html.replace(/<title>[^<]*<\/title>/, `<title>${title} help — crisp.fm</title>`),
        })
      }
    } },
  }
}

export default defineConfig(({ mode }) => {
  // Read the env exactly as Vite will, including .env files. The '' prefix
  // loads every variable, not just VITE_-prefixed ones, so the value is seen
  // however it was provided.
  const env = loadEnv(mode, process.cwd(), '')
  const devPanels = mode === 'development' || env.VITE_DEV_PANELS === '1'

  return {
    plugins: [
      stripDevOnlyModules(devPanels),
      helpPages(devPanels),
      vue(),
      tailwindcss(),
    ],
    build: {
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          help: fileURLToPath(new URL('./help/index.html', import.meta.url)),
        },
      },
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
        },
        '/checker': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
        },
      },
    },
  }
})
