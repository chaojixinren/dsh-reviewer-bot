/**
 * Baseline rule pack.
 *
 * Declarative data only — no callbacks, no I/O. Deactivates automatically when
 * `reviewRules` is absent, via the Cordis reactive coeffect on `inject`.
 */
import type { RulePack } from '@dshrb/rule-registry'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dshrb-rules-baseline'
export const inject = ['reviewRules']

/**
 * Rule groups planned for M2. Severity assignments deliberately reserve
 * `blocker` for defects with a reproducible failure path; everything advisory
 * starts at `major` or below, because a bot that cries blocker gets muted.
 *
 * - correctness: null/undefined handling, off-by-one, unhandled rejection,
 *   resource leak, race on shared state
 * - security: injection sinks, missing authz check on a new endpoint, secret in
 *   source, unsafe deserialization, path traversal
 * - api-contract: breaking signature change without a version bump, silent
 *   behavior change
 * - maintainability: duplicated logic, dead code, misleading name
 * - tests: new branch without coverage, `test.skip` / `.only` left behind
 */
export declare const baselinePack: RulePack

export function apply(_ctx: Context): void {
  // TODO(M2): ctx.reviewRules.register(baselinePack)
  throw new Error('not implemented: M2')
}
