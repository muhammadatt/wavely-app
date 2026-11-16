/**
 * Entry for the effect marketing pages (`effects/index.html`, served at
 * `/effects/` and `/effects/<slug>/`). A separate Vite entry, like the help
 * pages: a product page loads its content and its player, never the editor.
 */
import { createApp } from 'vue'
import MarketingApp from './MarketingApp.vue'

createApp(MarketingApp).mount('#marketing')
