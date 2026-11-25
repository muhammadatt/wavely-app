<script setup>
/**
 * Share a before / after (useShareListen.js): what will be shared, a title, a
 * note and the rights check, then the link. Below it, the user's own shares,
 * each with Copy and Delete — the only place a share is taken down.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useShareListen } from '../composables/useShareListen.js'
import { usePluginChain } from '../composables/usePluginChain.js'
import { SHARE_NOTE_MAX, SHARE_TITLE_MAX } from '../audio/shareRecord.js'

const share = useShareListen()
const { liveSlots } = usePluginChain()
const st = share.state

const title = ref('')
const note = ref('')
const rights = ref(false)
const titleInput = ref(null)
const showMine = ref(false)

watch(() => st.open, async (open) => {
  if (!open) return
  title.value = share.defaultTitle()
  note.value = ''
  rights.value = false
  showMine.value = false
  await nextTick()
  titleInput.value?.focus()
  titleInput.value?.select()
})

const span = computed(() => (st.open ? share.span() : null))
const blocker = computed(() => (st.open && !st.busy ? share.blocker() : ''))
const chainNames = computed(() => liveSlots.value.map(s => s.label).join(' → '))

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

async function create() {
  if (!rights.value || blocker.value) return
  await share.create({ title: title.value, note: note.value })
}

function toggleMine() {
  showMine.value = !showMine.value
  if (showMine.value) share.listMine()
}

function confirmRemove(item) {
  if (window.confirm(`Delete “${item.title}”? Its link will stop working.`)) share.remove(item.id)
}

function onKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); share.close() }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="st.open" class="sd-backdrop" @pointerdown.self="share.close()" @keydown="onKey">
      <div class="sd" role="dialog" aria-modal="true" aria-labelledby="sd-title" data-testid="share-dialog">
        <div class="sd-head">
          <h2 id="sd-title" class="sd-title">Share a before / after</h2>
          <button type="button" class="sd-x" aria-label="Close" :disabled="st.busy" @click="share.close()">×</button>
        </div>

        <template v-if="!st.made">
          <p class="sd-what">
            <template v-if="span">
              <strong>{{ span.whole ? 'The whole file' : 'The selection' }}</strong> ({{ clock(span.end - span.start) }}),
              as it is and through <strong>{{ chainNames || 'the chain' }}</strong>.
            </template>
            Anyone with the link can listen, download both takes and open them in the editor with this chain. The link isn’t listed anywhere.
          </p>

          <label class="sd-label" for="sd-name">Title</label>
          <input id="sd-name" ref="titleInput" v-model="title" class="sd-input" :maxlength="SHARE_TITLE_MAX" :disabled="st.busy">

          <label class="sd-label" for="sd-note">Note <span class="sd-opt">(optional)</span></label>
          <textarea
            id="sd-note" v-model="note" class="sd-input sd-note" :maxlength="SHARE_NOTE_MAX" rows="3" :disabled="st.busy"
            placeholder="What you changed, or what to listen for"
          />

          <label class="sd-check">
            <input v-model="rights" type="checkbox" :disabled="st.busy">
            <span>I have the right to share this recording (it’s mine, or its owner agreed).</span>
          </label>

          <p v-if="blocker" class="sd-warn">{{ blocker }}</p>
          <p v-else-if="st.error" class="sd-warn" role="alert">{{ st.error }}</p>
          <p v-else-if="st.busy" class="sd-stage" role="status"><span class="sd-lamp" aria-hidden="true" />{{ share.stageText() }}</p>

          <div class="sd-actions">
            <button type="button" class="sd-primary" :disabled="st.busy || !rights || !!blocker || !title.trim()" @click="create">
              {{ st.busy ? 'Sharing…' : 'Create link' }}
            </button>
            <button type="button" class="sd-link" :disabled="st.busy" @click="share.close()">Cancel</button>
          </div>
        </template>

        <template v-else>
          <p class="sd-what"><strong>{{ st.made.title }}</strong> is ready to share.</p>
          <div class="sd-url">
            <input class="sd-input" :value="st.made.url" readonly data-testid="share-url" @focus="$event.target.select()">
            <button type="button" class="sd-primary" @click="share.copy(st.made.url)">Copy</button>
          </div>
          <div class="sd-actions">
            <a :href="st.made.url" target="_blank" rel="noopener" class="sd-link">Open the page</a>
            <button type="button" class="sd-link" @click="confirmRemove({ id: st.made.id, title: st.made.title })">Delete this share</button>
          </div>
        </template>

        <div class="sd-mine">
          <button type="button" class="sd-link" @click="toggleMine">{{ showMine ? 'Hide your shares' : 'Your shares…' }}</button>
          <template v-if="showMine">
            <p v-if="st.mineError" class="sd-warn">{{ st.mineError }}</p>
            <p v-else-if="!st.mine" class="sd-stage">Loading…</p>
            <p v-else-if="!st.mine.length" class="sd-stage">You haven’t shared anything yet.</p>
            <ul v-else class="sd-list">
              <li v-for="item in st.mine" :key="item.id">
                <a :href="item.url" target="_blank" rel="noopener" class="sd-item-name">{{ item.title }}</a>
                <span class="sd-item-len">{{ clock(item.seconds) }}</span>
                <button type="button" class="sd-link" @click="share.copy(item.url)">Copy</button>
                <button type="button" class="sd-link" @click="confirmRemove(item)">Delete</button>
              </li>
            </ul>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sd-backdrop {
  position: fixed; inset: 0; z-index: 5000;
  display: grid; place-items: center;
  padding: 16px;
  background: rgba(4, 6, 9, .6);
}
.sd {
  width: min(460px, 100%);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  box-sizing: border-box;
  padding: 18px 20px;
  border-radius: 14px;
  background: #161b22;
  border: 1px solid rgba(255,255,255,.1);
  box-shadow: 0 20px 50px rgba(0,0,0,.55);
  font-family: 'Inter', sans-serif;
  color: #eaf6f8;
}
.sd-head { display: flex; align-items: center; justify-content: space-between; }
.sd-title { margin: 0; font-size: 16px; font-weight: 700; }
.sd-x { border: none; background: none; color: rgba(255,255,255,.55); font-size: 22px; cursor: pointer; line-height: 1; }
.sd-x:hover { color: #fff; }
.sd-what { margin: 10px 0 4px; font-size: 13px; line-height: 1.5; color: rgba(255,255,255,.7); }
.sd-what strong { color: #eaf6f8; font-weight: 600; }
.sd-label { display: block; margin-top: 12px; font-size: 12px; font-weight: 600; color: rgba(255,255,255,.75); }
.sd-opt { font-weight: 400; color: rgba(255,255,255,.45); }
.sd-input {
  width: 100%; box-sizing: border-box; margin-top: 5px;
  padding: 8px 10px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,.13); background: rgba(255,255,255,.05);
  color: #eaf6f8; font: 500 13px 'Inter', sans-serif; outline: none;
}
.sd-input:focus { border-color: #35d3e6; }
.sd-note { resize: vertical; min-height: 60px; }
.sd-check { display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; font-size: 12.5px; line-height: 1.45; color: rgba(255,255,255,.72); cursor: pointer; }
.sd-check input { margin-top: 2px; }
.sd-warn { margin: 10px 0 0; font-size: 12.5px; line-height: 1.45; color: #e0b84a; }
.sd-stage { margin: 10px 0 0; font-size: 12.5px; color: rgba(255,255,255,.62); }
.sd-lamp { display: inline-block; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: #35d3e6; vertical-align: 1px; animation: sd-pulse 1.4s ease-in-out infinite; }
@keyframes sd-pulse { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .sd-lamp { animation: none; } }
.sd-actions { margin-top: 14px; display: flex; align-items: center; gap: 14px; }
.sd-primary {
  height: 34px; padding: 0 16px; border: none; border-radius: 10px;
  background: #35d3e6; color: #06232a; font: 700 13px 'Inter', sans-serif; cursor: pointer; flex: none;
}
.sd-primary:disabled { opacity: .45; cursor: default; }
.sd-link { border: none; background: none; padding: 0; font: 600 12.5px 'Inter', sans-serif; color: rgba(255,255,255,.6); text-decoration: underline; cursor: pointer; }
.sd-link:hover:not(:disabled) { color: #eaf6f8; }
.sd-link:disabled { opacity: .5; cursor: default; }
.sd-url { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
.sd-url .sd-input { margin-top: 0; }
.sd-mine { margin-top: 18px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.08); }
.sd-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.sd-list li { display: flex; align-items: center; gap: 10px; font-size: 12.5px; }
.sd-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #eaf6f8; text-decoration: none; }
.sd-item-name:hover { text-decoration: underline; }
.sd-item-len { color: rgba(255,255,255,.45); font-variant-numeric: tabular-nums; }
</style>
