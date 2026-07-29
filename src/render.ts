/**
 * Markdown → terminal lines.
 *
 * Line-oriented on purpose: card bodies are note fragments (bullets, short
 * paragraphs, the occasional code block or quote), and a block-level pass with
 * an inline tokenizer wraps and styles them predictably. A full mdast walk
 * would buy correctness on constructs these notes do not use.
 */

export type Span = {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
  color?: string
}

export type RenderedLine = {
  spans: Span[]
}

const BULLET = '•'
const QUOTE_BAR = '│'

/** Visible width, ignoring the styling we attach out-of-band. */
export function lineWidth(line: RenderedLine): number {
  return line.spans.reduce((total, span) => total + span.text.length, 0)
}

function text(value: string, style: Omit<Span, 'text'> = {}): Span {
  return { text: value, ...style }
}

/**
 * Split inline markdown into styled spans. Handles `code`, **bold**, *italic*,
 * _italic_, ~~strike~~ (rendered dim) and [links](url).
 */
export function parseInline(input: string, base: Omit<Span, 'text'> = {}): Span[] {
  const spans: Span[] = []
  let buffer = ''

  const flush = () => {
    if (buffer !== '') {
      spans.push(text(buffer, base))
      buffer = ''
    }
  }

  let i = 0
  while (i < input.length) {
    const rest = input.slice(i)

    const code = /^`([^`]+)`/.exec(rest)
    if (code?.[1] !== undefined) {
      flush()
      spans.push(text(code[1], { ...base, color: 'magenta' }))
      i += code[0].length
      continue
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(rest)
    if (link?.[1] !== undefined && link[2] !== undefined) {
      flush()
      spans.push(text(link[1] === '' ? link[2] : link[1], { ...base, color: 'blue', underline: true }))
      i += link[0].length
      continue
    }

    const boldItalic = /^\*\*\*([^*]+)\*\*\*/.exec(rest)
    if (boldItalic?.[1] !== undefined) {
      flush()
      spans.push(...parseInline(boldItalic[1], { ...base, bold: true, italic: true }))
      i += boldItalic[0].length
      continue
    }

    const bold = /^\*\*([^*]+)\*\*/.exec(rest) ?? /^__([^_]+)__/.exec(rest)
    if (bold?.[1] !== undefined) {
      flush()
      spans.push(...parseInline(bold[1], { ...base, bold: true }))
      i += bold[0].length
      continue
    }

    const strike = /^~~([^~]+)~~/.exec(rest)
    if (strike?.[1] !== undefined) {
      flush()
      spans.push(...parseInline(strike[1], { ...base, dim: true }))
      i += strike[0].length
      continue
    }

    // Underscore emphasis only counts between word boundaries, so snake_case
    // identifiers in these notes survive intact.
    const italic =
      /^\*([^*\n]+)\*/.exec(rest) ??
      (i === 0 || /[\s([]/.test(input[i - 1] ?? ' ') ? /^_([^_\n]+)_(?![\w])/.exec(rest) : null)
    if (italic?.[1] !== undefined) {
      flush()
      spans.push(...parseInline(italic[1], { ...base, italic: true }))
      i += italic[0].length
      continue
    }

    buffer += input[i]
    i += 1
  }

  flush()
  return spans
}

/**
 * Greedy word wrap over styled spans. Spans are split at word boundaries and
 * keep their styling across the break.
 */
export function wrapSpans(spans: Span[], width: number, hangingIndent = ''): RenderedLine[] {
  if (width <= 0) return [{ spans }]

  const lines: RenderedLine[] = []
  let current: Span[] = []
  let used = 0
  let isFirst = true

  const limit = () => (isFirst ? width : Math.max(1, width - hangingIndent.length))

  const pushLine = () => {
    // A break can land just after a space token; keep it off the line so
    // wrapped text does not push against the card border.
    while (current.length > 0 && /^\s+$/.test(current[current.length - 1]?.text ?? '')) current.pop()
    if (current.length === 0 && lines.length > 0) return
    lines.push({ spans: isFirst || hangingIndent === '' ? current : [text(hangingIndent), ...current] })
    current = []
    used = 0
    isFirst = false
  }

  for (const span of spans) {
    // Keep the separators so runs of spaces inside a span are not collapsed.
    const tokens = span.text.split(/(\s+)/).filter((t) => t !== '')
    for (const token of tokens) {
      const isSpace = /^\s+$/.test(token)
      if (isSpace && used === 0) continue

      if (used + token.length > limit() && used > 0) {
        pushLine()
        if (isSpace) continue
      }

      // A single token longer than the line (a URL, a long identifier) is hard
      // broken rather than allowed to overflow the box.
      let remaining = token
      while (remaining.length > limit()) {
        const head = remaining.slice(0, limit() - used)
        current.push({ ...span, text: head })
        remaining = remaining.slice(head.length)
        pushLine()
      }
      if (remaining !== '') {
        current.push({ ...span, text: remaining })
        used += remaining.length
      }
    }
  }

  pushLine()
  return lines.length === 0 ? [{ spans: [] }] : lines
}

function headingSpans(level: number, content: string): Span[] {
  const color = level <= 3 ? 'cyan' : 'blue'
  return parseInline(content, { bold: true, color })
}

/**
 * Render a markdown card body into styled, wrapped terminal lines.
 */
export function renderMarkdown(markdown: string, width: number): RenderedLine[] {
  const source = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: RenderedLine[] = []
  let inFence = false
  let fenceLang = ''

  for (const raw of source) {
    const fence = /^\s*```(.*)$/.exec(raw)
    if (fence) {
      if (inFence) {
        inFence = false
        fenceLang = ''
      } else {
        inFence = true
        fenceLang = (fence[1] ?? '').trim()
        if (fenceLang !== '') out.push({ spans: [text(`  ${fenceLang}`, { dim: true, italic: true })] })
      }
      continue
    }

    if (inFence) {
      // Code keeps its own spacing, so it is indented rather than wrapped.
      out.push({ spans: [text('  '), text(raw, { color: 'green' })] })
      continue
    }

    if (raw.trim() === '') {
      out.push({ spans: [] })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      out.push(...wrapSpans(headingSpans(heading[1].length, heading[2]), width))
      continue
    }

    const rule = /^\s*([-*_])\s*(\1\s*){2,}$/.exec(raw)
    if (rule) {
      out.push({ spans: [text('─'.repeat(Math.max(1, Math.min(width, 40))), { dim: true })] })
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(raw)
    if (quote?.[1] !== undefined) {
      const inner = parseInline(quote[1], { dim: true, italic: true })
      const wrapped = wrapSpans(inner, Math.max(1, width - 2), '')
      for (const line of wrapped) {
        out.push({ spans: [text(`${QUOTE_BAR} `, { dim: true }), ...line.spans] })
      }
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw)
    if (bullet?.[1] !== undefined && bullet[2] !== undefined) {
      const depth = Math.floor(bullet[1].length / 2)
      const indent = '  '.repeat(depth)
      const marker = `${indent}${BULLET} `
      const wrapped = wrapSpans(parseInline(bullet[2]), Math.max(1, width - marker.length), '')
      out.push(...wrapped.map((line, i) => ({
        spans: [text(i === 0 ? marker : ' '.repeat(marker.length), { color: i === 0 ? 'yellow' : undefined }), ...line.spans],
      })))
      continue
    }

    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw)
    if (ordered?.[1] !== undefined && ordered[2] !== undefined && ordered[3] !== undefined) {
      const indent = '  '.repeat(Math.floor(ordered[1].length / 2))
      const marker = `${indent}${ordered[2]}. `
      const wrapped = wrapSpans(parseInline(ordered[3]), Math.max(1, width - marker.length), '')
      out.push(...wrapped.map((line, i) => ({
        spans: [text(i === 0 ? marker : ' '.repeat(marker.length), { color: i === 0 ? 'yellow' : undefined }), ...line.spans],
      })))
      continue
    }

    out.push(...wrapSpans(parseInline(raw.trim()), width))
  }

  // Trailing blank lines waste viewport rows in a small review box.
  while (out.length > 0 && lineWidth(out[out.length - 1] as RenderedLine) === 0) out.pop()
  return out
}
