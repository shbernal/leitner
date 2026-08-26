import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  type AppConfig,
  DEFAULT_CONFIG,
  defaultConfigPath,
  expandHome,
  readConfigFile,
  withDefaults,
  writeConfig,
} from './config.js'
import { parseDirectory } from './parser.js'

/** A question and the answer to it; injected so the flow is testable without a tty. */
export type Ask = (question: string, defaultAnswer?: string) => Promise<string>

export type InitOptions = {
  configPath?: string
  /** Skips the prompt entirely: `leitner init <dir>`, and the only non-interactive way in. */
  dir?: string
  ask?: Ask
  out?: (text: string) => void
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

/*
 * Prompts go to stderr, never stdout: `list`, `stats` and `export` promise a
 * parseable stdout, and a question printed into it would be part of the output.
 */
function terminalAsk(): { ask: Ask; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  // A closed input leaves `question` pending forever, which would hang the
  // process on ctrl-D with no message. Racing it turns that into an error.
  const closed = new Promise<never>((_resolve, reject) => {
    rl.once('close', () => reject(new Error('cancelled')))
  })
  const ask: Ask = async (question, defaultAnswer) => {
    const suffix = defaultAnswer === undefined ? '' : ` [${defaultAnswer}]`
    const answer = await Promise.race([rl.question(`${question}${suffix} `), closed])
    return answer.trim() || (defaultAnswer ?? '')
  }
  return { ask, close: () => rl.close() }
}

type DirProblem = 'missing' | 'not-a-directory' | null

async function inspect(dir: string): Promise<DirProblem> {
  try {
    return (await fs.stat(dir)).isDirectory() ? null : 'not-a-directory'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function describe(problem: Exclude<DirProblem, null>, dir: string): string {
  return problem === 'missing' ? `no such directory: ${dir}` : `not a directory: ${dir}`
}

/**
 * Writes the config file and answers with what it wrote. Existing keys survive:
 * re-running this to move a collection must not silently reset `dailyLimit`.
 */
export async function runInit(options: InitOptions = {}): Promise<AppConfig> {
  const configPath = options.configPath ?? defaultConfigPath()
  const out = options.out ?? ((text: string) => process.stderr.write(`${text}\n`))
  const existing = await readConfigFile(configPath)

  let sourceDir: string
  if (options.dir !== undefined) {
    sourceDir = path.resolve(expandHome(options.dir))
    const problem = await inspect(sourceDir)
    // Non-interactive callers get an error rather than a prompt they cannot answer.
    if (problem !== null) throw new Error(describe(problem, sourceDir))
  } else {
    sourceDir = await prompt(options.ask, out, configPath, existing !== null)
  }

  const config = withDefaults({ ...existing, sourceDir })
  await writeConfig(configPath, config)
  out(`wrote ${configPath}`)
  return config
}

async function prompt(
  injected: Ask | undefined,
  out: (text: string) => void,
  configPath: string,
  exists: boolean,
): Promise<string> {
  let ask = injected
  let close: (() => void) | undefined
  if (ask === undefined) {
    const terminal = terminalAsk()
    ask = terminal.ask
    close = terminal.close
  }
  try {
    out(
      exists
        ? `leitner will update ${configPath}.`
        : `leitner has no configuration yet; it will be written to ${configPath}.`,
    )
    // Only offered when it is really there — a default that does not exist is
    // exactly the trap this whole flow exists to remove.
    const suggestion =
      (await inspect(DEFAULT_CONFIG.sourceDir)) === null ? DEFAULT_CONFIG.sourceDir : undefined

    for (;;) {
      const answer = await ask('Where are your flashcards?', suggestion)
      if (answer === '') {
        out('A directory is needed. Ctrl-C to stop.')
        continue
      }
      const sourceDir = path.resolve(expandHome(answer))
      const problem = await inspect(sourceDir)
      if (problem !== null) {
        out(describe(problem, sourceDir))
        continue
      }
      await report(sourceDir, out)
      return sourceDir
    }
  } finally {
    close?.()
  }
}

/* The count is the confirmation: a path that exists but holds nothing is how a
   typo survives, and it is the one mistake the prompt itself cannot catch. */
async function report(sourceDir: string, out: (text: string) => void): Promise<void> {
  const parsed = await parseDirectory(sourceDir)
  if (parsed.cards.length === 0) {
    out('No flashcards there yet — that is fine, they will be picked up when you write them.')
    return
  }
  out(`Found ${parsed.cards.length} cards in ${parsed.decks.length} decks.`)
}
