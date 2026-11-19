<script setup>
/**
 * Server jobs a closed or crashed tab left running, picked up by this one
 * (useServerJobs.js): one card each, showing the wait, then Apply once the
 * server is done. Jobs this tab started itself show on the processing overlay
 * instead and never appear here.
 */
import { useServerJobs } from '../composables/useServerJobs.js'
import { useEditorState } from '../composables/useEditorState.js'
import { matchDocument } from '../audio/serverJobRecord.js'

const { jobs, applyResumed, forget } = useServerJobs()
const { appState } = useEditorState()

const KIND_LABEL = { mastering: 'Mastering', noiseReduction: 'Noise Reduction' }

function waitText(entry) {
  if (entry.queuePosition != null) return `Waiting in line on the server (${entry.queuePosition} ahead)`
  return entry.progress || 'Still running on the server…'
}

/** Whether Apply will land on the file (it is open with the timeline that was sent) or open a new one. */
function landsOnFile(entry) {
  return !!matchDocument(entry.record, appState.documents)
}
</script>

<template>
  <div v-if="jobs.resumed.length" class="jobs" data-testid="resumed-jobs">
    <div v-for="entry in jobs.resumed" :key="entry.record.jobId" class="job" role="status">
      <div class="job-eyebrow">{{ KIND_LABEL[entry.record.kind] }} · resumed</div>
      <div class="job-name" :title="entry.record.name">{{ entry.record.name }}</div>

      <template v-if="entry.status === 'running'">
        <div class="job-line"><span class="lamp" aria-hidden="true" />{{ waitText(entry) }}</div>
        <div class="job-actions">
          <button type="button" class="job-link" @click="forget(entry)">Stop waiting</button>
        </div>
      </template>

      <template v-else-if="entry.status === 'ready'">
        <div class="job-line">
          Finished.
          <template v-if="landsOnFile(entry)">Apply it to the file as one undo step.</template>
          <template v-else>The file isn't open as it was sent, so it opens as a new file. Restore your files first to apply it to them.</template>
        </div>
        <div class="job-actions">
          <button type="button" class="job-apply" :disabled="entry.busy" @click="applyResumed(entry)">
            {{ entry.busy ? 'Downloading…' : landsOnFile(entry) ? 'Apply' : 'Open as new file' }}
          </button>
          <button type="button" class="job-link" :disabled="entry.busy" @click="forget(entry)">Discard</button>
        </div>
      </template>

      <template v-else>
        <div class="job-line warn">{{ entry.error }}</div>
        <div class="job-actions">
          <button type="button" class="job-link" @click="forget(entry)">Dismiss</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.jobs {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 45;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(340px, calc(100vw - 32px));
  font-family: 'Inter', sans-serif;
}
.job {
  padding: 14px 16px;
  border-radius: 14px;
  background: #161b22;
  border: 1px solid rgba(255,255,255,.1);
  box-shadow: 0 12px 32px rgba(0,0,0,.45);
}
.job-eyebrow {
  font: 600 10.5px 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: #35d3e6;
}
.job-name {
  margin-top: 4px;
  font-size: 14px;
  font-weight: 700;
  color: #eaf6f8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.job-line {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.45;
  color: rgba(255,255,255,.62);
}
.job-line.warn { color: #e0b84a; }
.lamp {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 7px;
  border-radius: 50%;
  background: #35d3e6;
  vertical-align: 1px;
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .lamp { animation: none; } }
.job-actions {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 14px;
}
.job-apply {
  height: 32px;
  padding: 0 14px;
  border: none;
  border-radius: 10px;
  background: #35d3e6;
  color: #06232a;
  font: 700 12.5px 'Inter', sans-serif;
  cursor: pointer;
}
.job-apply:disabled { opacity: .6; cursor: default; }
.job-link {
  border: none;
  background: none;
  padding: 0;
  font: 600 12px 'Inter', sans-serif;
  color: rgba(255,255,255,.55);
  text-decoration: underline;
  cursor: pointer;
}
.job-link:hover { color: #eaf6f8; }
.job-link:disabled { opacity: .5; cursor: default; }
</style>
