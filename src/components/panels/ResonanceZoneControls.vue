<script setup>
import { computed, ref, watch } from 'vue'
import {
  RESONANCE_ZONE_RANGES,
  RESONANCE_ZONE_STOCK,
  zoneBounds,
  zoneSettings,
} from '../../audio/resonanceParams.js'
import {
  setZoneParam, toggleZone, toggleZoneProtect,
} from '../meters/resonanceZoneEdit.js'
import DeviceField from '../knobs/DeviceField.vue'
import Knob from '../knobs/Knob.vue'

/**
 * One set of controls, showing whichever zone is selected.
 *
 * NOT ONE STRIP PER ZONE. That was the previous arrangement and it does not
 * scale: three settings across up to six zones is eighteen values competing for
 * a row, which forces each of them into something too small to be a control —
 * the version before this printed them as numbers and had to be explained. A
 * multiband compressor shows one band's controls at a time for the same reason,
 * and the plot above already says which band is which.
 *
 * How MANY zones there are is not here: it is the one zone control that is not
 * about a particular zone, and on a plate showing ZONE 3's identity and ZONE
 * 3's settings it read as belonging to zone 3. It sits beside the plot now —
 * see ResonanceZoneCount.
 */
const props = defineProps({
  zones: { type: Array, required: true },
  selected: { type: Number, default: 0 },
  /** Index of the soloed zone, or -1. Monitoring state, not a parameter. */
  solo: { type: Number, default: -1 },
  /**
   * The pitch range the protection mask searches, for the caption. Fixed rather
   * than chosen — see HARMONIC_PITCH_RANGE.
   */
  pitchRangeCaption: { type: String, default: '' },
  /**
   * Which reference the detector is using. The mask means DIFFERENT THINGS
   * under the two, so the control cannot carry one name over both.
   */
  refMode: { type: String, default: 'peak' },
  accent: { type: String, default: '#8de0a8' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:zones', 'solo'])

/**
 * The harmonics decision hides behind a door, and swaps places with the zone's
 * identity rather than opening beside it.
 *
 * Two reasons for the door. The protection toggle and the pitch range are ONE
 * decision — what counts as a harmonic here, and what pitch to look for — and
 * they were on opposite sides of the faceplate, one per zone and one global,
 * with nothing saying they were related. And the panel has no room for a third
 * cluster: everything added to this row so far has come out of the display.
 *
 * Swapping in place rather than expanding keeps the row height fixed, so
 * opening it never moves the knobs beside it. It closes on Escape and on
 * selecting a different zone — the settings inside are per zone, and a panel
 * left open on zone 2's harmonics while zone 4 is selected would be showing one
 * zone's identity and another's settings.
 */
const harmonicsOpen = ref(false)

watch(() => props.selected, () => { harmonicsOpen.value = false })

const zone = computed(() => props.zones[props.selected] ?? props.zones[0] ?? null)
/**
 * The STORED settings, not the effective ones.
 *
 * zoneSettings reports a disabled zone as depth 0, which is what the kernel
 * needs and the wrong thing to show: switching a zone off would make the Depth
 * knob read zero, and switching it back on would look like the panel had
 * invented a value. Only `enabled` comes from there.
 */
const settings = computed(() => {
  const z = zone.value
  const R = RESONANCE_ZONE_RANGES
  const clamp = (v, r) => Math.max(r.min, Math.min(r.max, v))
  return {
    enabled: zoneSettings(z).enabled,
    depth: clamp(z?.depth ?? RESONANCE_ZONE_STOCK.depth, R.depth),
    sharpness: clamp(z?.sharpness ?? RESONANCE_ZONE_STOCK.sharpness, R.sharpness),
    selectivity: clamp(z?.selectivity ?? RESONANCE_ZONE_STOCK.selectivity, R.selectivity),
    maxCut: clamp(z?.maxCut ?? RESONANCE_ZONE_STOCK.maxCut, R.maxCut),
    protect: (z?.protect ?? RESONANCE_ZONE_STOCK.protect) !== false,
  }
})
const index = computed(() =>
  Math.max(0, Math.min(props.selected, props.zones.length - 1)))

const span = computed(() => {
  const b = zoneBounds(props.zones, 20, 20000)[index.value]
  if (!b) return ''
  const f = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`)
  return `${f(b.loHz)}–${f(b.hiHz)} Hz`
})

/** Any zone running unmasked. Tints the closed door, so the state is visible
 *  without opening it — the one thing a hidden control must not cost. */
/**
 * THE MASK IS NOT THE SAME CONTROL UNDER THE TWO REFERENCES, and labelling it
 * as though it were would make the panel lie on the shipping path.
 *
 *   cepstral — the reference sits at the inter-harmonic floor, so harmonics
 *     protrude and read as resonances. The mask holds the suppressor off them.
 *     That is protection, and turning it off really will thin the material —
 *     hence the amber.
 *   peak — the envelope is drawn through the harmonic peaks, so nothing
 *     protrudes at a harmonic and there is nothing to protect against. What the
 *     mask does there is INVERT where the cut lands: partials held, the floor
 *     between them attenuated. A different process, not a broken one, so the
 *     control stays live — it just must not claim to be protecting anything,
 *     and its off state is not a warning.
 */
const maskIsProtection = computed(() => props.refMode === 'cepstral')

const maskCopy = computed(() => {
  const on = settings.value.protect
  if (!maskIsProtection.value) {
    return on
      ? { label: 'BETWEEN PARTIALS', caption: 'Cuts between the partials, not on them.' }
      : { label: 'ACROSS SPECTRUM', caption: 'Cuts evenly across the spectrum.' }
  }
  return on
    ? {
      label: 'PRESERVE HARMONICS',
      caption: `Preserves voice harmonics${props.pitchRangeCaption ? ` (${props.pitchRangeCaption})` : ''}.`,
    }
    : { label: 'PROTECTION OFF', caption: 'Full suppression — may thin harmonics.' }
})

/** Only under the cepstral reference is an unmasked zone a hazard. */
const anyUnprotected = computed(() => maskIsProtection.value
  && props.zones.some(z => !zoneSettings(z).protect))

function set(name, value) {
  emit('update:zones', setZoneParam(props.zones, index.value, name, value))
}

const percent = v => `${Math.round(v * 100)}`
const oneDp = v => v.toFixed(1)
const db = v => `${Math.round(v)}`
</script>

<template>
  <div
    class="flex items-center gap-[16px] rounded-[7px] px-[14px] py-[10px]"
    @keydown.escape="harmonicsOpen = false"
    :style="{
      background: 'rgba(0,0,0,.28)',
      boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 20%, transparent)`,
      opacity: disabled ? 0.4 : 1,
    }"
  >
    <!-- Identity first: these knobs mean nothing without it, because the same
         three knobs show six different sets of values. -->
    <!-- The identity block, or the harmonics door in its place. -->
    <div class="w-[128px] shrink-0">
      <template v-if="!harmonicsOpen">
      <div
        style="font:700 12px 'JetBrains Mono',monospace;letter-spacing:.08em;white-space:nowrap"
        :style="{ color: settings.enabled
          ? `color-mix(in srgb, ${accent} 60%, #ffffff)` : 'var(--color-text-faint)' }"
      >ZONE {{ index + 1 }}</div>
      <div class="flex items-baseline justify-between gap-[6px] mt-[2px]">
        <span style="font:600 9px 'JetBrains Mono',monospace;color:var(--color-text-muted);white-space:nowrap"
        >{{ span }}</span>
      </div>


      <!-- BYPASS AND SOLO ARE NOT THE SAME KIND OF CONTROL, and the panel has
           to say so. Bypass is a setting: it is stored, it is rendered, a file
           applied with a zone off really has that band untreated. Solo is a
           monitoring state that never reaches Apply — the same distinction as
           DELTA in the header, which is why solo is lettered rather than shown
           as a second lamp. -->
      <div class="flex items-center gap-[5px] mt-[6px]">
        <!-- The OFF look is the base, in classes; the ON look overrides it
             inline, because all three of its values are mixed from the accent
             prop and a utility cannot hold a colour that is not known until
             render. Layering that way round means each property still has one
             owner — the inline value simply wins whenever it is set. -->
        <button
          class="rounded-[4px] px-[6px] py-[2px] font-mono text-[8px] font-bold leading-[normal]
                 tracking-[.1em] text-text-muted inset-ring-1 inset-ring-[rgba(255,255,255,.16)]
                 cursor-pointer disabled:cursor-default"
          :style="settings.enabled ? {
            background: `color-mix(in srgb, ${accent} 22%, transparent)`,
            color: `color-mix(in srgb, ${accent} 55%, #ffffff)`,
            boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 45%, transparent)`,
          } : null"
          :aria-pressed="String(!settings.enabled)"
          :aria-label="`Zone ${index + 1} bypass, currently ${settings.enabled ? 'off' : 'on'}`"
          title="Bypass this zone — the effect leaves that band alone. Stored, and applied to the file."
          :disabled="disabled"
          @click="emit('update:zones', toggleZone(zones, index))"
        >{{ settings.enabled ? 'ON' : 'BYP' }}</button>
        <!-- No inline style at all: solo's lit colour is the fixed amber, not
             the accent, so both states are static and both can be classes.
             Note the two shadows are different KINDS — an outward glow when
             lit, an inset hairline when not — which is why this is a ternary
             between whole classes rather than one utility with a colour swap. -->
        <button
          class="rounded-[4px] px-[6px] py-[2px] font-mono text-[8px] font-bold leading-[normal]
                 tracking-[.1em] cursor-pointer disabled:cursor-default"
          :class="solo === index
            ? 'bg-[#ffb27a] text-[#20160c] shadow-[0_0_7px_rgba(255,178,122,.5)]'
            : 'text-text-muted inset-ring-1 inset-ring-[rgba(255,255,255,.16)]'"
          :aria-pressed="String(solo === index)"
          :aria-label="`Solo zone ${index + 1}`"
          title="Hear this zone's processing alone. Monitoring only — Apply always renders every zone."
          :disabled="disabled"
          @click="emit('solo', index)"
        >SOLO</button>
      </div>

        <button
          class="cursor-pointer shrink-0 disabled:cursor-default"
          style="font:700 9px 'JetBrains Mono',monospace;letter-spacing:.06em;white-space:nowrap;color:var(--color-text-dim)"
          :aria-expanded="String(harmonicsOpen)"
          title="Harmonic protection for this zone, and the pitch range the mask looks for."
          :disabled="disabled"
          @click="harmonicsOpen = true"
        > HARMONIC MASK›</button>
      </template>

      <template v-else>
        <button
          class="flex items-center gap-[4px] cursor-pointer"
          style="font:700 9px 'JetBrains Mono',monospace;letter-spacing:.08em;color:var(--color-text-dim)"
          @click="harmonicsOpen = false"
        >‹ <span>HARMONIC MASK</span></button>

        <!-- Stacked, not side by side: the two together are wider than the
             identity block they replace, and letting them spill would push the
             knobs beside them. The row's height is set by those knobs, so there
             is vertical room going spare and none horizontally. -->
        <div class="flex flex-col items-start gap-[4px] mt-[5px]">


                  <button
          class="w-full px-2 py-[6px] rounded-lg cursor-pointer transition-all text-left disabled:cursor-default"
          :style="{
            background: settings.protect || !maskIsProtection
              ? 'rgba(141,224,168,.14)' : 'rgba(255,178,122,.12)',
            border: `1px solid ${settings.protect || !maskIsProtection
              ? 'rgba(141,224,168,.4)' : 'rgba(255,178,122,.45)'}`,
          }"
          :aria-pressed="String(settings.protect)"
          :aria-label="`Zone ${index + 1} harmonic protection`"
          title="Protects the harmonics of the pitched source in the recording from being treated as resonances. Turning it off is a diagnostic aid — it will thin the material."
          @click="emit('update:zones', toggleZoneProtect(zones, index))"
        >
          <span
            class="block"
            :style="{
              font: `700 8.5px 'JetBrains Mono',monospace`,
              letterSpacing: '.12em',
              color: settings.protect || !maskIsProtection ? '#8de0a8' : '#ffb27a',
            }"
          >{{ maskCopy.label }}</span>
          <!-- THE RANGE IS A STATEMENT NOW, NOT A CHOICE, and printing it here
               is what keeps that visible. It used to be a VOICE/WIDE switch on
               this row; the mask is a comb built from one tracked F0, so it is
               a voice feature whatever the rest of the effect is pointed at,
               and WIDE was measurably worse on the only material the mask is
               for. A zone whose content is not a voice switches this off rather
               than retuning it. See HARMONIC_PITCH_RANGE. -->
          <span
            class="block mt-[2px]"
            style="font:500 8.5px/1.35 'Inter'"
            :style="{ color: settings.protect || !maskIsProtection
              ? 'var(--color-text-faint)' : 'rgba(255,178,122,.75)' }"
          >{{ maskCopy.caption }}</span>
        </button>

        </div>
      </template>
    </div>

    <div class="flex-1 flex justify-center items-center gap-[8px]">
      <div class="w-[88px] shrink-0">
        <Knob
          :model-value="settings.selectivity" @update:model-value="set('selectivity', $event)"
          :min="RESONANCE_ZONE_RANGES.selectivity.min" :max="RESONANCE_ZONE_RANGES.selectivity.max"
          :step="0.5" :value-font-px="13"
          label="Selectivity" :accent="accent" :format-value="oneDp"
          :disabled="disabled"
        />
      </div>
      <div class="w-[88px] shrink-0">
        <Knob
          :model-value="settings.sharpness" @update:model-value="set('sharpness', $event)"
          :min="RESONANCE_ZONE_RANGES.sharpness.min" :max="RESONANCE_ZONE_RANGES.sharpness.max"
          :step="0.01" :value-font-px="13"
          label="Sharpness" :accent="accent" :format-value="percent"
          :disabled="disabled"
        />
      </div>
      <div class="w-[88px] shrink-0">
        <Knob
          :model-value="settings.depth" @update:model-value="set('depth', $event)"
          :min="RESONANCE_ZONE_RANGES.depth.min" :max="RESONANCE_ZONE_RANGES.depth.max"
          :step="0.01" :value-font-px="13"
          label="Depth" :accent="accent" :format-value="percent"
          :disabled="disabled"
        />
      </div>
      <!-- A ceiling is set once and read often, so it is a field rather than a
           dial — and it belongs here rather than among the global controls
           because the honest answer differs by band: a low-mid resonance can
           lose 12 dB before it is obviously gone, where the same number spent
           on sibilance is a lisp. -->
      <DeviceField
        :model-value="settings.maxCut" @update:model-value="set('maxCut', $event)"
        :min="RESONANCE_ZONE_RANGES.maxCut.min" :max="RESONANCE_ZONE_RANGES.maxCut.max"
        :step="1" :width="54"
        label="Max Cut" unit="dB" :accent="accent"
        :format-value="db" :disabled="disabled"
      />
    </div>


  </div>
</template>
