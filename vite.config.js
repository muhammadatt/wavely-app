import { defineConfig } from 'vite'
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

export default defineConfig(({ mode }) => ({
  plugins: [
    stripDevOnlyModules(mode === 'development' || process.env.VITE_DEV_PANELS === '1'),
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
}))
