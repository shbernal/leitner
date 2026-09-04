import { describe, expect, it } from 'vitest'
import {
  applyNoteMoves,
  applyRecordMoves,
  reconcileCardIds,
  reconcileCardRefs,
} from '../src/edit.js'
import type { Note, NotesFile } from '../src/notes.js'
import { emptyState, type ReviewState } from '../src/state.js'
import type { Flashcard, ReviewRecord } from '../src/types.js'

function makeCard(id: string, title: string, ref = `deck#${id}`): Flashcard {
  return {
    id,
    deckId: 'deck',
    deckTitle: 'Deck',
    sourcePath: '/notes/deck.md',
    rootDir: '/notes',
    sourceMtimeMs: 0,
    sourceLine: 1,
    type: 'content',
    ref,
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

function note(text: string, createdAt: string): Note {
  return { text, createdAt, cardTitle: 'Groups', sourcePath: 'deck.md' }
}

function notesFile(notes: Record<string, Note[]>): NotesFile {
  return { version: 1, notes }
}

describe('reconcileCardRefs', () => {
  it('reports nothing when the edit left every heading alone', () => {
    const cards = [makeCard('a', 'Groups', 'deck#groups')]
    expect(reconcileCardRefs(cards, cards)).toEqual([])
  })

  it('follows a renamed heading', () => {
    const before = [makeCard('a', 'Groups', 'deck#groups')]
    const after = [makeCard('a2', 'What is a group?', 'deck#what-is-a-group')]
    expect(reconcileCardRefs(before, after)).toEqual([
      { from: 'deck#groups', to: 'deck#what-is-a-group' },
    ])
  })

  /* The reason these are derived from the pairing rather than from the id moves:
     an insertion moves every later id and no reference at all. */
  it('reports nothing for an insertion, which moves ids and no references', () => {
    const before = [makeCard('a', 'Groups', 'deck#groups')]
    const after = [makeCard('x', 'Sets', 'deck#sets'), makeCard('a2', 'Groups', 'deck#groups')]
    expect(reconcileCardIds(before, after)).toEqual([{ from: 'a', to: 'a2' }])
    expect(reconcileCardRefs(before, after)).toEqual([])
  })

  it('reports nothing when two cards were renamed at once, as ids do', () => {
    const before = [makeCard('a', 'Groups', 'deck#groups'), makeCard('b', 'Rings', 'deck#rings')]
    const after = [makeCard('a2', 'Group?', 'deck#group'), makeCard('b2', 'Ring?', 'deck#ring')]
    expect(reconcileCardRefs(before, after)).toEqual([])
  })
})

describe('applyNoteMoves', () => {
  const moved = makeCard('a2', 'What is a group?', 'deck#what-is-a-group')

  it('re-keys the notes of a renamed card and leaves the others alone', () => {
    const file = notesFile({
      'deck#groups': [note('front gives it away', '2026-09-01T00:00:00.000Z')],
      'deck#rings': [note('fine as it is', '2026-09-02T00:00:00.000Z')],
    })
    const result = applyNoteMoves(file, [{ from: 'deck#groups', to: moved.ref }], [moved])

    expect(result.carried).toBe(1)
    expect(Object.keys(result.notes.notes).sort()).toEqual(['deck#rings', moved.ref])
    expect(result.notes.notes[moved.ref]?.[0]?.text).toBe('front gives it away')
  })

  // A stale title on a note that did follow its card only shows up much later.
  it('refreshes the card title and path the moved notes carry', () => {
    const file = notesFile({ 'deck#groups': [note('thin', '2026-09-01T00:00:00.000Z')] })
    const result = applyNoteMoves(file, [{ from: 'deck#groups', to: moved.ref }], [moved])
    expect(result.notes.notes[moved.ref]?.[0]?.cardTitle).toBe('What is a group?')
    expect(result.notes.notes[moved.ref]?.[0]?.sourcePath).toBe('deck.md')
  })

  /* Two schedules cannot merge, but two remarks about what is now one card are
     both still true — so unlike a record, an arriving note is never dropped. */
  it('concatenates into an occupied reference, oldest note first', () => {
    const file = notesFile({
      'deck#groups': [note('older', '2026-09-01T00:00:00.000Z')],
      [moved.ref]: [note('newer', '2026-09-03T00:00:00.000Z')],
    })
    const result = applyNoteMoves(file, [{ from: 'deck#groups', to: moved.ref }], [moved])
    expect(result.notes.notes[moved.ref]?.map((entry) => entry.text)).toEqual(['older', 'newer'])
  })

  it('carries a chain of renames without one clobbering the next', () => {
    const file = notesFile({
      'deck#a': [note('first', '2026-09-01T00:00:00.000Z')],
      'deck#b': [note('second', '2026-09-02T00:00:00.000Z')],
    })
    const result = applyNoteMoves(file, [
      { from: 'deck#a', to: 'deck#b' },
      { from: 'deck#b', to: 'deck#c' },
    ])
    expect(result.notes.notes['deck#b']?.map((entry) => entry.text)).toEqual(['first'])
    expect(result.notes.notes['deck#c']?.map((entry) => entry.text)).toEqual(['second'])
  })

  it('leaves a file alone when nothing moved', () => {
    const file = notesFile({ 'deck#groups': [note('thin', '2026-09-01T00:00:00.000Z')] })
    expect(applyNoteMoves(file, [])).toEqual({ notes: file, carried: 0 })
  })
})
