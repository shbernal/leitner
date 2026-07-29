import { describe, expect, it } from 'vitest'
import { applyGrade, isDue, newRecord } from '../src/scheduler.js'
import type { Flashcard, ReviewRecord } from '../src/types.js'

const now = new Date('2026-06-11T12:00:00.000Z')

const card: Flashcard = {
  id: 'card-1',
  deckId: 'deck',
  deckTitle: 'Deck',
  sourcePath: '/tmp/deck.md',
  sourceMtimeMs: 0,
  type: 'content',
  title: 'Card',
  bodyMarkdown: '- fact',
  plainText: 'fact',
  images: [],
  tags: [],
}

function daysFromNow(record: ReviewRecord): number {
  return (new Date(record.dueAt).getTime() - now.getTime()) / 86_400_000
}

describe('applyGrade', () => {
  it('again: resets interval, due in 10 minutes, counts a lapse only after first rep', () => {
    const first = applyGrade(newRecord(card, now), 'again', now)
    expect(first.intervalDays).toBe(0)
    expect(first.lapses).toBe(0)
    expect(new Date(first.dueAt).getTime() - now.getTime()).toBe(10 * 60_000)

    const second = applyGrade(first, 'again', now)
    expect(second.lapses).toBe(1)
  })

  it('hard: first review due tomorrow, then grows slowly with reduced ease', () => {
    const first = applyGrade(newRecord(card, now), 'hard', now)
    expect(first.intervalDays).toBe(1)
    expect(first.ease).toBeCloseTo(2.35)

    const later = applyGrade({ ...first, intervalDays: 10 }, 'hard', now)
    expect(later.intervalDays).toBe(12)
  })

  it('good: 1 day for new cards, interval * ease afterwards', () => {
    const first = applyGrade(newRecord(card, now), 'good', now)
    expect(first.intervalDays).toBe(1)
    expect(daysFromNow(first)).toBe(1)

    const second = applyGrade(first, 'good', now)
    expect(second.intervalDays).toBe(3) // round(1 * 2.5)

    const third = applyGrade(second, 'good', now)
    expect(third.intervalDays).toBe(8) // round(3 * 2.5)
  })

  it('easy: larger growth and ease increase', () => {
    const first = applyGrade(newRecord(card, now), 'easy', now)
    expect(first.intervalDays).toBe(3)
    expect(first.ease).toBeCloseTo(2.65)

    const second = applyGrade(first, 'easy', now)
    expect(second.intervalDays).toBe(Math.round(3 * 2.65 * 1.3))
  })

  it('ease never drops below 1.3', () => {
    let record = newRecord(card, now)
    for (let i = 0; i < 20; i++) record = applyGrade(record, 'again', now)
    expect(record.ease).toBe(1.3)
  })

  it('is deterministic and does not mutate its input', () => {
    const record = newRecord(card, now)
    const a = applyGrade(record, 'good', now)
    const b = applyGrade(record, 'good', now)
    expect(a).toEqual(b)
    expect(record.reps).toBe(0)
  })
})

describe('isDue', () => {
  it('is true for past due dates and false when suspended', () => {
    const record = newRecord(card, now)
    expect(isDue(record, now)).toBe(true)
    expect(isDue({ ...record, suspended: true }, now)).toBe(false)
    expect(isDue(applyGrade(record, 'good', now), now)).toBe(false)
  })
})
