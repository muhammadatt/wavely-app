<script setup>
// dBFS scale ticks, top and bottom mirrored around the zero line. Position is
// derived from linear amplitude (10^(db/20)) since peaks are drawn linearly,
// so ticks bunch up near the center the way a real meter's dB scale does.
const DB_LEVELS = [-1, -3, -6, -12, -18]

// The renderer leaves 2px of headroom above full scale, so the 0 dB tick sits
// 2px from the edge. Centring a label on it puts half the glyph outside the
// canvas box, where it gets clipped — the extremes hug the edge instead.
const dbTicks = DB_LEVELS.map(db => {
  const distPct = Math.pow(10, db / 20) * 50
  return {
    db: String(db),
    pos: db === 0 ? '1px' : `calc(${(50 - distPct).toFixed(2)}%)`,
    edge: db === 0,
  }
})
</script>

<template>
  <div class="w-7 shrink-0 relative select-none font-['JetBrains_Mono'] text-[8px] font-semibold" style="color:rgba(255,255,255,.32)" >
    <span
      v-for="t in dbTicks"
      :key="'t' + t.db"
      class="absolute right-1"
      :class="t.edge ? '' : '-translate-y-1/2'"
      :style="{ top: t.pos }"
      >{{ t.db }}</span
    >
    <span
      v-for="t in dbTicks"
      :key="'b' + t.db"
      class="absolute right-1"
      :class="t.edge ? '' : 'translate-y-1/2'"
      :style="{ bottom: t.pos }"
      >{{ t.db }}</span
    >
  </div>
</template>
