/**
 * The eight-stage review pipeline. Single orchestration point shared by every
 * driver, so Action, daemon, DSH profile, and CLI never grow separate business
 * logic. See docs/03-review-pipeline.md.
 *
 * Each stage is `(input, deps) => Promise<output>` and unit-testable without a
 * network. Only the `reason` stage is non-deterministic.
 */
import { findingId, isSafeRelativePath, narrowProposal, toDiscarded } from '@dshrb/review-core'
import type {
  DiscardedProposal, Failure, Finding, NormalizedEvent, Phase, RawProposal,
  ReviewRequest, ReviewResult, ReviewIntent, ReviewTarget,
} from '@dshrb/review-core'
import { createAnchorResolver, publishIdempotencyKey } from '@dshrb/forge'
import type { ForgeRegistry, UnifiedDiff } from '@dshrb/forge'
import type { Rule } from '@dshrb/rule-registry'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dshrb-review-runtime'
export const inject = ['agents', 'sessions', 'tools', 'reviewRules']

export interface Config {
  /** Watchdog budget. Keep the job-level timeout a few minutes above this so
   *  outputs can still be finalized. */
  timeoutMinutes: number
  /** Max diff bytes per shard before hard-splitting by hunk. */
  shardBytes: number
  /** Fan out shards to ctx.subagents. */
  parallelShards: boolean
  /** Persist the bounded context for `dshrb replay`. Local-only by default:
   *  snapshots contain source code. */
  snapshotReplay: boolean
}

export const Config: Schema<Config> = Schema.object({
  timeoutMinutes: Schema.number().default(25),
  shardBytes: Schema.number().default(120_000),
  parallelShards: Schema.boolean().default(true),
  snapshotReplay: Schema.boolean().default(true),
})

/** Everything handed to the agent. Assembled by the controller, bounded on purpose. */
export interface BoundedContext {
  readonly request: ReviewRequest
  readonly shards: readonly DiffShard[]
  readonly rules: readonly Rule[]
  /** Prior decisions and accepted exceptions for this repo (cross-PR memory). */
  readonly memory: readonly string[]
}

export interface DiffShard {
  readonly index: number
  readonly files: readonly string[]
  readonly text: string
  /** True when the shard was cut mid-context; the model must not judge
   *  incomplete code as confidently. */
  readonly truncated: boolean
}

export interface StageDeps {
  readonly forges: ForgeRegistry
  readonly now: () => number
}

// --- Stages -----------------------------------------------------------------

export function ingest(_raw: unknown, _deps: StageDeps): Promise<NormalizedEvent> {
  throw new Error('not implemented: ingest (M1)')
}
/** Commands must appear on the comment's FIRST line, so quoting someone else's
 *  comment cannot trigger a run. */
export function route(_event: NormalizedEvent): ReviewIntent {
  throw new Error('not implemented: route (M1)')
}
export function authorize(
  _event: NormalizedEvent, _intent: ReviewIntent, _deps: StageDeps,
): Promise<ReviewRequest> {
  throw new Error('not implemented: authorize (M1)')
}
export function assembleContext(
  _request: ReviewRequest, _deps: StageDeps,
): Promise<BoundedContext> {
  throw new Error('not implemented: assembleContext (M1)')
}
export function reason(_bounded: BoundedContext): Promise<readonly RawProposal[]> {
  throw new Error('not implemented: reason (M1)')
}

// --- Validation -------------------------------------------------------------

/** Cap on the rendered comment text. Exceeding a cap is a rejection, not a
 *  truncation: chopping a code excerpt mid-line corrupts the finding. */
const MAX_TITLE_CHARS = 200
const MAX_BODY_CHARS = 8000

/** Caps untrusted text before it lands in a rejection reason. */
function excerpt(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value
}

/** Finds the cited rule, used only for its `requiresScenario` flag. */
function findRule(rules: readonly Rule[], rawRuleId: string | undefined): Rule | undefined {
  const id = (rawRuleId ?? '').trim()
  return id === '' ? undefined : rules.find((rule) => rule.id === id)
}

/** True when a finding would render a comment beyond the configured caps. */
function exceedsSizeCap(finding: Finding): boolean {
  return finding.title.length > MAX_TITLE_CHARS || finding.body.length > MAX_BODY_CHARS
}

