/**
 * Domain vocabulary for DSH Reviewer Bot.
 *
 * This package is intentionally dependency-free and I/O-free: it declares what a
 * review IS, never how it is fetched or published. Every other package depends
 * on these types; nothing here depends on a forge, a model, or a transport.
 *
 * Contracts documented in docs/07-data-contracts.md.
 */

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** Opaque id for one review run; the key for replay snapshots. */
export type RequestId = Brand<string, 'RequestId'>
/** Forge provider id, e.g. `github`, `gitlab`, `local`. */
export type ForgeId = Brand<string, 'ForgeId'>
/**
 * Change request identifier, normalized across forges.
 *
 * For GitLab this is the project-scoped `iid`, never the global `id` — mixing
 * them posts comments onto an unrelated MR. See docs/06-forge-abstraction.md.
 */
export type ChangeRequestId = Brand<string, 'ChangeRequestId'>
export type CommentId = Brand<string, 'CommentId'>
export type CommitSha = Brand<string, 'CommitSha'>
export type FindingId = Brand<string, 'FindingId'>
export type RuleId = Brand<string, 'RuleId'>

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

/**
 * Capability tiers. Ordered least to most privileged, but never compare these
 * as strings — use the helpers in `@dshrb/trust-policy`, which encode the
 * fork and allow-write conditions that a bare ordering cannot express.
 */
export type TrustLevel = 'none' | 'untrusted' | 'trusted-read' | 'trusted-write'

/** What the agent is permitted to do under a resolved TrustLevel. */
export interface Capabilities {
  readonly readDiff: boolean
  readonly readRepoFiles: boolean
  readonly readCheckLogs: boolean
  readonly publishComments: boolean
  readonly proposePatches: boolean
  readonly commitPatches: boolean
}

// ---------------------------------------------------------------------------
// Intent and events
// ---------------------------------------------------------------------------

export type ReviewIntent = 'review' | 'explain' | 'diagnose' | 'fix' | 'rules' | 'none'

/** A forge webhook or CI event after normalization. Untrusted throughout. */
export interface NormalizedEvent {
  readonly forgeId: ForgeId
  /** Idempotency key: a repeat delivery must not produce repeat comments. */
  readonly deliveryId: string
  readonly kind: 'change-request' | 'comment' | 'check-failed'
  readonly target: ReviewTarget
  readonly actorLogin: string
  /** Raw comment body when kind is `comment`. Untrusted data, never a command. */
  readonly commentBody?: string
}

export interface ReviewTarget {
  readonly repo: string
  readonly changeRequestId: ChangeRequestId
  /** The trusted SHA to check out. Never the fork head. */
  readonly baseSha: CommitSha
  readonly headSha: CommitSha
  readonly isFork: boolean
}

export interface ReviewRequest {
  readonly requestId: RequestId
  readonly event: NormalizedEvent
  readonly intent: ReviewIntent
  readonly trust: TrustLevel
  readonly capabilities: Capabilities
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * `blocker` additionally requires a reproducible `failureScenario`; a claim
 * without one is downgraded to `major` during validation. That single rule
 * removes most "sounds severe but is a guess" noise.
 */
export type Severity = 'blocker' | 'major' | 'minor' | 'nit' | 'info'

/** Where a finding attaches in the diff. */
export interface Anchor {
  readonly path: string
  readonly line: number
  readonly side: 'left' | 'right'
  /** False when the line fell outside any diff hunk. */
  readonly anchored: boolean
  /** Present only when `anchored` is false; surfaced to the user, never dropped. */
  readonly fallbackReason?: string
}

export interface Finding {
  readonly findingId: FindingId
  readonly severity: Severity
  readonly title: string
  readonly body: string
  readonly anchor: Anchor
  readonly ruleId?: RuleId
  /** Concrete inputs or state leading to wrong output. Required for `blocker`. */
  readonly failureScenario?: string
  readonly suggestedPatch?: Patch
}

export interface Patch {
  readonly path: string
  /** Unified diff text. Validated against the path allowlist before apply. */
  readonly diff: string
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type ReviewStatus =
  | 'success'
  | 'neutral'
  | 'failed'
  | 'timed_out'
  | 'validation_failed'
  | 'denied'

/** Pipeline stage names; surfaced as `result-json.failure.phase`. */
export type Phase =
  | 'ingest'
  | 'route'
  | 'authorize'
  | 'context'
  | 'reason'
  | 'validate'
  | 'publish'
  | 'mutate'
  | 'report'

export interface Failure {
  readonly code: string
  readonly phase: Phase
  readonly title: string
  readonly message: string
  /** Actionable next step for the user; not a stack trace. */
  readonly guidance: string
  readonly retryable: boolean
}

export interface ValidationReport {
  readonly ran: boolean
  /** Commands as argv arrays — never shell strings. See docs/04-trust-model.md T3. */
  readonly commands: readonly (readonly string[])[]
  readonly passed: boolean
  readonly exitCodes: readonly number[]
}

export interface WriteResult {
  readonly appliedPatches: readonly Patch[]
  readonly commitSha?: CommitSha
  readonly pullRequestUrl?: string
  readonly validation: ValidationReport
}

export interface Verdict {
  readonly status: ReviewStatus
  readonly findingsCount: number
  readonly blockersCount: number
  readonly durationMs: number
}

export interface ReviewResult {
  readonly requestId: RequestId
  readonly verdict: Verdict
  readonly findings: readonly Finding[]
  /** Proposals rejected during validation, with reasons, for auditability. */
  readonly discarded: readonly DiscardedProposal[]
  readonly write?: WriteResult
  readonly failure?: Failure
  readonly stickyCommentId?: CommentId
}

export interface DiscardedProposal {
  readonly reason: string
  readonly rawTitle: string
}

/**
 * Untrusted model output before validation. Deliberately loose: every field is
 * optional and unbranded, so nothing can be consumed without passing through
 * the validator first.
 */
export interface RawProposal {
  readonly severity?: string
  readonly title?: string
  readonly body?: string
  readonly path?: string
  readonly line?: number
  readonly ruleId?: string
  readonly failureScenario?: string
  readonly patch?: { path?: string; diff?: string }
}
