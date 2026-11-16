/**
 * Wire contract of the `pool/*` Remotes, shared by the Host registration
 * (`src/typert.ts`) and the browser mount (`src/remote.ts`).
 *
 * Dependency-free on purpose: the client bundle inlines it, so only
 * `import type` edges leave this file. Results are checked for shape at the
 * boundary but not field-by-field: the Host produces them from its own typed
 * state, the types below are the single source both halves compile against.
 *
 * @module dsh-account-pool/remote/wire
 */

import type { InvocationDescriptor, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'

import type { CatalogEntry, PoolReport } from '../control.ts'

export type { AccountReport, AccountStatus, CatalogEntry, PoolReport, ProviderReport } from '../control.ts'

export const REMOTE_PACKAGE = 'dsh-account-pool'
/** Cordis service key the Gateway resolves the receiver from. */
export const REMOTE_SERVICE = 'accountPool'
export const REMOTE_NAMESPACE = 'pool'

/** Catalog result: provider id → every model the route serves. */
export type PoolCatalog = Record<string, CatalogEntry[]>

const objectSchema = <T>(what: string): TypertSchema<T> => ({
  parse(value: unknown): T {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`pool/${what} result: not an object`)
    return value as T
  },
})

const stringSchema: TypertSchema<string> = {
  parse(value: unknown): string {
    if (typeof value !== 'string') throw new TypeError('pool parameter: expected a string')
    return value
  },
}

const nullableStringSchema: TypertSchema<string | null> = {
  parse(value: unknown): string | null {
    if (value !== null && typeof value !== 'string') throw new TypeError('pool parameter: expected a string or null')
    return value
  },
}

const codec = (typeSymbol: string, schema: TypertSchema) => ({ mode: 'strict' as const, typeSymbol, create: () => schema })

const parameter = (name: string, typeSymbol: string, schema: TypertSchema, optional = false) => ({
  name,
  wire: name,
  source: 'json' as const,
  codec: codec(typeSymbol, schema),
  ...(optional ? { acceptsUndefined: true as const } : {}),
})

function descriptor(
  method: string,
  parameters: InvocationDescriptor['parameters'],
  result: TypertSchema,
): InvocationDescriptor {
  return {
    id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_SERVICE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: codec(`${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}:result`, result),
  }
}

/** Every `pool/*` invocation descriptor, in registration order. */
export const POOL_DESCRIPTORS: readonly InvocationDescriptor[] = [
  descriptor('report', [], objectSchema<PoolReport>('report')),
  descriptor('models', [], objectSchema<PoolCatalog>('models')),
  descriptor('switchAccount', [
    parameter('provider', `${REMOTE_PACKAGE}#pool/switchAccount:provider`, stringSchema),
    parameter('accountId', `${REMOTE_PACKAGE}#pool/switchAccount:accountId`, nullableStringSchema),
  ], objectSchema<PoolReport>('switchAccount')),
  descriptor('clear', [
    parameter('provider', `${REMOTE_PACKAGE}#pool/clear:provider`, stringSchema, true),
  ], objectSchema<PoolReport>('clear')),
]
