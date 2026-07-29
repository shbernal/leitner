import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDirectory, parseFile } from '../src/parser.js'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

describe('parseFile', () => {
  it('parses a file with frontmatter into cards', async () => {
    const result = await parseFile(path.join(fixtures, 'with-frontmatter.md'), fixtures)
    expect(result.deck?.title).toBe('Sample Deck')
    expect(result.cards).toHaveLength(2)

    const [first, second] = result.cards
    expect(first?.title).toBe('First card')
    expect(first?.type).toBe('content')
    expect(first?.bodyMarkdown).toContain('- fact one')
    expect(first?.bodyMarkdown).toContain('`code`')
    expect(first?.plainText).toContain('fact one')

    // ### headings belong to the preceding ## card
    expect(second?.bodyMarkdown).toContain('Sub-heading stays inside the card')
    expect(second?.bodyMarkdown).toContain('nested detail')
  })

  it('parses a file without frontmatter and uses H1 as deck title', async () => {
    const result = await parseFile(path.join(fixtures, 'no-frontmatter.md'), fixtures)
    expect(result.deck?.title).toBe('deck-without-frontmatter')
    expect(result.cards).toHaveLength(2)
    expect(result.cards.every((c) => c.type === 'unknown')).toBe(true)
  })

  it('gives repeated headings distinct stable ids', async () => {
    const result = await parseFile(path.join(fixtures, 'no-frontmatter.md'), fixtures)
    const ids = result.cards.map((c) => c.id)
    expect(new Set(ids).size).toBe(2)

    const again = await parseFile(path.join(fixtures, 'no-frontmatter.md'), fixtures)
    expect(again.cards.map((c) => c.id)).toEqual(ids)
  })

  it('resolves relative image references to absolute paths', async () => {
    const result = await parseFile(path.join(fixtures, 'images.md'), fixtures)
    const card = result.cards[0]
    expect(card?.images).toHaveLength(1)
    expect(card?.images[0]?.alt).toBe('example alt')
    expect(card?.images[0]?.path).toBe(path.join(fixtures, '.images', 'example.png'))
  })

  it('parses vocabulary files with the same card shape', async () => {
    const result = await parseFile(path.join(fixtures, 'vocabulary', 'words.md'), fixtures)
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0]?.type).toBe('vocabulary')
    expect(result.cards[0]?.title).toBe('coax')
    expect(result.cards[0]?.bodyMarkdown).toContain('Gently persuade')
  })

  it('warns on empty files and files without cards', async () => {
    const empty = await parseFile(path.join(fixtures, 'empty.md'), fixtures)
    expect(empty.cards).toHaveLength(0)
    expect(empty.warnings[0]?.message).toContain('empty')

    const noCards = await parseFile(path.join(fixtures, 'no-cards.md'), fixtures)
    expect(noCards.cards).toHaveLength(0)
    expect(noCards.warnings[0]?.message).toContain('no `##` card headings')
  })
})

describe('parseDirectory', () => {
  it('scans recursively, skipping hidden directories', async () => {
    const result = await parseDirectory(fixtures)
    const deckIds = result.decks.map((d) => d.id).sort()
    expect(deckIds).toEqual(['images', 'no-frontmatter', 'vocabulary-words', 'with-frontmatter'])
    expect(result.cards).toHaveLength(6)
    expect(result.warnings).toHaveLength(2)
  })
})
