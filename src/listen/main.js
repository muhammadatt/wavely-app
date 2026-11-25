/**
 * Entry for the shared before / after page (`s/index.html`, served at
 * `/s/<id>`). A separate Vite entry like the effect pages: it loads the share,
 * the A/B player and a Supabase client, never the editor.
 */
import { createApp } from 'vue'
import ListenApp from './ListenApp.vue'

createApp(ListenApp).mount('#listen')
