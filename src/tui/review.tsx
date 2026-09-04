import path from 'node:path'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout, useWindowSize } from 'ink'
import { defaultConfigPath, writeHiddenDecks } from '../config.js'
import { applyRecordMoves, reconcileCardIds } from '../edit.js'
import { resolveEditor, runEditor, type EditorRunner } from '../editor.js'
import { buildKittyClearSequence, buildKittyImageSequence, type ImageSupport } from '../images.js'
import { addNote, type Note, type NotesFile, notesFor, saveNotes } from '../notes.js'
import { parseFile } from '../parser.js'
import {
  buildPracticeQueue,
  buildQueue,
  summarizeDecks,
  type QueueItem,
  type QueueOptions,
} from '../queue.js'
import { renderMarkdown, type RenderedLine } from '../render.js'
import { applyGrade, newRecord } from '../scheduler.js'
import { saveState, type ReviewState } from '../state.js'
import type { Deck, Flashcard, Grade, ReviewRecord, SessionMode } from '../types.js'
import { MarkdownLine } from './components.js'
import { DeckPicker } from './DeckPicker.js'

export type ReviewSessionOptions = {
  cards: Flashcard[]
  decks: Deck[]
  state: ReviewState
  statePath: string
  queueOptions: QueueOptions
  /** When set, the deck picker is skipped. */
  deckFilter?: string | undefined
  /** The config's `hiddenDecks`; the picker keeps them out of its list until `.`. */
  hiddenDecks?: string[]
  /**
   * Where `H` writes the changed list. Overridable so the tests drive the key
   * without a config file, the way `openEditor` stands in for `$EDITOR`.
   */
  persistHiddenDecks?: (hiddenDecks: string[]) => Promise<void>
  images: ImageSupport
  /** Absolute paths verified as displayable PNGs. */
  displayablePngs: Set<string>
  /** The config's `editor`; unset falls through to $VISUAL/$EDITOR/vi. */
  editor?: string | null
  /** Overridable so tests can drive the edit flow without spawning $EDITOR. */
  openEditor?: EditorRunner
  /** The collection's drive-by notes, keyed by source root, as `loadAllNotes` gives them. */
  notes?: Map<string, NotesFile>
  /** Where `n` writes them; overridable for the same reason `persistHiddenDecks` is. */
  persistNotes?: (rootDir: string, file: NotesFile) => Promise<void>
}

type UndoEntry = {
  cardId: string
  previousRecord: ReviewRecord | undefined
  action: string
}

const GRADE_KEYS: Record<string, Grade> = {
  '1': 'again',
  '2': 'hard',
  '3': 'good',
  '4': 'easy',
}

const EMPTY_NOTES: NotesFile = { version: 1, notes: {} }

/** How many of a card's notes the composer shows above the input line. */
const NOTE_PREVIEW = 3

/** Chrome around the card box: header, borders, hints, message. */
const CHROME_ROWS = 7

/** Stands in for the card's `***`, matching how render.ts draws a thematic break. */
function separatorLine(width: number): RenderedLine {
  return { spans: [{ text: '─'.repeat(Math.max(1, Math.min(width, 40))), dim: true }] }
}

function attachmentLines(item: QueueItem, displayablePngs: Set<string>): RenderedLine[] {
  if (item.card.images.length === 0) return []
  const lines: RenderedLine[] = [{ spans: [] }]
  for (const image of item.card.images) {
    const previewable = displayablePngs.has(image.path)
    lines.push({
      spans: [
        { text: '📎 ', color: previewable ? 'green' : 'yellow' },
        { text: image.alt || 'image', italic: true },
        { text: ' → ' + image.path, dim: true },
      ],
    })
  }
  return lines
}

/** With --deck the picker is skipped, so that deck's scope exists from mount. */
function initialScope(options: ReviewSessionOptions): string[] {
  const { deckFilter, cards } = options
  if (deckFilter === undefined) return []
  const paths = cards
    .filter((card) => card.deckId === deckFilter || card.sourcePath.includes(deckFilter))
    .map((card) => card.sourcePath)
  return [...new Set(paths)]
}

