/**
 * Runtime bootstrap: assembles the Cordis container, the DSH runtime services,
 * and the @dshrb plugin chain into a runnable entrypoint.
 *
 * This is the seam that `driver-action.createRunner` and `driver-cli.runAgent`
 * both defer to. In profile mode (docs/08 mode C) the same assembly is expressed
 * declaratively by `bundle/cordis.patch.yml` and booted by the DSH launcher;
 * here a standalone Action/CLI process owns the boot, so it mounts the DSH
 * runtime services directly (no Loader, no native helper — every plugin is a
 * static import the release build bundles into `dist/index.js`).
 *
 * See docs/05-packaging.md for how this is bundled and attached to a release.
 */
import { Context } from '@deepseek-ai/cordis'
import type { ReviewResult, Severity } from '@dshrb/review-core'
import { createRunAgent } from '@dshrb/review-runtime'
import type { AgentLoopServices } from '@dshrb/review-runtime'

// DSH runtime services (mode A standalone; every default export is a Cordis
// plugin that provides the service named after it).
import systemPrompt from '@deepseek-ai/dsh-system-prompt'
import tools from '@deepseek-ai/dsh-tools'
import sandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import fsSandbox from '@deepseek-ai/dsh-fs-sandbox'
import typertRegistry from '@deepseek-ai/dsh-typert-registry'
import session from '@deepseek-ai/dsh-session'
import agent from '@deepseek-ai/dsh-agent'
import sessionProjection from '@deepseek-ai/dsh-session-projection'
import subagent from '@deepseek-ai/dsh-subagent'
import * as subagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import agentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import llm from '@deepseek-ai/dsh-llm'
import * as llmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import credentialsLocal from '@deepseek-ai/dsh-credentials-local'
import settingsFile from '@deepseek-ai/dsh-settings-file'
import agentLoop from '@deepseek-ai/dsh-agent-loop'
import { DockerSandboxProvider } from './docker-sandbox.js'
import { UnavailableSandboxProvider } from './unavailable-sandbox.js'

// @dshrb plugin chain, in the layer order documented by bundle/cordis.patch.yml.
import * as ruleRegistry from '@dshrb/rule-registry'
import * as rulesBaseline from '@dshrb/rules-baseline'
import * as trustPolicy from '@dshrb/trust-policy'
import * as forge from '@dshrb/forge'
import * as forgeGithub from '@dshrb/forge-github'
import * as forgeGitlab from '@dshrb/forge-gitlab'
import * as toolReview from '@dshrb/tool-review'
import * as progress from '@dshrb/progress'
import * as reviewRuntime from '@dshrb/review-runtime'

/**
 * Driver-facing assembly config. Every field maps onto an Action input or an
 * environment variable; unset fields fall back to the plugin schemas' defaults.
 */
export interface RuntimeBootstrapConfig {
  /** LLM provider/model for `agent-default-model` (defaults to the DSH base). */
  readonly provider?: string
  readonly model?: string
  /** Sandbox policy: fail-closed `read-only` by default. */
  readonly sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly workspaceRoot?: string
  /** GitHub token (forge-github); required for remote review. */
  readonly githubToken?: string
  readonly githubBaseUrl?: string
  /** Optional GitLab token; forge-gitlab is mounted only when present. */
  readonly gitlabToken?: string
  /** Review pipeline + policy switches. */
  readonly allowWrite?: boolean
  readonly enableDiagnose?: boolean
  readonly minSeverity?: Severity
  readonly timeoutMinutes?: number
  readonly disabledRules?: readonly string[]
  readonly protectedPaths?: readonly string[]
  /** Validation command gate (exact argv arrays, never shell strings). */
  readonly testCommands?: readonly (readonly string[])[]
  readonly validationEnv?: readonly string[]
  /**
   * Digest-pinned isolation image for write-mode validation. When set, the
   * standalone runtime mounts a `DockerSandboxProvider` (docker run) instead of
   * the fail-closed `UnavailableSandboxProvider`; read-only reviews never
   * confine a subprocess, so the image is only consulted in write mode.
   */
  readonly containerImage?: string
}

export interface BootstrappedRuntime {
  /** The settled Cordis root context. */
  readonly ctx: Context
  /** Runs one normalized event through the eight-stage pipeline. */
  readonly runReview: (raw: unknown) => Promise<ReviewResult>
  /** Builds a single-agent loop over the booted runtime services. */
  readonly createRunAgent: (services: AgentLoopServices) => ReturnType<typeof createRunAgent>
  /** Disposes the whole tree (bounded, awaited). */
  readonly dispose: () => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    reviewRuntime: { runReview(raw: unknown): Promise<ReviewResult> }
  }
}

