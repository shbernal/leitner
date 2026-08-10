import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyState, type ReviewState } from '../src/state.js'
import { ReviewApp } from '../src/tui/review.js'
import type { Flashcard } from '../src/types.js'
import { KEY, renderTui, type TuiHarness } from './helpers/tui.js'

function makeCard(id: string, title: string, body: string): Flashcard {
  return {
    id,
    deckId: 'algebra',
    deckTitle: 'Algebra',
    sourcePath: '/notes/algebra.md',
    sourceMtimeMs: 0,
    type: 'content',
    title,
    bodyMarkdown: body,
    plainText: body,
    images: [],
    tags: [],
  }
}

const cards = [
  makeCard('a', 'What is a group?', 'A set with an associative operation.'),
  makeCard('b', 'What is a ring?', 'A group with a second operation.'),
]

let dir: string
let statePath: string
let state: ReviewState
let ui: TuiHarness | undefined

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flashcards-tui-review-'))
  statePath = path.join(dir, 'state.json')
  state = emptyState()
})

afterEach(async () => {
  ui?.unmount()
  ui = undefined
  await fs.rm(dir, { recursive: true, force: true })
})

async function open(size?: { columns?: number; rows?: number }) {
  ui = await renderTui(
    <ReviewApp
      cards={cards}
      decks={[]}
      state={state}
      statePath={statePath}
      queueOptions={{}}
      deckFilter="algebra"
      images={{ enabled: false, tmux: false, reason: 'not a kitty terminal' }}
      displayablePngs={new Set()}
    />,
    size,
  )
  return ui
}

describe('ReviewApp', () => {
  it('opens on the first card with the answer hidden', async () => {
    const ui = await open()
    const frame = ui.frame()
    expect(frame).toContain('Algebra')
    expect(frame).toContain('card 1/2')
    expect(frame).toContain('2 new')
    expect(frame).toContain('What is a group?')
    expect(frame).toContain('[press space or enter to reveal]')
    expect(frame).not.toContain('associative')
  })

  it('reveals the body on space and offers the grade keys', async () => {
    const ui = await open()
    await ui.press(KEY.space)
    const frame = ui.frame()
    expect(frame).toContain('A set with an associative operation.')
    expect(frame).toContain('grade: 1 again · 2 hard · 3 good · 4 easy')
  })

  it('ignores grade keys until the card is revealed', async () => {
    const ui = await open()
    await ui.press('3')
    expect(ui.frame()).toContain('card 1/2')
    expect(state.records['a']).toBeUndefined()
  })

  it('grades the revealed card, records it and advances', async () => {
    const ui = await open()
    await ui.press(KEY.space)
    await ui.press('3')

    const frame = ui.frame()
    expect(frame).toContain('card 2/2')
    expect(frame).toContain('graded "What is a group?": good')
    expect(frame).toContain('[press space or enter to reveal]')

    const record = state.records['a']
    expect(record).toBeDefined()
    expect(record?.reps).toBe(1)
    expect(record?.ease).toBe(2.5)
  })

  it('persists graded cards to the state file', async () => {
    const ui = await open()
    await ui.press(KEY.space)
    await ui.press('3')
    await ui.press(KEY.space)
    await ui.press('2')

    const written = JSON.parse(await fs.readFile(statePath, 'utf8')) as ReviewState
    expect(Object.keys(written.records).sort()).toEqual(['a', 'b'])
    expect(written.records['a']?.ease).toBe(2.5)
    expect(written.records['b']?.ease).toBe(2.35)
  })

  it('ends the session after the last card', async () => {
    const ui = await open()
    for (let i = 0; i < cards.length; i++) {
      await ui.press(KEY.space)
      await ui.press('3')
    }
    expect(ui.frame()).toContain('Session complete — 2 cards reviewed.')
  })

  it('undoes the last grade and restores the card', async () => {
    const ui = await open()
    await ui.press(KEY.space)
    await ui.press('3')
    expect(state.records['a']).toBeDefined()

    await ui.press('u')
    const frame = ui.frame()
    expect(frame).toContain('undid good')
    expect(frame).toContain('card 1/2')
  })

  it('reports when there is nothing to undo', async () => {
    const ui = await open()
    await ui.press('u')
    expect(ui.frame()).toContain('nothing to undo')
  })

  it('suspends a card without needing a reveal', async () => {
    const ui = await open()
    await ui.press('s')
    expect(ui.frame()).toContain('suspended "What is a group?"')
    expect(state.records['a']?.suspended).toBe(true)
  })

  it('narrows the queue to search matches', async () => {
    const ui = await open()
    await ui.press('/')
    await ui.type('ring')
    expect(ui.frame()).toContain('/ring')

    await ui.press(KEY.enter)
    const frame = ui.frame()
    expect(frame).toContain('1 card matching "ring" · esc to clear')
    expect(frame).toContain('What is a ring?')
    expect(frame).toContain('card 1/1')
  })

  it('abandons an unconfirmed search on escape', async () => {
    const ui = await open()
    await ui.press('/')
    await ui.type('ring')
    await ui.press(KEY.escape)

    const frame = ui.frame()
    expect(frame).toContain('search cleared')
    expect(frame).toContain('card 1/2')
    expect(frame).toContain('What is a group?')
  })

  it('edits the search with backspace instead of quitting', async () => {
    const ui = await open()
    await ui.press('/')
    await ui.type('ringx')
    await ui.press(KEY.backspace)
    expect(ui.frame()).toContain('/ring')

    await ui.press(KEY.enter)
    expect(ui.frame()).toContain('1 card matching "ring"')
  })

  it('reports a search that matches nothing without changing the queue', async () => {
    const ui = await open()
    await ui.press('/')
    await ui.type('zzz')
    await ui.press(KEY.enter)

    const frame = ui.frame()
    expect(frame).toContain('no cards match "zzz"')
    expect(frame).toContain('card 1/2')
  })

  it('explains why the image preview is unavailable', async () => {
    const ui = await open()
    await ui.press('i')
    expect(ui.frame()).toContain('image previews unavailable: not a kitty terminal')
  })
})