function initialQueue(options: ReviewSessionOptions): QueueItem[] {
  const scope = new Set(initialScope(options))
  if (scope.size === 0) return []
  const scoped = options.cards.filter((card) => scope.has(card.sourcePath))
  return buildQueue(scoped, options.state, options.queueOptions)
}

/* An empty queue is the one place a deck says why it is empty. In review mode
   that reason is the schedule, and the way past it is a practice pass. */
function emptyQueueMessage(length: number, mode: SessionMode): string {
  if (length > 0) return 'space/enter: reveal'
  if (mode === 'practice') return 'every card in that deck is suspended'
  return 'nothing due in that deck · p: practise the whole deck'
}

function matches(item: QueueItem, needle: string): boolean {
  const q = needle.toLowerCase()
  return item.card.title.toLowerCase().includes(q) || item.card.plainText.toLowerCase().includes(q)
}

export function ReviewApp(options: ReviewSessionOptions): React.ReactElement {
  const { cards, decks, state, statePath, queueOptions, images, displayablePngs } = options
  const editorCommand = resolveEditor(options.editor)
  const openEditor =
    options.openEditor ?? ((file: string, line: number) => runEditor(file, line, editorCommand))
  /* `defaultConfigPath` rather than an injected path, because `parseCli` reads the
     config the same way: the lever on both is XDG_CONFIG_HOME. */
  const persistHiddenDecks =
    options.persistHiddenDecks ?? ((next: string[]) => writeHiddenDecks(defaultConfigPath(), next))
  const persistNotes = options.persistNotes ?? saveNotes
  const { exit, waitUntilRenderFlush, suspendTerminal } = useApp()
  const { stdout } = useStdout()

  /* --deck scopes the whole invocation, so a session started under it never had a
     picker and does not get sent to one when the deck runs out. */
  const canPick = options.deckFilter === undefined
  // With --deck the picker is skipped entirely, so the session starts picked.
  const [picked, setPicked] = useState(!canPick)
  // Editing rewrites the source file, so the card pool outlives the prop.
  const [allCards, setAllCards] = useState<Flashcard[]>(cards)
  // `H` edits this, so the picker's list outlives the prop as well.
  const [hiddenDecks, setHiddenDecks] = useState<string[]>(options.hiddenDecks ?? [])
  const [queue, setQueue] = useState<QueueItem[]>(() => initialQueue(options))
  const [fullQueue, setFullQueue] = useState<QueueItem[]>(() => initialQueue(options))
  const [mode, setMode] = useState<SessionMode>('review')
  /* The source paths behind the current queue, kept so the completion screen can
     reopen the same decks as a practice pass without going back to the picker —
     which under --deck is not there to go back to. */
  const [scopePaths, setScopePaths] = useState<string[]>(() => initialScope(options))
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [scroll, setScroll] = useState(0)
  /* Under --deck there is no picker to explain an empty queue, so the mount-time
     message is the only place that says why the first screen is the last one. */
  const [message, setMessage] = useState(() => emptyQueueMessage(queue.length, 'review'))
  const [graded, setGraded] = useState(0)
  const [practised, setPractised] = useState(0)
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  const [done, setDone] = useState(false)
  const [searching, setSearching] = useState(false)
  const [search, setSearch] = useState('')
  const [imageMode, setImageMode] = useState(false)
  const [editing, setEditing] = useState(false)
  const [noting, setNoting] = useState(false)
  const [draft, setDraft] = useState('')
  const [notes, setNotes] = useState<Map<string, NotesFile>>(
    () => new Map(options.notes ?? new Map()),
  )

  // Re-renders on SIGWINCH, so the viewport follows the terminal as it resizes.
  const { rows, columns } = useWindowSize()
  /* The composer replaces the one-line hint with a block of its own, so the card
     box gives those rows back rather than pushing its own top off the screen. */
  const viewportHeight = Math.max(5, rows - CHROME_ROWS - (noting ? NOTE_PREVIEW + 2 : 0))
  const bodyWidth = Math.max(20, columns - 4)

  const selectDeck = (sourcePaths: string[], nextMode: SessionMode = 'review') => {
    const scope = new Set(sourcePaths)
    const scoped = allCards.filter((card) => scope.has(card.sourcePath))
    const built =
      nextMode === 'practice'
        ? buildPracticeQueue(scoped, state)
        : buildQueue(scoped, state, queueOptions)
    setPicked(true)
    setMode(nextMode)
    setScopePaths(sourcePaths)
    setQueue(built)
    setFullQueue(built)
    setIndex(0)
    setRevealed(false)
    setScroll(0)
    setDone(built.length === 0)
    // Undo rewrites a record for a card that is not in this deck and would not
    // come back on screen, so the stack does not cross a deck boundary.
    setUndoStack([])
    setSearching(false)
    setSearch('')
    setMessage(emptyQueueMessage(built.length, nextMode))
  }

  /** Back to the menu with the session still running, so another deck can follow. */
  const backToPicker = () => {
    setPicked(false)
    setQueue([])
    setFullQueue([])
    setIndex(0)
    setRevealed(false)
    setScroll(0)
    setDone(false)
    setSearching(false)
    setSearch('')
    setUndoStack([])
    setMode('review')
    setScopePaths([])
    setMessage('space/enter: reveal')
  }

  const item = queue[index]

  const frontLines = useMemo(
    () => (item ? renderMarkdown(item.card.frontBody, bodyWidth) : []),
    [item, bodyWidth],
  )

  const backLines = useMemo(() => {
    if (!item) return []
    const back = item.card.back.trim() === '' ? '_(no body)_' : item.card.back
    return [...renderMarkdown(back, bodyWidth), ...attachmentLines(item, displayablePngs)]
  }, [item, bodyWidth, displayablePngs])

  /* The front is the `##` heading plus everything above the `***`, so a card may ask
     its question in more than a heading. Unrevealed, only that half is on screen;
     revealed, the two scroll as one list with a rule where the separator was. */
  const lines = useMemo(() => {
    if (!revealed) return frontLines
    if (frontLines.length === 0) return backLines
    return [...frontLines, { spans: [] }, separatorLine(bodyWidth), { spans: [] }, ...backLines]
  }, [revealed, frontLines, backLines, bodyWidth])

  const maxScroll = Math.max(0, lines.length - viewportHeight)

  const cardNotes = item ? notesFor(notes.get(item.card.rootDir) ?? EMPTY_NOTES, item.card.ref) : []

  /* A note is the user's own writing about the deck's content, so it is governed
     by the rule about markdown — which it is not — and not by the one about
     scheduling. That is why this is reachable in a practice pass, where `s` and
     the grade keys are not: a read-through is when a remark most often occurs. */
  const commitNote = async (target: QueueItem, text: string) => {
    const { rootDir, ref } = target.card
    const file = notes.get(rootDir) ?? EMPTY_NOTES
    const note: Note = {
      text,
      createdAt: new Date().toISOString(),
      // The card as it is now, so the note survives its reference being broken.
      cardTitle: target.card.title,
      sourcePath: path.relative(rootDir, target.card.sourcePath),
    }
    const next = addNote(file, ref, note)
    /* Kept in the session either way. An unwritable tree costs the note when the
       session ends, not the moment it is typed. */
    setNotes((current) => new Map(current).set(rootDir, next))
    try {
      await persistNotes(rootDir, next)
      setMessage(`noted on ${ref}`)
    } catch (error) {
      setMessage(`note kept for this session only: ${String(error)}`)
    }
  }
  const previewable = useMemo(
    () => (item ? item.card.images.filter((image) => displayablePngs.has(image.path)) : []),
    [item, displayablePngs],
  )

  // The graphics escape has to land after the (deliberately bare) image frame
  // has reached the terminal, or the redraw paints over the pixels. Committing
  // the frame is not enough — waitUntilRenderFlush() waits for the write itself.
  useEffect(() => {
    if (!imageMode || !stdout) return
    const first = previewable[0]
    if (!first) return

    let cancelled = false
    void (async () => {
      await waitUntilRenderFlush()
      if (cancelled) return
      stdout.write(buildKittyClearSequence(images.tmux))
      stdout.write(
        buildKittyImageSequence(first.path, {
          cols: Math.max(10, columns - 4),
          rows: Math.max(5, rows - 4),
          tmux: images.tmux,
        }),
      )
    })()

    return () => {
      cancelled = true
      stdout.write(buildKittyClearSequence(images.tmux))
    }
  }, [imageMode, previewable, stdout, images.tmux, columns, rows, waitUntilRenderFlush])

  /* Whether this session has written the state file. Every mutation persists as
     it happens, so the save after teardown is only a flush for the last one, and
     a session that changed nothing must not touch the file at all — which is
     what makes a practice pass inert rather than merely harmless. */
  const touched = useRef(false)

  const persist = (action: string) => {
    touched.current = true
    void saveState(statePath, state).catch((error: unknown) => {
      setMessage(`${action} (warning: failed to save state: ${String(error)})`)
    })
  }

  const advance = (action: string) => {
    setRevealed(false)
    setScroll(0)
    setMessage(action)
    if (index + 1 >= queue.length) setDone(true)
    else setIndex(index + 1)
  }

  const recordUndo = (cardId: string, action: string) => {
    // Read the record now, not inside the updater: callers mutate state.records
    // immediately after, and React runs the updater during the next render.
    const previousRecord = state.records[cardId]
    setUndoStack((stack) => [...stack, { cardId, previousRecord, action }])
  }

  /**
   * Hand the terminal to $EDITOR, then reread the file it touched. The card
   * pool, both queues and the undo stack are patched from that one file rather
   * than rebuilt, so the session keeps its place and its history.
   */
  const edit = async (target: QueueItem) => {
    const { sourcePath } = target.card
    setEditing(true)
    try {
      await suspendTerminal(() => openEditor(sourcePath, target.card.sourceLine))
    } catch (error) {
      setEditing(false)
      setMessage(`edit failed: ${String(error)}`)
      return
    }

    let after: Flashcard[]
    try {
      // The card's own root, so the reread derives ids exactly as the first
      // parse did. Any other directory would rename every card in the file.
      after = (await parseFile(sourcePath, target.card.rootDir)).cards
    } catch (error) {
      setEditing(false)
      setMessage(`edited, but could not reread ${sourcePath}: ${String(error)}`)
      return
    }

    const before = allCards.filter((card) => card.sourcePath === sourcePath)
    const moves = reconcileCardIds(before, after)
    const carried = applyRecordMoves(state, moves, after)

    // Splice the file's cards back where they were so deck order survives.
    const next: Flashcard[] = []
    let spliced = false
    for (const card of allCards) {
      if (card.sourcePath !== sourcePath) next.push(card)
      else if (!spliced) {
        next.push(...after)
        spliced = true
      }
    }
    setAllCards(next)

    const remap = new Map(moves.map((move) => [move.from, move.to]))
    const byId = new Map(after.map((card) => [card.id, card]))
    // Cards deleted in the editor drop out of the queue rather than linger.
    const restock = (items: QueueItem[]): QueueItem[] =>
      items.flatMap((entry) => {
        if (entry.card.sourcePath !== sourcePath) return [entry]
        const card = byId.get(remap.get(entry.card.id) ?? entry.card.id)
        return card ? [{ ...entry, card }] : []
      })

    const nextQueue = restock(queue)
    const targetId = remap.get(target.card.id) ?? target.card.id
    const position = nextQueue.findIndex((entry) => entry.card.id === targetId)

    setQueue(nextQueue)
    setFullQueue(restock(fullQueue))
    setUndoStack((stack) =>
      stack.map((entry) => ({ ...entry, cardId: remap.get(entry.cardId) ?? entry.cardId })),
    )
    setIndex(position >= 0 ? position : Math.min(index, Math.max(0, nextQueue.length - 1)))
    setScroll(0)
    setDone(nextQueue.length === 0)
    setEditing(false)

    if (carried > 0) persist('edit')
    const gone = position < 0 ? ' · that card is gone, showing the next one' : ''
    const kept =
      carried > 0 ? ` · ${carried} record${carried === 1 ? '' : 's'} followed the edit` : ''
    setMessage(`edited ${sourcePath}${kept}${gone}`)
  }

  useInput((input, key) => {
    // The picker is mounted alongside this hook and owns the keyboard while it
    // is up; without this, `/` would start a search behind it.
    if (!picked || editing) return

    if (imageMode) {
      setImageMode(false)
      setMessage('closed image preview')
      return
    }

    const clearSearch = () => {
      setSearching(false)
      setSearch('')
      setQueue(fullQueue)
      setIndex(0)
      setRevealed(false)
      setScroll(0)
      setDone(fullQueue.length === 0)
      setMessage('search cleared')
    }

    /* One key, one mode: `n` is both "write a note" and "see the notes", and the
       composer owns the keyboard while it is up so a grade key cannot fire into it. */
    if (noting) {
      if (key.escape) {
        setNoting(false)
        setDraft('')
        setMessage('note cancelled')
        return
      }
      if (key.return) {
        setNoting(false)
        const text = draft.trim()
        setDraft('')
        // An empty input closes without writing, so `n` is a safe way to look.
        if (text === '' || !item) {
          setMessage('closed notes')
          return
        }
        void commitNote(item, text)
        return
      }
      if (key.backspace || key.delete) {
        setDraft((d) => d.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) setDraft((d) => d + input)
      return
    }

    if (searching) {
      if (key.escape) {
        clearSearch()
        return
      }
      if (key.return) {
        const found = fullQueue.filter((q) => matches(q, search))
        setSearching(false)
        if (search.trim() === '') {
          setQueue(fullQueue)
          setIndex(0)
          setMessage('search cleared')
          return
        }
        if (found.length === 0) {
          setMessage(`no cards match "${search}"`)
          return
        }
        setQueue(found)
        setIndex(0)
        setRevealed(false)
        setScroll(0)
        setDone(false)
        setMessage(
          `${found.length} card${found.length === 1 ? '' : 's'} matching "${search}" · esc to clear`,
        )
        return
      }
      if (key.backspace || key.delete) {
        setSearch((s) => s.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) setSearch((s) => s + input)
      return
    }

    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit({ graded, practised, touched: touched.current })
      return
    }
    if (input === '/') {
      setSearching(true)
      setSearch('')
      return
    }
    // The hint on a committed search promises esc clears it.
    if (key.escape) {
      if (search !== '') clearSearch()
      return
    }
    if (input === 'u') {
      const entry = undoStack.at(-1)
      if (!entry) {
        setMessage('nothing to undo')
        return
      }
      if (entry.previousRecord) state.records[entry.cardId] = entry.previousRecord
      else delete state.records[entry.cardId]
      setUndoStack((stack) => stack.slice(0, -1))
      // The queue may have been narrowed by a search since the card was graded.
      const position = queue.findIndex((q) => q.card.id === entry.cardId)
      if (position >= 0) {
        setIndex(position)
        setRevealed(true)
        setScroll(0)
      }
      setDone(false)
      setGraded((n) => Math.max(0, n - 1))
      persist(`undid ${entry.action}`)
      setMessage(`undid ${entry.action}`)
      return
    }

    /* `done || !item` is the completion screen's own condition: an empty queue
       reaches it without ever setting `done`, and its keys have to work there too. */
    if (done || !item) {
      if (input === 'p' && scopePaths.length > 0) {
        selectDeck(scopePaths, 'practice')
        return
      }
      if (canPick && (input === 'b' || input === ' ' || key.return)) backToPicker()
      return
    }

    if (input === ' ' || key.return) {
      if (!revealed) {
        setRevealed(true)
        setScroll(0)
        setMessage(
          mode === 'practice'
            ? 'space/enter: next card'
            : 'grade: 1 again · 2 hard · 3 good · 4 easy',
        )
        return
      }
      // One key for the whole pass: reveal, then next. Nothing to decide between.
      if (mode === 'practice') {
        setPractised((n) => n + 1)
        // The card box carries the reveal hint itself, so the message line stays
        // clear rather than following the last card onto the completion screen.
        advance('')
      }
      return
    }

    /* A practice pass writes no scheduling, so the keys that would are answered
       rather than ignored: silence here reads as a dropped keypress. */
    if (mode === 'practice' && (input === 's' || GRADE_KEYS[input] !== undefined)) {
      setMessage('a practice pass schedules nothing · space/enter for the next card')
      return
    }
    if (input === 'n') {
      setNoting(true)
      setDraft('')
      return
    }
    if (input === 'e') {
      setMessage(`opening ${editorCommand}…`)
      void edit(item)
      return
    }
    if (input === 'i') {
      if (previewable.length === 0) {
        setMessage(
          images.enabled
            ? 'no PNG attachment on this card'
            : `image previews unavailable: ${images.reason}`,
        )
        return
      }
      if (!images.enabled) {
        setMessage(`image previews unavailable: ${images.reason}`)
        return
      }
      setImageMode(true)
      return
    }
    if (input === 'j' || key.downArrow) {
      setScroll((s) => Math.min(maxScroll, s + 1))
      return
    }
    if (input === 'k' || key.upArrow) {
      setScroll((s) => Math.max(0, s - 1))
      return
    }
    if (input === 's') {
      const record = state.records[item.card.id] ?? newRecord(item.card)
      recordUndo(item.card.id, 'suspend')
      state.records[item.card.id] = { ...record, suspended: true }
      persist('suspended')
      setGraded((n) => n + 1)
      advance(`suspended "${item.card.title}"`)
      return
    }
    const grade = GRADE_KEYS[input]
    if (grade && revealed && mode === 'review') {
      const record = state.records[item.card.id] ?? newRecord(item.card)
      recordUndo(item.card.id, grade)
      state.records[item.card.id] = applyGrade(record, grade)
      persist(grade)
      setGraded((n) => n + 1)
      advance(`graded "${item.card.title}": ${grade}`)
    }
  })

  if (!picked) {
    /* Counted here rather than in a memo: grading mutates `state.records` in
       place, so nothing a dependency array can watch changes, and a deck
       finished this session would come back to the menu with its old numbers. */
    const summaries = summarizeDecks(allCards, state)
    return (
      <DeckPicker
        decks={decks}
        summaries={summaries}
        height={viewportHeight}
        hiddenDecks={hiddenDecks}
        onToggleHidden={async (sourcePath, hide) => {
          const next = hide
            ? [...hiddenDecks, sourcePath]
            : hiddenDecks.filter((entry) => entry !== sourcePath)
          /* Written before the list changes, so a config that could not be
             written leaves a picker that still agrees with the file on disk. */
          await persistHiddenDecks(next)
          setHiddenDecks(next)
        }}
        onSelect={selectDeck}
        onPractice={(sourcePaths) => selectDeck(sourcePaths, 'practice')}
        onQuit={() => exit({ graded, practised, touched: touched.current })}
      />
    )
  }

  if (imageMode) {
    const first = previewable[0]
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          {first?.alt || 'image'} <Text dimColor>— {first?.path}</Text>
        </Text>
        <Text dimColor>any key to return</Text>
      </Box>
    )
  }

  if (done || !item) {
    /* The last screen of a deck is where a practice pass is offered, because with
       --deck or defaultDeckFilter there is no picker behind it to offer one. */
    const hints = [
      canPick ? 'enter: pick another deck' : '',
      mode === 'review' && scopePaths.length > 0 ? 'p: practise the whole deck' : '',
      'q to quit',
      mode === 'review' ? 'u to undo last grade' : '',
    ].filter((hint) => hint !== '')
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="green">
          {mode === 'practice'
            ? `Practice pass complete — ${practised} card${practised === 1 ? '' : 's'}.`
            : `Session complete — ${graded} card${graded === 1 ? '' : 's'} reviewed.`}
        </Text>
        <Text dimColor>{hints.join(' · ')}</Text>
        <Text dimColor>{message}</Text>
      </Box>
    )
  }

  const newCount = queue.filter((q) => q.isNew).length
  const visible = lines.slice(scroll, scroll + viewportHeight)

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {item.card.deckTitle}
        </Text>
        <Text dimColor>
          card {index + 1}/{queue.length} ·{' '}
          {mode === 'practice' ? (
            <Text color="yellow">full pass</Text>
          ) : (
            `${queue.length - newCount} due · ${newCount} new`
          )}
          {item.isNew ? ' · NEW' : ''}
        </Text>
      </Box>
      <Box
        borderStyle="round"
        borderColor="gray"
        flexDirection="column"
        paddingX={1}
        minHeight={viewportHeight + 2}
      >
        <Text bold>
          {item.card.title}
          {cardNotes.length > 0 ? <Text dimColor>{`  📝 ${cardNotes.length}`}</Text> : ''}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {visible.map((line, i) => (
            <MarkdownLine key={scroll + i} line={line} />
          ))}
          {maxScroll > 0 && (
            <Text dimColor>
              — {scroll + visible.length}/{lines.length} lines (j/k to scroll) —
            </Text>
          )}
          {!revealed && (
            <Text dimColor italic>
              [press space or enter to reveal]
            </Text>
          )}
        </Box>
      </Box>
      {noting ? (
        <Box flexDirection="column">
          {/* Only the last few: the frame is sized against the terminal, and a card
              with a dozen notes would push the card box off the top of it. */}
          {cardNotes.length > NOTE_PREVIEW && (
            <Text dimColor>… {cardNotes.length - NOTE_PREVIEW} earlier</Text>
          )}
          {cardNotes.slice(-NOTE_PREVIEW).map((note, i) => (
            <Text key={note.createdAt + String(i)} dimColor>
              {cardNotes.length - Math.min(cardNotes.length, NOTE_PREVIEW) + i + 1}. {note.text}
            </Text>
          ))}
          {cardNotes.length === 0 && <Text dimColor>no notes on this card yet</Text>}
          <Text color="yellow">note: {draft}▏</Text>
          <Text dimColor>enter saves · empty enter closes · esc cancels</Text>
        </Box>
      ) : searching ? (
        <Text color="yellow">/{search}▏</Text>
      ) : (
        <Text dimColor>
          {mode === 'practice'
            ? 'space reveal/next · j/k scroll · n note · e edit · / search'
            : 'space reveal · 1-4 grade · j/k scroll · s suspend · u undo · n note · e edit · / search'}
          {previewable.length > 0 ? ' · i image' : ''} · q quit
        </Text>
      )}
      <Text color="yellow">{message}</Text>
    </Box>
  )
}

