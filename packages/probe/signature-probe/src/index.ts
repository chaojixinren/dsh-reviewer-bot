/**
 * Signature-validation plugin.
 *
 * Purpose: prove the four extension points DSH Reviewer Bot depends on against
 * the REAL installed types, before the design is replicated across nine
 * packages. Every construct here is load-bearing — if this file typechecks,
 * the corresponding design assumption is confirmed.
 *
 * Validates:
 *   1. plugin module shape       — name / inject / Config / apply
 *   2. ctx.tools.register()      — via defineTool, incl. mandatory output schema
 *   3. tools/pre-execute         — waterfall returning PreToolDecision
 *   4. ctx.tools.guard()         — monotonic sync guard returning string | undefined
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  PreToolDecision,
  ToolExecution,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'

export const name = 'probe-signatures'

/** Service dependencies. Plain service-name strings, per real upstream plugins. */
export const inject: string[] = ['tools']

export interface Config {
  /** Tool names the guard denies outright. Proves config reaches the guard. */
  readonly denyTools: string[]
}

export const Config: z<Config> = z.object({
  denyTools: z.array(z.string()).default([]),
}) as unknown as z<Config>

export function apply(ctx: Context, config: Config): void {
  // ---- 2. Tool registration ------------------------------------------------
  // `output` is REQUIRED: a value schema plus a render() producing ContentBlock[].
  ctx.tools.register(
    defineTool({
      name: 'probe_read_diff',
      description: 'Probe tool. Returns a fixed payload; proves the register contract.',
      // FLAT map of name -> spec. Not wrapped in {type:'object',properties}.
      // Requiredness is per-property (`required: true`), not a top-level array.
      parameters: {
        path: {
          type: 'string',
          description: 'File path to pretend to read.',
          required: true,
        },
      },
      output: {
        // `additionalProperties` is MANDATORY on an object value schema.
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            lines: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `${value.path}: ${value.lines} lines` },
        ],
      },
      execute: async (args, exec: ToolRunContext) => {
        exec.signal.throwIfAborted()
        return { path: args.path, lines: 0 }
      },
    }),
  )

  // ---- 3. tools/pre-execute waterfall --------------------------------------
  // NOT a plain event listener: it receives next() and returns PreToolDecision.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name === 'probe_read_diff' && exec.arguments === undefined) {
      return { kind: 'deny', reason: 'probe: missing arguments' }
    }
    return next()
  })

  // ---- 4. Monotonic guard --------------------------------------------------
  // Sync, returns a denial reason string or undefined to abstain.
  ctx.tools.guard((execution: Readonly<ToolExecution>): string | undefined => {
    return config.denyTools.includes(execution.name)
      ? `probe: ${execution.name} is on the deny list`
      : undefined
  })
}
