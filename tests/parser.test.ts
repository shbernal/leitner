import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cardId, parseDirectory, parseFile, slugify } from '../src/parser.js'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

describe('parseFile', () => {
  it('parses a file with frontmatter into cards', async () => {
    const result = await parseFile(path.join(fixtures, 'with-frontmatter.md'), fixtures)
    expect(result.deck?.title).toBe('Sample Deck')
    expect(result.cards).toHaveLength(2)

    const [first, second] = result.cards
    expect(first?.title).toBe('First card')
    expect(first?.type).toBe('content')
    expect(first?.back).toContain('- fact one')
    expect(first?.back).toContain('`code`')
    expect(first?.plainText).toContain('fact one')

    // ### headings belong to the preceding ## card
    expect(second?.back).toContain('Sub-heading stays inside the card')
    expect(second?.back).toContain('nested detail')
  })

  it('parses a file without frontmatter and uses H1 as deck title', async () => {
    const result = await parseFile(path.join(fixtures, 'no-frontmatter.md'), fixtures)
    expect(result.deck?.title).toBe('deck-without-frontmatter')
    expect(result.cards).toHaveLength(2)
    // The format leaves `type` to the user, so a file that declares none has none —
    // there is no value standing in for absence.
    expect(result.cards.every((c) => c.type === undefined)).toBe(true)
  })

  it('gives repeated headings distinct stable ids', async () => {
    const result = await parseFile(path.join(fixtures, 'no-frontmatter.md'), fixtures)
    const ids = result.cards.map((c) => c.id)
    expect(new Set(ids).size).toBe(2)

    const again = await parseFile(path.join(fixtures, 'no-frontmatter.md'), fixtures)
    expect(again.cards.map((c) => c.id)).toEqual(ids)
  })

  it('records the heading line, counting the frontmatter $EDITOR will see', async () => {
    const withFrontmatter = await parseFile(path.join(fixtures, 'with-frontmatter.md'), fixtures)
    expect(withFrontmatter.cards.map((c) => c.sourceLine)).toEqual([7, 11])

    const without = await parseFile(path.join(fixtures, 'no-frontmatter.md'), fixtures)
    expect(without.cards.map((c) => c.sourceLine)).toEqual([3, 6])
  })

  it('resolves relative image references to absolute paths, keeping the source form', async () => {
    const result = await parseFile(path.join(fixtures, 'images.md'), fixtures)
    const card = result.cards[0]
    expect(card?.images).toHaveLength(1)
    expect(card?.images[0]?.alt).toBe('example alt')
    expect(card?.images[0]?.src).toBe('.images/example.png')
    expect(card?.images[0]?.path).toBe(path.join(fixtures, '.images', 'example.png'))
    expect(result.warnings).toHaveLength(0)
  })

  it('splits front from back on a `***`, and only on that spelling', async () => {
    const result = await parseFile(path.join(fixtures, 'rich-front.md'), fixtures)
    const [split, whole] = result.cards

    expect(split?.title).toBe('el pretérito')
    expect(split?.frontBody).toBe('Conjugate this tense for a regular -ar verb.')
    expect(split?.back).toContain('hablé, hablaste')

    // A --- further down is back content, not a second separator.
    expect(whole?.frontBody).toBe('')
    expect(whole?.back).toContain('---')
    expect(whole?.back).toContain('thematic break')
  })

  it('unions file and card tags, counting a tag in the front region', async () => {
    const result = await parseFile(path.join(fixtures, 'rich-front.md'), fixtures)
    const [split, whole] = result.cards

    expect(split?.cardTags).toEqual(['spanish/grammar'])
    expect(split?.tags).toEqual(['spanish', 'spanish/grammar'])
    // File tags reach every card, whether or not the card writes any of its own.
    expect(whole?.tags).toEqual(['spanish'])
  })

  it('passes an unrecognized frontmatter type through verbatim', async () => {
    const result = await parseFile(path.join(fixtures, 'rich-front.md'), fixtures)
    expect(result.deck?.type).toBe('grammar')
    expect(result.cards.every((c) => c.type === 'grammar')).toBe(true)
  })

  it('parses vocabulary files with the same card shape', async () => {
    const result = await parseFile(path.join(fixtures, 'vocabulary', 'words.md'), fixtures)
    expect(result.cards).toHaveLength(1)
    expect(result.cards[0]?.type).toBe('vocabulary')
    expect(result.cards[0]?.title).toBe('coax')
    expect(result.cards[0]?.back).toContain('Gently persuade')
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
    expect(deckIds).toEqual([
      'images',
      'no-frontmatter',
      'rich-front',
      'vocabulary-words',
      'with-frontmatter',
    ])
    expect(result.cards).toHaveLength(8)
    expect(result.warnings).toHaveLength(2)
  })

  // A missing root is a broken configuration, not an empty collection. Without
  // this it globs to nothing and every command reports a collection of zero.
  it('throws on a root that does not exist', async () => {
    await expect(parseDirectory(path.join(fixtures, 'nope'))).rejects.toThrow('no such directory')
  })

  it('throws on a root that is a file', async () => {
    await expect(parseDirectory(path.join(fixtures, 'with-frontmatter.md'))).rejects.toThrow(
      'not a directory',
    )
  })
})

