import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addNote,
  emptyNotes,
  loadAllNotes,
  loadNotes,
  type Note,
  notesFor,
  notesPath,
  removeNote,
  saveNotes,
} from '../src/notes.js'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leitner-notes-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function note(text: string, createdAt = '2026-09-04T18:22:11.031Z'): Note {
  return { text, createdAt, cardTitle: 'Ser vs estar', sourcePath: 'spanish/verbs.md' }
}

const ref = 'spanish-verbs#ser-vs-estar'

describe('the notes file', () => {
  it('sits at the root of the source directory, as a dotfile discovery skips', () => {
    expect(notesPath(dir)).toBe(path.join(dir, '.leitner-notes.json'))
    expect(path.basename(notesPath(dir)).startsWith('.')).toBe(true)
  })

  it('loads empty when there is none, rather than throwing', async () => {
    expect(await loadNotes(dir)).toEqual(emptyNotes())
  })

  it('round-trips, keeping each reference its notes in the order written', async () => {
    let file = addNote(emptyNotes(), ref, note('first'))
    file = addNote(file, ref, note('second'))
    file = addNote(file, 'algebra#groups', note('elsewhere'))
    await saveNotes(dir, file)

    const loaded = await loadNotes(dir)
    expect(loaded).toEqual(file)
    expect(notesFor(loaded, ref).map((n) => n.text)).toEqual(['first', 'second'])
  })

  it('refuses a file that is not the shape it claims, naming the path', async () => {
    await fs.writeFile(notesPath(dir), '"not an object"')
    await expect(loadNotes(dir)).rejects.toThrow('invalid notes file')
    await expect(loadNotes(dir)).rejects.toThrow(notesPath(dir))
  })

  /* No fallback under XDG_DATA_HOME: a second location that diverges from this one
     is a second place to lose notes. The path the user asked for is what is named. */
  it('reports a write it cannot make, with the path, rather than relocating it', async () => {
    const readOnly = path.join(dir, 'locked')
    await fs.mkdir(readOnly)
    await fs.chmod(readOnly, 0o500)

    await expect(saveNotes(readOnly, addNote(emptyNotes(), ref, note('nope')))).rejects.toThrow(
      notesPath(readOnly),
    )

    await fs.chmod(readOnly, 0o700)
  })

  it('keys a multi-root load by root, so a reference is looked up in its own file', async () => {
    const other = path.join(dir, 'work')
    await fs.mkdir(other)
    await saveNotes(dir, addNote(emptyNotes(), ref, note('mine')))
    await saveNotes(other, addNote(emptyNotes(), ref, note('theirs')))

    const all = await loadAllNotes([dir, other])
    expect(notesFor(all.get(dir) ?? emptyNotes(), ref).map((n) => n.text)).toEqual(['mine'])
    expect(notesFor(all.get(other) ?? emptyNotes(), ref).map((n) => n.text)).toEqual(['theirs'])
  })

  it('loads a root with no sidecar as empty in a multi-root collection', async () => {
    const other = path.join(dir, 'work')
    await fs.mkdir(other)
    await saveNotes(dir, addNote(emptyNotes(), ref, note('mine')))

    const all = await loadAllNotes([dir, other])
    expect(all.get(other)).toEqual(emptyNotes())
  })
})

describe('editing notes', () => {
  it('appends to the list a reference already has, leaving the original alone', () => {
    const one = addNote(emptyNotes(), ref, note('first'))
    const two = addNote(one, ref, note('second'))
    expect(notesFor(two, ref)).toHaveLength(2)
    expect(notesFor(one, ref)).toHaveLength(1)
  })

  it('removes by position, keeping the rest in order', () => {
    let file = addNote(emptyNotes(), ref, note('first'))
    file = addNote(file, ref, note('second'))
    file = addNote(file, ref, note('third'))
    expect(notesFor(removeNote(file, ref, 1), ref).map((n) => n.text)).toEqual(['first', 'third'])
  })

  // An empty list is a key nothing points at, and it accumulates.
  it('drops the reference entirely when its last note goes', () => {
    const file = addNote(emptyNotes(), ref, note('only'))
    expect(removeNote(file, ref, 0)).toEqual(emptyNotes())
  })

  it('removes nothing for a position or a reference that is not there', () => {
    const file = addNote(emptyNotes(), ref, note('only'))
    expect(removeNote(file, ref, 3)).toEqual(file)
    expect(removeNote(file, 'algebra#groups', 0)).toEqual(file)
  })
})
