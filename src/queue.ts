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
