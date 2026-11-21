/**
 * A small Markdown renderer for the legal pages (`src/content/legal/*.md`).
 *
 * Deliberately limited to what a policy document needs, so it can run both in
 * the browser (the page) and in Node (the build pre-renders each page into its
 * HTML for crawlers and no-JS readers) with no dependency:
 *
 *   # … ####        headings (each gets an id for #anchors)
 *   - / * / 1.      bullet and numbered lists (one level)
 *   > …             a callout
 *   ---             a rule
 *   **bold**, _italic_ / *italic*, `code`, [text](url), bare https:// links
 *   <!-- … -->      comments — notes for editors, never shown
 *
 * Every character of the source is HTML-escaped before the inline rules run,
 * so a stray `<` in the text can never become markup.
 */

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** `Your rights (EEA & UK)` → `your-rights-eea-uk`. */
export function slugify(text) {
  return text.toLowerCase().replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function inline(raw) {
  let s = esc(raw)
  const codes = []
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const safe = /^(https?:|mailto:|\/|#)/i.test(href) ? href : '#'
    return `<a href="${safe}">${text}</a>`
  })
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:])/g, '$1<a href="$2">$2</a>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`)
}

/**
 * Render Markdown to HTML. Returns `{ html, title }` — the title is the first
 * `#` heading's text, for the page's <title>.
 */
export function renderMarkdown(source) {
  const text = String(source).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '')
  const lines = text.split('\n')
  const out = []
  const used = new Map()
  let title = ''
  let para = []
  let list = null // { tag, items: [] }
  let quote = []

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`)
    quote = []
  }
  const flushAll = () => { flushPara(); flushList(); flushQuote() }

  for (const line of lines) {
    const t = line.trim()
    let m
    if (!t) { flushAll(); continue }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(t))) {
      flushAll()
      const level = m[1].length
      const html = inline(m[2])
      if (level === 1 && !title) title = m[2].replace(/[*_`]/g, '')
      let id = slugify(html) || 'section'
      const n = used.get(id) ?? 0
      used.set(id, n + 1)
      if (n) id = `${id}-${n + 1}`
      out.push(`<h${level} id="${id}">${html}</h${level}>`)
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) { flushAll(); out.push('<hr />'); continue }
    if ((m = /^>\s?(.*)$/.exec(t))) { flushPara(); flushList(); quote.push(m[1]); continue }
    if ((m = /^([-*]|\d+[.)])\s+(.*)$/.exec(t))) {
      flushPara(); flushQuote()
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul'
      if (list && list.tag !== tag) flushList()
      if (!list) list = { tag, items: [] }
      list.items.push(m[2])
      continue
    }
    // An indented line under a list item continues that item.
    if (list && /^\s+/.test(line)) { list.items[list.items.length - 1] += ' ' + t; continue }
    if (quote.length) { quote.push(t); continue }
    flushList()
    para.push(t)
  }
  flushAll()
  return { html: out.join('\n'), title }
}
