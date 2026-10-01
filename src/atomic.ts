import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/* The write in flight for each target, so a second write to the same path waits
   for the first instead of racing it. A review session persists on every
   keypress without awaiting, so two grades in quick succession are two writes at
   once; queued, the last one called is the last one to land. */
const pending = new Map<string, Promise<void>>()

/**
 * Write `contents` to `target` through a temp file and a rename, so a reader
 * never sees half a file. The temp name is unique per call: a shared one let two
 * overlapping writes truncate each other's temp file and then race to rename it,
 * and the loser failed with ENOENT on a save that may or may not have landed.
 *
 * The temp file is synced before the rename because rename is atomic against
 * other processes but not against a power cut, and is removed when anything
 * fails, so a failed write leaves nothing behind — in the notes case that is the
 * user's deck tree.
 *
 * `createDir` makes the parent directory as part of the queued write rather than
 * before it: awaited ahead of the call, it let calls reach the queue in a
 * different order than they were made, and an older state won.
 */
export function writeFileAtomic(
  target: string,
  contents: string,
  { createDir = false }: { createDir?: boolean } = {},
): Promise<void> {
  const previous = pending.get(target) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      if (createDir) await fs.mkdir(path.dirname(target), { recursive: true })
      await write(target, contents)
    })
  pending.set(target, next)
  // Only the latest write clears the slot; an earlier one settling must not drop
  // a later one from the queue.
  const clear = () => {
    if (pending.get(target) === next) pending.delete(target)
  }
  next.then(clear, clear)
  return next
}

async function write(target: string, contents: string): Promise<void> {
  const tmpPath = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await fs.open(tmpPath, 'w')
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmpPath, target)
  } catch (error) {
    await fs.rm(tmpPath, { force: true })
    throw error
  }
}