/*
 * The id scheme is sticky: review history is keyed on a card id and nothing else, so
 * changing the derivation silently invalidates every record on disk and nothing tells
 * the user. `docs/format.md` says so in prose; these literal hashes are what makes it
 * cost something to break. If one of them fails, the question is not "update the
 * expectation" — it is whether every existing user's review state is being discarded.
 */
describe('card identity', () => {
  it('slugifies to lowercase alphanumerics joined by single dashes', () => {
    expect(slugify('First card')).toBe('first-card')
    expect(slugify('  Trailing & leading punctuation!  ')).toBe('trailing-leading-punctuation')
    expect(slugify('Ökonomie 101')).toBe('konomie-101')
    expect(slugify('C++')).toBe('c')
  })

  it('falls back to `untitled` when nothing survives slugification', () => {
    expect(slugify('***')).toBe('untitled')
    expect(slugify('')).toBe('untitled')
  })

  it('hashes path, heading slug and heading index into a stable sha1', () => {
    expect(cardId('vocabulary/words.md', 'first-card', 0)).toBe(
      '44f3cb83bca30ae07da8d86de3af28e141a6c271',
    )
    expect(cardId('notes.md', 'untitled', 0)).toBe('55338923e62f69e042b7f4dbc810a18297d3fa32')
  })

  it('changes when the heading index changes, which is why inserting a card resets it', () => {
    expect(cardId('vocabulary/words.md', 'first-card', 1)).toBe(
      'e574a01521fd411a8a84127546b1734dc4a5acb7',
    )
    expect(cardId('vocabulary/words.md', 'first-card', 1)).not.toBe(
      cardId('vocabulary/words.md', 'first-card', 0),
    )
  })

  it('gives duplicate headings distinct ids, and identical headings in two files too', () => {
    expect(cardId('a.md', 'same', 0)).not.toBe(cardId('a.md', 'same', 1))
    expect(cardId('a.md', 'same', 0)).not.toBe(cardId('b.md', 'same', 0))
  })

  it('derives the deck id the parser actually uses from the relative path', async () => {
    const result = await parseFile(path.join(fixtures, 'vocabulary', 'words.md'), fixtures)
    expect(result.deck?.id).toBe('vocabulary-words')
    // Slugifying the whole path is what makes `a/b.md` and `a-b.md` collide, as
    // docs/format.md warns.
    expect(slugify('a/b')).toBe(slugify('a-b'))
  })

  it('gives a real parsed card the id the derivation predicts', async () => {
    const result = await parseFile(path.join(fixtures, 'vocabulary', 'words.md'), fixtures)
    const first = result.cards[0]
    expect(first).toBeDefined()
    expect(first?.id).toBe(cardId('vocabulary/words.md', slugify(first?.title ?? ''), 0))
  })
})
