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

export type ReviewIntent = 'review' | 'explain' | 'diagnose' | 'fix' | 'rules' | 'accept' | 'forget' | 'none'

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

/**
 * A maintainer-accepted exception persisted across PRs (cross-PR memory).
 *
 * `key` is the `findingMemoryKey` of the finding that was accepted; the other
 * fields are the human-readable identity kept alongside it for audit and for
 * explaining WHY a later finding was suppressed (docs/07).
 */
export interface ResolvedException {
  /** The `findingMemoryKey` this exception suppresses. */
  readonly key: string
  readonly path: string
  readonly ruleId?: RuleId
  readonly title: string
  /** Why the finding was accepted; surfaced to future reviewers as context. */
  readonly reason: string
  /** Actor login that accepted it. */
  readonly resolvedBy: string
  /** The change request where it was accepted, when known. */
  readonly changeRequestId?: ChangeRequestId
  /** Epoch ms when it was accepted. */
  readonly resolvedAt: number
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
  | 'snapshot'
  | 'publish'
  | 'mutate'
  | 'memory'
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

export type ValidationEnforcement = 'full' | 'partial'

export interface ValidationReport {
  readonly ran: boolean
  /** Commands as argv arrays — never shell strings. See docs/04-trust-model.md T3. */
  readonly commands: readonly (readonly string[])[]
  readonly passed: boolean
  readonly exitCodes: readonly number[]
  /** Per-command sandbox execution completeness, consumed from `ConfinedArgv.enforcement`. */
  readonly enforcement: readonly ValidationEnforcement[]
  /** Denial signatures matched by the sandbox, consumed from `ConfinedArgv.denialSignatures`. */
  readonly denials: readonly string[]
  /** Full merged output of the validation subprocesses, posted back on failure. */
  readonly log: string
}

export interface WriteResult {
  readonly appliedPatches: readonly Patch[]
  readonly commitSha?: CommitSha
  readonly pullRequestUrl?: string
  readonly validation: ValidationReport
}

/**
 * Honest report of the write-mode sandbox actually in effect for a run
 * (docs/07 line 95). Derived from the resolved `SandboxExecutionPolicy` and the
 * fs backend's own advertised mode — never fabricated, so a bare (non-sandboxing)
 * fs backend is reported as such instead of claiming confinement that is not there.
 */
export interface IsolationProfile {
  /** The mode the sandbox policy resolved to for this run. */
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** The fs backend's default sandbox mode; absent when it never confines. */
  readonly fsMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** True only when the fs backend actually fences mutations. */
  readonly fsFencesMutations: boolean
}

export interface Verdict {
  readonly status: ReviewStatus
  readonly findingsCount: number
  readonly blockersCount: number
  readonly durationMs: number
}

/**
 * Per-stage timing for `result-json.timing`. Optional fields are added without
 * bumping `schemaVersion` (docs/07:174): a consumer reading only `durationMs`
 * keeps working, while a newer consumer reads the shard fan-out details.
 */
export interface ResultTiming {
  /** Wall-clock ms spent in the shard fan-out; absent on the single-agent path. */
  readonly shardMs?: number
  /** Shards that did not complete (timeout/error) during a fan-out. */
  readonly incompleteShards?: number
}

export interface ReviewResult {
  readonly requestId: RequestId
  readonly verdict: Verdict
  readonly findings: readonly Finding[]
  /** Per-stage timing; the fan-out entries are present only on a sharded run. */
  readonly timing?: ResultTiming
  /** Proposals rejected during validation, with reasons, for auditability. */
  readonly discarded: readonly DiscardedProposal[]
  /** Findings suppressed by cross-PR memory (maintainer-accepted exceptions). */
  readonly suppressed?: readonly SuppressedFinding[]
  /** The intent that ran. Absent only when the run failed before routing. */
  readonly operation?: ReviewIntent
  /** The forge provider that produced the event. Absent before ingest succeeds. */
  readonly forgeId?: ForgeId
  /** Resolved trust level, for the `trust` scalar output and result-json policy. */
  readonly trust?: TrustLevel
  /** Resolved capabilities, for result-json `policy.capabilities`. */
  readonly capabilities?: Capabilities
  /** Publish outcome, for result-json `publication`. */
  readonly publication?: PublicationStats
  /** Active rule packs with versions, for the auditable result-json `rules`. */
  readonly rules?: readonly RulePackSummary[]
  /** Human-readable summary, untrusted — pass via env, never into a shell. */
  readonly summary?: string
  readonly write?: WriteResult
  /** Write-mode sandbox profile; absent for read-only runs. */
  readonly isolation?: IsolationProfile
  readonly failure?: Failure
  readonly stickyCommentId?: CommentId
  /** Snapshot id for `dshrb replay`. Absent until B4 snapshots land. */
  readonly replayId?: string
  /**
   * Non-fatal snapshot persistence failure. When set, the review still
   * succeeded (findings were published) but the replay snapshot could not be
   * written, so `replayId` is absent and `dshrb replay` is unavailable for this
   * run. Carries the underlying error message, never a secret value.
   */
  readonly snapshotError?: string
}

/** Publish outcome: how many findings posted, degraded, or failed. */
export interface PublicationStats {
  readonly published: number
  readonly degradedToSummary: number
  readonly failed: number
}

/** Rule pack identity for the auditable result-json `rules` field. */
export interface RulePackSummary {
  readonly id: string
  readonly version: string
  readonly title: string
}

export interface DiscardedProposal {
  readonly reason: string
  readonly rawTitle: string
}

/**
 * A finding suppressed by cross-PR memory: a valid, already-validated finding
 * whose `findingMemoryKey` matches a maintainer-accepted exception. Kept
 * separately from `discarded` (validation rejections) so the two failure modes
 * stay distinguishable in `result-json`.
 */
export interface SuppressedFinding {
  readonly key: string
  readonly path: string
  readonly title: string
  readonly severity: Severity
  /** The actor who accepted the exception, for the audit trail. */
  readonly resolvedBy: string
  readonly reason: string
}

/**
 * A standalone patch proposal from `propose_patch` — a path plus a unified diff,
 * with no finding attached. Like `RawProposal`, every field is optional and
 * unbranded so nothing is consumed without passing through `narrowPatchProposal`
 * (the patch arm of the `narrowProposal` channel) first.
 */
export interface RawPatch {
  readonly path?: string | undefined
  readonly diff?: string | undefined
}

/**
 * Untrusted model output before validation. Deliberately loose: every field is
 * optional and unbranded, so nothing can be consumed without passing through
 * `narrowProposal` first.
 *
 * Each field is `?: T | undefined` rather than just `?: T`. Under this repo's
 * `exactOptionalPropertyTypes`, the bare form would make "absent" and
 * "explicitly undefined" different types — a distinction the model's JSON does
 * not have, and one that would force every caller mapping a parsed payload to
 * delete keys instead of passing them through.
 */
export interface RawProposal {
  readonly severity?: string | undefined
  readonly title?: string | undefined
  readonly body?: string | undefined
  readonly path?: string | undefined
  readonly line?: number | undefined
  readonly ruleId?: string | undefined
  readonly failureScenario?: string | undefined
  readonly patch?: RawPatch | undefined
}

// ---------------------------------------------------------------------------
// Branded id constructors
// ---------------------------------------------------------------------------

/**
 * The brands above are compile-time only, so without constructors every call
 * site would reach for `as RequestId` — and a cast is exactly as happy to brand
 * `''` as a real id. These are the only sanctioned way in.
 *
 * They THROW rather than return a result type: ids come from the forge payload
 * or from our own code, i.e. from places where an empty id is a bug, not a
 * user-visible outcome. Untrusted model output goes through `narrowProposal`
 * instead, which reports rejections rather than throwing.
 *
 * Surrounding whitespace is stripped: it is never semantic in an id, and an id
 * that differs only by a stray space breaks idempotency and dedupe silently.
 */
function brandNonEmpty<T>(kind: string, raw: string): T {
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new TypeError(`${kind} must be a non-empty string`)
  }
  return trimmed as T
}

