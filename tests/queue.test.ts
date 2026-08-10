import { describe, expect, it } from 'vitest'
import { buildQueue, summarizeDecks } from '../src/queue.js'
import { emptyState } from '../src/state.js'
import type { Flashcard, ReviewRecord } from '../src/types.js'

const now = new Date('2026-06-11T12:00:00.000Z')

function makeCard(id: string): Flashcard {
  return {
    id,
    deckId: 'deck',
    deckTitle: 'Deck',
    sourcePath: '/tmp/deck.md',
    sourceMtimeMs: 0,
    type: 'content',
    title: id,
    bodyMarkdown: '- fact',
    plainText: 'fact',
    images: [],
    tags: [],
  }
}

function makeRecord(cardId: string, dueAt: string, suspended = false): ReviewRecord {
  return {
    cardId,
    sourcePath: '/tmp/deck.md',
    sourceMtimeMs: 0,
    suspended,
    dueAt,
    intervalDays: 1,
    ease: 2.5,
    reps: 1,
    lapses: 0,
  }
}

describe('buildQueue', () => {
  const cards = ['a', 'b', 'c', 'd'].map(makeCard)
  const state = emptyState()
  state.records['a'] = makeRecord('a', '2026-06-10T12:00:00.000Z') // due yesterday
  state.records['b'] = makeRecord('b', '2026-06-01T12:00:00.000Z') // due long ago
  state.records['c'] = makeRecord('c', '2026-07-01T12:00:00.000Z') // not due
  state.records['orphan'] = makeRecord('orphan', '2026-06-01T12:00:00.000Z') // deleted card
  // d has no record: new

  it('orders oldest due first, then new cards; skips not-due and orphans', () => {
    const queue = buildQueue(cards, state, {}, now)
    expect(queue.map((q) => q.card.id)).toEqual(['b', 'a', 'd'])
    expect(queue.map((q) => q.isNew)).toEqual([false, false, true])
  })

  it('supports dueOnly, newOnly, and limit', () => {
    expect(buildQueue(cards, state, { dueOnly: true }, now).map((q) => q.card.id)).toEqual([
      'b',
      'a',
    ])
    expect(buildQueue(cards, state, { newOnly: true }, now).map((q) => q.card.id)).toEqual(['d'])
    expect(buildQueue(cards, state, { limit: 1 }, now)).toHaveLength(1)
  })

  it('skips suspended cards', () => {
    const suspendedState = emptyState()
    suspendedState.records['a'] = makeRecord('a', '2026-06-01T12:00:00.000Z', true)
    const queue = buildQueue([makeCard('a')], suspendedState, {}, now)
    expect(queue).toHaveLength(0)
  })
})

describe('summarizeDecks', () => {
  it('counts due, new and suspended cards per deck', () => {
    const cards = ['a', 'b', 'c', 'd'].map(makeCard)
    const other = { ...makeCard('e'), deckId: 'other' }
    const state = emptyState()
    state.records['a'] = makeRecord('a', '2026-06-10T12:00:00.000Z') // due
    state.records['b'] = makeRecord('b', '2026-07-01T12:00:00.000Z') // not due
    state.records['c'] = makeRecord('c', '2026-06-01T12:00:00.000Z', true) // suspended
    // d is new

    const summaries = summarizeDecks([...cards, other], state, now)
    expect(summaries.get('deck')).toEqual({ total: 4, due: 1, fresh: 1, suspended: 1 })
    expect(summaries.get('other')).toEqual({ total: 1, due: 0, fresh: 1, suspended: 0 })
  })

  it('omits decks with no cards', () => {
    expect(summarizeDecks([], emptyState(), now).size).toBe(0)
  })
})
