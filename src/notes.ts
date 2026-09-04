/**
 * Drive-by notes: a thought about a card's *content*, left for later.
 *
 * They are keyed by card reference (`src/refs.ts`), not by the sha1 id, and they
 * live in a sidecar at the root of each source directory rather than under
 * `XDG_DATA_HOME` — a note is about the deck and travels with it through git or
 * syncthing, where a review schedule deliberately does not. See `docs/notes.md`.
 *
 * The file is the one thing this program writes into the notes tree. It is a
 * dotfile it owns end to end: never markdown, never something the user authored.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export type Note = {
  text: string
  createdAt: string
  /**
   * The card's title and path as they were when the note was written, relative to
   * the root. Denormalized and never used for lookup: they are what keeps a note
   * readable and reattachable by hand once its reference stops resolving.
   */
  cardTitle: string
  sourcePath: string
}

export type NotesFile = {
  version: 1
  /** Reference to its notes, oldest first, in the order they were written. */
  notes: Record<string, Note[]>
}

/** Skipped by discovery twice over: not `*.md`, and not visible with `dot: false`. */
export const NOTES_FILENAME = '.leitner-notes.json'

export function notesPath(rootDir: string): string {
  return path.join(rootDir, NOTES_FILENAME)
}

export function emptyNotes(): NotesFile {
  return { version: 1, notes: {} }
}

export function notesFor(file: NotesFile, ref: string): Note[] {
  return file.notes[ref] ?? []
}

export function addNote(file: NotesFile, ref: string, note: Note): NotesFile {
  return { ...file, notes: { ...file.notes, [ref]: [...notesFor(file, ref), note] } }
}

/** Out of range removes nothing; the caller checks `notesFor` to say so. */
export function removeNote(file: NotesFile, ref: string, index: number): NotesFile {
  const kept = notesFor(file, ref).filter((_, at) => at !== index)
  const notes = { ...file.notes }
  // An empty list would keep the reference alive as a key nothing points at.
  if (kept.length === 0) delete notes[ref]
  else notes[ref] = kept
  return { ...file, notes }
}

export async function loadNotes(rootDir: string): Promise<NotesFile> {
  const file = notesPath(rootDir)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyNotes()
    throw error
  }
  const parsed = JSON.parse(raw) as Partial<NotesFile>
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.notes !== 'object') {
    throw new Error(`invalid notes file: ${file}`)
  }
  return { version: 1, notes: parsed.notes ?? {} }
}

/**
 * Every root, keyed by root. A reference is only unique inside one, which is the
 * same reason a card id is derived against a single root and not a common parent.
 */
export async function loadAllNotes(rootDirs: string[]): Promise<Map<string, NotesFile>> {
  const loaded = await Promise.all(rootDirs.map((rootDir) => loadNotes(rootDir)))
  return new Map(rootDirs.map((rootDir, index) => [rootDir, loaded[index] ?? emptyNotes()]))
}

/**
 * A write that cannot happen is reported with its path, never relocated. A
 * fallback under `XDG_DATA_HOME` on a read-only tree would be a second place to
 * lose notes, and nothing would say which one holds them.
 */
export async function saveNotes(rootDir: string, file: NotesFile): Promise<void> {
  const target = notesPath(rootDir)
  const tmpPath = `${target}.tmp`
  try {
    await fs.writeFile(tmpPath, JSON.stringify(file, null, 2) + '\n', 'utf8')
    await fs.rename(tmpPath, target)
  } catch (error) {
    // The failure is usually on the temp file, so name the one the user asked for.
    throw new Error(`cannot write ${target}: ${(error as Error).message}`)
  }
}
