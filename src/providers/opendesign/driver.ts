/**
 * Open Design.
 *
 * The model API (`https://amr-link.open-design.ai/v1`, OpenAI Chat Completions)
 * takes a model key (`sk-amr-…`). Quota lives on a separate control API
 * (`https://amr-api.open-design.ai`, `billing/preflight`) that needs a
 * *control key* (`vela_ctrl_…`) and a workspace id. The response shape of that
 * endpoint is not known yet, so this driver deliberately reports no windows
 * rather than inventing a parser: rotation then relies on 429s alone and the UI
 * shows "quota unavailable". The parser lands once a real sample exists.
 *
 * @module dsh-account-pool/providers/opendesign/driver
 */

import type { QuotaSnapshot } from '../../pool/types.ts'
import type { ProviderDriver } from '../driver.ts'

export const OPENDESIGN_API_BASE = 'https://amr-link.open-design.ai/v1'
export const OPENDESIGN_CONTROL_BASE = 'https://amr-api.open-design.ai'

export const opendesignDriver: ProviderDriver = {
  id: 'opendesign',
  displayName: 'Open Design',
  fetchQuota(): Promise<QuotaSnapshot> {
    return Promise.resolve({ windows: [], fetchedAt: Date.now(), error: 'quota endpoint not implemented yet' })
  },
}
