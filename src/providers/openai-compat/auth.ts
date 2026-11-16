/**
 * Credential plumbing for the wrapped pi-ai adapter.
 *
 * The plugin hands the adapter an explicit key for every request, so the
 * pi-ai credential store never holds anything; the auth context only has to
 * answer the ambient lookups a provider performs while resolving a request.
 *
 * @module dsh-account-pool/providers/openai-compat/auth
 */

import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'

/** Resolve one credential reference through the credentials seam, else the launch environment. */
export async function resolveCredentialRef(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    // The seam layers the process environment, the managed store and `.env`
    // files itself: a miss here is genuinely unconfigured.
    return (await credentials.resolve(ref))?.value
  }
  const ambient = launchEnvironmentOf(ctx).get(ref)
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
}

export function buildAuth(ctx: Context, owner: string): PiAiAdapterOptions['auth'] {
  return {
    credentials: {
      async read(): Promise<undefined> { return undefined },
      async list(): Promise<never[]> { return [] },
      async modify(): Promise<never> {
        throw new LlmError(`${owner}: this provider stores no pi-ai credential records; manage keys in Settings → Account Pool`, 'NO_CREDENTIAL_STORE')
      },
      async delete(): Promise<void> {},
    },
    authContext: {
      async env(name: string): Promise<string | undefined> {
        if (isCredentialRefName(name)) {
          const hit = await ctx.get('credentials')?.resolve(credentialRef(name))
          if (hit !== undefined) return hit.value
        }
        return launchEnvironmentOf(ctx).get(name)?.value
      },
      async fileExists(path: string): Promise<boolean> {
        const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1).replace(/^\//, '')) : path
        try {
          await access(expanded)
          return true
        } catch {
          return false
        }
      },
    },
  } as unknown as PiAiAdapterOptions['auth']
}
