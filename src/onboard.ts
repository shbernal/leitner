import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  type AppConfig,
  DEFAULT_CONFIG,
  defaultConfigPath,
  expandHome,
  normalizeSourceDirs,
  readConfigFile,
  sourceDirsFrom,
  withDefaults,
  writeConfig,
} from './config.js'
import { parseDirectory } from './parser.js'

/** A question and the answer to it; injected so the flow is testable without a tty. */
export type Ask = (question: string, defaultAnswer?: string) => Promise<string>

export type InitOptions = {
  configPath?: string
  /** Skips the prompt entirely: `leitner init <dir...>`, and the only non-interactive way in. */
  dirs?: string[]
  /** Keep the directories already configured and add to them. */
  add?: boolean
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

  let answered: string[]
  if (options.dirs !== undefined && options.dirs.length > 0) {
    answered = options.dirs.map((dir) => path.resolve(expandHome(dir)))
    for (const dir of answered) {
      const problem = await inspect(dir)
      // Non-interactive callers get an error rather than a prompt they cannot answer.
      if (problem !== null) throw new Error(describe(problem, dir))
    }
  } else {
    answered = await prompt(options.ask, out, configPath, existing !== null)
  }

  // `--add` grows the collection; without it the answer is the collection, so
  // dropping a directory needs no separate command.
  const sourceDirs = options.add === true ? [...sourceDirsFrom(existing), ...answered] : answered

  const config = withDefaults({ ...existing, sourceDirs })
  await writeConfig(configPath, config)
  out(`wrote ${configPath}`)
  return config
}

async function prompt(
  injected: Ask | undefined,
  out: (text: string) => void,
  configPath: string,
  exists: boolean,
): Promise<string[]> {
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
    const [fallback] = DEFAULT_CONFIG.sourceDirs
    const suggestion =
      fallback !== undefined && (await inspect(fallback)) === null ? fallback : undefined

    const accepted: string[] = []
    for (;;) {
      const first = accepted.length === 0
      const answer = first
        ? await ask('Where are your flashcards?', suggestion)
        : await ask('Another directory? (blank to finish)')
      if (answer === '') {
        // The first answer is the collection; every later one is optional.
        if (!first) return accepted
        out('A directory is needed. Ctrl-C to stop.')
        continue
      }
      const sourceDir = path.resolve(expandHome(answer))
      const problem = await inspect(sourceDir)
      if (problem !== null) {
        out(describe(problem, sourceDir))
        continue
      }
      try {
        // Nesting is refused here too, so the answer to it is another prompt
        // rather than an error thrown after the whole conversation.
        normalizeSourceDirs([...accepted, sourceDir])
      } catch (error) {
        out(error instanceof Error ? error.message : String(error))
        continue
      }
      await report(sourceDir, out)
      accepted.push(sourceDir)
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
