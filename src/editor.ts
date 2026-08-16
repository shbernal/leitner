import { spawn } from 'node:child_process'
import path from 'node:path'

export type EditorCommand = {
  command: string
  args: string[]
}

/** Opens `file` at `line` and resolves once the editor is done with the terminal. */
export type EditorRunner = (file: string, line: number) => Promise<void>

/** What `git` falls back to, and what is present on essentially every unix box. */
const FALLBACK_EDITOR = 'vi'

/** Editors that jump to a line via a leading `+N` argument. */
const PLUS_LINE: ReadonlySet<string> = new Set([
  'emacs',
  'emacsclient',
  'gvim',
  'jed',
  'joe',
  'kak',
  'mg',
  'micro',
  'nano',
  'ne',
  'nvim',
  'pico',
  'vi',
  'view',
  'vim',
])

/** Editors that take `path:line` and need a flag to block until the file is closed. */
const WAIT_FLAGS: Record<string, string> = {
  code: '--wait',
  'code-insiders': '--wait',
  codium: '--wait',
  subl: '--wait',
  sublime_text: '--wait',
}

/**
 * $EDITOR routinely carries flags ("code --wait", "emacsclient -nw"). Quoted
 * paths inside it are rare enough that splitting on whitespace beats running
 * the value through a shell.
 */
function splitCommand(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '')
}

function baseName(command: string): string {
  return path.basename(command).replace(/\.exe$/i, '')
}

export function editorFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['VISUAL'] ?? env['EDITOR'] ?? ''
  return configured.trim() === '' ? FALLBACK_EDITOR : configured
}

/**
 * Build the argv for opening `file` with the cursor on `line`. Editors whose
 * line syntax we do not recognise just get the path — landing at the top of the
 * file beats passing an argument they will treat as a second file to open.
 */
export function resolveEditorCommand(editor: string, file: string, line?: number): EditorCommand {
  const parts = splitCommand(editor)
  const command = parts[0] ?? FALLBACK_EDITOR
  const args = parts.slice(1)
  const base = baseName(command)

  if (line === undefined || !Number.isInteger(line) || line < 1) {
    return { command, args: [...args, file] }
  }
  if (PLUS_LINE.has(base)) {
    return { command, args: [...args, `+${line}`, file] }
  }

  const waitFlag = WAIT_FLAGS[base]
  if (waitFlag !== undefined) {
    // Without it these return immediately and we would reparse the unedited file.
    const waited = args.includes(waitFlag) || args.includes('-w') ? args : [...args, waitFlag]
    const goto = base.startsWith('code') ? ['--goto', `${file}:${line}`] : [`${file}:${line}`]
    return { command, args: [...waited, ...goto] }
  }
  if (base === 'hx' || base === 'helix') {
    return { command, args: [...args, `${file}:${line}`] }
  }
  return { command, args: [...args, file] }
}

/**
 * Run $EDITOR against the file, inheriting the terminal. The caller is
 * responsible for handing the terminal over first (Ink's `suspendTerminal`).
 *
 * A non-zero exit is not treated as a failure: whatever the editor wrote is on
 * disk either way, and reparsing the file is what tells us what actually
 * changed. Only a failure to launch is reported.
 */
export async function runEditor(
  file: string,
  line: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { command, args } = resolveEditorCommand(editorFromEnv(env), file, line)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(`editor not found: ${command} (set $EDITOR)`)
          : new Error(`could not run ${command}: ${error.message}`),
      )
    })
    child.on('close', () => {
      resolve()
    })
  })
}
