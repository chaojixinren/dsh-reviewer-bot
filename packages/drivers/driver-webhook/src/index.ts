/**
 * Long-running webhook daemon driver.
 *
 * Trades a larger attack surface for no cold start: this process holds
 * credentials for many repositories and listens on the network, unlike the
 * one-shot Action. The hardening requirements in docs/08-deployment-modes.md
 * are not optional for this mode.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dshrb-driver-webhook'
export const inject = ['agents']

export interface Config {
  host: string
  port: number
  /** Per-forge webhook signing secrets. Read from KMS/Vault, never from disk. */
  secrets: Record<string, string>
  /** Concurrent reviews across repositories. Same-repo work stays serial to
   *  avoid workspace contention. */
  maxConcurrentRepos: number
  /** Queue depth per repository; beyond it, requests are shed with backpressure
   *  so one busy repo cannot starve the service. */
  maxQueuePerRepo: number
  /** Warm git workspace cache size. */
  workspacePoolSize: number
}

export const Config: Schema<Config> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.number().default(7723),
  secrets: Schema.dict(Schema.string()).default({}),
  maxConcurrentRepos: Schema.number().default(4),
  maxQueuePerRepo: Schema.number().default(16),
  workspacePoolSize: Schema.number().default(8),
})

export function apply(_ctx: Context, _config: Config): void {
  // TODO(M4): HTTP entry — verify the signature FIRST; on failure do not enqueue
  //           and do not echo the reason (it leaks whether a secret is close).
  // TODO(M4): dedupe by delivery id before enqueue.
  // TODO(M4): per-repo serial queue, cross-repo parallel, with backpressure.
  // TODO(M4): warm workspace pool doing incremental fetch only; strict
  //           per-repo isolation so no path escapes into a sibling repo.
  // TODO(M4): default bind is loopback — public exposure must be a deliberate
  //           operator choice behind a reverse proxy.
  throw new Error('not implemented: M4')
}
