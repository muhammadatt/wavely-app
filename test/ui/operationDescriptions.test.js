import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Every operation's description must fit its rail row on ONE line. The rail
 * (ContextPanel, 280 px) leaves the description 150 px beside the icon and the
 * chevron — 142 once the rail's 8 px scrollbar shows — at 11 px Inter medium,
 * and the rows are not allowed to grow taller (owner, November 2026). The plan
 * badge sits on the NAME line, so it takes nothing from the description.
 *
 * Node cannot measure a font, so the width is the sum of each character's
 * advance in Inter Medium at 11 px (measured in Chromium; kerning ignored,
 * which reads within ~1 px on the shipped set). A description over the limit
 * needs rewording, not a wider rail.
 *
 * Read from the source rather than imported: the registry imports every
 * panel's .vue file, which node cannot load.
 */
const MAX_DESC_PX = 142
const ADVANCE_PX = {"0":7.1,"1":4.57,"2":6.78,"3":6.9,"4":7.22,"5":6.8,"6":6.93,"7":6.28,"8":6.92,"9":6.93," ":2.93,"!":3.35,"\"":5.44,"#":7.03,"$":7.11,"%":10.92,"&":7.19,"'":3.44,"(":4.06,")":4.06,"*":5.73,"+":7.34,",":3.34,"-":5.09,".":3.34,"/":4.07,":":3.34,";":3.47,"<":7.34,"=":7.34,">":7.34,"?":5.8,"@":10.81,"A":7.8,"B":7.22,"C":8.07,"D":7.94,"E":6.63,"F":6.48,"G":8.22,"H":8.19,"I":3,"J":6.33,"K":7.56,"L":6.22,"M":10.04,"N":8.32,"O":8.43,"P":7.06,"Q":8.45,"R":7.13,"S":7.11,"T":7.18,"U":8.14,"V":7.8,"W":11.03,"X":7.71,"Y":7.66,"Z":7.05,"[":4.06,"\\":4.07,"]":4.06,"^":5.24,"_":5.09,"`":3.71,"a":6.25,"b":6.8,"c":6.35,"d":6.8,"e":6.46,"f":4.17,"g":6.82,"h":6.62,"i":2.77,"j":2.77,"k":6.15,"l":2.77,"m":9.77,"n":6.62,"o":6.64,"p":6.8,"q":6.8,"r":4.25,"s":5.92,"t":3.74,"u":6.62,"v":6.32,"w":9.12,"x":6.13,"y":6.33,"z":6.15,"{":4.84,"|":3.8,"}":4.84,"~":7.34,"’":3.05,"–":5.5,"—":11,"…":10.01}
const WIDEST_PX = Math.max(...Object.values(ADVANCE_PX))

function widthPx(text) {
  let w = 0
  for (const ch of text) w += ADVANCE_PX[ch] ?? WIDEST_PX
  return w
}

const registry = readFileSync(new URL('../../src/ui/registry.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const opSrc = registry.slice(registry.indexOf('const ALL_OPERATIONS = ['))

// One registry entry at a time, so a missing desc can never borrow the next
// entry's.
const entries = [...opSrc.matchAll(/\n  \{\n([\s\S]*?)\n  \},/g)].map(m => ({
  id: /\n?    id: '([^']+)',/.exec(m[1])?.[1],
  desc: /\n    desc: '([^']*)',/.exec(m[1])?.[1],
}))

test('every operation has a single-quoted description the test can read', () => {
  assert.ok(entries.length > 20, 'the registry parse found its operations')
  assert.deepEqual(entries.filter(e => !e.id || e.desc === undefined).map(e => e.id ?? '(no id)'), [])
})

test(`operation descriptions fit the rail row (≤ ${MAX_DESC_PX} px)`, () => {
  const long = entries.filter(e => e.desc !== undefined && widthPx(e.desc) > MAX_DESC_PX)
  assert.deepEqual(long.map(e => `${e.id}: ${e.desc} (${widthPx(e.desc).toFixed(1)} px)`), [])
})
