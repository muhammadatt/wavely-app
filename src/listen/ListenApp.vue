<script setup>
/**
 * A shared before / after (`/s/<id>`, made in the editor by the chain window's
 * Share…, useShareListen.js): the title and note, the two takes in the effect
 * pages' A/B player (lock-step, ON / BYPASS), the chain that made the "after",
 * and the way into the editor — the recording with its chain, or the chain
 * alone on the visitor's own audio (a `#share=` link, audio/shareLink.js).
 *
 * Read through `get_share(id)` (supabase/migrations/20261125000000_shares.sql):
 * one share for one id, nothing listed. The page imports nothing from the editor.
 */
import { computed, onMounted, ref } from 'vue'
import ABPlayer from '../marketing/ABPlayer.vue'
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

const plugins = computed(() => (share.value?.chain.slots ?? []).map((slot) => {
  const pluginId = typeof slot?.plugin === 'string' ? slot.plugin : ''
  const meta = HELP_META[pluginId]
  const published = meta && meta.release !== 'dev'
  return {
    name: meta?.title ?? 'An effect',
    href: published && MARKETING[pluginId] ? marketingUrl(pluginId) : null,
    active: slot?.active !== false,
  }
}))

const chainSummary = computed(() => plugins.value.filter(p => p.active).map(p => p.name).join(' → '))

const samples = computed(() => (share.value ? [{
  id: share.value.id,
  title: share.value.title,
  text: '',
  setting: chainSummary.value,
  audio: {
    off: share.value.audio.off,
    on: share.value.audio.on,
    seconds: share.value.seconds,
    levelDb: share.value.levelDb,
  },
}] : []))

const created = computed(() => {
  const t = share.value?.createdAt ? new Date(share.value.createdAt) : null
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : ''
})

const editorHref = () => openInEditorUrl(id)
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
    document.title = `${found.title} — before / after | crisp.fm`
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
      <a href="/effects/" class="ls-brand" aria-label="crisp.fm effects">
        <img src="/crisp-fm-logo.png" alt="crisp.fm" class="ls-logo" draggable="false" />
      </a>
      <a href="/" class="ls-cta ls-cta--small">Open the editor</a>
    </header>

    <main class="ls-main">
      <p v-if="status === 'loading'" class="ls-msg">Loading…</p>
      <template v-else-if="status !== 'ready'">
        <h1 class="ls-title">{{ status === 'failed' ? 'This page didn’t load' : 'Nothing here' }}</h1>
        <p class="ls-msg">
          <template v-if="status === 'failed'">Check your connection and reload the page.</template>
          <template v-else-if="status === 'unavailable'">Shared recordings aren’t available on this site.</template>
          <template v-else>This shared recording doesn’t exist, or its owner deleted it.</template>
        </p>
        <a href="/" class="ls-cta">Try the editor</a>
      </template>

      <template v-else>
        <p class="ls-eyebrow">Before / after</p>
        <h1 class="ls-title">{{ share.title }}</h1>
        <p v-if="created" class="ls-date">Shared {{ created }}</p>
        <p v-if="share.note" class="ls-note">{{ share.note }}</p>

        <ABPlayer
          :samples="samples" name="Chain" :show-list="false"
          :try-href="editorHref" try-label="Open in crisp.fm"
        />

        <section class="ls-chain" aria-labelledby="ls-chain-h">
          <h2 id="ls-chain-h" class="ls-h2">The chain</h2>
          <p class="ls-lede">Processed in the browser by these effects, top first.</p>
          <ol class="ls-list">
            <li v-for="(p, i) in plugins" :key="i" :class="{ 'is-off': !p.active }">
              <a v-if="p.href" :href="p.href">{{ p.name }}</a><span v-else>{{ p.name }}</span>
              <span v-if="!p.active" class="ls-off"> (bypassed)</span>
            </li>
          </ol>
          <div class="ls-actions">
            <a :href="editorHref()" class="ls-cta" data-testid="open-in-editor">Open this in crisp.fm</a>
            <a v-if="chainLink" :href="chainLink" class="ls-ghost">Use this chain on your own audio</a>
          </div>
          <p class="ls-small">
            Downloads: <a :href="share.audio.off" download>before</a> · <a :href="share.audio.on" download>after</a> (MP3)
          </p>
        </section>
      </template>
    </main>

    <footer class="ls-footer">
      <p>Shared by a crisp.fm user. crisp.fm doesn’t review shared recordings.
        <template v-if="reportHref"> <a :href="reportHref">Report this page</a>.</template>
      </p>
      <p><a href="/terms/">Terms of Service</a> · <a href="/privacy/">Privacy Policy</a></p>
    </footer>
  </div>
