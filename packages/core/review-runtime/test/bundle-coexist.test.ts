import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import toolsPlugin, { defineTool } from '@deepseek-ai/dsh-tools'
import systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as ruleRegistry from '@dshrb/rule-registry'
import * as toolReview from '@dshrb/tool-review'
import * as trustPolicy from '@dshrb/trust-policy'

/**
 * Coexistence + uninstall tests in a REAL Cordis container.
 *
 * The issue's success criterion is not "the bundle can be installed" but "once
 * installed, our plugins coexist with a stranger plugin on the same `ctx`
 * without stepping on each other" (docs/08-deployment-modes.md, mode C). We
 * load the three plugins that actually register shared-`ctx` things —
 * `rule-registry` (the `reviewRules` service), `tool-review` (tools),
 * `trust-policy` (the `tools/pre-execute` waterfall + monotonic guard) — next
 * to a stub third-party plugin, and assert:
 *
 *   1. both services resolve,
 *   2. systemPrompt section ordering stays stable,
 *   3. our `tools/pre-execute` abstains for a tool we do not govern,
 *   4. disposing each fiber rolls its registrations back with no residue.
 */

/** A stub third-party plugin's service, used to prove shared-`ctx` coexistence. */
interface StubService {
  ping(): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    stubService?: StubService
  }
}

const stubTool = defineTool({
  name: 'stub_echo',
  description: 'Stub third-party tool. Returns its input; proves coexistence.',
  parameters: {
    text: { type: 'string', description: 'text to echo', required: true },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { echoed: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.echoed }],
  },
  execute: async (args) => ({ echoed: args.text }),
})

/** A stub third-party plugin: one service, one tool, two systemPrompt sections. */
const stubPlugin = {
  name: 'stub-third-party',
  inject: ['tools', 'systemPrompt'],
  apply(ctx: Context): void {
    ctx.provide('stubService', { ping: () => 'pong' })
    ctx.effect(() => ctx.tools.register(stubTool))
    // Two sections with distinct orders, to pin that assembly keeps ascending order.
    ctx.effect(() => ctx.systemPrompt.section({ name: 'stub:high', order: 900, text: 'stub high' }))
    ctx.effect(() => ctx.systemPrompt.section({ name: 'stub:low', order: 100, text: 'stub low' }))
  },
}

async function bootContainer(): Promise<{
  ctx: Context
  ruleRegistryFiber: Awaited<ReturnType<Context['plugin']>>
  toolReviewFiber: Awaited<ReturnType<Context['plugin']>>
  trustPolicyFiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolsPlugin, {})
  const ruleRegistryFiber = await ctx.plugin(ruleRegistry, { disabled: [], minSeverity: 'minor' })
  const toolReviewFiber = await ctx.plugin(toolReview, { enablePatchProposal: true })
  const trustPolicyFiber = await ctx.plugin(trustPolicy, { allowWrite: false, protectedPaths: [] })
  await ctx.plugin(stubPlugin)
  return { ctx, ruleRegistryFiber, toolReviewFiber, trustPolicyFiber }
}

/** Runs one tool through the registry's real pre-execute + guard pipeline. */
async function runTool(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: CallId(`test-${name}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

describe('bundle coexistence', () => {
  it('resolves our services and a stub third-party service in one container', async () => {
    const { ctx } = await bootContainer()
    expect(ctx.reviewRules).toBeDefined()
    expect(ctx.trustPolicy).toBeDefined()
    expect(ctx.reviewTools).toBeDefined()
    expect(ctx.stubService?.ping()).toBe('pong')
  })

  it('registers our tools and a stub tool side by side', async () => {
    const { ctx } = await bootContainer()
    const names = ctx.tools.schemas().map((schema) => schema.name)
    expect(names).toContain('read_diff_shard')
    expect(names).toContain('stub_echo')
  })

  it('keeps systemPrompt section ordering stable next to a stub section', async () => {
    const { ctx } = await bootContainer()
    const assembly = await ctx.systemPrompt.assemble()
    const names = assembly.sections.map((section) => section.name)
    // `order` is applied at assembly; lower order renders first.
    expect(names.indexOf('stub:low')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('stub:high')).toBeGreaterThan(names.indexOf('stub:low'))
    expect(assembly.sections.find((section) => section.name === 'stub:low')?.text).toBe('stub low')
  })

  it('does not block a stub tool at tools/pre-execute', async () => {
    const { ctx } = await bootContainer()
    const result = await runTool(ctx, 'stub_echo', { text: 'hi' })
    expect(result.isError).toBe(false)
    if (!result.isError) {
      expect(result.value).toEqual({ echoed: 'hi' })
    }
  })
})

describe('bundle uninstall', () => {
  it('rolls back tools, the guard, and services when fibers are disposed', async () => {
    const { ctx, ruleRegistryFiber, toolReviewFiber, trustPolicyFiber } = await bootContainer()

    expect(ctx.trustPolicy).toBeDefined()
    expect(ctx.reviewTools).toBeDefined()
    expect(ctx.reviewRules).toBeDefined()
    expect(ctx.tools.schemas().some((schema) => schema.name === 'read_diff_shard')).toBe(true)

    // trust-policy's monotonic guard denies a governed write tool while no
    // write-guard context is bound (no run is active).
    const patch = { path: 'a.ts', diff: '@@ -1 +1 @@\n-x\n+y\n' }
    const guarded = await runTool(ctx, 'propose_patch', patch)
    expect(guarded.isError).toBe(true)

    // Disposing trust-policy removes the pre-execute waterfall and the guard,
    // so propose_patch (still registered by tool-review) is no longer denied.
    await trustPolicyFiber.dispose()
    expect(ctx.trustPolicy).toBeUndefined()
    const unguarded = await runTool(ctx, 'propose_patch', patch)
    expect(unguarded.isError).toBe(false)

    // Disposing tool-review rolls back every tool it registered via ctx.effect.
    await toolReviewFiber.dispose()
    expect(ctx.reviewTools).toBeUndefined()
    expect(ctx.tools.schemas().some((schema) => schema.name === 'read_diff_shard')).toBe(false)

    // Disposing rule-registry rolls back the reviewRules service it provided.
    await ruleRegistryFiber.dispose()
    expect(ctx.reviewRules).toBeUndefined()
  })
})
