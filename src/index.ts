/**
 * dsh-account-pool: multi-account rotation and quota tracking for the
 * OpenCode Go and Open Design provider routes (Command Code follows).
 *
 * @module dsh-account-pool
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls in the settings service augmentation for Context.
import type {} from '@deepseek-ai/dsh-settings'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { Config, plainConfig } from './config.ts'
import { PoolControl } from './control.ts'
import { UsageLedger } from './pool/ledger.ts'
import { QuotaCache } from './pool/quota-cache.ts'
import { StateStore } from './pool/state-store.ts'
import { mountCommandCode } from './providers/commandcode/mount.ts'
import { opencodeDriver, OPENCODE_API_BASE } from './providers/opencode/driver.ts'
import { opendesignDriver, OPENDESIGN_API_BASE } from './providers/opendesign/driver.ts'
import { mountOpenAiCompat } from './providers/openai-compat/mount.ts'
import { registerRoute, type SharedServices } from './providers/pool-wiring.ts'
import { POOL_PROVIDER } from './pooling.ts'
import { PoolRouteAdapter } from './providers/pool-route.ts'
import { PoolRemoteService } from './remote/service.ts'

export { Config }
export const name = 'llm-account-pool'
export const inject = ['llm']

export function apply(ctx: Context, live: object): void {
  const config = () => plainConfig(live)
  const warn = (what: string) => (error: unknown) => { ctx.logger.warn(`${name}: ${what}: ${String(error)}`) }
  const store = new StateStore(dshHomePath('storages', 'dsh-account-pool', 'state.json'), warn('could not persist rotation state'))
  const ledger = new UsageLedger(dshHomePath('storages', 'dsh-account-pool', 'ledger.json'), warn('could not persist the usage ledger'))
  void store.load()
  void ledger.load()
  ctx.effect(() => () => { void store.flush(); void ledger.flush() }, `${name}: durable state`)

  const shared: SharedServices = {
    store,
    ledger,
    quota: new QuotaCache(),
    rotation: () => ({
      switchAtPercent: config().rotation?.switchAtPercent ?? 100,
      cooldownMs: config().rotation?.cooldownMs ?? 300_000,
    }),
    order: () => config().order ?? [],
  }

  const handles = [mountOpenAiCompat(ctx, shared, {
    driver: opencodeDriver,
    defaultRef: 'OPENCODE_API_KEY',
    defaultApiBase: OPENCODE_API_BASE,
    seedModels: ['deepseek-v4.1-flash'],
    section: () => config().opencode ?? {},
    quotaExtras: (section) => ({ monthlyUsd: section.monthlyUsd }),
  }).handle, mountOpenAiCompat(ctx, shared, {
    driver: opendesignDriver,
    defaultRef: 'OPENDESIGN_API_KEY',
    defaultApiBase: OPENDESIGN_API_BASE,
    seedModels: ['deepseek-v4.1-flash'],
    section: () => config().opendesign ?? {},
  }).handle, mountCommandCode(ctx, shared, () => config().commandcode ?? {})]

  registerRoute(ctx, POOL_PROVIDER, 'Account pool', new PoolRouteAdapter({
    members: handles,
    ledger,
    order: shared.order,
    onRotate: (info) => { ctx.logger.info(`${name}: pool account "${info.slotId}" rejected (${info.reason}); trying the next account`) },
  }), ['order'])

  const control = new PoolControl({
    handles,
    ledger,
    settingsNs: name,
    mutateSettings: (ns, ops) => {
      const settings = ctx.get('settings')
      if (settings === undefined) return Promise.reject(new Error('the settings service is not available'))
      return settings.mutate(ns, ops)
    },
  })
  new PoolRemoteService(ctx, control)
}
