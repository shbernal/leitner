import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyState, loadState, saveState } from '../src/state.js'
import type { ReviewRecord } from '../src/types.js'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leitner-test-'))
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

  /* A review session persists on every keypress without awaiting, so writes do
     overlap. A shared temp name let one rename find its temp file already gone. */
  it('survives overlapping saves, keeping the last and leaving no temp file', async () => {
    const statePath = path.join(dir, 'review-state.json')
    const big = emptyState()
    for (let i = 0; i < 20_000; i++) big.records['k' + i] = { ...record, cardId: 'k' + i }
    const small = emptyState()
    small.records['abc'] = record

    await Promise.all([
      saveState(statePath, big),
      saveState(statePath, big),
      saveState(statePath, small),
    ])

    expect(await loadState(statePath)).toEqual(small)
    expect(await fs.readdir(dir)).toEqual(['review-state.json'])
  })

  it('leaves no temp file behind when the write fails', async () => {
    // A directory where the file should be makes the rename fail after the temp is written.
    const statePath = path.join(dir, 'review-state.json')
    await fs.mkdir(statePath)

    await expect(saveState(statePath, emptyState())).rejects.toThrow('EISDIR')
    expect(await fs.readdir(dir)).toEqual(['review-state.json'])
  })

  it('rejects a state file whose records are an array', async () => {
    const statePath = path.join(dir, 'review-state.json')
    await fs.writeFile(statePath, '{"version":1,"records":[]}')
    await expect(loadState(statePath)).rejects.toThrow('invalid review state')
  })

  it('rejects corrupt state files instead of silently clobbering them', async () => {
    const statePath = path.join(dir, 'review-state.json')
    await fs.writeFile(statePath, '"not an object"')
    await expect(loadState(statePath)).rejects.toThrow('invalid review state')
  })
})
