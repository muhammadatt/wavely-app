/**
 * Entry for the standalone help pages (`help/index.html`, served at `/help/`
 * and `/help/<window-id>/`). A separate Vite entry so a help tab loads only the
 * help content and this page — never the editor, its stylesheet or its audio
 * engine.
 */
import { createApp } from 'vue'
import HelpApp from './HelpApp.vue'

createApp(HelpApp).mount('#help')
