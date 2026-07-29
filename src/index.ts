#!/usr/bin/env node
import { main } from './cli.js'

// The ~/.local/bin wrapper runs this through `pnpm --dir <repo> run`, which
// starts the process in the repo rather than where the command was typed.
// Restore the caller's cwd so relative source-dir arguments mean what they look
// like they mean.
const callerCwd = process.env['FLASHCARDS_TUI_CALLER_CWD']
if (callerCwd && callerCwd !== process.cwd()) {
  process.chdir(callerCwd)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