export function requestId(raw: string): RequestId {
  return brandNonEmpty('RequestId', raw)
}

export function forgeId(raw: string): ForgeId {
  return brandNonEmpty('ForgeId', raw)
}

/** For GitLab pass the project-scoped `iid`. See the type's own note. */
export function changeRequestId(raw: string): ChangeRequestId {
  return brandNonEmpty('ChangeRequestId', raw)
}

export function commentId(raw: string): CommentId {
  return brandNonEmpty('CommentId', raw)
}

export function findingId(raw: string): FindingId {
  return brandNonEmpty('FindingId', raw)
}

export function ruleId(raw: string): RuleId {
  return brandNonEmpty('RuleId', raw)
}

/** Abbreviated or full git object name. */
const SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/

/**
 * Stricter than the other ids: a SHA is checked out and diffed, so a malformed
 * one must fail here rather than as an opaque git error three stages later.
 * Normalized to lowercase so `baseSha === headSha` comparisons hold across
 * forges that differ in case.
 */
export function commitSha(raw: string): CommitSha {
  const trimmed = raw.trim()
  if (!SHA_PATTERN.test(trimmed)) {
    throw new TypeError(`CommitSha must be 7-40 hex characters, got '${excerpt(raw)}'`)
  }
  return trimmed.toLowerCase() as CommitSha
}

