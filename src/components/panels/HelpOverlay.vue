<script setup>
/**
 * The help panel — usage instructions for whichever effect is in the harness.
 *
 * It renders `src/content/help/<window-id>.js` and owns every decision about
 * how that content looks. The content files hold no markup and no styling for
 * exactly this reason: fifteen files edited over time will not agree on a
 * layout, and the one thing this panel has to be is the same panel on every
 * effect.
 *
 * ── IT COVERS THE FACE, NOT THE WINDOW ──────────────────────────────────────
 * The harness header stays visible above it, so the button that opened it is
 * the button that closes it and the window never loses its identity. The footer
 * stays too: reading how an effect works and then applying it is one thought,
 * and hiding Apply behind the instructions for using it would be perverse.
 *
 * Deliberately NOT modal. Audio keeps playing, the waveform stays usable, and
 * the effect keeps running — help you can read while the thing is working is
 * worth more than help that stops it.
 */
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  help: { type: Object, required: true },
  // The window's own brand mark, so the panel says what it is help FOR without
  // the content file having to repeat a name it does not own.
  title: { type: String, default: '' },
})

defineEmits(['close'])

/**
 * Order: what it is, when to reach for it, how to work it, what each control
 * does, then the caveats.
 *
 * The control reference sat last in the first cut and that was wrong — on an
 * effect with anything to say it fell below the fold, so the section people
 * open a help panel to read was the one they had to scroll for, behind the
 * caveats about a feature they had not used yet.
 */
const leadSections = computed(() => [
  { key: 'when', heading: 'When to use it', items: props.help.whenToUse },
  { key: 'steps', heading: 'How to use it', items: props.help.steps, ordered: true },
])
const tailSections = computed(() => [
  { key: 'notes', heading: 'Worth knowing', items: props.help.notes },
])

/**
 * Whether the panel runs past its own bottom edge.
 *
 * The harness has a "MORE ↓" hint for exactly this and it watches the FACE, so
 * it is hidden while help is open — which left the help panel with the defect
 * that hint was written for. On a 360px window help is several screens long and
 * the only thing saying so was a hairline scrollbar on a near-black surface.
 *
 * Measured rather than derived: only the DOM knows how tall this content is at
 * this width, and it changes with the effect and the window size.
 */
const scroller = ref(null)
const canScrollDown = ref(false)
let ro = null

function updateOverflow() {
  const el = scroller.value
  // A pixel of slack, for the same reason the harness leaves one: fractional
  // layout heights would otherwise light the hint on content that fits exactly.
  canScrollDown.value = !!el && el.scrollHeight - el.scrollTop - el.clientHeight > 1
}

onMounted(() => {
  ro = new ResizeObserver(updateOverflow)
  ro.observe(scroller.value)
  if (scroller.value.firstElementChild) ro.observe(scroller.value.firstElementChild)
  updateOverflow()
})

onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <div class="help" role="region" :aria-label="`${title} help`">
    <div ref="scroller" class="help-body" @scroll="updateOverflow">
      <p class="help-summary">{{ help.summary }}</p>

      <!--
        Ordered where the order carries meaning (anything with an analyse
        pass), unordered where it does not. A numbered list of things that are
        not steps reads as a sequence someone has to follow.
      -->
      <template v-for="s in leadSections" :key="s.key">
        <section v-if="s.items && s.items.length" class="help-section">
          <h3 class="help-heading">{{ s.heading }}</h3>
          <ol v-if="s.ordered" class="help-list help-list--ordered">
            <li v-for="(item, i) in s.items" :key="i">{{ item }}</li>
          </ol>
          <ul v-else class="help-list">
            <li v-for="(item, i) in s.items" :key="i">{{ item }}</li>
          </ul>
        </section>
      </template>

      <section v-if="help.controls && help.controls.length" class="help-section">
        <h3 class="help-heading">The controls</h3>
        <!--
          A definition list rather than a table: the labels are short and the
          descriptions are not, so a two-column table would spend most of its
          width on the narrow side and wrap the wide one.
        -->
        <dl class="help-controls">
          <template v-for="c in help.controls" :key="c.label">
            <dt class="help-control-label">{{ c.label }}</dt>
            <dd class="help-control-text">{{ c.text }}</dd>
          </template>
        </dl>
      </section>

      <template v-for="s in tailSections" :key="s.key">
        <section v-if="s.items && s.items.length" class="help-section">
          <h3 class="help-heading">{{ s.heading }}</h3>
          <ul class="help-list">
            <li v-for="(item, i) in s.items" :key="i">{{ item }}</li>
          </ul>
        </section>
      </template>
    </div>

    <!-- Same capsule over the same fade the harness uses on the face, because
         it is the same statement about the same kind of edge. -->
    <div
      v-show="canScrollDown"
      class="help-more flex items-end justify-center pointer-events-none"
      aria-hidden="true"
    >
      <span class="help-more-pill">MORE ↓</span>
    </div>
  </div>
