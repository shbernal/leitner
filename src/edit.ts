import type { ReviewState } from './state.js'
import type { Flashcard } from './types.js'

export type RecordMove = {
  from: string
  to: string
}

/**
 * Card ids hash the heading text together with the heading's index in the file
 * (see `cardId`), so an edit that renames a `##` heading — or inserts a card
 * above one — hands the same card a new id and orphans its review record.
 *
 * Pair the cards as they were before the edit against the cards as they are
 * now, and report the ids that need to follow their card:
 *
 * 1. Titles that still exist pair up in order. That covers an insertion or a
 *    deletion, which shifts heading indices without touching any title.
 * 2. Whatever is left over pairs only when exactly one card went unmatched on
 *    each side — that is a rename. Two or more unmatched cards on a side is
 *    ambiguous, and guessing there would attach history to the wrong card.
 */
export function reconcileCardIds(before: Flashcard[], after: Flashcard[]): RecordMove[] {
  const byTitle = new Map<string, Flashcard[]>()
  for (const card of after) {
    const bucket = byTitle.get(card.title)
    if (bucket) bucket.push(card)
    else byTitle.set(card.title, [card])
  }

  const moves: RecordMove[] = []
  const unmatchedBefore: Flashcard[] = []
  const matchedAfter = new Set<string>()

  for (const old of before) {
    const current = byTitle.get(old.title)?.shift()
    if (!current) {
      unmatchedBefore.push(old)
      continue
    }
    matchedAfter.add(current.id)
    if (current.id !== old.id) moves.push({ from: old.id, to: current.id })
  }

  const unmatchedAfter = after.filter((card) => !matchedAfter.has(card.id))
  const renamedFrom = unmatchedBefore[0]
  const renamedTo = unmatchedAfter[0]
  if (unmatchedBefore.length === 1 && unmatchedAfter.length === 1 && renamedFrom && renamedTo) {
    moves.push({ from: renamedFrom.id, to: renamedTo.id })
  }

  return moves
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
