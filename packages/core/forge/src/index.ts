/**
 * ForgeGateway capability interfaces and the provider registry.
 *
 * Capabilities are split into narrow interfaces so a provider implements only
 * what its platform supports. `review-runtime` checks required capabilities at
 * startup, so a missing capability degrades explicitly instead of failing
 * halfway through a run. See docs/06-forge-abstraction.md.
 */
import { createHash } from 'node:crypto'
import { anchorAt, anchorFallback } from '@dshrb/review-core'
import type {
  Anchor, ChangeRequestId, CommentId, CommitSha, Finding, ForgeId, Patch, ReviewTarget,
} from '@dshrb/review-core'
import type { Context } from '@deepseek-ai/cordis'

export type ForgeCapability =
  | 'diff-source' | 'comment-sink' | 'inline-comments' | 'sticky-comment'
  | 'actor-resolver' | 'check-reader' | 'mutation-sink'

/** Normalized permission, mapped from each platform's own scheme. */
export type ForgePermission = 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin'

export interface UnifiedDiff {
  readonly files: readonly DiffFile[]
}

export interface DiffFile {
  readonly path: string
  readonly previousPath?: string
  readonly hunks: readonly DiffHunk[]
  readonly binary: boolean
}

export interface DiffHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly text: string
}

export interface BotIdentity {
  /** Numeric id, not a login: logins can be renamed, ids cannot. */
  readonly id: string
  readonly login: string
}

export interface CheckRun {
  readonly id: string
  readonly name: string
  readonly conclusion: 'failure' | 'cancelled' | 'timed_out' | 'success' | 'neutral'
}

export interface PublishStats {
  readonly published: number
  readonly degradedToSummary: number
  readonly failed: number
}

export interface ForgeGateway {
  readonly id: ForgeId
  readonly capabilities: readonly ForgeCapability[]
}

export interface DiffSource extends ForgeGateway {
  fetchDiff(target: ReviewTarget): Promise<UnifiedDiff>
  /**
   * `repo` is explicit because no forge can route a blob read without it, and
   * `CommitSha` does not carry one. It also matches `CheckReader`, which took a
   * `repo` from the start.
   */
  fetchFile(repo: string, path: string, sha: CommitSha): Promise<string>
}

export interface CommentSink extends ForgeGateway {
  createComment(target: ReviewTarget, body: string): Promise<CommentId>
  /** `repo` for the same reason as `DiffSource.fetchFile`: a `CommentId` alone is not routable. */
  updateComment(repo: string, id: CommentId, body: string): Promise<void>
  /**
   * `botId` is required so only the bot's own comments contribute idempotency
   * keys: a marker written by anyone else is forgeable and must not suppress a
   * finding.
   */
  createInlineComments(target: ReviewTarget, findings: readonly Finding[], botId: string): Promise<PublishStats>
  /**
   * Returns a sticky comment only when it was authored by `botId` AND carries
   * our own first-line marker. A forged marker must be ignored, never updated.
   */
  findStickyComment(target: ReviewTarget, marker: string, botId: string): Promise<CommentId | undefined>
}

export interface ActorResolver extends ForgeGateway {
  resolvePermission(repo: string, actorLogin: string): Promise<ForgePermission>
  isFork(target: ReviewTarget): Promise<boolean>
  botIdentity(): Promise<BotIdentity>
}

export interface CheckReader extends ForgeGateway {
  listFailedChecks(repo: string, sha: CommitSha): Promise<readonly CheckRun[]>
  fetchLog(repo: string, checkId: string): Promise<string>
}

export interface MutationSink extends ForgeGateway {
  commitPatches(
    repo: string, branch: string, patches: readonly Patch[], message: string,
  ): Promise<CommitSha>
  openPullRequest(spec: PullRequestSpec): Promise<string>
}

export interface PullRequestSpec {
  readonly repo: string
  readonly headBranch: string
  readonly baseBranch: string
  readonly title: string
  readonly body: string
}

/**
 * Resolves a provider by id. Registration is effect-based in the plugin layer:
 * disposing the owning fiber unregisters the provider.
 */
export interface ForgeRegistry {
  register(gateway: ForgeGateway): () => void
  resolve(id: ForgeId): ForgeGateway | undefined
  /** Throws with the missing capability list rather than failing mid-pipeline. */
  require<T extends ForgeGateway>(id: ForgeId, caps: readonly ForgeCapability[]): T
}

/**
 * Maps a finding onto platform-specific inline comment coordinates.
 * Anchoring failure must degrade to a summary entry, never silently drop:
 * a misplaced comment is worse than a summary entry, but losing a real
 * problem is not acceptable either.
 */