/** What ReviewApp hands back through exit(), for the summary printed after teardown. */
type ReviewResult = { graded: number; practised: number; touched: boolean }

function isReviewResult(value: unknown): value is ReviewResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'graded') === 'number' &&
    typeof Reflect.get(value, 'practised') === 'number' &&
    typeof Reflect.get(value, 'touched') === 'boolean'
  )
}

export async function startReview(options: ReviewSessionOptions): Promise<void> {
  const app = render(<ReviewApp {...options} />, {
    // Review owns the whole screen, so keep it out of the scrollback like less does.
    exitOnCtrlC: false,
    alternateScreen: true,
  })
  const result = await app.waitUntilExit()
  /* An unrecognised result means the session ended some way this code does not
     know about, so flush rather than assume there was nothing to flush. */
  const outcome = isReviewResult(result) ? result : { graded: 0, practised: 0, touched: true }
  if (outcome.touched) await saveState(options.statePath, options.state)

  // The alternate screen is gone by now along with the session-complete frame,
  // so restate the outcome on the primary screen.
  const { graded, practised } = outcome
  if (graded > 0) {
    process.stdout.write(`Reviewed ${graded} card${graded === 1 ? '' : 's'}.\n`)
  }
  // Counted apart from the graded total, and named apart: a practice pass moved
  // no card's schedule, so calling it a review would overstate what happened.
  if (practised > 0) {
    process.stdout.write(`Practised ${practised} card${practised === 1 ? '' : 's'}.\n`)
  }
}
