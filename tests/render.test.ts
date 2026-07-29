import { describe, expect, it } from 'vitest'
import { lineWidth, parseInline, renderMarkdown, wrapSpans } from '../src/render.js'

function plain(lines: ReturnType<typeof renderMarkdown>): string[] {
  return lines.map((line) => line.spans.map((span) => span.text).join(''))
}

describe('parseInline', () => {
  it('styles bold, italic and inline code', () => {
    expect(parseInline('a **b** c')).toEqual([{ text: 'a ' }, { text: 'b', bold: true }, { text: ' c' }])
    expect(parseInline('*em*')).toEqual([{ text: 'em', italic: true }])
    expect(parseInline('use `grep` here')).toEqual([
      { text: 'use ' },
      { text: 'grep', color: 'magenta' },
      { text: ' here' },
    ])
  })

  it('renders links as their label', () => {
    expect(parseInline('[docs](https://example.com)')).toEqual([
      { text: 'docs', color: 'blue', underline: true },
    ])
  })

  it('leaves snake_case identifiers alone', () => {
    expect(parseInline('call some_long_name now')).toEqual([{ text: 'call some_long_name now' }])
  })

  it('handles bold-italic', () => {
    expect(parseInline('***both***')).toEqual([{ text: 'both', bold: true, italic: true }])
  })
})

describe('wrapSpans', () => {
  it('wraps at word boundaries and drops the leading space', () => {
    const lines = wrapSpans([{ text: 'aaa bbb ccc' }], 7)
    expect(plain(lines)).toEqual(['aaa bbb', 'ccc'])
  })

  it('hard-breaks a token longer than the line', () => {
    const lines = wrapSpans([{ text: 'abcdefghij' }], 4)
    expect(plain(lines)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('carries styling across a break', () => {
    const lines = wrapSpans([{ text: 'aaa bbb', bold: true }], 3)
    expect(lines.every((line) => line.spans.every((span) => span.bold))).toBe(true)
  })

  it('applies a hanging indent to continuation lines only', () => {
    const lines = wrapSpans([{ text: 'aaa bbb' }], 5, '>>')
    expect(plain(lines)).toEqual(['aaa', '>>bbb'])
  })
})

describe('renderMarkdown', () => {
  it('marks bullets and preserves nesting depth', () => {
    const lines = renderMarkdown('- one\n  - two', 40)
    expect(plain(lines)).toEqual(['• one', '  • two'])
  })

  it('numbers ordered lists', () => {
    expect(plain(renderMarkdown('1. first\n2. second', 40))).toEqual(['1. first', '2. second'])
  })

  it('styles headings without printing the hashes', () => {
    const lines = renderMarkdown('### Section', 40)
    expect(plain(lines)).toEqual(['Section'])
    expect(lines[0]?.spans[0]?.bold).toBe(true)
    expect(lines[0]?.spans[0]?.color).toBe('cyan')
  })

  it('keeps code block spacing and colors the body', () => {
    const lines = renderMarkdown('```js\n  const a = 1\n```', 40)
    expect(plain(lines)).toEqual(['  js', '    const a = 1'])
    expect(lines[1]?.spans[1]?.color).toBe('green')
  })

  it('prefixes blockquotes with a bar', () => {
    expect(plain(renderMarkdown('> quoted', 40))).toEqual(['│ quoted'])
  })

  it('renders a horizontal rule', () => {
    const lines = renderMarkdown('---', 40)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.spans[0]?.text.startsWith('─')).toBe(true)
  })

  it('wraps long bullet text under the marker', () => {
    const lines = renderMarkdown('- aaa bbb ccc ddd', 9)
    expect(plain(lines)).toEqual(['• aaa bbb', '  ccc ddd'])
  })

  it('drops trailing blank lines', () => {
    const lines = renderMarkdown('text\n\n\n', 40)
    expect(lines).toHaveLength(1)
    expect(lineWidth(lines[0]!)).toBe(4)
  })

  it('keeps interior blank lines as spacing', () => {
    expect(plain(renderMarkdown('a\n\nb', 40))).toEqual(['a', '', 'b'])
  })
})
