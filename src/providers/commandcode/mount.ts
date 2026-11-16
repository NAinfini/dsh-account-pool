/**
 * Mounts the Command Code provider: its account pool, model catalog, adapter
 * and the rotating wrapper registered as the `commandcode` route.
 *
 * @module dsh-account-pool/providers/commandcode/mount
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import type { CommandCodeConfig } from '../../config.ts'
import type { AccountSlot } from '../../pool/account-pool.ts'
import { RotatingAdapter } from '../openai-compat/rotating-adapter.ts'
import { createProviderPool, registerRoute, slotsOf, type ProviderHandle, type SharedServices } from '../pool-wiring.ts'
import { CommandCodeAdapter } from './adapter.ts'
import { readCliAuthKey } from './auth-file.ts'
import { CATALOG_TTL_MS, CommandCodeCatalog } from './catalog.ts'
import { commandcodeDriver } from './driver.ts'
import { DEFAULT_API_BASE } from './wire.ts'

export const COMMANDCODE_DEFAULT_REF = 'COMMANDCODE_API_KEY'

export function mountCommandCode(ctx: Context, shared: SharedServices, section: () => CommandCodeConfig): ProviderHandle {
  const owner = 'llm-account-pool:commandcode'
  const provider = commandcodeDriver.id

  // The official CLI's auth file backs the default account only.
  const slots = (): AccountSlot[] => slotsOf(section(), COMMANDCODE_DEFAULT_REF, commandcodeDriver.displayName)
    .map((slot) => (slot.id === COMMANDCODE_DEFAULT_REF ? { ...slot, fallback: readCliAuthKey } : slot))

  const parts = createProviderPool(ctx, shared, {
    driver: commandcodeDriver,
    defaultRef: COMMANDCODE_DEFAULT_REF,
    defaultApiBase: DEFAULT_API_BASE,
    section,
    slots,
  })
  const { pool, apiBase } = parts

  const catalog = new CommandCodeCatalog(
    dshHomePath('storages', 'dsh-account-pool', 'models-commandcode.json'),
    (error) => { ctx.logger.warn(`${owner}: model discovery failed: ${String(error)}`) },
  )
  const refreshCatalog = async (): Promise<void> => {
    if (catalog.stale(apiBase()) && await catalog.refresh(apiBase())) {
      ctx.logger.info(`${owner}: discovered ${catalog.list(apiBase()).length} model(s)`)
    }
  }
  void catalog.load().then(() => refreshCatalog())
  ctx.effect(() => {
    const timer = setInterval(() => { void refreshCatalog() }, CATALOG_TTL_MS)
    timer.unref?.()
    return () => { clearInterval(timer) }
  }, `${owner}: catalog refresh`)

  const inner = new CommandCodeAdapter({
    provider,
    displayName: commandcodeDriver.displayName,
    apiBase,
    workingDir: () => section().workingDir?.trim() || process.cwd(),
    requestTimeoutMs: () => section().requestTimeoutMs,
    streamIdleTimeoutMs: () => section().streamIdleTimeoutMs,
    models: () => catalog.list(apiBase()),
  })

  const adapter = new RotatingAdapter({
    provider,
    inner,
    pool,
    ledger: shared.ledger,
    visibleModels: () => section().visibleModels,
    onRotate: (info) => {
      ctx.logger.info(`${owner}: account "${info.slotId}" rejected (${info.reason}); trying the next account`)
    },
  })
  registerRoute(ctx, provider, commandcodeDriver.displayName, adapter)

  return { ...parts, inner, models: () => adapter.allModels(provider) }
}
