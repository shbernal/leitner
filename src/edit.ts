import path from 'node:path'
import type { Note, NotesFile } from './notes.js'
import type { ReviewState } from './state.js'
import type { Flashcard } from './types.js'

export type RecordMove = {
  from: string
  to: string
}

/** One card, as it was before the edit and as it is after it. */
export type CardPair = {
  before: Flashcard
  after: Flashcard
}

/**
 * Card ids hash the heading text together with the heading's index in the file
 * (see `cardId`), so an edit that renames a `##` heading — or inserts a card
 * above one — hands the same card a new id and orphans everything keyed on it.
 *
 * Pair the cards as they were before the edit against the cards as they are
 * now, so both names a card carries can follow it:
 *
 * 1. Titles that still exist pair up in order. That covers an insertion or a
 *    deletion, which shifts heading indices without touching any title.
 * 2. Whatever is left over pairs only when exactly one card went unmatched on
 *    each side — that is a rename. Two or more unmatched cards on a side is
 *    ambiguous, and guessing there would attach history to the wrong card.
 */
export function pairCards(before: Flashcard[], after: Flashcard[]): CardPair[] {
  const byTitle = new Map<string, Flashcard[]>()
  for (const card of after) {
    const bucket = byTitle.get(card.title)
    if (bucket) bucket.push(card)
    else byTitle.set(card.title, [card])
  }

  const pairs: CardPair[] = []
  const unmatchedBefore: Flashcard[] = []
  const matchedAfter = new Set<string>()

  for (const old of before) {
    const current = byTitle.get(old.title)?.shift()
    if (!current) {
      unmatchedBefore.push(old)
      continue
    }
    matchedAfter.add(current.id)
    pairs.push({ before: old, after: current })
  }

  const unmatchedAfter = after.filter((card) => !matchedAfter.has(card.id))
  const renamedFrom = unmatchedBefore[0]
  const renamedTo = unmatchedAfter[0]
  if (unmatchedBefore.length === 1 && unmatchedAfter.length === 1 && renamedFrom && renamedTo) {
    pairs.push({ before: renamedFrom, after: renamedTo })
  }

  return pairs
}

/** The ids that have to follow their card. See `pairCards` for the pairing. */
export function reconcileCardIds(before: Flashcard[], after: Flashcard[]): RecordMove[] {
  return pairCards(before, after)
    .filter((pair) => pair.before.id !== pair.after.id)
    .map((pair) => ({ from: pair.before.id, to: pair.after.id }))
}

/**
 * The references that have to follow their card — the currency notes are keyed
 * in, and not the same set as the ids above. A reference carries no heading
 * index, so a card inserted above another moves that card's id and leaves its
 * reference alone; deriving these from the id moves would do work for cards
 * whose notes never needed to go anywhere.
 */
export function reconcileCardRefs(before: Flashcard[], after: Flashcard[]): RecordMove[] {
  return pairCards(before, after)
    .filter((pair) => pair.before.ref !== pair.after.ref)
    .map((pair) => ({ from: pair.before.ref, to: pair.after.ref }))
}

/**
 * An id is a free destination when nothing holds a record there, or when the
 * record holding it is itself moving away. Dropping a move can strand another
 * one that was relying on it, so shrink the set until it stops changing.
 */
function applicableMoves(state: ReviewState, moves: RecordMove[]): RecordMove[] {
  let applicable = moves
  for (;;) {
    const vacated = new Set(applicable.map((move) => move.from))
    const next = applicable.filter(
      (move) => state.records[move.to] === undefined || vacated.has(move.to),
    )
    if (next.length === applicable.length) return applicable
    applicable = next
  }
}

/**
 * Re-key the review records named by `moves`, mutating `state` in place and
 * returning how many actually moved. Every record is read before any is
 * written, so a chain of moves cannot clobber itself. `cards` supplies the
 * post-edit cards, whose mtimes the moved records pick up.
 */
export function applyRecordMoves(
  state: ReviewState,
  moves: RecordMove[],
  cards: Flashcard[] = [],
): number {
  const pending = moves.filter((move) => state.records[move.from] !== undefined)
  const applicable = applicableMoves(state, pending)

  const carried = applicable.flatMap((move) => {
    const record = state.records[move.from]
    return record ? [{ move, record }] : []
  })
  for (const { move } of carried) delete state.records[move.from]

  const mtimes = new Map(cards.map((card) => [card.id, card.sourceMtimeMs]))
  for (const { move, record } of carried) {
    state.records[move.to] = {
      ...record,
      cardId: move.to,
      sourceMtimeMs: mtimes.get(move.to) ?? record.sourceMtimeMs,
    }
  }
  return carried.length
}

/**
 * Re-key the notes named by `moves`, returning the new file and how many notes
 * moved. Every list is read before any is written, so a chain of renames cannot
 * clobber itself.
 *
 * Unlike a review record, a note arriving at an occupied reference is **kept**:
 * the two lists concatenate, ordered by when they were written. A record is one
 * card's schedule and two of them cannot merge, but two people's remarks about
 * what is now one card are both still true, and dropping one to keep the file
 * tidy would destroy the only copy of something hand-written.
 *
 * `cards` supplies the post-edit cards, whose title and path the moved notes
 * pick up — a note that followed its card carrying the old title would be a lie
 * that surfaces much later, when the reference finally breaks.
 */
export function applyNoteMoves(
  file: NotesFile,
  moves: RecordMove[],
  cards: Flashcard[] = [],
): { notes: NotesFile; carried: number } {
  const destinations = new Map(
    moves.filter((move) => move.from !== move.to).map((move) => [move.from, move.to]),
  )
  const byRef = new Map(cards.map((card) => [card.ref, card]))

  const next: Record<string, Note[]> = {}
  const into = (ref: string): Note[] => (next[ref] ??= [])
  let carried = 0

  for (const [ref, list] of Object.entries(file.notes)) {
    const to = destinations.get(ref)
    if (to === undefined) {
      into(ref).push(...list)
      continue
    }
    const card = byRef.get(to)
    into(to).push(
      ...list.map((note) => ({
        ...note,
        cardTitle: card?.title ?? note.cardTitle,
        sourcePath: card ? path.relative(card.rootDir, card.sourcePath) : note.sourcePath,
      })),
    )
    carried += list.length
  }

  for (const list of Object.values(next)) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  return { notes: { ...file, notes: next }, carried }
}
