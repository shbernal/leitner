import { describe, expect, it } from 'vitest'
import { assignRefs, cardRef, resolveRef } from '../src/refs.js'
import type { Flashcard } from '../src/types.js'

/** Only the fields resolution reads; the rest of a card is irrelevant here. */
function makeCard(ref: string, rootDir = '/notes'): Flashcard {
  const [deckId = '', title = ''] = ref.split('#')
  return {
    id: `id-${rootDir}-${ref}`,
    ref,
    deckId,
    deckTitle: deckId,
    sourcePath: `${rootDir}/${deckId}.md`,
    rootDir,
    sourceMtimeMs: 0,
    sourceLine: 1,
    title,
    frontBody: '',
    back: '- fact',
    plainText: 'fact',
    images: [],
    cardTags: [],
    tags: [],
  }
}

describe('cardRef', () => {
  it('joins the deck slug and the heading slug with a `#`', () => {
    expect(cardRef('spanish-verbs', 'ser-vs-estar')).toBe('spanish-verbs#ser-vs-estar')
  })

  it('appends an ordinal with `~` when one is given', () => {
    expect(cardRef('spanish-verbs', 'ser-vs-estar', 2)).toBe('spanish-verbs#ser-vs-estar~2')
  })
})

describe('assignRefs', () => {
  it('leaves a slug that occurs once without an ordinal', () => {
    const { refs, duplicated } = assignRefs('deck', ['first', 'second'])
    expect(refs).toEqual(['deck#first', 'deck#second'])
    expect(duplicated).toEqual([])
  })

  /* Not "all but the first": deleting a bare first occurrence would promote the
     second into its reference, and hand it whatever was filed against it. */
  it('gives every occurrence of a repeated slug an ordinal, none of them bare', () => {
    const { refs, duplicated } = assignRefs('deck', ['geography', 'other', 'geography'])
    expect(refs).toEqual(['deck#geography~1', 'deck#other', 'deck#geography~2'])
    expect(duplicated).toEqual(['geography'])
  })

  it('counts each repeated slug separately and reports them in first-seen order', () => {
    const { refs, duplicated } = assignRefs('deck', ['b', 'a', 'b', 'a', 'b'])
    expect(refs).toEqual(['deck#b~1', 'deck#a~1', 'deck#b~2', 'deck#a~2', 'deck#b~3'])
    expect(duplicated).toEqual(['b', 'a'])
  })

  it('answers an empty file with no refs and nothing duplicated', () => {
    expect(assignRefs('deck', [])).toEqual({ refs: [], duplicated: [] })
  })
})

describe('resolveRef', () => {
  const cards = [
    makeCard('spanish-verbs#ser-vs-estar'),
    makeCard('spanish-verbs#ser-conjugation'),
    makeCard('algebra#groups'),
  ]

  it('finds a card by its full reference', () => {
    const result = resolveRef(cards, 'spanish-verbs#ser-vs-estar')
    expect(result).toEqual({ kind: 'found', card: cards[0] })
  })

  it('accepts surrounding whitespace and a different case', () => {
    expect(resolveRef(cards, '  Spanish-Verbs#Ser-Vs-Estar\n')).toEqual({
      kind: 'found',
      card: cards[0],
    })
  })

  it('falls back to a prefix when nothing matches exactly', () => {
    expect(resolveRef(cards, 'algebra#gr')).toEqual({ kind: 'found', card: cards[2] })
  })

  it('reports every candidate when a prefix reaches more than one card', () => {
    const result = resolveRef(cards, 'spanish-verbs#ser')
    expect(result).toEqual({ kind: 'ambiguous', matches: [cards[0], cards[1]] })
  })

  it('matches on the deck slug alone when the query carries no `#`', () => {
    const result = resolveRef(cards, 'algebra')
    expect(result).toEqual({ kind: 'found', card: cards[2] })
  })

  /* An exact reference wins outright, so a card whose reference is a prefix of
     another's is still addressable. */
  it('prefers an exact match over the cards it is a prefix of', () => {
    const nested = [makeCard('deck#ser'), makeCard('deck#ser-vs-estar')]
    expect(resolveRef(nested, 'deck#ser')).toEqual({ kind: 'found', card: nested[0] })
  })

  it('reports no match rather than throwing', () => {
    expect(resolveRef(cards, 'french#avoir')).toEqual({ kind: 'none' })
    expect(resolveRef(cards, '   ')).toEqual({ kind: 'none' })
    expect(resolveRef([], 'algebra')).toEqual({ kind: 'none' })
  })

  /* Two roots holding the same relative path produce one reference for two cards,
     the collision `parseDirectories` already warns about. It surfaces here as
     ambiguity, not as a second warning. */
  it('reports two roots sharing a reference as ambiguous', () => {
    const collided = [makeCard('spanish#hola', '/mine'), makeCard('spanish#hola', '/theirs')]
    const result = resolveRef(collided, 'spanish#hola')
    expect(result).toEqual({ kind: 'ambiguous', matches: collided })
  })
})