export interface AnchorResolver {
  resolve(diff: UnifiedDiff, path: string, line: number): Anchor
}

/**
 * Per-finding publish idempotency key: `hash(path + anchor + ruleId)`, per
 * docs/06-forge-abstraction.md. A retry after a `publish_partial` failure
 * recomputes the same key for an already-published finding, so the provider can
 * skip it instead of posting a duplicate comment.
 *
 * This is deliberately NOT `findingDedupeKey` from review-core. That one merges
 * the same problem reported from two diff shards, so it folds in the title and
 * ignores `side`/`anchored`. This one identifies a published comment's location,
 * so it must include the full anchor and must NOT include the title: a reworded
 * body on retry has to update the same comment, not create a second one.
 *
 * Lives here rather than in the GitHub provider because every provider needs
 * byte-identical behavior to pass the shared conformance suite (docs/06).
 *
 * Fields are JSON-encoded before hashing so that a `ruleId` containing the
 * delimiter cannot shift field boundaries and forge a collision.
 */
export function publishIdempotencyKey(finding: Finding): string {
  const { anchor } = finding
  const encoded = JSON.stringify([
    anchor.path,
    anchor.line,
    anchor.side,
    anchor.anchored,
    finding.ruleId ?? '',
  ])
  return createHash('sha256').update(encoded, 'utf8').digest('hex')
}

/**
 * Resolves a proposed `path` + `line` onto diff coordinates.
 *
 * Anchoring is forced to land inside a hunk (docs/09-roadmap.md risk register):
 * a comment on the wrong line damages trust more than a summary entry, but
 * silently dropping a real problem is not acceptable either. A line inside a
 * hunk anchors with the matching side; a line in no hunk degrades to a
 * fallback anchor that records why — it is still returned, never dropped.
 *
 * The resolver assumes the caller has already normalized the path and line
 * (`validate()` does this before anchoring, because anchoring a raw path would
 * silently land on the wrong file). It therefore uses `anchorAt` /
 * `anchorFallback`, which enforce the safe-path / positive-line invariant at
 * construction time rather than fabricating a contradictory anchor.
 */
export function createAnchorResolver(): AnchorResolver {
  return { resolve }
}

function resolve(diff: UnifiedDiff, path: string, line: number): Anchor {
  const file = diff.files.find((candidate) => candidate.path === path || candidate.previousPath === path)
  if (file === undefined) {
    return anchorFallback(path, line, `file '${path}' is not in the diff`)
  }
  if (file.binary) {
    return anchorFallback(path, line, `file '${path}' is binary and has no diff lines to anchor to`)
  }
  // The model reports new-side line numbers, so try the right side first. A
  // line lands on the left only when it names a removed line.
  for (const hunk of file.hunks) {
    if (line >= hunk.newStart && line < hunk.newStart + hunk.newLines) {
      return anchorAt(path, line, 'right')
    }
    if (line >= hunk.oldStart && line < hunk.oldStart + hunk.oldLines) {
      return anchorAt(path, line, 'left')
    }
  }
  return anchorFallback(path, line, `line ${line} is outside every diff hunk in '${path}'`)
}

export function createForgeRegistry(): ForgeRegistry {
  const gateways = new Map<string, ForgeGateway>()
  return {
    register(gateway) {
      gateways.set(gateway.id, gateway)
      return () => {
        gateways.delete(gateway.id)
      }
    },
    resolve(id) {
      return gateways.get(id)
    },
    require: <T extends ForgeGateway>(id: ForgeId, caps: readonly ForgeCapability[]): T => {
      const gateway = gateways.get(id)
      if (gateway === undefined) {
        throw new Error(`no forge provider registered for '${id}'`)
      }
      const missing = caps.filter((cap) => !gateway.capabilities.includes(cap))
      if (missing.length > 0) {
        throw new Error(`forge '${id}' is missing required capabilities: ${missing.join(', ')}`)
      }
      return gateway as unknown as T
    },
  }
}

export const name = 'dshrb-forge'

export function apply(ctx: Context): void {
  // `ctx.provide` is fiber-owned: the service unregisters when this plugin's
  // fiber unloads, which deactivates every `inject: ['forges']` provider.
  ctx.provide('forges', createForgeRegistry())
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    forges: ForgeRegistry
  }
}

// Re-exported because they appear in this module's own public signatures
// (`ForgeGateway.id`, `resolve`, `require`), so a consumer cannot name them
// without reaching past this package into review-core.
export type { ChangeRequestId, ForgeId }