/** Caps untrusted text before it lands in an error message or a log line. */
function excerpt(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value
}

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

/**
 * Most to least severe. This array is the ordering — `Severity` is a string
 * union, so `<` on the values themselves is alphabetical nonsense
 * (`'blocker' < 'info'` is true, `'major' < 'minor'` is also true).
 */
export const SEVERITY_ORDER = ['blocker', 'major', 'minor', 'nit', 'info'] as const satisfies
  readonly Severity[]

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITY_ORDER as readonly string[]).includes(value)
}

/** 0 is the most severe. */
export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity)
}

/** Sort comparator: ascending rank puts blockers first. */
export function compareSeverity(a: Severity, b: Severity): number {
  return severityRank(a) - severityRank(b)
}

/** True when `severity` is at least as severe as the configured `minSeverity`. */
export function meetsSeverityThreshold(severity: Severity, minSeverity: Severity): boolean {
  return severityRank(severity) <= severityRank(minSeverity)
}

/** One step less severe; `info` is the floor and stays put. */
export function downgradeSeverity(severity: Severity): Severity {
  return SEVERITY_ORDER[severityRank(severity) + 1] ?? severity
}

// ---------------------------------------------------------------------------
// Finding badge (shields.io image)
// ---------------------------------------------------------------------------

/**
 * Color per severity for the shields.io static badge. The scale follows the
 * severity ladder: `blocker` is the hottest (darkred), `info` is informational
 * (blue). Values are standard CSS color names shields.io accepts.
 */
export const SEVERITY_BADGE_COLOR: Readonly<Record<Severity, string>> = Object.freeze({
  blocker: 'darkred',
  major: 'red',
  minor: 'orange',
  nit: 'green',
  info: 'blue',
})

/**
 * The rule group a finding's `ruleId` belongs to: the segment before the first
 * `/` (`security` from `security/secret-in-source`). Returns `undefined` when
 * the id has no `/` or an empty prefix, so a badge can fall back to severity
 * only rather than inventing a category.
 */
export function findingCategory(ruleId: RuleId | undefined): string | undefined {
  if (ruleId === undefined) return undefined
  const slash = ruleId.indexOf('/')
  if (slash <= 0) return undefined
  const category = ruleId.slice(0, slash).trim()
  return category === '' ? undefined : category
}

/**
 * Escapes a value for a shields.io static-badge path segment. `-` and `_` are
 * shields.io separators so they are doubled first; `(`/`)` are left alone by
 * `encodeURIComponent` but are structural in a Markdown link destination, so
 * they are percent-encoded explicitly.
 */
function shieldsEscape(value: string): string {
  return encodeURIComponent(value.replace(/-/g, '--').replace(/_/g, '__'))
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
}

