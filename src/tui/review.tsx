import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout, useWindowSize } from 'ink'
import { applyRecordMoves, reconcileCardIds } from '../edit.js'
import { editorFromEnv, runEditor, type EditorRunner } from '../editor.js'
import { buildKittyClearSequence, buildKittyImageSequence, type ImageSupport } from '../images.js'
import { parseFile } from '../parser.js'
import { buildQueue, summarizeDecks, type QueueItem, type QueueOptions } from '../queue.js'
import { renderMarkdown, type RenderedLine } from '../render.js'
import { applyGrade, newRecord } from '../scheduler.js'
import { saveState, type ReviewState } from '../state.js'
import type { Deck, Flashcard, Grade, ReviewRecord } from '../types.js'
import { MarkdownLine } from './components.js'
import { DeckPicker } from './DeckPicker.js'

export type ReviewSessionOptions = {
  cards: Flashcard[]
  decks: Deck[]
  state: ReviewState
  statePath: string
  /** The collection root, needed to re-derive card ids after an edit. */
  rootDir: string
  queueOptions: QueueOptions
  /** When set, the deck picker is skipped. */
  deckFilter?: string | undefined
  images: ImageSupport
  /** Absolute paths verified as displayable PNGs. */
  displayablePngs: Set<string>
  /** Overridable so tests can drive the edit flow without spawning $EDITOR. */
  openEditor?: EditorRunner
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

/** With --deck the picker is skipped, so that deck's queue exists from mount. */
function initialQueue(options: ReviewSessionOptions): QueueItem[] {
  const { deckFilter, cards, state, queueOptions } = options
  if (deckFilter === undefined) return []
  const scoped = cards.filter(
    (card) => card.deckId === deckFilter || card.sourcePath.includes(deckFilter),
  )
  return buildQueue(scoped, state, queueOptions)
}

function matches(item: QueueItem, needle: string): boolean {
  const q = needle.toLowerCase()
  return item.card.title.toLowerCase().includes(q) || item.card.plainText.toLowerCase().includes(q)
}

export function ReviewApp(options: ReviewSessionOptions): React.ReactElement {
  const { cards, decks, state, statePath, rootDir, queueOptions, images, displayablePngs } = options
  const openEditor = options.openEditor ?? runEditor
  const { exit, waitUntilRenderFlush, suspendTerminal } = useApp()
  const { stdout } = useStdout()

  // With --deck the picker is skipped entirely, so the session starts picked.
  const [picked, setPicked] = useState(options.deckFilter !== undefined)
  // Editing rewrites the source file, so the card pool outlives the prop.
  const [allCards, setAllCards] = useState<Flashcard[]>(cards)
  const [queue, setQueue] = useState<QueueItem[]>(() => initialQueue(options))
  const [fullQueue, setFullQueue] = useState<QueueItem[]>(() => initialQueue(options))
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [scroll, setScroll] = useState(0)
  const [message, setMessage] = useState('space/enter: reveal')
  const [graded, setGraded] = useState(0)
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  const [done, setDone] = useState(false)
  const [searching, setSearching] = useState(false)
  const [search, setSearch] = useState('')
  const [imageMode, setImageMode] = useState(false)
  const [editing, setEditing] = useState(false)

  // Re-renders on SIGWINCH, so the viewport follows the terminal as it resizes.
  const { rows, columns } = useWindowSize()
  const viewportHeight = Math.max(5, rows - CHROME_ROWS)
  const bodyWidth = Math.max(20, columns - 4)

  const summaries = useMemo(() => summarizeDecks(allCards, state), [allCards, state])

  const selectDeck = (deckIds: string[]) => {
    const scope = new Set(deckIds)
    const scoped = allCards.filter((card) => scope.has(card.deckId))
    const built = buildQueue(scoped, state, queueOptions)
    setPicked(true)
    setQueue(built)
    setFullQueue(built)
    setIndex(0)
    setRevealed(false)
    setScroll(0)
    setDone(built.length === 0)
    setMessage(built.length === 0 ? 'nothing due in that deck' : 'space/enter: reveal')
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

  const persist = (action: string) => {
    void saveState(statePath, state).catch((error: unknown) => {
      setMessage(`${action} (warning: failed to save state: ${String(error)})`)
    })
  }

  const advance = (action: string) => {
    setGraded((n) => n + 1)
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
      after = (await parseFile(sourcePath, rootDir)).cards
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
    if (editing) return

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
      exit({ graded })
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
    if (done || !item) return

    if (input === ' ' || key.return) {
      if (!revealed) {
        setRevealed(true)
        setScroll(0)
        setMessage('grade: 1 again · 2 hard · 3 good · 4 easy')
      }
      return
    }
    if (input === 'e') {
      setMessage(`opening ${editorFromEnv()}…`)
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
    if (input === 's') {
      const record = state.records[item.card.id] ?? newRecord(item.card)
      recordUndo(item.card.id, 'suspend')
      state.records[item.card.id] = { ...record, suspended: true }
      persist('suspended')
      advance(`suspended "${item.card.title}"`)
      return
    }
    const grade = GRADE_KEYS[input]
    if (grade && revealed) {
      const record = state.records[item.card.id] ?? newRecord(item.card)
      recordUndo(item.card.id, grade)
      state.records[item.card.id] = applyGrade(record, grade)
      persist(grade)
      advance(`graded "${item.card.title}": ${grade}`)
    }
  })

  if (!picked) {
    return (
      <DeckPicker
        decks={decks}
        summaries={summaries}
        height={viewportHeight}
        onSelect={selectDeck}
        onQuit={exit}
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
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="green">Session complete — {graded} cards reviewed.</Text>
        <Text dimColor>q to quit · u to undo last grade</Text>
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
          card {index + 1}/{queue.length} · {queue.length - newCount} due · {newCount} new
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
        <Text bold>{item.card.title}</Text>
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
      {searching ? (
        <Text color="yellow">/{search}▏</Text>
      ) : (
        <Text dimColor>
          space reveal · 1-4 grade · j/k scroll · s suspend · u undo · e edit · / search
          {previewable.length > 0 ? ' · i image' : ''} · q quit
        </Text>
      )}
      <Text color="yellow">{message}</Text>
    </Box>
  )
}

/** What ReviewApp hands back through exit(), for the summary printed after teardown. */
export type ReviewResult = { graded: number }

function isReviewResult(value: unknown): value is ReviewResult {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'graded') === 'number'
  )
}

export async function startReview(options: ReviewSessionOptions): Promise<void> {
  const app = render(<ReviewApp {...options} />, {
    // Review owns the whole screen, so keep it out of the scrollback like less does.
    exitOnCtrlC: false,
    alternateScreen: true,
  })
  const result = await app.waitUntilExit()
  await saveState(options.statePath, options.state)

  // The alternate screen is gone by now along with the session-complete frame,
  // so restate the outcome on the primary screen.
  const graded = isReviewResult(result) ? result.graded : 0
  if (graded > 0) {
    process.stdout.write(`Reviewed ${graded} card${graded === 1 ? '' : 's'}.\n`)
  }
}
