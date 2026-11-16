/**
 * The slot service the client renderer provides, restated here because the
 * renderer package is not a dependency of this plugin. Only the surface this
 * plugin touches is declared.
 */

import type { ComponentType } from 'react'

declare module '@deepseek-ai/cordis' {
  interface SlotRegistration {
    name: string
    id?: string
    key?: string
    order?: number
    locale?: string
    label?: () => string
    inject?: () => Record<string, unknown>
  }

  interface Context {
    slots: {
      register(registration: SlotRegistration, component: ComponentType<any>): (() => void) | void
      inject(name: string, callback: () => (() => void) | void): void
    }
  }
}