/** Escapes Markdown image alt text so a stray `[`/`]`/`\` cannot break the image. */
function escapeMarkdownAlt(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

/**
 * Renders a finding's severity (and rule category, when the `ruleId` has one)
 * as a single shields.io static badge for Markdown surfaces (GitHub inline and
 * summary comments). The image alt text keeps the plain-text form so screen
 * readers and image-load failures degrade to the previous text. Severity is a
 * validated enum, so the color lookup never misses.
 *
 *   category + severity → `![category · severity](…/badge/category-severity-<color>)`
 *   severity only       → `![severity](…/badge/severity--<color>)`
 *
 * The severity-only form uses the shields.io double-dash (empty message) so the
 * trailing segment stays the color; a bare `severity-<color>` would make the
 * color the badge message and drop the tint.
 */
export function buildFindingBadge(finding: Finding): string {
  const category = findingCategory(finding.ruleId)
  const severity = finding.severity
  const color = SEVERITY_BADGE_COLOR[severity]
  const alt = category === undefined ? severity : `${category} · ${severity}`
  const path = category === undefined
    ? `${shieldsEscape(severity)}--${color}`
    : `${shieldsEscape(category)}-${shieldsEscape(severity)}-${color}`
  return `![${escapeMarkdownAlt(alt)}](https://img.shields.io/badge/${path})`
}

export interface SeverityClaim {
  readonly severity: Severity
  /** Concrete inputs or state leading to wrong output. */
  readonly failureScenario?: string | undefined
  /** The cited rule's `requiresScenario` flag, when a rule was cited. */
  readonly requiresScenario?: boolean | undefined
}

/**
 * The noise gate from docs/07-data-contracts.md: a claim that cannot describe
 * how it fails is a guess, so it loses a severity step. Applies to every
 * `blocker`, and to any severity whose rule author set `requiresScenario`.
 */
export function effectiveSeverity(claim: SeverityClaim): Severity {
  const hasScenario = (claim.failureScenario ?? '').trim() !== ''
  if (hasScenario) {
    return claim.severity
  }
  const needsScenario = claim.severity === 'blocker' || claim.requiresScenario === true
  return needsScenario ? downgradeSeverity(claim.severity) : claim.severity
}

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

/** An anchor that landed on a diff line and carries no fallback reason. */
export type AnchoredAnchor = Anchor & { readonly anchored: true; readonly fallbackReason?: undefined }

/**
 * An anchor that missed the diff. `fallbackReason` is required here, which is
 * what makes "degrade to a summary entry" different from "silently drop":
 * the reason cannot be omitted at the type level.
 */
export type FallbackAnchor = Anchor & { readonly anchored: false; readonly fallbackReason: string }

/** True for a line inside a diff hunk; the only case allowed to be published inline. */
export function isAnchored(anchor: Anchor): anchor is AnchoredAnchor {
  return anchor.anchored
}

export function anchorAt(path: string, line: number, side: Anchor['side'] = 'right'): AnchoredAnchor {
  return { path: assertAnchorPath(path), line: assertLine(line), side, anchored: true }
}

export function anchorFallback(
  path: string, line: number, fallbackReason: string, side: Anchor['side'] = 'right',
): FallbackAnchor {
  const reason = fallbackReason.trim()
  if (reason === '') {
    throw new TypeError('a fallback anchor must state why anchoring failed')
  }
  return { path: assertAnchorPath(path), line: assertLine(line), side, anchored: false, fallbackReason: reason }
}

function assertAnchorPath(path: string): string {
  const trimmed = path.trim()
  if (!isSafeRelativePath(trimmed)) {
    throw new TypeError(`anchor path must be a safe repo-relative path, got '${excerpt(path)}'`)
  }
  return trimmed
}

function assertLine(line: number): number {
  if (!isPositiveInteger(line)) {
    throw new TypeError(`anchor line must be a positive integer, got ${String(line)}`)
  }
  return line
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Rejects absolute paths, Windows drive paths, `..` traversal, and NUL bytes.
 * Read mode only ever reports on files inside the change, so anything outside
 * the repo is a bogus anchor; write mode needs the same check as a hard red
 * line (docs/03-review-pipeline.md). Pure syntax — no filesystem access, so it
 * cannot resolve symlinks; that check belongs to the sandbox layer in M3.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.includes('\0')) {
    return false
  }
  // A drive prefix is any single letter + colon: `C:\x`, `C:/x`, and also the
  // drive-relative `C:x` (no slash), which a `[\\/]`-suffixed pattern misses.
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) {
    return false
  }
  return !path.split(/[/\\]/).includes('..')
}

// ---------------------------------------------------------------------------
// Path glob matching
// ---------------------------------------------------------------------------