</template>

<style scoped>
/*
  Sits over the faceplate and is opaque, not translucent. A tinted scrim over a
  working meter means reading body copy against something that moves — the one
  case where the product's own transparency rule ("blur is never decorative")
  says to put a surface down instead.
*/
.help {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, #12161d, #0d1014);
  animation: helpIn 0.15s ease both;
}

.help-body {
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px 24px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
}
.help-body::-webkit-scrollbar {
  width: 9px;
}
.help-body::-webkit-scrollbar-track {
  background: transparent;
}
.help-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.26);
  border: 3px solid transparent;
  background-clip: content-box;
  border-radius: 999px;
}

/* The one line at full text colour: it is the answer to "what is this", which
   is the question most people open this panel with. */
.help-summary {
  margin: 0;
  font: 500 13px/1.5 'Inter', system-ui, sans-serif;
  color: var(--color-text, #eaf6f8);
}

.help-section {
  margin-top: 22px;
}

.help-heading {
  margin: 0 0 10px;
  font: 700 9px 'JetBrains Mono', monospace;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.42);
}

/*
  The list style is declared, not inherited. Tailwind's preflight resets
  `list-style` to none on every ul and ol, so a plain <ol> draws no numbers —
  which silently collapses the one distinction this component makes, between a
  set of situations and an ordered walkthrough. Rendered, the two sections were
  identical.
*/
.help-list {
  margin: 0;
  list-style: disc outside;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  font: 400 12.5px/1.5 'Inter', system-ui, sans-serif;
  color: var(--color-text-softer, rgba(255, 255, 255, 0.65));
}
.help-list li::marker {
  color: rgba(255, 255, 255, 0.3);
}
.help-list--ordered {
  list-style: decimal outside;
  font-variant-numeric: tabular-nums;
}

/*
  Label column sized to the longest label the panel actually carries, capped so
  one verbose entry cannot squeeze every description. Collapses to stacked rows
  on a narrow window, where two columns leave nothing for the prose.
*/
.help-controls {
  margin: 0;
  display: grid;
  grid-template-columns: minmax(0, max-content) 1fr;
  column-gap: 16px;
  row-gap: 9px;
  align-items: baseline;
}

.help-control-label {
  font: 700 10px 'JetBrains Mono', monospace;
  letter-spacing: 0.08em;
  color: var(--color-text, #eaf6f8);
  white-space: nowrap;
}

.help-control-text {
  margin: 0;
  font: 400 12.5px/1.5 'Inter', system-ui, sans-serif;
  color: var(--color-text-softer, rgba(255, 255, 255, 0.65));
}

@container win (max-width: 480px) {
  .help-controls {
    grid-template-columns: 1fr;
    row-gap: 4px;
  }
  .help-control-label {
    margin-top: 8px;
    white-space: normal;
  }
}

.help-more {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 34px;
  background: linear-gradient(rgba(13, 16, 20, 0), rgba(13, 16, 20, 0.94));
}

.help-more-pill {
  margin-bottom: 3px;
  padding: 2px 8px;
  border-radius: 999px;
  font: 700 8px 'JetBrains Mono', monospace;
  letter-spacing: 0.14em;
  color: rgba(234, 246, 248, 0.75);
  background: rgba(0, 0, 0, 0.55);
}

@keyframes helpIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
