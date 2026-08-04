import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

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
const DEV_ONLY_MODULES = [/SibilanceTuningPanel\.vue$/]

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

export default defineConfig(({ mode }) => {
  // Read the env exactly as Vite will, including .env files. The '' prefix
  // loads every variable, not just VITE_-prefixed ones, so the value is seen
  // however it was provided.
  const env = loadEnv(mode, process.cwd(), '')
  const devPanels = mode === 'development' || env.VITE_DEV_PANELS === '1'

  return {
    plugins: [
      stripDevOnlyModules(devPanels),
      vue(),
      tailwindcss(),
    ],
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/checker': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  }
})
