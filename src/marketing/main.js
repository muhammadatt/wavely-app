/**
 * Entry for the effect marketing pages (`plugins/index.html`, served at
 * `/plugins/` and `/plugins/<slug>/`). A separate Vite entry, like the help
 * pages: a product page loads its content and its player, never the editor.
 */
import { createApp } from 'vue'
import MarketingApp from './MarketingApp.vue'

createApp(MarketingApp).mount('#marketing')
