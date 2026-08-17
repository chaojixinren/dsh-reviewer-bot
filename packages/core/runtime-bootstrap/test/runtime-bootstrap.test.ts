import { describe, expect, it } from 'vitest'
import { forgeId } from '@dshrb/review-core'
import { DockerSandboxProvider } from '../src/docker-sandbox.ts'
import { UnavailableSandboxProvider } from '../src/unavailable-sandbox.ts'
import { bootReviewRuntime } from '../src/index.ts'

/**
 * Offline boot smoke for the standalone runtime entrypoint.
 *
 * `bootReviewRuntime` is what `driver-action.createRunner` and the CLI's
 * `runAgent` both build on, so this pins the container the release build ships:
 * every DSH runtime service plus the @dshrb plugin chain composes into one
 * context, `reviewRuntime` is provided, and the agent loop is constructible —
 * all without a network or a credential (docs/05-packaging.md).
 */
describe('runtime bootstrap', () => {
  it('boots the full container offline and composes every service', async () => {
    const runtime = await bootReviewRuntime({})
    try {
      const { ctx } = runtime

      // DSH runtime services the pipeline depends on.
      expect(ctx.systemPrompt).toBeDefined()
      expect(ctx.tools).toBeDefined()
      expect(ctx.sandboxPolicy).toBeDefined()
      expect(ctx.fs).toBeDefined()
      expect(ctx.sandbox).toBeDefined()
      expect(ctx.typert).toBeDefined()
      expect(ctx.sessions).toBeDefined()
      expect(ctx.agents).toBeDefined()
      expect(ctx.sessionProjections).toBeDefined()
      expect(ctx.subagents).toBeDefined()
      expect(ctx.agentDefaultModel).toBeDefined()
      expect(ctx.llm).toBeDefined()
      expect(ctx.credentials).toBeDefined()
      expect(ctx.settings).toBeDefined()

      // @dshrb plugin chain.
      expect(ctx.reviewRules).toBeDefined()
      expect(ctx.trustPolicy).toBeDefined()
      expect(ctx.forges).toBeDefined()
      expect(ctx.reviewTools).toBeDefined()
      expect(ctx.progress).toBeDefined()
      expect(ctx.reviewRuntime).toBeDefined()

      // The review tools are registered on the shared ctx.tools.
      const names = ctx.tools.schemas().map((schema) => schema.name)
      expect(names).toContain('read_diff_shard')
      expect(names).toContain('report_finding')
      expect(names).toContain('propose_patch')

      // The baseline rule pack is registered.
      expect(ctx.reviewRules.packs().length).toBeGreaterThan(0)

      // The driver-facing entrypoints are wired.
      expect(typeof runtime.runReview).toBe('function')
      expect(typeof runtime.createRunAgent).toBe('function')
    } finally {
      await runtime.dispose()
    }
  })

  it('mounts forge-github only when a token is supplied', async () => {
    const bare = await bootReviewRuntime({})
    try {
      expect(bare.ctx.forges.resolve(forgeId('github'))).toBeUndefined()
    } finally {
      await bare.dispose()
    }

    const withToken = await bootReviewRuntime({ githubToken: 'test-token' })
    try {
      expect(withToken.ctx.forges.resolve(forgeId('github'))).toBeDefined()
    } finally {
      await withToken.dispose()
    }
  })

  it('mounts the fail-closed sandbox provider by default', async () => {
    const runtime = await bootReviewRuntime({})
    try {
      expect(runtime.ctx.sandbox).toBeInstanceOf(UnavailableSandboxProvider)
    } finally {
      await runtime.dispose()
    }
  })

  it('mounts the Docker sandbox provider when a container image is supplied', async () => {
    const runtime = await bootReviewRuntime({ containerImage: `ghcr.io/owner/repo@sha256:${'a'.repeat(64)}` })
    try {
      expect(runtime.ctx.sandbox).toBeInstanceOf(DockerSandboxProvider)
    } finally {
      await runtime.dispose()
    }
  })

  it('constructs an agent loop without making an LLM call', async () => {
    const runtime = await bootReviewRuntime({})
    try {
      const { ctx } = runtime
      // `createRunAgent` only builds the closure; it must not touch the network.
      const runAgent = runtime.createRunAgent({ forges: ctx.forges, trustPolicy: ctx.trustPolicy })
      expect(typeof runAgent).toBe('function')
    } finally {
      await runtime.dispose()
    }
  })
})