/**
 * Minimal glob matcher for repo-relative `/`-separated paths. Single source of
 * truth for both rule applicability (`@dshrb/rule-registry`) and the write
 * guard's protected-path deny-list (`@dshrb/trust-policy`), so the two layers
 * can never drift on semantics. Supported syntax:
 *
 * - `*`      any run of characters within one path segment (no `/`)
 * - `**`     any run of path segments, including none
 * - `?`      exactly one character within a segment (no `/`)
 * - `[...]`  a character class; `[!...]` negates
 *
 * A backslash escapes the next character. Patterns are split on `/` and never
 * anchored to a directory, so `src/**` also matches the (unlikely) file path
 * `src` itself — harmless for both call sites, which only ever feed file paths.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  return matchSegments(pattern.split('/'), path.split('/'))
}

function matchSegments(pattern: readonly string[], path: readonly string[], pi = 0, si = 0): boolean {
  while (pi < pattern.length) {
    const segment = pattern[pi]
    if (segment === undefined) {
      return si === path.length
    }
    if (segment === '**') {
      if (pi === pattern.length - 1) {
        // A trailing `**` matches whatever remains, including nothing.
        return true
      }
      // A `**` in the middle matches zero or more whole segments.
      for (let skip = si; skip <= path.length; skip++) {
        if (matchSegments(pattern, path, pi + 1, skip)) {
          return true
        }
      }
      return false
    }
    const value = path[si]
    if (value === undefined || !matchesSegment(segment, value)) {
      return false
    }
    pi++
    si++
  }
  return si === path.length
}

function matchesSegment(pattern: string, value: string): boolean {
  // Fast path: a segment with no metacharacters compares literally.
  return hasMeta(pattern) ? segmentToRegExp(pattern).test(value) : pattern === value
}

function hasMeta(segment: string): boolean {
  return /[*?[\\]/.test(segment)
}

function segmentToRegExp(segment: string): RegExp {
  let source = ''
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]
    if (char === undefined) break
    if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '[') {
      const close = segment.indexOf(']', i + 1)
      if (close === -1) {
        // An unclosed class is a literal bracket.
        source += '\\['
      } else {
        let body = segment.slice(i + 1, close)
        if (body.startsWith('!')) {
          body = `^${body.slice(1)}`
        } else if (body.startsWith('^')) {
          body = `\\${body}`
        }
        source += `[${body}]`
        i = close
      }
    } else if (char === '\\' && i + 1 < segment.length) {
      source += escapeRegExp(segment[i + 1] ?? '')
      i++
    } else {
      source += escapeRegExp(char)
    }
  }
  return new RegExp(`^${source}$`)
}

function escapeRegExp(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Deny-by-default baseline. Frozen: a shared object that callers can mutate is a hole. */
export const NO_CAPABILITIES: Capabilities = Object.freeze({
  readDiff: false,
  readRepoFiles: false,
  readCheckLogs: false,
  publishComments: false,
  proposePatches: false,
  commitPatches: false,
})

/**
 * Builds a capability set from the grants only. Every field is spelled out in
 * one place, so adding a capability later defaults it to denied everywhere
 * instead of silently granting it wherever a literal was written by hand.
 */
export function capabilities(granted: Partial<Capabilities>): Capabilities {
  return { ...NO_CAPABILITIES, ...granted }
}

// ---------------------------------------------------------------------------
// RawProposal narrowing
// ---------------------------------------------------------------------------

/** Machine-readable rejection codes; the counterpart to `DiscardedProposal.reason`. */
export type ProposalRejection =
  | 'missing-title'
  | 'missing-body'
  | 'missing-severity'
  | 'unknown-severity'
  | 'missing-path'
  | 'unsafe-path'
  | 'invalid-line'
  | 'invalid-patch'

export interface Accepted<T> {
  readonly ok: true
  readonly value: T
}

export interface Rejected {
  readonly ok: false
  readonly reason: ProposalRejection
  /** Human-readable, safe to put in a comment; untrusted excerpts are capped. */
  readonly message: string
}

export type Narrowed<T> = Accepted<T> | Rejected

export interface NarrowProposalInput {
  readonly findingId: FindingId
  /**
   * Resolved by the caller against the real diff. review-core never sees a
   * diff, so anchoring cannot happen here — but a `Finding` cannot exist
   * without an anchor, which is what keeps the two steps in lockstep.
   */
  readonly anchor: Anchor
  /** The cited rule's `requiresScenario` flag, when a rule was cited. */
  readonly requiresScenario?: boolean | undefined
}

