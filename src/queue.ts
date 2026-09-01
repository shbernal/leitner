import type { ReviewState } from './state.js'
import { isDue } from './scheduler.js'
import type { Flashcard } from './types.js'

export type QueueOptions = {
  dueOnly?: boolean
  newOnly?: boolean
  limit?: number
}

export type QueueItem = {
  card: Flashcard
  isNew: boolean
}

/**
 * Due cards (oldest due first), then new cards in deck order.
 * Records for cards that no longer exist are ignored but left in state.
 */
export function buildQueue(
  cards: Flashcard[],
  state: ReviewState,
  options: QueueOptions = {},
  now: Date = new Date(),
): QueueItem[] {
  const due: QueueItem[] = []
  const fresh: QueueItem[] = []

  for (const card of cards) {
    const record = state.records[card.id]
    if (!record) {
      fresh.push({ card, isNew: true })
    } else if (isDue(record, now)) {
      due.push({ card, isNew: false })
    }
  }

  due.sort((a, b) => {
    const aDue = state.records[a.card.id]?.dueAt ?? ''
    const bDue = state.records[b.card.id]?.dueAt ?? ''
    return aDue.localeCompare(bDue)
  })

  let queue: QueueItem[]
  if (options.dueOnly) queue = due
  else if (options.newOnly) queue = fresh
  else queue = [...due, ...fresh]

  if (options.limit !== undefined && options.limit >= 0) {
    queue = queue.slice(0, options.limit)
  }
  return queue
}

export type DeckSummary = {
  total: number
  due: number
  fresh: number
  suspended: number
}

/**
 * Per-deck counts for the deck picker and `stats`, keyed by source path. Two
 * source directories can hold the same relative path and so produce the same
 * deck slug; keying on the slug would merge those two files into one row
 * carrying both their counts.
 */
export function summarizeDecks(
  cards: Flashcard[],
  state: ReviewState,
  now: Date = new Date(),
): Map<string, DeckSummary> {
  const summaries = new Map<string, DeckSummary>()
  for (const card of cards) {
    let summary = summaries.get(card.sourcePath)
    if (!summary) {
      summary = { total: 0, due: 0, fresh: 0, suspended: 0 }
      summaries.set(card.sourcePath, summary)
    }
    summary.total += 1

    const record = state.records[card.id]
    if (!record) summary.fresh += 1
    else if (record.suspended) summary.suspended += 1
    else if (isDue(record, now)) summary.due += 1
  }
  return summaries
}

/**
 * Every card in the deck, in deck order, suspended ones aside.
 *
 * A practice pass is a read-through, not scheduled work, so no due date narrows
 * it and neither `--limit` nor `dailyLimit` truncates it: those cap how much the
 * scheduler asks of you, and this asks nothing. Deck order rather than due order
 * because the file's order is the order the notes were written in, and "card
 * 12/40" only means something when the pass is stable.
 */
export function buildPracticeQueue(cards: Flashcard[], state: ReviewState): QueueItem[] {
  return cards
    .filter((card) => state.records[card.id]?.suspended !== true)
    .map((card) => ({ card, isNew: state.records[card.id] === undefined }))
}
