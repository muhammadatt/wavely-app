<script setup>
/**
 * A shared before / after (`/s/<id>`, made in the editor by the chain window's
 * Share…, useShareListen.js).
 *
 * ⚠ IT IS MEANT TO LOOK LIKE AN ORDINARY SHARED FILE, NOT A PRODUCT PAGE
 * (owner, November 2026): people arrive from a Reddit comment expecting a
 * recording, and the effect pages' teal-on-black marketing styling read as an
 * advert. So: a light, neutral page (dark only if the visitor's system is),
 * system fonts, a small text wordmark, the recording in a plain card with its
 * player and downloads, and the app mentioned once, quietly, underneath —
 * what processed it, "Open in crisp.fm", and the chain alone for the visitor's
 * own audio (a `#share=` link, audio/shareLink.js).
 *
 * Read through `get_share(id)` (supabase/migrations/20261125000000_shares.sql):
 * one share for one id, nothing listed. The page imports nothing from the editor.
 */
import { computed, onMounted, ref } from 'vue'
import SharePlayer from './SharePlayer.vue'
import { formatClock } from '../marketing/abPlayback.js'
import { AUTH_ENABLED, SUPABASE_URL, SUPABASE_KEY } from '../auth/config.js'
import { getSupabase } from '../auth/supabaseClient.js'
import { createShareApi } from '../api/shares.js'
import { openInEditorUrl, shareIdFromLocation } from '../audio/shareRecord.js'
import { encodeShare, shareUrl } from '../audio/shareLink.js'
import { HELP_META } from '../content/help/meta.js'
import { MARKETING, marketingUrl } from '../content/marketing/index.js'
import { ABUSE_CONTACT_EMAIL } from '../content/legal/contact.js'

const id = shareIdFromLocation(window.location.pathname, window.location.search)
const status = ref('loading') // loading | ready | missing | unavailable | failed
const share = ref(null)
const chainLink = ref('')

const plugins = computed(() => (share.value?.chain.slots ?? [])
  .filter(slot => slot?.active !== false)
  .map((slot) => {
    const pluginId = typeof slot?.plugin === 'string' ? slot.plugin : ''
    const meta = HELP_META[pluginId]
    const published = meta && meta.release !== 'dev'
    return {
      name: meta?.title ?? 'an effect',
      href: published && MARKETING[pluginId] ? marketingUrl(pluginId) : null,
    }
  }))

const clip = computed(() => (share.value ? { id: share.value.id, audio: share.value.audio } : null))

const created = computed(() => {
  const t = share.value?.createdAt ? new Date(share.value.createdAt) : null
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
})

/** A public storage URL that downloads under a readable name (Supabase's `?download=`). */
function downloadUrl(url, suffix) {
  const base = (share.value?.title ?? 'recording').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'recording'
  return `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(`${base} (${suffix}).mp3`)}`
}

const editorHref = computed(() => openInEditorUrl(id))
const reportHref = computed(() => (/^\S+@\S+$/.test(ABUSE_CONTACT_EMAIL)
  ? `mailto:${ABUSE_CONTACT_EMAIL}?subject=${encodeURIComponent(`Report: shared page ${id}`)}`
  : null))

onMounted(async () => {
  if (!id) { status.value = 'missing'; return }
  if (!AUTH_ENABLED) { status.value = 'unavailable'; return }
  try {
    const found = await createShareApi(getSupabase(SUPABASE_URL, SUPABASE_KEY)).get(id)
    if (!found) { status.value = 'missing'; return }
    share.value = found
    status.value = 'ready'
    document.title = `${found.title} — crisp.fm`
    // The chain alone, for the visitor's own audio: the editor's chain link.
    encodeShare({ v: 1, kind: 'chain', name: found.title, params: found.chain })
      .then((code) => { chainLink.value = shareUrl(code, window.location.origin) })
      .catch(() => {})
  } catch (err) {
    console.error(err)
    status.value = 'failed'
  }
})
</script>