</template>

<style>
html, body { margin: 0; background: #0b0e12; }
</style>

<style scoped>
.ls {
  /* The effect pages' tokens: ABPlayer reads them. */
  --mk-bg: #0b0e12;
  --mk-surface: #141920;
  --mk-hairline: rgba(255, 255, 255, 0.08);
  --mk-text: #eaf6f8;
  --mk-soft: rgba(234, 246, 248, 0.7);
  --mk-muted: rgba(234, 246, 248, 0.45);
  --mk-accent: #35d3e6;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(1200px 600px at 75% -10%, rgba(53, 211, 230, 0.10), transparent 60%),
    var(--mk-bg);
  color: var(--mk-text);
  font-family: Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
.ls-top {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 32px; border-bottom: 1px solid var(--mk-hairline);
}
.ls-logo { height: 22px; display: block; }
.ls-main { flex: 1; width: 100%; max-width: 860px; box-sizing: border-box; margin: 0 auto; padding: 48px 32px 56px; }
.ls-eyebrow { margin: 0; font: 600 12px 'JetBrains Mono', ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; color: var(--mk-accent); }
.ls-title { margin: 8px 0 0; font-size: 34px; line-height: 1.15; font-weight: 800; letter-spacing: -.01em; overflow-wrap: anywhere; }
.ls-date { margin: 8px 0 0; font-size: 13px; color: var(--mk-muted); }
.ls-note { margin: 16px 0 0; font-size: 16px; line-height: 1.6; color: var(--mk-soft); white-space: pre-line; overflow-wrap: anywhere; }
.ls-msg { margin: 12px 0 20px; font-size: 15px; color: var(--mk-soft); }
.ls-main :deep(.ab) { margin-top: 28px; }
.ls-chain { margin-top: 40px; }
.ls-h2 { margin: 0; font-size: 20px; font-weight: 700; }
.ls-lede { margin: 6px 0 0; font-size: 14px; color: var(--mk-muted); }
.ls-list { margin: 14px 0 0; padding-left: 22px; font-size: 15px; line-height: 1.8; }
.ls-list a { color: var(--mk-text); text-decoration-color: rgba(53, 211, 230, .5); text-underline-offset: 3px; }
.ls-list .is-off { color: var(--mk-muted); }
.ls-off { font-size: 13px; }
.ls-actions { margin-top: 22px; display: flex; flex-wrap: wrap; align-items: center; gap: 14px 20px; }
.ls-cta {
  display: inline-flex; align-items: center; height: 42px; padding: 0 20px; border-radius: 12px;
  background: var(--mk-accent); color: #06232a; font-weight: 700; font-size: 14px; text-decoration: none;
}
.ls-cta:hover { filter: brightness(1.08); }
.ls-cta--small { height: 34px; padding: 0 14px; font-size: 13px; border-radius: 10px; }
.ls-ghost { font-size: 14px; font-weight: 600; color: var(--mk-soft); }
.ls-ghost:hover { color: var(--mk-text); }
.ls-small { margin: 18px 0 0; font-size: 13px; color: var(--mk-muted); }
.ls-small a { color: var(--mk-soft); }
.ls-footer { padding: 20px 32px 28px; border-top: 1px solid var(--mk-hairline); font-size: 12.5px; color: var(--mk-muted); }
.ls-footer p { margin: 4px 0; }
@media (max-width: 640px) {
  .ls-top { padding: 12px 16px; }
  .ls-main { padding: 28px 16px 40px; }
  .ls-title { font-size: 26px; }
  .ls-footer { padding: 16px; }
}
</style>
