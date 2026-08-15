/**
 * ForgeGateway capability interfaces and the provider registry.
 *
 * Capabilities are split into narrow interfaces so a provider implements only
 * what its platform supports. `review-runtime` checks required capabilities at
 * startup, so a missing capability degrades explicitly instead of failing
 * halfway through a run. See docs/06-forge-abstraction.md.
 */
import type {
  Anchor, ChangeRequestId, CommentId, CommitSha, Finding, ForgeId, Patch, ReviewTarget,
} from '@dshrb/review-core'

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
  fetchFile(path: string, sha: CommitSha): Promise<string>
}

export interface CommentSink extends ForgeGateway {
  createComment(target: ReviewTarget, body: string): Promise<CommentId>
  updateComment(id: CommentId, body: string): Promise<void>
  createInlineComments(target: ReviewTarget, findings: readonly Finding[]): Promise<PublishStats>
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

export declare function createForgeRegistry(): ForgeRegistry

export type { ChangeRequestId }
