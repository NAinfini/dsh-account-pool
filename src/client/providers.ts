/**
 * What the browser needs to know about each provider. Mirrors the Host's
 * drivers (names, default credential reference, default endpoint); kept here
 * because the client bundle cannot import Host code.
 *
 * @module dsh-account-pool/client/providers
 */

export type ProviderKey = 'commandcode' | 'opencode' | 'opendesign'

export interface ProviderMeta {
  id: ProviderKey
  name: string
  /** Credential reference standing in when the account list is empty. */
  defaultRef: string
  defaultApiBase: string
  /** Windows the provider meters, in display order. */
  windows: readonly ('5h' | '7d' | '30d')[]
}

export const PROVIDERS: readonly ProviderMeta[] = [
  { id: 'commandcode', name: 'Command Code', defaultRef: 'COMMANDCODE_API_KEY', defaultApiBase: 'https://api.commandcode.ai', windows: ['5h', '7d'] },
  { id: 'opencode', name: 'OpenCode Go', defaultRef: 'OPENCODE_API_KEY', defaultApiBase: 'https://opencode.ai/zen/go/v1', windows: ['5h', '7d', '30d'] },
  { id: 'opendesign', name: 'Open Design', defaultRef: 'OPENDESIGN_API_KEY', defaultApiBase: 'https://amr-link.open-design.ai/v1', windows: ['5h', '7d'] },
]

export const providerMeta = (id: string): ProviderMeta | undefined => PROVIDERS.find((provider) => provider.id === id)