<template>
  <div class="ls">
    <header class="ls-top">
      <a href="/" class="ls-mark" aria-label="crisp.fm">crisp<span class="ls-mark-fm">•fm</span></a>
    </header>

    <main class="ls-main">
      <div v-if="status === 'loading'" class="ls-card ls-card--empty">Loading…</div>

      <div v-else-if="status !== 'ready'" class="ls-card ls-card--empty">
        <p class="ls-empty-title">{{ status === 'failed' ? 'This page didn’t load' : 'This recording isn’t available' }}</p>
        <p class="ls-empty-text">
          <template v-if="status === 'failed'">Check your connection and reload the page.</template>
          <template v-else-if="status === 'unavailable'">Shared recordings aren’t available on this site.</template>
          <template v-else>The link may be wrong, or the person who shared it deleted it.</template>
        </p>
      </div>

      <template v-else>
        <article class="ls-card">
          <h1 class="ls-title">{{ share.title }}</h1>
          <p class="ls-meta">
            <span>{{ formatClock(share.seconds) }}</span>
            <span v-if="created"> · Shared {{ created }}</span>
          </p>
          <p v-if="share.note" class="ls-note">{{ share.note }}</p>

          <SharePlayer class="ls-player" :clip="clip" />

          <div class="ls-downloads">
            <a :href="downloadUrl(share.audio.on, 'processed')" class="ls-btn ls-btn--primary" data-testid="download-processed">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
              Download processed
            </a>
            <a :href="downloadUrl(share.audio.off, 'original')" class="ls-btn">Download original</a>
            <span class="ls-format">MP3</span>
          </div>
        </article>

        <p class="ls-made" data-testid="made-with">
          Processed in the browser with
          <a href="/" class="ls-link">crisp.fm</a><template v-if="plugins.length">
            using <template v-for="(p, i) in plugins" :key="i"><a v-if="p.href" :href="p.href" class="ls-link">{{ p.name }}</a><span v-else>{{ p.name }}</span><template v-if="i < plugins.length - 2">, </template><template v-else-if="i === plugins.length - 2"> and </template></template></template>.
          <br>
          <a :href="editorHref" class="ls-link" data-testid="open-in-editor">Open it in the editor</a>
          <template v-if="chainLink"> · <a :href="chainLink" class="ls-link">Try these settings on your own audio</a></template>
        </p>
      </template>
    </main>

    <footer class="ls-footer">
      <a href="/terms/">Terms</a>
      <a href="/privacy/">Privacy</a>
      <a v-if="reportHref" :href="reportHref">Report</a>
    </footer>
  </div>
</template>

<style>
:root {
  --ls-bg: #f6f6f4;
  --ls-card: #ffffff;
  --ls-line: #e2e2de;
  --ls-hover: #efefec;
  --ls-ink: #1f1f1e;
  --ls-soft: #55554f;
  --ls-muted: #8a8a83;
  --ls-wave: #c9c9c3;
  --ls-focus: #4a7fd6;
  --ls-brand: #f47629;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ls-bg: #161616;
    --ls-card: #1f1f1f;
    --ls-line: #333331;
    --ls-hover: #2a2a29;
    --ls-ink: #ececea;
    --ls-soft: #b4b4ae;
    --ls-muted: #85857f;
    --ls-wave: #4a4a47;
    --ls-focus: #7aa5ec;
    color-scheme: dark;
  }
}
html, body { margin: 0; background: var(--ls-bg); }
</style>

<style scoped>
.ls {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--ls-bg);
  color: var(--ls-ink);
  font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
.ls-top { padding: 18px 24px; }
.ls-mark { font-size: 17px; font-weight: 600; letter-spacing: -.01em; color: var(--ls-soft); text-decoration: none; }
.ls-mark-fm { color: var(--ls-brand); margin-left: 1px; }
.ls-main { flex: 1; width: 100%; max-width: 640px; box-sizing: border-box; margin: 0 auto; padding: 24px 16px 40px; }
.ls-card {
  background: var(--ls-card);
  border: 1px solid var(--ls-line);
  border-radius: 12px;
  padding: 24px;
}
.ls-card--empty { text-align: center; color: var(--ls-muted); padding: 40px 24px; }
.ls-empty-title { margin: 0; font-size: 17px; font-weight: 600; color: var(--ls-ink); }
.ls-empty-text { margin: 6px 0 0; }
.ls-title { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 600; overflow-wrap: anywhere; }
.ls-meta { margin: 4px 0 0; font-size: 13px; color: var(--ls-muted); }
.ls-note { margin: 14px 0 0; color: var(--ls-soft); white-space: pre-line; overflow-wrap: anywhere; }
.ls-player { margin-top: 20px; }
.ls-downloads {
  margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--ls-line);
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
}
.ls-btn {
  display: inline-flex; align-items: center; gap: 7px;
  height: 36px; padding: 0 14px; border-radius: 8px;
  border: 1px solid var(--ls-line); background: var(--ls-card); color: var(--ls-ink);
  font-size: 14px; font-weight: 500; text-decoration: none;
}
.ls-btn:hover { background: var(--ls-hover); }
.ls-btn svg { width: 16px; height: 16px; }
.ls-btn--primary { background: var(--ls-ink); border-color: var(--ls-ink); color: var(--ls-card); }
.ls-btn--primary:hover { background: var(--ls-ink); opacity: .88; }
.ls-format { font-size: 12.5px; color: var(--ls-muted); }
.ls-made { margin: 18px 4px 0; font-size: 13.5px; line-height: 1.7; color: var(--ls-muted); text-align: center; }
.ls-link { color: var(--ls-soft); text-decoration: underline; text-decoration-color: var(--ls-line); text-underline-offset: 3px; }
.ls-link:hover { color: var(--ls-ink); text-decoration-color: currentColor; }
.ls-footer { display: flex; justify-content: center; gap: 18px; padding: 20px 16px 28px; font-size: 12.5px; }
.ls-footer a { color: var(--ls-muted); text-decoration: none; }
.ls-footer a:hover { color: var(--ls-soft); text-decoration: underline; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--ls-focus); outline-offset: 2px; border-radius: 4px; }
@media (max-width: 480px) {
  .ls-top { padding: 14px 16px; }
  .ls-main { padding: 12px 12px 32px; }
  .ls-card { padding: 18px 16px; }
}
</style>
