/**
 * GitLab ForgeGateway provider.
 *
 * The iid trap: a merge request has both a global `id` and a project-scoped
 * `iid`. Note APIs take the `iid`, while webhook payloads carry both. Mixing
 * them posts comments onto an unrelated MR. This provider normalizes to `iid`
 * only, surfaced as `ChangeRequestId`. See docs/06-forge-abstraction.md.
 */
import type { ForgeCapability } from '@dshrb/forge'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dshrb-forge-gitlab'
export const inject = ['forges']

export const CAPABILITIES: readonly ForgeCapability[] = [
  'diff-source', 'comment-sink', 'inline-comments', 'sticky-comment',
  'actor-resolver', 'check-reader', 'mutation-sink',
]

export interface Config {
  token: string
  baseUrl: string
}

export const Config: Schema<Config> = Schema.object({
  token: Schema.string().required(),
  baseUrl: Schema.string().default('https://gitlab.com/api/v4'),
})

export function apply(_ctx: Context, _config: Config): void {
  // TODO(M4): implement against REST v4.
  // TODO(M4): inline notes need position: { base_sha, head_sha, start_sha,
  //           new_line, new_path } — richer than GitHub's shape.
  // TODO(M4): map numeric access_level onto ForgePermission.
  // TODO(M4): isFork compares source_project_id against target_project_id.
  // TODO(M4): CheckReader maps onto Pipelines/Jobs.
  // TODO(M4): must pass the shared provider conformance suite from
  //           @dshrb/forge before release — without it providers drift into
  //           three different semantics.
  throw new Error('not implemented: M4')
}