/** Maps driver config onto the review-runtime plugin's config object. */
function reviewRuntimeConfig(config: RuntimeBootstrapConfig): reviewRuntime.Config {
  return {
    timeoutMinutes: config.timeoutMinutes ?? 25,
    shardBytes: 120_000,
    parallelShards: true,
    shardConcurrency: 4,
    shardTokenBudget: 0,
    snapshotReplay: true,
    allowWrite: config.allowWrite ?? false,
    enableDiagnose: config.enableDiagnose ?? true,
    minSeverity: config.minSeverity ?? 'minor',
    testCommands: config.testCommands === undefined ? [] : [...config.testCommands].map((argv) => [...argv]),
    validationEnv: config.validationEnv === undefined ? [] : [...config.validationEnv],
  }
}

/**
 * Boots the standalone runtime. The caller is responsible for setting the
 * credential environment first (e.g. `DEEPSEEK_API_KEY`), mirroring how the
 * DSH base resolves credentials from the inherited environment.
 */
export async function bootReviewRuntime(config: RuntimeBootstrapConfig): Promise<BootstrappedRuntime> {
  const ctx = new Context()
  const workspaceRoot = config.workspaceRoot ?? process.cwd()
  const allowWrite = config.allowWrite ?? false
  // The sandbox policy's default mode must track `allowWrite` so the two never
  // drift (bundle/cordis.patch.yml comment): fail-closed read-only by default,
  // widened only when the maintainer-held driver config raises write mode.
  const sandboxMode = config.sandboxMode ?? (allowWrite ? 'workspace-write' : 'read-only')

  // --- DSH runtime services, in dependency order ---------------------------
  await ctx.plugin(systemPrompt)
  await ctx.plugin(tools, {})
  await ctx.plugin(sandboxPolicy, { mode: sandboxMode, workspaceRoot })
  await ctx.plugin(fsSandbox, { cwd: workspaceRoot })
  // Write-mode validation confinement: a digest-pinned image upgrades the
  // fail-closed provider to a real Docker sandbox; without one, confinement
  // stays unavailable and any write-mode validation fails closed.
  if (config.containerImage !== undefined) {
    await ctx.plugin(DockerSandboxProvider, { image: config.containerImage })
  } else {
    await ctx.plugin(UnavailableSandboxProvider)
  }
  await ctx.plugin(typertRegistry)
  await ctx.plugin(session)
  await ctx.plugin(agent)
  await ctx.plugin(sessionProjection)
  await ctx.plugin(subagent)
  await ctx.plugin(subagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(agentDefaultModel, { provider: config.provider ?? 'deepseek-official', model: config.model ?? 'deepseek-v4-flash' })
  await ctx.plugin(llm)
  await ctx.plugin(llmDeepseek)
  await ctx.plugin(credentialsLocal)
  await ctx.plugin(settingsFile)
  // Registers the concrete agent factory (`ctx.agents.setFactory`). Without it
  // `ctx.agents.create()` in review-runtime's `createRunAgent` fails with
  // "no agent factory registered (load an agent-loop plugin)".
  await ctx.plugin(agentLoop)

  // --- @dshrb plugin chain (bundle/cordis.patch.yml layer order) -----------
  await ctx.plugin(ruleRegistry, { disabled: [...(config.disabledRules ?? [])], minSeverity: config.minSeverity ?? 'minor' })
  await ctx.plugin(rulesBaseline)
  await ctx.plugin(trustPolicy, { allowWrite, protectedPaths: [...(config.protectedPaths ?? ['.github/**', '.gitlab-ci.yml', '.circleci/**', 'Jenkinsfile'])] })
  await ctx.plugin(forge)
  if (config.githubToken !== undefined) {
    await ctx.plugin(forgeGithub, { token: config.githubToken, baseUrl: config.githubBaseUrl ?? 'https://api.github.com' })
  }
  if (config.gitlabToken !== undefined) {
    await ctx.plugin(forgeGitlab, { token: config.gitlabToken, baseUrl: 'https://gitlab.com/api/v4' })
  }
  await ctx.plugin(toolReview, { enablePatchProposal: true })
  await ctx.plugin(progress)
  await ctx.plugin(reviewRuntime, reviewRuntimeConfig(config))

  return {
    ctx,
    runReview: (raw) => ctx.reviewRuntime.runReview(raw),
    createRunAgent: (services) => createRunAgent(ctx, services),
    dispose: () => ctx.fiber.dispose(),
  }
}
