/**
 * The `./remote` artifact the browser mounts to call the `pool/*` Remotes.
 *
 * @module dsh-account-pool/remote
 */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

import { POOL_DESCRIPTORS, REMOTE_PACKAGE, type PoolCatalog, type PoolReport } from './remote/wire.ts'

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: REMOTE_PACKAGE,
  descriptors: POOL_DESCRIPTORS,
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'pool/report': () => Promise<RemoteResult<PoolReport>>
    'pool/models': () => Promise<RemoteResult<PoolCatalog>>
    'pool/switchAccount': (provider: string, accountId: string | null) => Promise<RemoteResult<PoolReport>>
    'pool/clear': (provider?: string) => Promise<RemoteResult<PoolReport>>
  }
  interface TypertRemoteNamespaceMap {
    pool: {
      report: () => Promise<RemoteResult<PoolReport>>
      models: () => Promise<RemoteResult<PoolCatalog>>
      switchAccount: (provider: string, accountId: string | null) => Promise<RemoteResult<PoolReport>>
      clear: (provider?: string) => Promise<RemoteResult<PoolReport>>
    }
  }
}

export default TYPERT_REMOTE
