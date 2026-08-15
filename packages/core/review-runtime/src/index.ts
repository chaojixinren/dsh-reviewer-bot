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

export declare function ingest(raw: unknown, deps: StageDeps): Promise<NormalizedEvent>
/** Commands must appear on the comment's FIRST line, so quoting someone else's
 *  comment cannot trigger a run. */
export declare function route(event: NormalizedEvent): ReviewIntent
export declare function authorize(
  event: NormalizedEvent, intent: ReviewIntent, deps: StageDeps,
): Promise<ReviewRequest>
export declare function assembleContext(
  request: ReviewRequest, deps: StageDeps,
): Promise<BoundedContext>
export declare function reason(ctx: BoundedContext): Promise<readonly RawProposal[]>
/**
 * Turns untrusted proposals into publishable findings: schema check, path
 * normalization, diff-line anchoring, size caps, dedupe, and the blocker
 * failureScenario requirement. Rejections are reported, not swallowed.
 */
export declare function validate(
  proposals: readonly RawProposal[], diff: UnifiedDiff, rules: readonly Rule[],
): { findings: readonly Finding[]; discarded: readonly { reason: string; rawTitle: string }[] }
export declare function publish(
  target: ReviewTarget, findings: readonly Finding[], deps: StageDeps,
): Promise<void>
export declare function mutate(
  request: ReviewRequest, findings: readonly Finding[], deps: StageDeps,
): Promise<void>
/** Never throws: a terminal result is always written, including on timeout. */
export declare function report(partial: Partial<ReviewResult>, failure?: Failure): ReviewResult

/** Runs the full pipeline under the watchdog. */
export declare function runReview(raw: unknown, deps: StageDeps, config: Config): Promise<ReviewResult>

export type { Phase }

export function apply(_ctx: Context, _config: Config): void {
  // TODO(M1): wire stages, register the watchdog, subscribe progress to
  //           session/event, and expose runReview to drivers.
  // TODO(M4): shard fan-out via ctx.subagents plus the cross-shard merge that
  //           dedupes findings and catches interface-level inconsistencies.
  throw new Error('not implemented: M1')
}
