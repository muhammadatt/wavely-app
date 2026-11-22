<script setup>
/**
 * The ad-consent bar — small, non-modal, at the bottom of the page.
 *
 * Rules (see `src/platform/consent.js` for the logic):
 *   - REJECT AND ACCEPT ARE THE SAME BUTTON: same class, size, weight and
 *     colour, one click each. A refusal must never be harder than a yes.
 *   - It never blocks the page: no backdrop, no focus trap, no scroll lock.
 *   - It shows only when `consent` asks (opt-in regions, nothing decided yet,
 *     or "Your privacy choices" pressed); with no vendor configured it never
 *     renders at all.
 *   - Details expands in place and names every configured vendor — a yes
 *     covers only what was named.
 *
 * Imports nothing from the editor, so the marketing bundle stays small.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { consent as defaultConsent, AD_VENDORS, PRIVACY_URL } from '../../platform/consent.js'

const props = defineProps({
  /** The manager to drive — injectable for tests; the browser's by default. */
  manager: { type: Object, default: () => defaultConsent },
  vendors: { type: Object, default: () => AD_VENDORS },
  privacyUrl: { type: String, default: PRIVACY_URL },
})

const state = ref(props.manager.state)
const unsubscribe = props.manager.subscribe(s => {
  // A fresh ask (or a reopen) starts with Details shut.
  if (s.ask && !state.value.ask) detailsOpen.value = false
  state.value = s
})
onBeforeUnmount(unsubscribe)

const detailsOpen = ref(false)

const vendorList = computed(() => [
  props.vendors.metaPixelId && { name: 'Meta (Facebook, Instagram)', what: 'Meta Pixel — measures visits from Meta ads and lets us show you our ads there.' },
  props.vendors.googleAdsId && { name: 'Google Ads', what: 'Google tag — measures visits from Google ads and lets us show you our ads on Google and its partners.' },
].filter(Boolean))

function answer(ads) { props.manager.choose(ads) }
</script>

<template>
  <section
    v-if="state.ready && !state.inert && state.ask"
    class="cb"
    :class="{ 'cb-reopened': state.reopened }"
    role="region"
    aria-label="Advertising cookie choices"
  >
    <p class="cb-text">
      We'd like to use advertising cookies to measure our ads and show you crisp.fm on other sites.
      Your audio is never part of this.
      <span v-if="state.reopened" class="cb-now">Now: {{ state.ads ? 'accepted' : 'rejected' }}.{{ ' ' }}</span>
      <button type="button" class="cb-link" :aria-expanded="detailsOpen" aria-controls="cb-details" @click="detailsOpen = !detailsOpen">
        {{ detailsOpen ? 'Hide details' : 'Details' }}
      </button>
    </p>

    <div v-if="detailsOpen" id="cb-details" class="cb-details">
      <p>If you accept, these load on our marketing pages (never in the editor):</p>
      <ul>
        <li v-for="v in vendorList" :key="v.name"><strong>{{ v.name }}</strong> — {{ v.what }}</li>
      </ul>
      <p>
        If you reject, none of them load. Either way we remember your answer in this browser
        (for 12 months if you accept, 6 if you reject) and you can change it any time from
        “Your privacy choices” at the bottom of the page.
        <a v-if="privacyUrl" :href="privacyUrl" class="cb-link">Privacy policy</a>
      </p>
    </div>

    <button v-if="state.reopened" type="button" class="cb-close" aria-label="Close without changing" @click="manager.cancel()">×</button>

    <div class="cb-actions">
      <button type="button" class="cb-btn" data-consent="reject" @click="answer(false)">Reject</button>
      <button type="button" class="cb-btn" data-consent="accept" @click="answer(true)">Accept</button>
    </div>
  </section>
</template>

<style scoped>
.cb {
  position: fixed;
  left: 20px;
  bottom: 20px;
  z-index: 1000;
  box-sizing: border-box;
  width: min(420px, calc(100vw - 32px));
  padding: 14px 16px;
  border-radius: 12px;
  background: #141920;
  border: 1px solid rgba(255, 255, 255, 0.10);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  color: #eaf6f8;
  font: 13px/1.5 Inter, system-ui, sans-serif;
}
.cb-text { margin: 0; color: rgba(234, 246, 248, 0.82); }
.cb-reopened .cb-text { padding-right: 20px; }
.cb-now { color: #eaf6f8; font-weight: 600; }
.cb-close {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 28px;
  height: 28px;
  border: 0;
  background: none;
  color: rgba(234, 246, 248, 0.6);
  font-size: 18px;
  cursor: pointer;
}
.cb-close:hover { color: #eaf6f8; }
.cb-details { margin-top: 10px; font-size: 12.5px; color: rgba(234, 246, 248, 0.7); }
.cb-details p { margin: 0 0 8px; }
.cb-details ul { margin: 0 0 8px; padding-left: 18px; }
.cb-details li { margin-bottom: 4px; }
.cb-link {
  padding: 0;
  border: 0;
  background: none;
  color: #35d3e6;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.cb-actions { display: flex; gap: 8px; margin-top: 12px; }
/* ONE class for both answers: equal prominence is the rule, not a style. */
.cb-btn {
  flex: 1 1 0;
  min-height: 36px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #eaf6f8;
  font: 600 13px/1 Inter, system-ui, sans-serif;
  cursor: pointer;
}
.cb-btn:hover { background: rgba(255, 255, 255, 0.11); }
.cb-btn:focus-visible, .cb-link:focus-visible { outline: 2px solid #35d3e6; outline-offset: 2px; }

@media (max-width: 640px) {
  .cb { left: 16px; right: 16px; bottom: 16px; width: auto; }
  .cb-btn { min-height: 44px; }
}
</style>
