import { describe, expect, it } from 'vitest'
import { applyRecordMoves, reconcileCardIds } from '../src/edit.js'
import { emptyState, type ReviewState } from '../src/state.js'
import type { Flashcard, ReviewRecord } from '../src/types.js'

function makeCard(id: string, title: string): Flashcard {
  return {
    id,
    deckId: 'deck',
    deckTitle: 'Deck',
    sourcePath: '/notes/deck.md',
    sourceMtimeMs: 0,
    sourceLine: 1,
    type: 'content',
    title,
    frontBody: '',
    back: '- fact',
    plainText: 'fact',
    images: [],
    cardTags: [],
    tags: [],
  }
}

function seed(state: ReviewState, cardId: string, overrides: Partial<ReviewRecord> = {}): void {
  state.records[cardId] = {
    cardId,
    sourcePath: '/notes/deck.md',
    sourceMtimeMs: 0,
    suspended: false,
    dueAt: '2026-01-01T00:00:00.000Z',
    intervalDays: 4,
    ease: 2.1,
    reps: 3,
    lapses: 1,
    ...overrides,
  }
}

describe('reconcileCardIds', () => {
  it('reports nothing when the edit left every id alone', () => {
    const cards = [makeCard('a', 'Groups'), makeCard('b', 'Rings')]
    expect(reconcileCardIds(cards, cards)).toEqual([])
  })

  it('follows a renamed heading', () => {
    const before = [makeCard('a', 'Groups'), makeCard('b', 'Rings')]
    const after = [makeCard('a2', 'What is a group?'), makeCard('b', 'Rings')]
    expect(reconcileCardIds(before, after)).toEqual([{ from: 'a', to: 'a2' }])
  })

  it('follows the ids that a card inserted above them shifted', () => {
    const before = [makeCard('a', 'Groups'), makeCard('b', 'Rings')]
    const after = [makeCard('x', 'Sets'), makeCard('a2', 'Groups'), makeCard('b2', 'Rings')]
    expect(reconcileCardIds(before, after)).toEqual([
      { from: 'a', to: 'a2' },
      { from: 'b', to: 'b2' },
    ])
  })

  it('reports nothing for a deleted card', () => {
    const before = [makeCard('a', 'Groups'), makeCard('b', 'Rings')]
    const after = [makeCard('a', 'Groups')]
    expect(reconcileCardIds(before, after)).toEqual([])
  })

  it('refuses to guess when two headings were renamed at once', () => {
    const before = [makeCard('a', 'Groups'), makeCard('b', 'Rings')]
    const after = [makeCard('a2', 'What is a group?'), makeCard('b2', 'What is a ring?')]
    expect(reconcileCardIds(before, after)).toEqual([])
  })

  it('pairs duplicate titles in order', () => {
    const before = [makeCard('a', 'Example'), makeCard('b', 'Example')]
    const after = [makeCard('a2', 'Example'), makeCard('b2', 'Example')]
    expect(reconcileCardIds(before, after)).toEqual([
      { from: 'a', to: 'a2' },
      { from: 'b', to: 'b2' },
    ])
  })
})

describe('applyRecordMoves', () => {
  it('carries the record over and re-keys it', () => {
    const state = emptyState()
    seed(state, 'a', { reps: 7 })

    const moved = applyRecordMoves(
      state,
      [{ from: 'a', to: 'a2' }],
      [{ ...makeCard('a2', 'Groups'), sourceMtimeMs: 999 }],
    )

    expect(moved).toBe(1)
    expect(state.records['a']).toBeUndefined()
    expect(state.records['a2']?.reps).toBe(7)
    expect(state.records['a2']?.cardId).toBe('a2')
    expect(state.records['a2']?.sourceMtimeMs).toBe(999)
  })

  it('ignores a move for a card that was never reviewed', () => {
    const state = emptyState()
    expect(applyRecordMoves(state, [{ from: 'a', to: 'a2' }])).toBe(0)
    expect(state.records).toEqual({})
  })

  it('does not clobber history already sitting at the destination', () => {
    const state = emptyState()
    seed(state, 'a', { reps: 1 })
    seed(state, 'b', { reps: 9 })

    expect(applyRecordMoves(state, [{ from: 'a', to: 'b' }])).toBe(0)
    expect(state.records['a']?.reps).toBe(1)
    expect(state.records['b']?.reps).toBe(9)
  })

  it('applies a chain of moves without one overwriting the next', () => {
    const state = emptyState()
    seed(state, 'a', { reps: 1 })
    seed(state, 'b', { reps: 2 })

    const moved = applyRecordMoves(state, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ])

    expect(moved).toBe(2)
    expect(state.records['a']).toBeUndefined()
    expect(state.records['b']?.reps).toBe(1)
    expect(state.records['c']?.reps).toBe(2)
  })

  it('drops a move that only looked free because a blocked move would vacate it', () => {
    const state = emptyState()
    seed(state, 'a', { reps: 1 })
    seed(state, 'b', { reps: 2 })
    seed(state, 'c', { reps: 3 })

    // b -> c is blocked by c staying put, so b never vacates and a -> b must not run.
    const moved = applyRecordMoves(state, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ])

    expect(moved).toBe(0)
    expect(state.records['a']?.reps).toBe(1)
    expect(state.records['b']?.reps).toBe(2)
    expect(state.records['c']?.reps).toBe(3)
  })
})
