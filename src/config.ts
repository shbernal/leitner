import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type AppConfig = {
  sourceDirs: string[]
  dailyLimit: number
  defaultDeckFilter: string | null
  /** The `e` key's editor command, flags included. `null` defers to $VISUAL/$EDITOR. */
  editor: string | null
  /**
   * Decks the picker leaves out of its list until `.` reveals them, each matched
   * the way `--deck` is: a deck slug, or a substring of a source path. It is a
   * presentation setting and nothing more — no command narrows what it parses by
   * it, so `list`, `stats` and above all `export --prune` still see every deck.
   */
  hiddenDecks: string[]
}

/**
 * The config as found on disk. `sourceDir` is the single-directory spelling this
 * program used to write: still read, never written, so an existing file does not
 * silently stop naming a collection.
 */
export type ParsedConfig = Partial<AppConfig> & { sourceDir?: string }

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

export function defaultConfigPath(): string {
  const configHome = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config')
  return path.join(configHome, 'leitner', 'config.json')
}

export const DEFAULT_CONFIG: AppConfig = {
  sourceDirs: [path.join(os.homedir(), 'notes', 'flashcards')],
  dailyLimit: 50,
  defaultDeckFilter: null,
  editor: null,
  hiddenDecks: [],
}

/**
 * Absolute, deduplicated, in the order given. Throws when one directory contains
 * another: every file under the inner one would then be read twice, once
 * relative to each root, and a card id is derived from that relative path — so
 * the same card would appear twice under two ids and two review records.
 */
export function normalizeSourceDirs(dirs: string[]): string[] {
  const resolved: string[] = []
  for (const dir of dirs) {
    const absolute = path.resolve(expandHome(dir))
    if (!resolved.includes(absolute)) resolved.push(absolute)
  }
  for (const outer of resolved) {
    for (const inner of resolved) {
      if (outer === inner) continue
      const relative = path.relative(outer, inner)
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue
      throw new Error(
        `source directories must not contain one another: ${outer} contains ${inner}, ` +
          'so every card under the second would be read twice under two different ids',
      )
    }
  }
  return resolved
}

/** The directories the file itself names, empty when it names none. */
export function sourceDirsFrom(parsed: ParsedConfig | null): string[] {
  const named = parsed?.sourceDirs ?? (parsed?.sourceDir === undefined ? [] : [parsed.sourceDir])
  return normalizeSourceDirs(named)
}

/**
 * The file as written, or null when there is none. The distinction is the whole
 * reason this is separate from `withDefaults`: first-run onboarding turns on
 * whether the user has ever answered, which a defaults-filled config cannot say.
 */
export async function readConfigFile(
  configPath: string = defaultConfigPath(),
): Promise<ParsedConfig | null> {
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return JSON.parse(raw) as ParsedConfig
}

export function withDefaults(parsed: ParsedConfig | null): AppConfig {
  const named = sourceDirsFrom(parsed)
  return {
    sourceDirs: named.length > 0 ? named : normalizeSourceDirs(DEFAULT_CONFIG.sourceDirs),
    dailyLimit: parsed?.dailyLimit ?? DEFAULT_CONFIG.dailyLimit,
    defaultDeckFilter: parsed?.defaultDeckFilter ?? DEFAULT_CONFIG.defaultDeckFilter,
    // An empty string is not a command; treated as unset so it falls through to
    // the environment rather than trying to spawn "".
    editor: parsed?.editor?.trim() ? parsed.editor : DEFAULT_CONFIG.editor,
    /* A blank entry is a substring of every source path, so one left in the file
       would hide the whole collection and read as an empty one. `~` is expanded
       because an entry may be a path; a slug has none to expand. */
    hiddenDecks: (parsed?.hiddenDecks ?? DEFAULT_CONFIG.hiddenDecks)
      .filter((entry) => entry.trim() !== '')
      .map(expandHome),
  }
}

/**
 * Written the way the state file is — temp file then rename — because a config
 * half-written by an interrupted `init` would fail to parse on every later run.
 *
 * It takes a `ParsedConfig` rather than an `AppConfig` so that a caller editing
 * one key can hand back the file it read, keys this program does not define
 * included. Passing a defaults-filled `AppConfig` writes every key, which is what
 * `init` wants and what a keypress in the picker does not.
 */
export async function writeConfig(configPath: string, config: ParsedConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  const tmpPath = `${configPath}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  await fs.rename(tmpPath, configPath)
}

/**
 * `hiddenDecks` rewritten in place, every other key left exactly as it was found
 * — the legacy `sourceDir` spelling and anything the user added by hand alike.
 * Hiding a deck is a keypress, and a keypress that quietly rewrote the rest of
 * someone's config would be a poor trade for a row leaving a list.
 *
 * An unparseable file throws out of `readConfigFile` before anything is written,
 * so the broken file survives to be fixed rather than being replaced.
 */
export async function writeHiddenDecks(configPath: string, hiddenDecks: string[]): Promise<void> {
  const existing = (await readConfigFile(configPath)) ?? {}
  await writeConfig(configPath, { ...existing, hiddenDecks })
}
