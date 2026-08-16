/**
 * Flashcard Markdown → the shape the specification talks about.
 *
 * This module is the whole of `flashcards-tui`'s conformance surface. It is pure —
 * a string in, a parsed deck out — so the conformance corpus can be run against it
 * directly, and so nothing above it has to know which rules came from the spec.
 * `parser.ts` layers the I/O concerns on top: ids, resolved image paths, mtimes.
 *
 * Section references are to `SPEC.md` in `@shbernal/flashcard-md-spec`.
 */

import matter from 'gray-matter'
import { toString as mdastToString } from 'mdast-util-to-string'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Heading, Image, Root, RootContent } from 'mdast'
import { diagnostic, type Diagnostic } from './diagnostics.js'
import { scanTags, unique } from './tags.js'

const processor = unified().use(remarkParse)

/** §5.3. The separator is this exact spelling and no other thematic break. */
const SEPARATOR = '***'

export type SpecImage = {
  alt: string
  /** The link destination as written, unresolved. */
  src: string
}

export type SpecCard = {
  /** The `##` heading's text, without the marker. §5.2 makes it the card's identity. */
  headingText: string
  /** Body content above the first `***`; `''` when there is none. */
  frontBody: string
  /** Body content below the separator, or the whole body when there is none. */
  back: string
  /** Tags found anywhere in the card, front region included (§6.3). */
  cardTags: string[]
  /** The effective set: file tags ∪ card tags, deduplicated (§6.1). */
  tags: string[]
  images: SpecImage[]
  /** Flattened text of the whole body, for search. */
  plainText: string
  /** 1-based line of the `##` heading in the source, counting frontmatter. */
  headingLine: number
}

export type ParsedDeck = {
  /** The `#` heading, or null when the file declares none (§4.2). */
  title: string | null
  titleSource: 'heading' | 'none'
  /** The frontmatter block as parsed, `{}` when absent. Unknown keys are kept (§4.1). */
  frontmatter: Record<string, unknown>
  fileTags: string[]
  /** Content between the title and the first `##`, or null (§4.3). */
  preamble: string | null
  cards: SpecCard[]
  diagnostics: Diagnostic[]
}

function countLines(text: string): number {
  return text.split('\n').length
}

/**
 * §6.4: a leading `#` on a frontmatter tag is accepted and stripped, because
 * Obsidian's property editor writes them both ways.
 */
