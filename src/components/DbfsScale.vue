<script setup>
// dBFS scale ticks, top and bottom mirrored around the zero line. Position is
// derived from linear amplitude (10^(db/20)) since peaks are drawn linearly,
// so ticks bunch up near the center the way a real meter's dB scale does.
const DB_LEVELS = [0, -6, -12, -18]
const dbTicks = DB_LEVELS.map(db => {
  const distPct = Math.pow(10, db / 20) * 50
  return { db: String(db), pos: db === 0 ? '2px' : `calc(${(50 - distPct).toFixed(2)}%)` }
})
</script>

<template>
  <div class="w-7 shrink-0 relative select-none font-['JetBrains_Mono'] text-[8px] font-semibold" style="color:rgba(255,255,255,.32)">
    <span v-for="t in dbTicks" :key="'t' + t.db" class="absolute right-1 -translate-y-1/2" :style="{ top: t.pos }">{{ t.db }}</span>
    <span v-for="t in dbTicks" :key="'b' + t.db" class="absolute right-1 translate-y-1/2" :style="{ bottom: t.pos }">{{ t.db }}</span>
  </div>
</template>
