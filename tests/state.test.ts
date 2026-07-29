import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyState, loadState, saveState } from '../src/state.js'
import type { ReviewRecord } from '../src/types.js'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flashcard-tui-test-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const record: ReviewRecord = {
  cardId: 'abc',
  sourcePath: '/tmp/deck.md',
  sourceMtimeMs: 123,
  suspended: false,
  dueAt: '2026-06-11T12:00:00.000Z',
  intervalDays: 1,
  ease: 2.5,
  reps: 1,
  lapses: 0,
}

describe('state store', () => {
  it('returns empty state when the file does not exist', async () => {
    const state = await loadState(path.join(dir, 'missing.json'))
    expect(state.records).toEqual({})
  })

  it('round-trips state across save/load, creating parent directories', async () => {
    const statePath = path.join(dir, 'nested', 'review-state.json')
    const state = emptyState()
    state.records['abc'] = record
    await saveState(statePath, state)

    const loaded = await loadState(statePath)
    expect(loaded).toEqual(state)
  })

  it('rejects corrupt state files instead of silently clobbering them', async () => {
    const statePath = path.join(dir, 'review-state.json')
    await fs.writeFile(statePath, '"not an object"')
    await expect(loadState(statePath)).rejects.toThrow('invalid review state')
  })
})