/**
 * Turns untrusted proposals into publishable findings: schema check, path
 * normalization, diff-line anchoring, size caps, dedupe, and the blocker
 * failureScenario requirement. Rejections are reported, not swallowed.
 *
 * Order matters: the path is normalized BEFORE anchoring (anchoring a raw
 * `../` path would silently land on the wrong file), and dedupe runs on the
 * shared `publishIdempotencyKey` so it agrees with what publish dedupes. The
 * blocker-requires-`failureScenario` downgrade happens inside `narrowProposal`
 * via `effectiveSeverity` — the #6 invariant helper.
 */
export function validate(
  proposals: readonly RawProposal[], diff: UnifiedDiff, rules: readonly Rule[],
): { findings: readonly Finding[]; discarded: readonly DiscardedProposal[] } {
  const resolver = createAnchorResolver()
  const findings: Finding[] = []
  const discarded: DiscardedProposal[] = []
  const seen = new Set<string>()

  for (const [index, raw] of proposals.entries()) {
    // 1. Path normalization + line validation, before anchoring.
    const title = excerpt((raw.title ?? '').trim())
    const path = (raw.path ?? '').trim()
    if (path === '') {
      discarded.push(toDiscarded(raw, { ok: false, reason: 'missing-path', message: `proposal '${title}' names no file` }))
      continue
    }
    if (!isSafeRelativePath(path)) {
      discarded.push(toDiscarded(raw, { ok: false, reason: 'unsafe-path', message: `path '${excerpt(path)}' is not repo-relative` }))
      continue
    }
    const line = raw.line
    if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) {
      discarded.push(toDiscarded(raw, { ok: false, reason: 'invalid-line', message: `proposal '${title}' has no usable line number` }))
      continue
    }

    // 2. Hunk anchoring — a miss degrades to a fallback anchor, never a drop.
    const anchor = resolver.resolve(diff, path, line)

    // 3. Schema check + blocker downgrade. `narrowProposal` applies
    //    `effectiveSeverity`, the #6 invariant helper that demotes a
    //    scenario-less blocker (and any `requiresScenario` rule hit) one step.
    const cited = findRule(rules, raw.ruleId)
    const narrowed = narrowProposal(raw, {
      findingId: findingId(`f${index + 1}`),
      anchor,
      ...(cited?.requiresScenario === true ? { requiresScenario: true } : {}),
    })
    if (!narrowed.ok) {
      discarded.push(toDiscarded(raw, narrowed))
      continue
    }
    const finding = narrowed.value

    // 4. Size cap.
    if (exceedsSizeCap(finding)) {
      discarded.push({
        reason: `size-cap: title exceeds ${MAX_TITLE_CHARS} chars or body exceeds ${MAX_BODY_CHARS} chars`,
        rawTitle: excerpt(finding.title),
      })
      continue
    }

    // 5. Dedupe on the publish idempotency key (path + anchor + ruleId), so a
    //    proposal repeated across shards collapses here, not at publish time.
    const key = publishIdempotencyKey(finding)
    if (seen.has(key)) {
      discarded.push({
        reason: `duplicate: collapses onto ${finding.anchor.path}:${finding.anchor.line} (${finding.ruleId ?? 'no rule'})`,
        rawTitle: excerpt(finding.title),
      })
      continue
    }
    seen.add(key)

    findings.push(finding)
  }

  return { findings, discarded }
}

export function publish(
  _target: ReviewTarget, _findings: readonly Finding[], _deps: StageDeps,
): Promise<void> {
  throw new Error('not implemented: publish (M1)')
}
export function mutate(
  _request: ReviewRequest, _findings: readonly Finding[], _deps: StageDeps,
): Promise<void> {
  throw new Error('not implemented: mutate (M3)')
}
/** Never throws: a terminal result is always written, including on timeout. */
export function report(_partial: Partial<ReviewResult>, _failure?: Failure): ReviewResult {
  throw new Error('not implemented: report (M1)')
}

/** Runs the full pipeline under the watchdog. */
export function runReview(_raw: unknown, _deps: StageDeps, _config: Config): Promise<ReviewResult> {
  throw new Error('not implemented: runReview (M1)')
}

export type { Phase }

export function apply(_ctx: Context, _config: Config): void {
  // TODO(M1): wire stages, register the watchdog, subscribe progress to
  //           session/event, and expose runReview to drivers.
  // TODO(M4): shard fan-out via ctx.subagents plus the cross-shard merge that
  //           dedupes findings and catches interface-level inconsistencies.
  throw new Error('not implemented: M1')
}
