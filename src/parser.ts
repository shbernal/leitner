import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import fastGlob from 'fast-glob'
import { parseDeck } from './deck.js'
import type { CardImage, Deck, Flashcard, ParseResult, ParseWarning } from './types.js'

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

/** True for a destination carrying a URI scheme, which is never resolved to disk. */
function isRemote(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src)
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
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
    return {
      deck: null,
      cards: [],
      warnings: [{ sourcePath, message: 'empty file', code: null, cardIndex: null }],
    }
  }

  const parsed = parseDeck(raw)
  for (const { code, cardIndex, message } of parsed.diagnostics) {
    warnings.push({ sourcePath, message, code, cardIndex })
  }

  const relPath = path.relative(rootDir, sourcePath)
  const sourceDir = path.dirname(sourcePath)
  const deckId = slugify(relPath.replace(/\.md$/, ''))
  // The format leaves the deck title optional (§4.2) and permits — but does not
  // require — a filename fallback. A review session has to print something.
  const deckTitle = parsed.title ?? path.basename(sourcePath, '.md')
  const type =
    typeof parsed.frontmatter['type'] === 'string' ? parsed.frontmatter['type'] : undefined

  const cards: Flashcard[] = parsed.cards.map((card, headingIndex) => {
    const images: CardImage[] = card.images.map((image) => ({
      alt: image.alt,
      src: image.src,
      path: isRemote(image.src) ? image.src : path.resolve(sourceDir, image.src),
    }))

    return {
      id: cardId(relPath, slugify(card.headingText), headingIndex),
      deckId,
      deckTitle,
      sourcePath,
      sourceMtimeMs: stat.mtimeMs,
      sourceLine: card.headingLine,
      ...(type === undefined ? {} : { type }),
      title: card.headingText,
      frontBody: card.frontBody,
      back: card.back,
      plainText: card.plainText,
      images,
      cardTags: card.cardTags,
      tags: card.tags,
    }
  })

  /* §7: an image that cannot be resolved is reported, never dropped in silence. The
     check is here rather than in deck.ts because whether a path resolves is a fact
     about the filesystem, not about the markdown. Remote destinations are legal and
     resolve to nothing on disk by definition, so they are left to render time. */
  await Promise.all(
    cards.map(async (card, cardIndex) => {
      for (const image of card.images) {
        if (isRemote(image.src)) continue
        if (await exists(image.path)) continue
        warnings.push({
          sourcePath,
          message: `image not found: ${image.src}`,
          code: 'unresolved-image',
          cardIndex,
        })
      }
    }),
  )

  if (cards.length === 0) {
    warnings.push({
      sourcePath,
      message: 'no `##` card headings found',
      code: null,
      cardIndex: null,
    })
    return { deck: null, cards: [], warnings }
  }

  const deck: Deck = {
    id: deckId,
    title: deckTitle,
    sourcePath,
    ...(type === undefined ? {} : { type }),
    cardCount: cards.length,
  }
  return { deck, cards, warnings }
}

export async function parseDirectory(rootDir: string): Promise<ParseResult> {
  /* fast-glob answers an absent cwd with an empty list, so without this a stale
     config or a mistyped path reads as "your collection is empty" — `list` prints
     0 decks and `review` congratulates you on being done. */
  let stat
  try {
    stat = await fs.stat(rootDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`no such directory: ${rootDir}`)
    }
    throw error
  }
  if (!stat.isDirectory()) throw new Error(`not a directory: ${rootDir}`)

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
      warnings.push({
        sourcePath: file,
        message: `failed to parse: ${String(error)}`,
        code: null,
        cardIndex: null,
      })
    }
  }

  return { decks, cards, warnings }
}
