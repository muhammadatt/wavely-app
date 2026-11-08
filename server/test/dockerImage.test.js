/**
 * The server image (server/Dockerfile) copies in only the shared files it
 * imports from src/, whitelisted one by one in the root .dockerignore. A new
 * import that is not in both lists builds fine and crashes on start with
 * ERR_MODULE_NOT_FOUND — which shipped once (noiseReductionParams.js). This
 * walks every import the server makes, following src/ files transitively, and
 * fails if any reaches a src/ file the image does not carry.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SERVER = join(ROOT, 'server')
const SKIP = new Set(['node_modules', 'test', 'uploads', 'logs', 'pipeline-logs', '.venv', 'venv'])

async function serverFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await serverFiles(p))
    else if (/\.(m?js)$/.test(entry.name)) out.push(p)
  }
  return out
}

/** Relative imports (static and dynamic) in a JS file. */
async function relativeImports(file) {
  const text = await readFile(file, 'utf8')
  const specs = [...text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)].map(m => m[1])
  return specs.map(s => resolve(dirname(file), s))
}

test('every src/ file the server imports is copied into the Docker image', async () => {
  const needed = new Set()
  const queue = []
  for (const file of await serverFiles(SERVER)) {
    for (const target of await relativeImports(file)) {
      if (!target.startsWith(SERVER + '/')) queue.push(target)
    }
  }
  while (queue.length) {
    const target = queue.pop()
    const rel = relative(ROOT, target)
    if (needed.has(rel)) continue
    needed.add(rel)
    for (const next of await relativeImports(target)) {
      if (!next.startsWith(SERVER + '/')) queue.push(next)
    }
  }
  assert.ok(needed.size > 0, 'found the server’s shared imports')

  const dockerignore = await readFile(join(ROOT, '.dockerignore'), 'utf8')
  const dockerfile = await readFile(join(SERVER, 'Dockerfile'), 'utf8')
  for (const rel of needed) {
    assert.ok(rel.startsWith('src/'), `the server imports ${rel}, outside server/ and src/`)
    assert.ok(dockerignore.split('\n').some(l => l.trim() === `!${rel}`),
      `${rel} is imported by the server but not whitelisted in .dockerignore`)
    assert.ok(new RegExp(`^COPY\\s+${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'm').test(dockerfile),
      `${rel} is imported by the server but not copied by server/Dockerfile`)
  }
})
