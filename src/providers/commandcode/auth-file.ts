/**
 * The official Command Code CLI's auth file (`~/.commandcode/auth.json`), used
 * as the last-resort key for the default account so a user who already ran
 * `command-code login` works without pasting anything. Only the official CLI's
 * own file is read; other tools' auth files are deliberately not scanned.
 *
 * @module dsh-account-pool/providers/commandcode/auth-file
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

function keyFromRecord(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === 'api') return str(value.key)
  if (value.type === 'oauth') return str(value.access)
  return str(value.key) ?? str(value.access)
}

/** Read the key out of one parsed auth document. */
export function keyFromAuthDocument(document: unknown): string | undefined {
  if (!isRecord(document)) return undefined
  return str(document.apiKey) ?? str(document.commandcode)
    ?? keyFromRecord(document.commandcode) ?? keyFromRecord(document['command-code'])
}

/** The CLI's key, or undefined when the file is missing or unreadable. */
export function readCliAuthKey(): string | undefined {
  try {
    return keyFromAuthDocument(JSON.parse(readFileSync(join(homedir(), '.commandcode', 'auth.json'), 'utf8')))
  } catch {
    return undefined
  }
}
