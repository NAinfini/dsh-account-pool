/**
 * Browser half of dsh-account-pool: the "Account pool" settings page, the
 * optional sidebar card and the usage panel.
 *
 * Data paths:
 *   - settings section (`llm-account-pool`) → `ctx.configForms`
 *   - API keys (write-only)                 → the `credentials` Remote
 *   - quota, usage, pin, clear              → the `pool/*` Remote mounted here
 *
 * @module dsh-account-pool/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

import { TYPERT_REMOTE } from '../remote.ts'
import { SettingsController, type ControllerDeps, type PoolApi } from './controller.ts'
import { en, zh } from './locales.ts'
import { AccountPoolPage, type PageActions } from './section.tsx'
import { createSnapshotStore } from './snapshot-store.ts'
import { PAGE_CSS, PAGE_CSS_ID } from './styles.ts'
import { PANEL_ID, PoolCard, UsagePanel } from './surfaces.tsx'

/** The settings namespace the Host plugin owns. */
const NS = 'llm-account-pool'
const LOCALE = 'settings.account-pool'
const CARD_FLAG = 'dap.sidebarCard'

function injectPageCss(): void {
  if (document.querySelector(`style[data-plugin-css="${PAGE_CSS_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = PAGE_CSS_ID
  tag.textContent = PAGE_CSS
  document.head.append(tag)
}

function readCardFlag(): boolean {
  try {
    return localStorage.getItem(CARD_FLAG) === '1'
  } catch {
    return false
  }
}

function writeCardFlag(enabled: boolean): void {
  try {
    localStorage.setItem(CARD_FLAG, enabled ? '1' : '0')
  } catch {
    // The choice then lasts only for this session.
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function apply(ctx: Context): void {
  injectPageCss()
  ctx.effect(() => ctx.locale.register(LOCALE, { zh, en }), 'dsh-account-pool: copy')
  // Keys are written through the credentials Remote; without it the page has no
  // writable key path, so nothing is mounted.
  ctx.inject(['remote.credentials'], (remoteCtx) => {
    mountSurfaces(remoteCtx, (remoteCtx.remote as unknown as { credentials: ControllerDeps['credentials'] }).credentials)
  })
}

function mountSurfaces(ctx: Context, credentials: ControllerDeps['credentials']): void {
  let pool: PoolApi | undefined
  let poolError: string | undefined = 'the pool service is still starting'

  const controller = new SettingsController({
    scope: ctx.configForms.get<Record<string, unknown>>(NS) as ControllerDeps['scope'],
    credentials,
    pool: () => pool,
    poolError: () => poolError,
    now: () => Date.now(),
  })
  ctx.effect(() => () => { controller.dispose() }, 'dsh-account-pool: controller')
  const store = createSnapshotStore(controller.state())
  controller.subscribe(() => { store.set(controller.state()) })
  ctx.effect(
    () => (ctx.remote as unknown as {
      $on(event: 'credentials/reference-updated', listener: () => void): () => void
    }).$on('credentials/reference-updated', () => { void controller.refreshCredentials() }),
    'dsh-account-pool: credential invalidations',
  )

  // Mount the Remote, then resolve its namespace through a scoped inject (the
  // service only exists after the mount, so a static inject would deadlock).
  ctx.effect(() => {
    let cancelled = false
    let unmount: (() => Promise<void>) | undefined
    ctx.remote.$mount(TYPERT_REMOTE).then((dispose: () => Promise<void>) => {
      if (cancelled) {
        void dispose()
        return
      }
      unmount = dispose
      ctx.inject(['remote.pool'], (poolCtx) => {
        pool = (poolCtx.remote as unknown as { pool: PoolApi }).pool
        poolError = undefined
        void controller.refresh()
        poolCtx.effect(() => () => { pool = undefined; poolError = 'the pool service went away' }, 'dsh-account-pool: pool namespace')
      })
    }, (error: unknown) => {
      poolError = message(error)
      console.error('[dsh-account-pool] could not mount the pool Remote:', poolError)
      controller.refresh().catch(() => undefined)
    })
    return () => {
      cancelled = true
      pool = undefined
      if (unmount !== undefined) void unmount()
    }
  }, 'dsh-account-pool: pool remote')

  const cardStore = createSnapshotStore(readCardFlag())
  const actions: PageActions = {
    setProvider: (provider) => { controller.setProvider(provider) },
    refresh: () => { void controller.refresh() },
    pin: (provider, id) => { void controller.pin(provider, id) },
    clearMarks: (provider) => { void controller.clearMarks(provider) },
    addAccount: (provider) => { controller.addAccount(provider) },
    removeAccount: (provider, id) => { controller.removeAccount(provider, id) },
    moveEntry: (key, delta) => { controller.moveEntry(key, delta) },
    editLabel: (provider, id, label) => { controller.editLabel(provider, id, label) },
    editKey: (provider, id, key) => { controller.editKey(provider, id, key) },
    toggleModel: (provider, id, checked) => { controller.toggleModel(provider, id, checked) },
    showAllModels: (provider) => { controller.showAllModels(provider) },
    addRule: (provider) => { controller.addRule(provider) },
    editRule: (provider, index, patch) => { controller.editRule(provider, index, patch) },
    removeRule: (provider, index) => { controller.removeRule(provider, index) },
    editApiBase: (provider, value) => { controller.editApiBase(provider, value) },
    editRotation: (patch) => { controller.editRotation(patch) },
    save: () => { void controller.save() },
    discard: () => { controller.discard() },
    setCard: (enabled) => { writeCardFlag(enabled); cardStore.set(enabled) },
  }

  let layout: { selectPanel(id: string | null): void } | undefined
  ctx.inject(['layout'], (scoped) => { layout = (scoped as unknown as { layout: typeof layout }).layout })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'account-pool',
    order: 12,
    label: () => ctx.locale.bind(LOCALE)('nav'),
    locale: LOCALE,
    inject: () => ({ hooks: { pool: store, card: cardStore }, actions }),
  }, AccountPoolPage))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: LOCALE,
    inject: () => ({ hooks: { pool: store }, refresh: actions.refresh, close: () => { layout?.selectPanel(null) } }),
  }, UsagePanel))

  // The card is opt-in (settings page toggle) and only exists while enabled.
  ctx.effect(() => {
    let offCard: (() => void) | undefined
    const sync = () => {
      const enabled = cardStore.getSnapshot()
      if (enabled && offCard === undefined) {
        const off = ctx.slots.register({
          name: 'sidebar.footer.action',
          id: PANEL_ID,
          locale: LOCALE,
          inject: () => ({ hooks: { pool: store }, openPanel: () => { layout?.selectPanel(PANEL_ID) } }),
        }, PoolCard)
        offCard = typeof off === 'function' ? off : () => undefined
      } else if (!enabled && offCard !== undefined) {
        offCard()
        offCard = undefined
      }
    }
    sync()
    const unsubscribe = cardStore.subscribe(sync)
    return () => { unsubscribe(); offCard?.() }
  }, 'dsh-account-pool: sidebar card')
}

export const inject: readonly string[] = ['slots', 'locale', 'connection', 'remote', 'configForms']
