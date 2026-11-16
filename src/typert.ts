/**
 * The `./typert` artifact the harness's typert loader registers for the Host:
 * the `pool/*` descriptors and an empty reflection model (the contract is
 * hand-written, so there is nothing for a generator to reflect).
 *
 * @module dsh-account-pool/typert
 */

import { POOL_DESCRIPTORS, REMOTE_PACKAGE } from './remote/wire.ts'

export const TYPERT = {
  package: REMOTE_PACKAGE,
  face: 'host' as const,
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: POOL_DESCRIPTORS,
}

export default TYPERT
