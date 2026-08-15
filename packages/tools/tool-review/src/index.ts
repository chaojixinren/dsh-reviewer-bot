/**
 * Model-facing review tools, registered on `ctx.tools`.
 *
 * These tools let the model READ and PROPOSE. None of them publishes a comment,
 * commits, or touches a forge API — publication is the controller's job, after
 * validation. Keeping the boundary here is what makes model output safe to
 * ignore when it fails validation.
 *
 * Tool contracts follow the upstream `defineTool` rules: args are validated
 * from the schema before execute runs, one canonical JSON value is returned,
 * and `exec.signal` must be honored.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dshrb-tool-review'
export const inject = ['tools', 'reviewRules']

export interface Config {
  /** Expose the patch-proposal tool. Requires trusted-write to be useful. */
  enablePatchProposal: boolean
}

export const Config: Schema<Config> = Schema.object({
  enablePatchProposal: Schema.boolean().default(true),
})

/**
 * Tool inventory. Names are model-visible and stable — renaming one is a
 * breaking change for prompt caches and rule guidance.
 *
 * | tool                  | purpose                                        | min trust      |
 * |-----------------------|------------------------------------------------|----------------|
 * | `read_diff_shard`     | read one bounded diff shard                    | untrusted      |
 * | `list_applicable_rules` | rules matching a path                        | untrusted      |
 * | `report_finding`      | propose one finding (validated later)          | untrusted      |
 * | `read_repo_file`      | read a file from the immutable copy            | trusted-read   |
 * | `read_check_log`      | read a failed CI job log                       | trusted-read   |
 * | `propose_patch`       | propose a unified diff for one path            | trusted-write  |
 */
export const TOOL_NAMES = [
  'read_diff_shard',
  'list_applicable_rules',
  'report_finding',
  'read_repo_file',
  'read_check_log',
  'propose_patch',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export function apply(_ctx: Context, _config: Config): void {
  // TODO(M1): ctx.tools.register(defineTool({ name: 'read_diff_shard', ... }))
  //           for the read-only set. Registration is effect-based, so disposing
  //           the plugin fiber unregisters the tools.
  // TODO(M1): `report_finding` returns a canonical JSON receipt; it must NOT
  //           post anything. The controller collects proposals and validates.
  // TODO(M3): `propose_patch`, gated by trust-policy at tools/pre-execute.
  throw new Error('not implemented: M1')
}
