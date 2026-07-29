import React, { useMemo, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import { applyGrade, newRecord } from '../scheduler.js'
import { saveState, type ReviewState } from '../state.js'
import type { QueueItem } from '../queue.js'
import type { Grade, ReviewRecord } from '../types.js'

type ReviewSessionOptions = {
  queue: QueueItem[]
  state: ReviewState
  statePath: string
}

type UndoEntry = {
  index: number
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

function bodyLines(item: QueueItem): string[] {
  const lines = item.card.bodyMarkdown === '' ? ['(no body)'] : item.card.bodyMarkdown.split('\n')
  if (item.card.images.length > 0) {
    lines.push('')
    for (const image of item.card.images) {
      lines.push(`📎 ${image.alt || 'image'} → ${image.path}`)
    }
  }
  return lines
}

function ReviewApp({ queue, state, statePath }: ReviewSessionOptions) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [scroll, setScroll] = useState(0)
  const [message, setMessage] = useState('space/enter: reveal')
  const [graded, setGraded] = useState(0)
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  const [done, setDone] = useState(false)

  const item = queue[index]
  const lines = useMemo(() => (item ? bodyLines(item) : []), [item])
  const viewportHeight = Math.max(5, (stdout?.rows ?? 24) - 7)
  const maxScroll = Math.max(0, lines.length - viewportHeight)

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

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit()
      return
    }
    if (done || !item) return

    if (input === ' ' || key.return) {
      if (!revealed) {
        setRevealed(true)
        setMessage('grade: 1 again · 2 hard · 3 good · 4 easy')
      }
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
      setIndex(entry.index)
      setDone(false)
      setRevealed(true)
      setScroll(0)
      setGraded((n) => Math.max(0, n - 1))
      persist(`undid ${entry.action}`)
      setMessage(`undid ${entry.action}`)
      return
    }
    if (input === 's') {
      const record = state.records[item.card.id] ?? newRecord(item.card)
      setUndoStack((stack) => [
        ...stack,
        { index, cardId: item.card.id, previousRecord: state.records[item.card.id], action: 'suspend' },
      ])
      state.records[item.card.id] = { ...record, suspended: true }
      persist('suspended')
      advance(`suspended "${item.card.title}"`)
      return
    }
    const grade = GRADE_KEYS[input]
    if (grade && revealed) {
      const record = state.records[item.card.id] ?? newRecord(item.card)
      setUndoStack((stack) => [
        ...stack,
        { index, cardId: item.card.id, previousRecord: state.records[item.card.id], action: grade },
      ])
      state.records[item.card.id] = applyGrade(record, grade)
      persist(grade)
      advance(`graded "${item.card.title}": ${grade}`)
    }
  })

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
      <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1} minHeight={viewportHeight + 2}>
        <Text bold>{item.card.title}</Text>
        {revealed ? (
          <Box flexDirection="column" marginTop={1}>
            {visible.map((line, i) => (
              <Text key={scroll + i}>{line === '' ? ' ' : line}</Text>
            ))}
            {maxScroll > 0 && (
              <Text dimColor>
                — {scroll + visible.length}/{lines.length} lines (j/k to scroll) —
              </Text>
            )}
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text dimColor italic>
              [press space or enter to reveal]
            </Text>
          </Box>
        )}
      </Box>
      <Text dimColor>
        space reveal · 1-4 grade · j/k scroll · s suspend · u undo · q quit
      </Text>
      <Text color="yellow">{message}</Text>
    </Box>
  )
}

export async function startReview(options: ReviewSessionOptions): Promise<void> {
  const app = render(<ReviewApp {...options} />, { exitOnCtrlC: false })
  await app.waitUntilExit()
  await saveState(options.statePath, options.state)
}
