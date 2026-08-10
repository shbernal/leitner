/**
 * Minimal in-process harness for the Ink screens.
 *
 * `ink-testing-library` would cover most of this, but its fake stdout hardcodes
 * a width and exposes no rows and no way to resize, which is exactly what the
 * review viewport math depends on.
 */
import { EventEmitter } from 'node:events'
import type React from 'react'
import { render } from 'ink'

class TestStdout extends EventEmitter {
  columns: number
  rows: number
  readonly frames: string[] = []

  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }

  write = (frame: string, callback?: () => void): boolean => {
    this.frames.push(frame)
    callback?.()
    return true
  }

  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
}

/** Ink 7 pulls input with `readable` + `read()`, so queue writes rather than pushing them. */
class TestStdin extends EventEmitter {
  isTTY = true
  private readonly pending: string[] = []

  write = (data: string): void => {
    this.pending.push(data)
    this.emit('readable')
  }

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => this.pending.shift() ?? null
}

export const KEY = {
  enter: '\r',
  escape: '\u001B',
  backspace: '\u007F',
  down: '\u001B[B',
  up: '\u001B[A',
  space: ' ',
} as const

export type TuiHarness = {
  /** Full frame from the most recent render, ANSI styling stripped. */
  frame: () => string
  /** Everything written to stdout, escapes intact — frames and direct writes alike. */
  output: () => string
  press: (input: string) => Promise<void>
  type: (text: string) => Promise<void>
  resize: (columns: number, rows: number) => Promise<void>
  unmount: () => void
}

// oxlint-disable-next-line no-control-regex -- SGR sequences are defined by ESC
const ANSI = /\u001B\[[0-9;]*m/g

/**
 * Let Ink's reconciler commit and flush the frame. The wait has to clear Ink's
 * 20ms pending-escape timer, which is what turns a lone ESC byte into a key
 * event once it is clear no escape sequence follows it.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 30)
  })
}

export async function renderTui(
  node: React.ReactElement,
  size: { columns?: number; rows?: number } = {},
): Promise<TuiHarness> {
  const stdout = new TestStdout(size.columns ?? 100, size.rows ?? 40)
  const stdin = new TestStdin()

  const instance = render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    // Writes a complete frame per render instead of incremental erase sequences.
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  const harness: TuiHarness = {
    frame: () => (stdout.frames.at(-1) ?? '').replace(ANSI, ''),
    output: () => stdout.frames.join(''),
    press: async (input) => {
      stdin.write(input)
      await flush()
    },
    type: async (text) => {
      for (const char of text) {
        stdin.write(char)
        await flush()
      }
    },
    resize: async (columns, rows) => {
      stdout.resize(columns, rows)
      await flush()
    },
    unmount: () => {
      instance.unmount()
      instance.cleanup()
    },
  }

  await flush()
  return harness
}