/**
 * The `RawProposal → Finding` narrowing. Every field of a proposal is optional
 * and unbranded; every field of a `Finding` is present and branded. This is the
 * only function that crosses that line, so `validate()` in `@dshrb/review-runtime`
 * cannot skip a check by casting.
 *
 * Rejections are returned, never thrown: a bad proposal is expected model
 * behavior and must be reported in `discarded`, not treated as a crash.
 *
 * Structural checks only. Path normalization, size caps, dedupe, and the
 * min-severity threshold stay in `validate()`, which has the diff and config
 * this package deliberately lacks.
 */
export function narrowProposal(raw: RawProposal, input: NarrowProposalInput): Narrowed<Finding> {
  const title = (raw.title ?? '').trim()
  if (title === '') {
    return rejected('missing-title', 'proposal has no title')
  }
  const body = (raw.body ?? '').trim()
  if (body === '') {
    return rejected('missing-body', `proposal '${excerpt(title)}' has no body`)
  }
  if (raw.severity === undefined) {
    return rejected('missing-severity', `proposal '${excerpt(title)}' has no severity`)
  }
  if (!isSeverity(raw.severity)) {
    return rejected('unknown-severity', `unknown severity '${excerpt(raw.severity)}'`)
  }
  const path = (raw.path ?? '').trim()
  if (path === '') {
    return rejected('missing-path', `proposal '${excerpt(title)}' names no file`)
  }
  if (!isSafeRelativePath(path)) {
    return rejected('unsafe-path', `path '${excerpt(path)}' is not repo-relative`)
  }
  if (!isPositiveInteger(raw.line)) {
    return rejected('invalid-line', `proposal '${excerpt(title)}' has no usable line number`)
  }

  // `null` (JSON null) is as absent as `undefined`: falling through to
  // `narrowPatch` would dereference it and crash, violating the "rejections are
  // returned, never thrown" contract.
  const patch = raw.patch === undefined || raw.patch === null ? undefined : narrowPatch(raw.patch)
  if (patch?.ok === false) {
    return patch
  }

  const scenario = (raw.failureScenario ?? '').trim()
  const rule = (raw.ruleId ?? '').trim()
  const severity = effectiveSeverity({
    severity: raw.severity,
    failureScenario: scenario,
    requiresScenario: input.requiresScenario,
  })

  return {
    ok: true,
    value: {
      findingId: input.findingId,
      severity,
      title,
      body,
      anchor: input.anchor,
      ...(rule === '' ? {} : { ruleId: ruleId(rule) }),
      ...(scenario === '' ? {} : { failureScenario: scenario }),
      ...(patch === undefined ? {} : { suggestedPatch: patch.value }),
    },
  }
}

/** Called only when the proposal actually suggested a patch. */
function narrowPatch(raw: RawPatch): Narrowed<Patch> {
  const path = (raw.path ?? '').trim()
  if (path === '' || !isSafeRelativePath(path)) {
    return rejected('invalid-patch', `suggested patch has an unusable path '${excerpt(path)}'`)
  }
  // Kept verbatim, not trimmed: trailing newlines are significant in a unified
  // diff, and a hunk that no longer applies is the apply step's business.
  const diff = raw.diff ?? ''
  if (diff.trim() === '') {
    return rejected('invalid-patch', `suggested patch for '${excerpt(path)}' has an empty diff`)
  }
  return { ok: true, value: { path, diff } }
}

/**
 * Narrows a standalone `propose_patch` proposal to a `Patch`. This is the same
 * patch arm `narrowProposal` runs for a finding's `suggestedPatch`, surfaced for
 * the write-mode channel where a patch is proposed without a finding. Rejections
 * carry the `invalid-patch` machine-readable code so a bad patch lands in
 * `ReviewResult.discarded` rather than being treated as a crash.
 */
export function narrowPatchProposal(raw: RawPatch): Narrowed<Patch> {
  return narrowPatch(raw)
}

function rejected(reason: ProposalRejection, message: string): Rejected {
  return { ok: false, reason, message }
}

