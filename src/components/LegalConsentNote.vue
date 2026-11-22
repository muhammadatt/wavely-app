<script setup>
/**
 * "By creating an account you agree to…" under every way of creating one
 * (password, emailed link, Google…) — one component so the forms cannot drift.
 * The links open a new tab: never navigate the editor away from unsaved work.
 */
</script>

<template>
  <p class="legal-note">
    By creating an account you agree to the
    <a href="/terms/" target="_blank" rel="noopener">Terms of Service</a>
    and
    <a href="/privacy/" target="_blank" rel="noopener">Privacy Policy</a>.
  </p>
</template>

<style scoped>
.legal-note {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.42);
}
.legal-note a {
  font-weight: 600;
  color: var(--color-accent-bright);
  text-decoration: none;
}
.legal-note a:hover { text-decoration: underline; }
</style>
