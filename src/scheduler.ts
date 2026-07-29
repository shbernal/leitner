import type { Flashcard, Grade, ReviewRecord } from './types.js'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const MIN_EASE = 1.3
const DEFAULT_EASE = 2.5
const AGAIN_DELAY_MS = 10 * MINUTE_MS

export function newRecord(card: Flashcard, now: Date = new Date()): ReviewRecord {
  return {
    cardId: card.id,
    sourcePath: card.sourcePath,
    sourceMtimeMs: card.sourceMtimeMs,
    suspended: false,
    dueAt: now.toISOString(),
    intervalDays: 0,
    ease: DEFAULT_EASE,
    reps: 0,
    lapses: 0,
  }
}

export function applyGrade(record: ReviewRecord, grade: Grade, now: Date = new Date()): ReviewRecord {
  const next: ReviewRecord = { ...record }
  next.reps = record.reps + 1
  next.lastReviewedAt = now.toISOString()

  switch (grade) {
    case 'again':
      next.ease = Math.max(MIN_EASE, record.ease - 0.2)
      next.intervalDays = 0
      next.lapses = record.lapses + (record.reps > 0 ? 1 : 0)
      next.dueAt = new Date(now.getTime() + AGAIN_DELAY_MS).toISOString()
      return next
    case 'hard':
      next.ease = Math.max(MIN_EASE, record.ease - 0.15)
      next.intervalDays = record.intervalDays < 1 ? 1 : Math.round(record.intervalDays * 1.2)
      break
    case 'good':
      next.intervalDays = record.intervalDays < 1 ? 1 : Math.round(record.intervalDays * record.ease)
      break
    case 'easy':
      next.ease = record.ease + 0.15
      next.intervalDays =
        record.intervalDays < 1 ? 3 : Math.round(record.intervalDays * record.ease * 1.3)
      break
  }

  next.intervalDays = Math.max(1, next.intervalDays)
  next.dueAt = new Date(now.getTime() + next.intervalDays * DAY_MS).toISOString()
  return next
}

export function isDue(record: ReviewRecord, now: Date = new Date()): boolean {
  return !record.suspended && new Date(record.dueAt).getTime() <= now.getTime()
}
