import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import fastGlob from 'fast-glob'
import matter from 'gray-matter'
import { toString as mdastToString } from 'mdast-util-to-string'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { Heading, Image, Root, RootContent } from 'mdast'
import type { CardImage, CardType, Deck, Flashcard, ParseResult, ParseWarning } from './types.js'

const KNOWN_TYPES: ReadonlySet<string> = new Set(['content', 'film', 'vocabulary'])

const processor = unified().use(remarkParse)

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  )
}

export function cardId(
  relativeSourcePath: string,
  headingSlug: string,
  headingIndex: number,
): string {
  return createHash('sha1')
    .update(`${relativeSourcePath}:${headingSlug}:${headingIndex}`)
    .digest('hex')
}

function cardType(frontmatter: Record<string, unknown>): CardType {
  const raw = frontmatter['type']
  return typeof raw === 'string' && KNOWN_TYPES.has(raw) ? (raw as CardType) : 'unknown'
}

function frontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter['tags']
  if (!Array.isArray(raw)) return []
  return raw.filter((tag): tag is string => typeof tag === 'string')
}

function collectImages(nodes: RootContent[], sourceDir: string): CardImage[] {
  const images: CardImage[] = []
  const visit = (node: { type: string; children?: unknown[] }) => {
    if (node.type === 'image') {
      const image = node as unknown as Image
      const url = image.url ?? ''
      // Only resolve local file references; leave remote URLs untouched.
      const resolved = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : path.resolve(sourceDir, url)
      images.push({ alt: image.alt ?? '', path: resolved })
    }
    for (const child of node.children ?? []) {
      visit(child as { type: string; children?: unknown[] })
    }
  }
  for (const node of nodes) visit(node)
  return images
}

type ParsedFile = {
  deck: Deck | null
  cards: Flashcard[]
  warnings: ParseWarning[]
}

export async function parseFile(sourcePath: string, rootDir: string): Promise<ParsedFile> {
  const warnings: ParseWarning[] = []
  const [raw, stat] = await Promise.all([fs.readFile(sourcePath, 'utf8'), fs.stat(sourcePath)])

  if (raw.trim() === '') {
    return { deck: null, cards: [], warnings: [{ sourcePath, message: 'empty file' }] }
  }

  let frontmatter: Record<string, unknown> = {}
  let content = raw
  try {
    const parsed = matter(raw)
    frontmatter = parsed.data as Record<string, unknown>
    content = parsed.content
  } catch (error) {
    warnings.push({
      sourcePath,
      message: `invalid frontmatter, treating whole file as content: ${String(error)}`,
    })
  }

  const tree = processor.parse(content) as Root
  const relPath = path.relative(rootDir, sourcePath)
  const type = cardType(frontmatter)
  const tags = frontmatterTags(frontmatter)
  const sourceDir = path.dirname(sourcePath)

  const firstH1 = tree.children.find(
    (node): node is Heading => node.type === 'heading' && node.depth === 1,
  )
  const deckTitle = firstH1 ? mdastToString(firstH1) : path.basename(sourcePath, '.md')
  const deckId = slugify(relPath.replace(/\.md$/, ''))

  const cards: Flashcard[] = []
  let headingIndex = -1
  for (let i = 0; i < tree.children.length; i++) {
    const node = tree.children[i]
    if (!node || node.type !== 'heading' || node.depth !== 2) continue
    headingIndex++

    const bodyNodes: RootContent[] = []
    for (let j = i + 1; j < tree.children.length; j++) {
      const next = tree.children[j]
      if (!next) break
      if (next.type === 'heading' && next.depth <= 2) break
      bodyNodes.push(next)
    }

    const title = mdastToString(node)
    const bodyStart = bodyNodes[0]?.position?.start.offset
    const bodyEnd = bodyNodes.at(-1)?.position?.end.offset
    const bodyMarkdown =
      bodyStart !== undefined && bodyEnd !== undefined
        ? content.slice(bodyStart, bodyEnd).trim()
        : ''

    cards.push({
      id: cardId(relPath, slugify(title), headingIndex),
      deckId,
      deckTitle,
      sourcePath,
      sourceMtimeMs: stat.mtimeMs,
      type,
      title,
      bodyMarkdown,
      plainText: bodyNodes.map((n) => mdastToString(n)).join('\n'),
      images: collectImages(bodyNodes, sourceDir),
      tags,
    })
  }

  if (cards.length === 0) {
    warnings.push({ sourcePath, message: 'no `##` card headings found' })
    return { deck: null, cards: [], warnings }
  }

  const deck: Deck = {
    id: deckId,
    title: deckTitle,
    sourcePath,
    type,
    cardCount: cards.length,
  }
  return { deck, cards, warnings }
}

export async function parseDirectory(rootDir: string): Promise<ParseResult> {
  const files = await fastGlob('**/*.md', {
    cwd: rootDir,
    absolute: true,
    dot: false,
  })
  files.sort()

  const decks: Deck[] = []
  const cards: Flashcard[] = []
  const warnings: ParseWarning[] = []

  for (const file of files) {
    try {
      const result = await parseFile(file, rootDir)
      if (result.deck) decks.push(result.deck)
      cards.push(...result.cards)
      warnings.push(...result.warnings)
    } catch (error) {
      warnings.push({ sourcePath: file, message: `failed to parse: ${String(error)}` })
    }
  }

  return { decks, cards, warnings }
}
