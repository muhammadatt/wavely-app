import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { renderMarkdown, slugify } from '../../src/legal/markdown.js'
import { LEGAL_PAGES, legalPageFromPath } from '../../src/legal/pages.js'

const read = f => readFileSync(new URL(`../../src/content/legal/${f}`, import.meta.url), 'utf8')

test('every legal page has a document with a title', () => {
  for (const [id, page] of Object.entries(LEGAL_PAGES)) {
    const { html, title } = renderMarkdown(read(page.file))
    assert.ok(title, `${id} has a # title`)
    assert.ok(html.length > 1000, `${id} has content`)
    assert.ok(!html.includes('EDITING THIS FILE'), `${id}: editor comments are not shown`)
  }
})

test('the dev rewrite in vite.config.js covers every page', () => {
  const config = readFileSync(new URL('../../vite.config.js', import.meta.url), 'utf8')
  const m = /\^\\\/\(([a-z|-]+)\)/.exec(config.slice(config.indexOf('function legalPages')))
  assert.ok(m, 'rewrite regex found')
  assert.deepEqual(m[1].split('|').sort(), Object.keys(LEGAL_PAGES).sort())
})

test('paths map to pages', () => {
  assert.equal(legalPageFromPath('/terms/'), 'terms')
  assert.equal(legalPageFromPath('/privacy'), 'privacy')
  assert.equal(legalPageFromPath('/privacy/index.html'), 'privacy')
  assert.equal(legalPageFromPath('/privacy/other.html'), null)
  assert.equal(legalPageFromPath('/help/'), null)
  assert.equal(legalPageFromPath('/'), null)
})

test('markdown: blocks and inline', () => {
  const { html, title } = renderMarkdown([
    '<!-- hidden -->', '# Title *one*', '', 'Para **bold** and _it_ and `x<y` and [link](/terms/).',
    'still para', '', '- a', '- b', '  continued', '', '1. one', '2. two', '', '> note', '', '---',
    '## Same', '## Same 2', '## Same',
  ].join('\n'))
  assert.equal(title, 'Title one')
  assert.ok(!html.includes('hidden'))
  assert.match(html, /<h1 id="title-one">Title <em>one<\/em><\/h1>/)
  assert.match(html, /<p>Para <strong>bold<\/strong> and <em>it<\/em> and <code>x&lt;y<\/code> and <a href="\/terms\/">link<\/a>\. still para<\/p>/)
  assert.match(html, /<ul><li>a<\/li><li>b continued<\/li><\/ul>/)
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/)
  assert.match(html, /<blockquote><p>note<\/p><\/blockquote>/)
  assert.match(html, /<hr \/>/)
  const ids = [...html.matchAll(/<h2 id="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(ids, ['same', 'same-2', 'same-3'])
})

test('markdown: raw HTML and unsafe links are escaped', () => {
  const { html } = renderMarkdown('<script>alert(1)</script> [x](javascript:alert(1)) https://a.com/b.')
  assert.ok(!html.includes('<script>'))
  assert.match(html, /<a href="#">x<\/a>/)
  assert.match(html, /<a href="https:\/\/a\.com\/b">https:\/\/a\.com\/b<\/a>\./)
  assert.equal(slugify('Your rights (EEA &amp; UK)'), 'your-rights-eea-uk')
})

test('markdown: emphasis never reaches into a URL', () => {
  const { html } = renderMarkdown('[docs _here_](https://x.com/_v2_/a*b*) and https://y.com/_z_/ and `a_b_c`')
  assert.match(html, /<a href="https:\/\/x\.com\/_v2_\/a\*b\*">docs <em>here<\/em><\/a>/)
  assert.match(html, /<a href="https:\/\/y\.com\/_z_\/">https:\/\/y\.com\/_z_\/<\/a>/)
  assert.match(html, /<code>a_b_c<\/code>/)
})
