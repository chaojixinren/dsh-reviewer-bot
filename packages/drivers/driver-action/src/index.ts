/**
 * GitHub Action driver shell.
 *
 * Thin adapter: reads inputs, runs the shared pipeline, writes outputs. No
 * business logic — that lives in review-runtime so every driver behaves alike.
 *
 * Scalar output names are a stable published contract: once released they are
 * never renamed, only added to. See docs/07-data-contracts.md.
 */
import type { ReviewResult } from '@dshrb/review-core'

/** Action inputs, kebab-case as declared in action.yml. */
export interface ActionInputs {
  readonly 'deepseek-api-key': string
  readonly 'github-token'?: string
  readonly 'allow-write'?: string
  readonly 'run-tests'?: string
  /** JSON array of argv arrays. Not shell-expanded. */
  readonly 'test-commands'?: string
  /** Full image digest required in write mode. */
  readonly 'container-image'?: string
  readonly 'progress-comment'?: string
  readonly 'timeout-minutes'?: string
  readonly 'min-severity'?: string
  readonly 'rule-packs'?: string
}

export declare function readInputs(env: NodeJS.ProcessEnv): ActionInputs

/**
 * Writes every scalar output plus `result-json`.
 *
 * Called even on a failed step, so consumers can read outputs under `always()`.
 * Model-derived strings stay untrusted here: they must reach downstream steps
 * through env vars, never spliced into a shell command.
 */
export declare function writeOutputs(result: ReviewResult): Promise<void>

export declare function main(): Promise<void>

// TODO(M1): implement main() — readInputs → runReview → writeOutputs, with the
//           watchdog finalizing outputs before the job-level timeout hits.
