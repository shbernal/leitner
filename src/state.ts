import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './atomic.js'
import type { ReviewRecord } from './types.js'

export type ReviewState = {
  version: 1
  records: Record<string, ReviewRecord>
}

export function defaultStatePath(): string {
  const dataHome = process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share')
  return path.join(dataHome, 'leitner', 'review-state.json')
}

export function emptyState(): ReviewState {
  return { version: 1, records: {} }
}

export async function loadState(statePath: string): Promise<ReviewState> {
  let raw: string
  try {
    raw = await fs.readFile(statePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
  const parsed = JSON.parse(raw) as Partial<ReviewState>
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.records !== 'object' ||
    // An array is an object too, and every later write would put string keys on it.
    Array.isArray(parsed.records)
  ) {
    throw new Error(`invalid review state file: ${statePath}`)
  }
  return { version: 1, records: parsed.records ?? {} }
}

export async function saveState(statePath: string, state: ReviewState): Promise<void> {
  await writeFileAtomic(statePath, JSON.stringify(state, null, 2) + '\n', { createDir: true })
}
