/**
 * Host receiver of the `pool/*` Remotes: a Cordis service the Gateway resolves
 * by key and binds to the wire namespace. The descriptors come from the
 * `./typert` artifact; this class only answers the calls.
 *
 * @module dsh-account-pool/remote/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type { PoolControl, PoolReport } from '../control.ts'
import { REMOTE_NAMESPACE, REMOTE_SERVICE, type PoolCatalog } from './wire.ts'

export class PoolRemoteService extends TypertRemoteService {
  private readonly control: PoolControl

  constructor(ctx: Context, control: PoolControl) {
    super(ctx, REMOTE_SERVICE, { namespace: REMOTE_NAMESPACE })
    this.control = control
  }

  report(): Promise<PoolReport> {
    return this.control.report()
  }

  models(): Promise<PoolCatalog> {
    return this.control.models()
  }

  async switchAccount(provider: string, accountId: string | null): Promise<PoolReport> {
    await this.control.switchAccount(provider, accountId)
    return this.control.report()
  }

  async clear(provider?: string): Promise<PoolReport> {
    await this.control.clear(provider)
    return this.control.report()
  }
}
