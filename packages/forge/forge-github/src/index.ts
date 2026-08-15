/**
 * GitHub ForgeGateway provider.
 *
 * Holds the only GitHub credential in the process. The token is never passed
 * into the agent workspace or a validation subprocess.
 */
import type { ForgeCapability } from '@dshrb/forge'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dshrb-forge-github'
export const inject = ['forges']

export const CAPABILITIES: readonly ForgeCapability[] = [
  'diff-source', 'comment-sink', 'inline-comments', 'sticky-comment',
  'actor-resolver', 'check-reader', 'mutation-sink',
]

export interface Config {
  token: string
  /** GitHub Enterprise Server base URL. */
  baseUrl: string
}

export const Config: Schema<Config> = Schema.object({
  token: Schema.string().required(),
  baseUrl: Schema.string().default('https://api.github.com'),
})

export function apply(_ctx: Context, _config: Config): void {
  // TODO(M1): register a gateway implementing DiffSource, CommentSink,
  //           ActorResolver, CheckReader, MutationSink.
  // TODO(M1): inline comments use path + line + side + commit_id.
  // TODO(M1): map the `permission` field onto ForgePermission.
  // TODO(M1): isFork reads head.repo.fork.
  // TODO(M1): per-finding idempotency key hash(path + anchor + ruleId) so a
  //           retry after partial publish does not duplicate comments.
  throw new Error('not implemented: M1')
}