/** Shapes a rejection for the audit trail in `ReviewResult.discarded`. */
export function toDiscarded(raw: RawProposal, rejection: Rejected): DiscardedProposal {
  return {
    reason: `${rejection.reason}: ${rejection.message}`,
    rawTitle: excerpt((raw.title ?? '').trim()),
  }
}

// ---------------------------------------------------------------------------
// Finding invariants
// ---------------------------------------------------------------------------

/**
 * Post-condition check for anything about to be published, including findings
 * assembled by hand in a test or a replay snapshot. Returns a denial reason or
 * `undefined` to abstain, matching the shape of `ctx.tools.guard()` upstream.
 *
 * `narrowProposal` output always passes; this is the net for every other route
 * into a `Finding`.
 */
export function findingInvariantViolation(finding: Finding): string | undefined {
  if (finding.findingId.trim() === '') {
    return 'finding has an empty findingId'
  }
  // A `Severity` is only ever minted by `isSeverity` / `narrowProposal`, but this
  // is the net for every OTHER route into a Finding (replay snapshot, hand-built
  // test fixture), where an unsafe cast could smuggle `'critical'` through.
  // Without this, `severityRank` would return -1 and silently invert ordering.
  if (!isSeverity(finding.severity)) {
    return `finding has an invalid severity '${excerpt(String(finding.severity))}'`
  }
  if (finding.title.trim() === '') {
    return 'finding has an empty title'
  }
  if (finding.body.trim() === '') {
    return 'finding has an empty body'
  }
  if (finding.severity === 'blocker' && (finding.failureScenario ?? '').trim() === '') {
    return 'blocker findings require a reproducible failureScenario'
  }
  const { anchor } = finding
  if (!isSafeRelativePath(anchor.path)) {
    return `anchor path '${excerpt(anchor.path)}' is not repo-relative`
  }
  if (!isPositiveInteger(anchor.line)) {
    return 'anchor line must be a positive integer'
  }
  // Both directions matter: an unanchored finding without a reason gets dropped
  // silently downstream, and an anchored one carrying a reason means some stage
  // lost track of which branch it was on.
  if (!anchor.anchored && (anchor.fallbackReason ?? '').trim() === '') {
    return 'an unanchored finding must record a fallbackReason'
  }
  if (anchor.anchored && anchor.fallbackReason !== undefined) {
    return 'an anchored finding must not carry a fallbackReason'
  }
  return undefined
}

/**
 * Stable identity for dedupe — the same problem reported from two diff shards
 * (M4 fan-out) must collapse to one comment. JSON-encoded rather than joined by
 * a delimiter: `JSON.stringify` escapes any delimiter-like bytes, so `ruleId`
 * and `title` (which come from model output and are not NUL-sanitized the way
 * `path` is) cannot shift the field boundaries and fake a collision.
 */
export function findingDedupeKey(finding: Finding): string {
  return JSON.stringify([
    finding.anchor.path,
    String(finding.anchor.line),
    finding.ruleId ?? '',
    finding.title.trim().toLowerCase(),
  ])
}

/**
 * Cross-PR memory identity (docs/07). Deliberately NOT `findingDedupeKey`:
 * that one identifies the same problem reported from two diff shards within ONE
 * run, so it folds in the anchor line (stable inside one diff). Lines shift
 * between revisions, so a cross-PR identity must be line-agnostic — it keeps
 * only `path + ruleId + normalized title`, the three fields that name "the same
 * problem" regardless of where it moved to.
 *
 * JSON-encoded for the same collision-resistance reason as `findingDedupeKey`:
 * a `ruleId` or `title` containing the delimiter cannot shift field boundaries.
 */
export function findingMemoryKey(finding: Finding): string {
  return memoryKey(finding.anchor.path, finding.ruleId ?? '', finding.title)
}

/**
 * Builds a cross-PR memory key from its three components. Exposed separately
 * because the `@dsr accept` command carries the components (a JSON array) and
 * the runtime must derive the identical key without fabricating a full `Finding`.
 */
export function memoryKey(path: string, ruleId: string, title: string): string {
  return JSON.stringify([path, ruleId, title.trim().toLowerCase()])
}

/** Feeds the `blockers-count` scalar output. */
export function countBlockers(findings: readonly Finding[]): number {
  return findings.filter((finding) => finding.severity === 'blocker').length
}
