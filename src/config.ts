import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type AppConfig = {
  sourceDir: string
  dailyLimit: number
  defaultDeckFilter: string | null
}

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
  sourceDir: path.join(os.homedir(), 'notes', 'flashcards'),
  dailyLimit: 50,
  defaultDeckFilter: null,
}

/**
 * The file as written, or null when there is none. The distinction is the whole
 * reason this is separate from `withDefaults`: first-run onboarding turns on
 * whether the user has ever answered, which a defaults-filled config cannot say.
 */
export async function readConfigFile(
  configPath: string = defaultConfigPath(),
): Promise<Partial<AppConfig> | null> {
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return JSON.parse(raw) as Partial<AppConfig>
}

export function withDefaults(parsed: Partial<AppConfig> | null): AppConfig {
  return {
    sourceDir: expandHome(parsed?.sourceDir ?? DEFAULT_CONFIG.sourceDir),
    dailyLimit: parsed?.dailyLimit ?? DEFAULT_CONFIG.dailyLimit,
    defaultDeckFilter: parsed?.defaultDeckFilter ?? DEFAULT_CONFIG.defaultDeckFilter,
  }
}

/**
 * Written the way the state file is — temp file then rename — because a config
 * half-written by an interrupted `init` would fail to parse on every later run.
 */
export async function writeConfig(configPath: string, config: AppConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  const tmpPath = `${configPath}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  await fs.rename(tmpPath, configPath)
}
