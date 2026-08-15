/**
 * Local CLI driver: dry-run, replay, and rule debugging.
 *
 * This is the fast feedback loop the project depends on — tuning prompts or rules
 * there means pushing a PR and waiting on CI for every iteration. Here a run is
 * reproducible offline from a snapshot.
 */
import type { ReviewResult } from '@dshrb/review-core'

export type Command = 'review' | 'replay' | 'rules' | 'doctor'

export interface CliOptions {
  readonly command: Command
  /** Review uncommitted working-tree changes with no network and no token. */
  readonly local?: boolean
  /** Fetch a remote change request and review it locally. */
  readonly pr?: string
  /** Snapshot id for `replay`. */
  readonly runId?: string
  /** Path for `rules --explain`. */
  readonly explain?: string
  readonly json?: boolean
}

export declare function parseArgs(argv: readonly string[]): CliOptions

/**
 * A snapshot holds the whole bounded context: diff shards, rule set, memory
 * fragments. It therefore contains source code, so it stays on the local disk
 * by default. Remote archiving must be configured explicitly — that is a real
 * private-code egress path, not a convenience toggle.
 */
export declare function replay(runId: string): Promise<ReviewResult>

export declare function renderToTty(result: ReviewResult): string

export declare function main(argv: readonly string[]): Promise<number>

// TODO(M2): `dshrb review --local` through the forge-local provider, so the
//           runtime cannot tell CI from a laptop.
// TODO(M2): `dshrb replay <id>` reproducing findings from a snapshot, enabling
//           A/B comparison of rule and model configurations.
// TODO(M2): `dshrb rules --explain <path>` listing effective rules and the pack
//           each came from.
// TODO(M2): `dshrb doctor` checking config and credential reachability without
//           printing secret values.
