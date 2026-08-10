/**
 * Import/export of review state, so progress can move between machines
 * without copying the live state file around blind.
 */
import { emptyState, type ReviewState } from './state.js'
import type { ReviewRecord } from './types.js'

export const BUNDLE_VERSION = 1

export type ExportBundle = {
  version: number
  exportedAt: string
  recordCount: number
  records: ReviewRecord[]
}

export type MergeStrategy = 'newer' | 'theirs' | 'ours'

export const MERGE_STRATEGIES: MergeStrategy[] = ['newer', 'theirs', 'ours']

export function isMergeStrategy(value: string): value is MergeStrategy {
  return (MERGE_STRATEGIES as string[]).includes(value)
}

export function toBundle(state: ReviewState, exportedAt: Date = new Date()): ExportBundle {
  const records = Object.values(state.records).sort((a, b) => a.cardId.localeCompare(b.cardId))
  return {
    version: BUNDLE_VERSION,
    exportedAt: exportedAt.toISOString(),
    recordCount: records.length,
    records,
  }
}

function isRecord(value: unknown): value is ReviewRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Partial<ReviewRecord>
  return (
    typeof r.cardId === 'string' &&
    typeof r.dueAt === 'string' &&
    typeof r.intervalDays === 'number' &&
    typeof r.ease === 'number' &&
    typeof r.reps === 'number' &&
    typeof r.lapses === 'number'
  )
}

/** Parse and validate an export bundle, or a bare review-state file. */
export function parseBundle(raw: string): ReviewRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('expected a JSON object')
  }

  const candidate = parsed as { records?: unknown }
  // Accept both the export bundle (records as an array) and a raw state file
  // (records keyed by card id), so either can be handed to `import`.
  const values = Array.isArray(candidate.records)
    ? candidate.records
    : typeof candidate.records === 'object' && candidate.records !== null
      ? Object.values(candidate.records)
      : null

  if (values === null) {
    throw new Error('missing a `records` array or object')
  }

  const records: ReviewRecord[] = []
  for (const [i, value] of values.entries()) {
    if (!isRecord(value)) throw new Error(`record ${i} is missing required fields`)
    records.push(value)
  }
  return records
}

/** Most recent activity on a record; falls back to its due date. */
function freshness(record: ReviewRecord): number {
  const stamp = record.lastReviewedAt ?? record.dueAt
  const parsed = Date.parse(stamp)
  return Number.isNaN(parsed) ? 0 : parsed
}

export type MergeResult = {
  state: ReviewState
  added: number
  updated: number
  kept: number
}

/**
 * Merge incoming records into `ours`. `newer` keeps whichever side was
 * reviewed most recently, `theirs` always takes the incoming record, `ours`
 * only fills in cards we have never seen.
 */
export function mergeRecords(
  ours: ReviewState,
  incoming: ReviewRecord[],
  strategy: MergeStrategy = 'newer',
): MergeResult {
  const merged: ReviewState = { version: 1, records: { ...ours.records } }
  let added = 0
  let updated = 0
  let kept = 0

  for (const record of incoming) {
    const existing = merged.records[record.cardId]
    if (!existing) {
      merged.records[record.cardId] = record
      added += 1
      continue
    }
    const takeTheirs =
      strategy === 'theirs' || (strategy === 'newer' && freshness(record) > freshness(existing))
    if (takeTheirs) {
      merged.records[record.cardId] = record
      updated += 1
    } else {
      kept += 1
    }
  }

  return { state: merged, added, updated, kept }
}

/** Drop records whose cards no longer exist in the parsed source directory. */
export function pruneToCards(
  state: ReviewState,
  cardIds: Iterable<string>,
): { state: ReviewState; removed: number } {
  const live = new Set(cardIds)
  const pruned = emptyState()
  let removed = 0
  for (const [id, record] of Object.entries(state.records)) {
    if (live.has(id)) pruned.records[id] = record
    else removed += 1
  }
  return { state: pruned, removed }
}
