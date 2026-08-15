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
 *
 * Data flow: the controller (review-runtime) fetches platform data and binds it
 * per run through `ctx.reviewTools.activate(context)`. A tool body reads only
 * from that bound context — it never reaches the forge gateway directly, which
 * is what keeps credentials out of the agent's data plane (docs/04-trust-model.md).
 * Enforcement of which tools a trust level may call is NOT here: it lives in the
 * `tools/pre-execute` waterfall owned by `@dshrb/trust-policy` (#8).
 */
import type { ReviewRuleRegistry, Rule } from '@dshrb/rule-registry'
import { SEVERITY_ORDER, isSafeRelativePath } from '@dshrb/review-core'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
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

/** The M1 set: everything except the M3-deferred `propose_patch`. */
export const M1_TOOL_NAMES = TOOL_NAMES.filter((tool): tool is Exclude<ToolName, 'propose_patch'> => tool !== 'propose_patch')

/**
 * A bounded diff shard the model may read. Mirrors the shape of
 * `DiffShard` in `@dshrb/review-runtime`, but declared here so this leaf
 * package does not depend on the orchestrator that assembles the shards.
 */
export interface DiffShard {
  readonly index: number
  readonly files: readonly string[]
  readonly text: string
  /** True when the shard was cut mid-context; the model must not judge
   *  incomplete code as confidently. */
  readonly truncated: boolean
}

/**
 * The per-run data a tool body reads from. The controller binds this before
 * the agent runs and supplies the two read callbacks, which it adapts from the
 * forge gateway (`fetchFile` at baseSha, `fetchLog`). The callbacks must honor
 * `signal` so a watchdog timeout actually cancels in-flight platform reads.
 */
export interface ReviewToolContext {
  readonly shards: readonly DiffShard[]
  /** Reads one file from the immutable base-SHA copy. Must honor `signal`. */
  readonly readRepoFile: (path: string, signal: AbortSignal) => Promise<string>
  /** Reads one failed check's log. Must honor `signal`. */
  readonly readCheckLog: (checkId: string, signal: AbortSignal) => Promise<string>
}

/**
 * The binding point for the controller. `review-runtime` calls
 * `activate(context)` once per run; the registered tools read `context` when
 * they execute. Before activation every tool fails closed with a clear error,
 * mirroring trust-policy's "no trust decision is active" behavior.
 */
export interface ReviewToolRuntime {
  readonly context: ReviewToolContext | undefined
  /** Binds the active context; the returned disposer restores the previous. */
  activate(context: ReviewToolContext): () => void
}

class ReviewToolRuntimeState implements ReviewToolRuntime {
  #context: ReviewToolContext | undefined

  get context(): ReviewToolContext | undefined {
    return this.#context
  }

  activate(context: ReviewToolContext): () => void {
    const previous = this.#context
    this.#context = context
    return () => {
      this.#context = previous
    }
  }
}

export function createReviewToolRuntime(): ReviewToolRuntime {
  return new ReviewToolRuntimeState()
}

/** Dependencies the tool bodies read from, injectable for tests. */
export interface ReviewToolDeps {
  /** The `reviewRules` service's matcher; the whole registry in production. */
  readonly rules: Pick<ReviewRuleRegistry, 'match'>
  /** Reads the active per-run context, or `undefined` before activation. */
  readonly context: () => ReviewToolContext | undefined
}

function requireContext(context: ReviewToolContext | undefined): ReviewToolContext {
  if (context === undefined) {
    throw new Error('no review context is bound — the controller must activate it before the agent runs')
  }
  return context
}

function assertSafePath(path: string): string {
  const trimmed = path.trim()
  if (!isSafeRelativePath(trimmed)) {
    throw new TypeError(`path must be a safe repo-relative path, got '${excerpt(path)}'`)
  }
  return trimmed
}

function excerpt(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value
}

/** The projected rule surface a tool exposes to the model. */
function projectRule(rule: Rule): { id: string; severity: Rule['severity']; guidance: string; requiresScenario: boolean } {
  return {
    id: rule.id,
    severity: rule.severity,
    guidance: rule.guidance,
    requiresScenario: rule.requiresScenario,
  }
}

/**
 * Builds the five M1 tool definitions. Extracted from `apply` so the suite can
 * exercise `execute` bodies directly against a mocked context and rule set,
 * without booting a Cordis container.
 *
 * `propose_patch` is deliberately absent: it lands in M3, gated by
 * trust-policy at `tools/pre-execute`. Registering a stub that looks callable
 * would hand the model a tool that does nothing.
 */
export function createReviewTools(deps: ReviewToolDeps): readonly ToolDefinition[] {
  const { rules, context } = deps

  const readDiffShard = defineTool({
    name: 'read_diff_shard',
    description:
      'Read one bounded diff shard by its zero-based index. Shards are the controller-sliced pieces of the pull request diff; read them instead of assuming file contents you have not seen.',
    parameters: {
      index: {
        type: 'integer',
        description: 'Zero-based index of the shard to read.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', required: true },
          files: { type: 'array', items: { type: 'string' }, required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `diff shard ${value.index} — ${value.files.length} file(s)${value.truncated ? ' (truncated)' : ''}\n\n${value.text}`,
        },
      ],
    },
    execute: async (args, exec: ToolRunContext) => {
      exec.signal.throwIfAborted()
      const shards = requireContext(context()).shards
      const shard = shards[args.index]
      if (shard === undefined) {
        throw new Error(`no diff shard at index ${args.index}; shards are 0..${shards.length - 1}`)
      }
      return { index: shard.index, files: [...shard.files], text: shard.text, truncated: shard.truncated }
    },
  })

  const listApplicableRules = defineTool({
    name: 'list_applicable_rules',
    description:
      'List the review rules whose glob patterns match a repository path. Use the returned rule ids (and their requiresScenario flag) when you report findings.',
    parameters: {
      path: {
        type: 'string',
        description: 'Repo-relative path to match rules for.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                severity: { type: 'string', enum: SEVERITY_ORDER, required: true },
                guidance: { type: 'string', required: true },
                requiresScenario: { type: 'boolean', required: true },
              },
            },
            required: true,
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.rules.length === 0
            ? `no rules match '${value.path}'`
            : `${value.rules.length} rule(s) match '${value.path}':\n${value.rules.map((rule) => `- [${rule.id}] ${rule.severity}: ${rule.guidance}`).join('\n')}`,
        },
      ],
    },
    execute: async (args, exec: ToolRunContext) => {
      exec.signal.throwIfAborted()
      const path = assertSafePath(args.path)
      const matched = rules.match(path)
      return { path, rules: matched.map(projectRule) }
    },
  })

  const reportFinding = defineTool({
    name: 'report_finding',
    description:
      'Propose one review finding. This only records a receipt — it posts nothing. The controller collects every proposal, validates it, and publishes the ones that pass; a proposal that fails validation is discarded, never written.',
    parameters: {
      severity: {
        type: 'string',
        enum: SEVERITY_ORDER,
        description: 'Severity. A blocker additionally needs a reproducible failureScenario.',
        required: true,
      },
      title: {
        type: 'string',
        description: 'Short, specific title for the finding.',
        required: true,
      },
      body: {
        type: 'string',
        description: 'What is wrong, why it matters, and what a correct version looks like.',
        required: true,
      },
      path: {
        type: 'string',
        description: 'Repo-relative path the finding attaches to.',
        required: true,
      },
      line: {
        type: 'integer',
        description: '1-based line number on the new side of the diff.',
        required: true,
      },
      ruleId: {
        type: 'string',
        description: 'Optional rule id this finding cites (from list_applicable_rules).',
      },
      failureScenario: {
        type: 'string',
        description: 'Optional reproducible inputs/state that lead to the failure. Required for blocker.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          received: { type: 'boolean', required: true },
          severity: { type: 'string', enum: SEVERITY_ORDER, required: true },
          title: { type: 'string', required: true },
          path: { type: 'string', required: true },
          line: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `proposal received — ${value.severity}: ${value.title} (${value.path}:${value.line}). The controller will validate it before publishing.`,
        },
      ],
    },
    execute: async (args, exec: ToolRunContext) => {
      // No forge I/O and no posting here: this is a pure receipt. The controller
      // collects the full proposal from the call's arguments and validates it
      // later, so an invalid proposal is dropped rather than published.
      exec.signal.throwIfAborted()
      return {
        received: true,
        severity: args.severity,
        title: args.title,
        path: args.path,
        line: args.line,
      }
    },
  })

  const readRepoFile = defineTool({
    name: 'read_repo_file',
    description:
      'Read one file from the immutable base-SHA copy of the repository. Never available to a fork: the untrusted head copy is not exposed through this tool.',
    parameters: {
      path: {
        type: 'string',
        description: 'Repo-relative path to read.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `${value.path}:\n\`\`\`\n${value.content}\n\`\`\`` },
      ],
    },
    execute: async (args, exec: ToolRunContext) => {
      exec.signal.throwIfAborted()
      const path = assertSafePath(args.path)
      const content = await requireContext(context()).readRepoFile(path, exec.signal)
      return { path, content }
    },
  })

  const readCheckLog = defineTool({
    name: 'read_check_log',
    description:
      'Read the log of one failed CI check by its check id. Available only at trusted-read and above, so a fork cannot read repository CI output.',
    parameters: {
      checkId: {
        type: 'string',
        description: 'Identifier of the failed check to read.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          checkId: { type: 'string', required: true },
          log: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.log }],
    },
    execute: async (args, exec: ToolRunContext) => {
      exec.signal.throwIfAborted()
      const checkId = args.checkId.trim()
      if (checkId === '') {
        throw new TypeError('checkId must be a non-empty string')
      }
      const log = await requireContext(context()).readCheckLog(checkId, exec.signal)
      return { checkId, log }
    },
  })

  return [readDiffShard, listApplicableRules, reportFinding, readRepoFile, readCheckLog]
}

export function apply(ctx: Context, _config: Config): void {
  const runtime = createReviewToolRuntime()
  // Fiber-owned: the service unregisters when this plugin's fiber unloads.
  ctx.provide('reviewTools', runtime)

  const tools = createReviewTools({
    rules: ctx.reviewRules,
    context: () => runtime.context,
  })
  // Effect-based registration: disposing the plugin fiber unregisters every tool.
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  // TODO(M3): register `propose_patch` when config.enablePatchProposal is true,
  //           gated by trust-policy at tools/pre-execute (trusted-write).
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    reviewTools: ReviewToolRuntime
  }
}
