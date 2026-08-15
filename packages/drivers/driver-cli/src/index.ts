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

export function parseArgs(_argv: readonly string[]): CliOptions {
  throw new Error('not implemented: parseArgs (M2)')
}

/**
 * A snapshot holds the whole bounded context: diff shards, rule set, memory
 * fragments. It therefore contains source code, so it stays on the local disk
 * by default. Remote archiving must be configured explicitly — that is a real
 * private-code egress path, not a convenience toggle.
 */
export function replay(_runId: string): Promise<ReviewResult> {
  throw new Error('not implemented: replay (M2)')
}

export function renderToTty(_result: ReviewResult): string {
  throw new Error('not implemented: renderToTty (M2)')
}

export function main(_argv: readonly string[]): Promise<number> {
  throw new Error('not implemented: main (M2)')
}

// TODO(M2): `dshrb review --local` through the forge-local provider, so the
//           runtime cannot tell CI from a laptop.
// TODO(M2): `dshrb replay <id>` reproducing findings from a snapshot, enabling
//           A/B comparison of rule and model configurations.
// TODO(M2): `dshrb rules --explain <path>` listing effective rules and the pack
//           each came from.
// TODO(M2): `dshrb doctor` checking config and credential reachability without
//           printing secret values.
