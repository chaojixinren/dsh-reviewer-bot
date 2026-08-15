/**
 * The eight-stage review pipeline. Single orchestration point shared by every
 * driver, so Action, daemon, DSH profile, and CLI never grow separate business
 * logic. See docs/03-review-pipeline.md.
 *
 * Each stage is `(input, deps) => Promise<output>` and unit-testable without a
 * network. Only the `reason` stage is non-deterministic.
 */
import type {
  Failure, Finding, NormalizedEvent, Phase, RawProposal, ReviewRequest,
  ReviewResult, ReviewIntent, ReviewTarget,
} from '@dshrb/review-core'
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
/**
 * Turns untrusted proposals into publishable findings: schema check, path
 * normalization, diff-line anchoring, size caps, dedupe, and the blocker
 * failureScenario requirement. Rejections are reported, not swallowed.
 */
export function validate(
  _proposals: readonly RawProposal[], _diff: UnifiedDiff, _rules: readonly Rule[],
): { findings: readonly Finding[]; discarded: readonly { reason: string; rawTitle: string }[] } {
  throw new Error('not implemented: validate (M1)')
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
