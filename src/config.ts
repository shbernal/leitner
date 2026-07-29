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
  return path.join(configHome, 'flashcards-tui', 'config.json')
}

const DEFAULT_CONFIG: AppConfig = {
  sourceDir: path.join(os.homedir(), 'notes', 'flashcards'),
  dailyLimit: 50,
  defaultDeckFilter: null,
}

export async function loadConfig(configPath: string = defaultConfigPath()): Promise<AppConfig> {
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONFIG }
    throw error
  }
  const parsed = JSON.parse(raw) as Partial<AppConfig>
  return {
    sourceDir: expandHome(parsed.sourceDir ?? DEFAULT_CONFIG.sourceDir),
    dailyLimit: parsed.dailyLimit ?? DEFAULT_CONFIG.dailyLimit,
    defaultDeckFilter: parsed.defaultDeckFilter ?? DEFAULT_CONFIG.defaultDeckFilter,
  }
}
