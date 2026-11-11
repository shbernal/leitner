import { describe, expect, it } from 'vitest'
import { emptyState, type ReviewState } from '../src/state.js'
import { mergeRecords, parseBundle, pruneToCards, toBundle } from '../src/transfer.js'
import type { ReviewRecord } from '../src/types.js'

function record(cardId: string, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    cardId,
    sourcePath: `/notes/${cardId}.md`,
    sourceMtimeMs: 0,
    suspended: false,
    dueAt: '2026-08-01T00:00:00.000Z',
    intervalDays: 1,
    ease: 2.5,
    reps: 1,
    lapses: 0,
    ...overrides,
  }
}

function stateWith(...records: ReviewRecord[]): ReviewState {
  const state = emptyState()
  for (const r of records) state.records[r.cardId] = r
  return state
}

describe('toBundle', () => {
  it('serializes records sorted by card id with a count', () => {
    const bundle = toBundle(stateWith(record('b'), record('a')), new Date('2026-07-29T10:00:00Z'))
    expect(bundle.version).toBe(1)
    expect(bundle.exportedAt).toBe('2026-07-29T10:00:00.000Z')
    expect(bundle.recordCount).toBe(2)
    expect(bundle.records.map((r) => r.cardId)).toEqual(['a', 'b'])
  })
})

describe('parseBundle', () => {
  it('reads an export bundle', () => {
    const raw = JSON.stringify(toBundle(stateWith(record('a'))))
    expect(parseBundle(raw).map((r) => r.cardId)).toEqual(['a'])
  })

  it('also reads a raw review-state file', () => {
    const raw = JSON.stringify(stateWith(record('a'), record('b')))
    expect(
      parseBundle(raw)
        .map((r) => r.cardId)
        .sort(),
    ).toEqual(['a', 'b'])
  })

  it('rejects malformed input with a useful message', () => {
    expect(() => parseBundle('{')).toThrow(/not valid JSON/)
    expect(() => parseBundle('[]')).toThrow(/missing a `records`/)
    expect(() => parseBundle('{"records":[{"cardId":"a"}]}')).toThrow(
      /record 0 is missing required fields/,
    )
  })

  // A missing `suspended` would read as false: importing would unsuspend the card.
  it('refuses a record missing a field the scheduler does not do arithmetic on', () => {
    for (const field of ['suspended', 'sourcePath', 'sourceMtimeMs']) {
      const partial: Record<string, unknown> = { ...record('a') }
      delete partial[field]
      expect(() => parseBundle(JSON.stringify({ records: [partial] }))).toThrow('record 0')
    }
  })

  // `NaN <= now` is false, so the card would never come due and no queue would show it.
  it('refuses a dueAt that is not a date', () => {
    const raw = JSON.stringify({ records: [record('a'), record('b', { dueAt: 'soon' })] })
    expect(() => parseBundle(raw)).toThrow('record 1')
  })

  it('refuses a bundle from a newer format, and takes one with no version', () => {
    const newer = { ...toBundle(stateWith(record('a'))), version: 99 }
    expect(() => parseBundle(JSON.stringify(newer))).toThrow('99')
    expect(parseBundle(JSON.stringify({ records: [record('a')] }))).toHaveLength(1)
  })
})

describe('mergeRecords', () => {
  const ours = stateWith(
    record('shared', { lastReviewedAt: '2026-07-01T00:00:00.000Z', reps: 5 }),
    record('only-ours'),
  )

  it('adds records we have never seen', () => {
    const result = mergeRecords(ours, [record('brand-new')])
    expect(result.added).toBe(1)
    expect(result.state.records['brand-new']).toBeDefined()
    expect(result.state.records['only-ours']).toBeDefined()
  })

  it('newer keeps whichever side was reviewed most recently', () => {
    const newer = mergeRecords(ours, [
      record('shared', { lastReviewedAt: '2026-07-20T00:00:00.000Z', reps: 9 }),
    ])
    expect(newer.updated).toBe(1)
    expect(newer.state.records['shared']?.reps).toBe(9)

    const older = mergeRecords(ours, [
      record('shared', { lastReviewedAt: '2026-06-01T00:00:00.000Z', reps: 9 }),
    ])
    expect(older.kept).toBe(1)
    expect(older.state.records['shared']?.reps).toBe(5)
  })

  it('theirs always wins, ours never overwrites', () => {
    const incoming = [record('shared', { lastReviewedAt: '2026-01-01T00:00:00.000Z', reps: 9 })]
    expect(mergeRecords(ours, incoming, 'theirs').state.records['shared']?.reps).toBe(9)
    expect(mergeRecords(ours, incoming, 'ours').state.records['shared']?.reps).toBe(5)
  })

  it('does not mutate the original state', () => {
    mergeRecords(
      ours,
      [record('shared', { reps: 99, lastReviewedAt: '2027-01-01T00:00:00.000Z' })],
      'theirs',
    )
    expect(ours.records['shared']?.reps).toBe(5)
  })

  it('falls back to dueAt when a record was never reviewed', () => {
    const noStamp = stateWith(record('x', { dueAt: '2026-01-01T00:00:00.000Z' }))
    const result = mergeRecords(noStamp, [
      record('x', { dueAt: '2026-09-01T00:00:00.000Z', reps: 7 }),
    ])
    expect(result.state.records['x']?.reps).toBe(7)
  })
})

describe('pruneToCards', () => {
  it('drops records whose cards are gone', () => {
    const result = pruneToCards(stateWith(record('keep'), record('drop')), ['keep'])
    expect(result.removed).toBe(1)
    expect(Object.keys(result.state.records)).toEqual(['keep'])
  })
})
