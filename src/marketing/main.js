/**
 * Entry for the effect marketing pages (`effects/index.html`, served at
 * `/effects/` and `/effects/<slug>/`). A separate Vite entry, like the help
 * pages: a product page loads its content and its player, never the editor.
 */
import { createApp } from 'vue'
import MarketingApp from './MarketingApp.vue'
import { consent } from '../platform/consent.js'

createApp(MarketingApp).mount('#marketing')
// Ad consent (src/platform/consent.js): inert unless a pixel id is configured.
// The marketing pages are the ONLY place it starts — the editor loads no pixel.
consent.start()