function stripLeadingHash(tag: string): string {
  return tag.replace(/^#/, '')
}

function readFileTags(data: Record<string, unknown>): {
  fileTags: string[]
  diagnostics: Diagnostic[]
} {
  const diagnostics: Diagnostic[] = []

  /* Obsidian removed the singular alias in 1.9. Reading it here would mean the vault
     and the flashcard tools disagree about the same file, with the vault showing no
     tags at all — so it is named rather than quietly honoured or quietly dropped. */
  if (data['tag'] !== undefined && data['tag'] !== null) {
    diagnostics.push(
      diagnostic(
        'frontmatter-tags-not-a-sequence',
        'the frontmatter key "tag" is not read as tags: Obsidian removed the singular ' +
          'alias in 1.9. Write a "tags" sequence instead.',
      ),
    )
  }

  const value = data['tags']
  if (value === undefined || value === null) return { fileTags: [], diagnostics }

  if (!Array.isArray(value)) {
    diagnostics.push(
      diagnostic(
        'frontmatter-tags-not-a-sequence',
        'the frontmatter key "tags" is not a sequence, so it is not read as tags. ' +
          'Obsidian stopped accepting a scalar in 1.9; write one tag per line under "tags:".',
      ),
    )
    return { fileTags: [], diagnostics }
  }

  const fileTags = value
    .filter((tag): tag is string | number => typeof tag !== 'object')
    .map((tag) => stripLeadingHash(String(tag)))
    .filter((tag) => tag !== '')

  return { fileTags: unique(fileTags), diagnostics }
}

function collectImages(nodes: RootContent[]): SpecImage[] {
  const images: SpecImage[] = []
  const visit = (node: { type: string; children?: unknown[] }) => {
    if (node.type === 'image') {
      const image = node as unknown as Image
      images.push({ alt: image.alt ?? '', src: image.url ?? '' })
    }
    for (const child of node.children ?? []) {
      visit(child as { type: string; children?: unknown[] })
    }
  }
  for (const node of nodes) visit(node)
  return images
}

/** The verbatim source of a run of top-level nodes, trimmed of surrounding blank lines. */
function slice(source: string, nodes: RootContent[]): string {
  const start = nodes[0]?.position?.start.offset
  const end = nodes.at(-1)?.position?.end.offset
  if (start === undefined || end === undefined) return ''
  return source.slice(start, end).trim()
}

/**
 * §5.3. An mdast `thematicBreak` does not say which characters produced it, so the
 * node type alone would accept `---` and `___` — precisely what the specification
 * rejects. The source has to be checked. Only top-level nodes are candidates, which
 * a walk over `tree.children` gets for free: a `***` inside a fence or a list item
 * is never one.
 */
function separatorIndex(source: string, nodes: RootContent[]): number {
  return nodes.findIndex((node) => {
    if (node.type !== 'thematicBreak') return false
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return false
    return source.slice(start, end).trim() === SEPARATOR
  })
}

export function parseDeck(source: string): ParsedDeck {
  const diagnostics: Diagnostic[] = []

  let frontmatter: Record<string, unknown> = {}
  let content = source
  try {
    const parsed = matter(source)
    frontmatter = parsed.data as Record<string, unknown>
    content = parsed.content
  } catch (error) {
    /* Salvage rather than refuse (§3.2): the fences fall through as thematic breaks
       and the metadata is lost, but the cards below still load. Losing it in silence
       is what §3.3 forbids. */
    diagnostics.push(
      diagnostic(
        'unrepresentable-content',
        `the frontmatter block is not valid YAML and was skipped: ${String(error)}`,
      ),
    )
  }

  const fromFrontmatter = readFileTags(frontmatter)
  const fileTags = fromFrontmatter.fileTags
  diagnostics.push(...fromFrontmatter.diagnostics)

  const tree = processor.parse(content) as Root
  // gray-matter hands back the body with the frontmatter block removed, so mdast
  // line numbers sit that many lines above their position in the file.
  const lineOffset = countLines(source) - countLines(content)

  const headings = tree.children.filter(
    (node): node is Heading => node.type === 'heading' && node.depth === 1,
  )
  const [titleNode, ...strayH1s] = headings
  const title = titleNode ? mdastToString(titleNode) : null

  /* §5.1: a second `#` ends the card before it and has no defined meaning in version 1.
     The region below it belongs to no card, and dropping it silently is the failure
     mode the diagnostic exists to prevent. */
  for (const stray of strayH1s) {
    diagnostics.push(
      diagnostic(
        'stray-h1',
        `the second \`#\` heading ("${mdastToString(stray)}") has no meaning in version 1 ` +
          'of the format; the content between it and the next `##` belongs to no card ' +
          'and is not shown.',
      ),
    )
  }

  const firstCard = tree.children.findIndex((node) => node.type === 'heading' && node.depth === 2)
  const aboveCards = tree.children.slice(0, firstCard === -1 ? undefined : firstCard)
  const preambleNodes = aboveCards.filter((node) => node !== titleNode)
  const preamble = slice(content, preambleNodes) || null

  /* §4.3 lets the preamble be dropped without a diagnostic — it is *specified*
     non-card content. A bare tag in it is different: version 1 gives it no meaning,
     so it is neither a file tag nor a card tag, and it would vanish unremarked. */
  if (preamble !== null && scanTags(preamble).length > 0) {
    diagnostics.push(
      diagnostic(
        'preamble-tag',
        'a tag above the first `##` is neither a file tag nor a card tag in version 1 ' +
          'of the format, and is ignored. Move it into a card, or into frontmatter.',
      ),
    )
  }

  const cards: SpecCard[] = []
  for (let i = 0; i < tree.children.length; i++) {
    const node = tree.children[i]
    if (!node || node.type !== 'heading' || node.depth !== 2) continue

    const bodyNodes: RootContent[] = []
    for (let j = i + 1; j < tree.children.length; j++) {
      const next = tree.children[j]
      if (!next) break
      if (next.type === 'heading' && next.depth <= 2) break
      bodyNodes.push(next)
    }

    const headingText = mdastToString(node).trim()
    if (headingText === '') {
      /* §5.2 makes the heading a card's whole identity, so there is no card here to
         keep. Skip the unit, report it, carry on with the rest of the file (§3.2). */
      diagnostics.push(
        diagnostic(
          'malformed-card-skipped',
          'a `##` heading with no text cannot identify a card, so the card was skipped.',
        ),
      )
      continue
    }

    const separator = separatorIndex(content, bodyNodes)
    const frontNodes = separator === -1 ? [] : bodyNodes.slice(0, separator)
    const backNodes = separator === -1 ? bodyNodes : bodyNodes.slice(separator + 1)

    const frontBody = slice(content, frontNodes)
    const back = slice(content, backNodes)
    const cardTags = unique([...scanTags(frontBody), ...scanTags(back)])

    cards.push({
      headingText,
      frontBody,
      back,
      cardTags,
      tags: unique([...fileTags, ...cardTags]),
      images: collectImages(bodyNodes),
      plainText: bodyNodes.map((n) => mdastToString(n)).join('\n'),
      headingLine: (node.position?.start.line ?? 1) + lineOffset,
    })
  }

  return {
    title,
    titleSource: titleNode ? 'heading' : 'none',
    frontmatter,
    fileTags,
    preamble,
    cards,
    diagnostics,
  }
}
