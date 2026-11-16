/**
 * Small durable-file helpers: atomic JSON writes, tolerant reads and a
 * trailing-edge debouncer. Several processes (desktop, TUI, other profiles)
 * may share one home, so a write is always temp-file + rename and a read
 * treats any damaged file as empty instead of failing the plugin.
 *
 * @module dsh-account-pool/pool/persist
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

/** Write one JSON document atomically (never leaves a half-written file). */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Read one JSON document; a missing or damaged file yields `undefined`. */
export async function readJsonSafe(path: string, onDamaged?: (error: unknown) => void): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    onDamaged?.(error)
    return undefined
  }
}

/**
 * Trailing-edge debounce: many `schedule()` calls inside `delayMs` collapse to
 * one `run`. `flush()` runs a pending call immediately; `dispose()` flushes and
 * stops the timer.
 */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending = false
  private readonly run: () => Promise<void>
  private readonly delayMs: number

  constructor(run: () => Promise<void>, delayMs: number) {
    this.run = run
    this.delayMs = delayMs
  }

  schedule(): void {
    this.pending = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.delayMs)
    this.timer.unref?.()
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.pending) return
    this.pending = false
    await this.run()
  }

  async dispose(): Promise<void> {
    await this.flush()
  }
}
