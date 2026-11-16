/**
 * Durable rotation state.
 *
 * Only facts that came from a real rejection are stored: a preflight skip is
 * derived from the live quota snapshot and is never written here, so a
 * snapshot that later turns out wrong cannot keep an account out. Keys are
 * never stored; allowances are identified by an HMAC fingerprint under a
 * per-installation random salt, used for matching only.
 *
 * @module dsh-account-pool/pool/state-store
 */

import { createHmac, randomBytes } from 'node:crypto'

import { Debouncer, readJsonSafe, writeJsonAtomic } from './persist.ts'
import type { AccountState } from './types.ts'

const VERSION = 1

/** Longest a stored cooldown is honoured after a restart (one week). */
const MAX_RESTORED_MS = 7 * 24 * 60 * 60_000

interface StoredFile {
  version: number
  salt: string
  /** Allowance fingerprint → state (cooldown / unknown). */
  scopes: Record<string, AccountState>
  /** Key fingerprint → state (disabled). */
  keys: Record<string, AccountState>
}

/** The in-memory view of the durable state plus its fingerprint helper. */
export class StateStore {
  private salt = randomBytes(16).toString('hex')
  readonly scopes = new Map<string, AccountState>()
  readonly keys = new Map<string, AccountState>()
  private readonly writer: Debouncer
  private readonly path: string
  private readonly onError: (error: unknown) => void

  constructor(path: string, onError: (error: unknown) => void, debounceMs = 2_000) {
    this.path = path
    this.onError = onError
    this.writer = new Debouncer(() => this.write(), debounceMs)
  }

  /** HMAC fingerprint of any identity string; stable for this installation. */
  fingerprint(identity: string): string {
    return createHmac('sha256', this.salt).update(identity).digest('hex').slice(0, 16)
  }

  /** Load the file, dropping expired cooldowns and any damaged content. */
  async load(now = Date.now()): Promise<void> {
    const raw = await readJsonSafe(this.path, (error) => { this.onError(error) })
    if (typeof raw !== 'object' || raw === null) return
    const file = raw as Partial<StoredFile>
    if (file.version !== VERSION || typeof file.salt !== 'string' || file.salt === '') return
    this.salt = file.salt
    for (const [id, state] of Object.entries(file.scopes ?? {})) {
      if ((state.kind === 'cooldown' || state.kind === 'unknown') && state.until > now && state.until - now <= MAX_RESTORED_MS) {
        this.scopes.set(id, state)
      }
    }
    for (const [id, state] of Object.entries(file.keys ?? {})) {
      if (state.kind === 'disabled') this.keys.set(id, state)
    }
  }

  /** Record that the in-memory state changed. */
  changed(): void {
    this.writer.schedule()
  }

  async flush(): Promise<void> {
    await this.writer.flush()
  }

  private async write(): Promise<void> {
    const file: StoredFile = {
      version: VERSION,
      salt: this.salt,
      scopes: Object.fromEntries(this.scopes),
      keys: Object.fromEntries(this.keys),
    }
    try {
      await writeJsonAtomic(this.path, file)
    } catch (error) {
      this.onError(error)
    }
  }
}
