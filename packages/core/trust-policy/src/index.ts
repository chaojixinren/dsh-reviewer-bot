/**
 * Trust resolution and tool execution gating.
 *
 * Two mechanisms, deliberately separate:
 *   - `tools/pre-execute` — the reorderable allow/deny/ask policy layer.
 *   - `ctx.tools.guard()` — monotonic final denial that later listeners cannot
 *     undo. Hard red lines live here, not in the waterfall.
 *
 * A prompt-layer defense is not part of this design: even a fully persuaded
 * model cannot cross these gates, because they sit at the mechanism layer.
 * See docs/04-trust-model.md.
 */
import type { Capabilities, ReviewIntent, TrustLevel } from '@dshrb/review-core'
import type { ForgePermission } from '@dshrb/forge'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dshrb-trust-policy'
export const inject = ['tools']

export interface Config {
  /**
   * Must only be settable from layers the repository maintainer controls
   * (bundle patch / Action inputs). A fork must not be able to raise this by
   * adding `.dshrb.yml` on its own branch. See docs/05-plugin-composition.md.
   */
  allowWrite: boolean
  /** Paths that can never be written, regardless of trust. */
  protectedPaths: string[]
}

export const Config: Schema<Config> = Schema.object({
  allowWrite: Schema.boolean().default(false),
  protectedPaths: Schema.array(Schema.string()).default([
    '.github/**',
    '.gitlab-ci.yml',
    '.circleci/**',
    'Jenkinsfile',
  ]),
})

export interface TrustInput {
  readonly isFork: boolean
  readonly permission: ForgePermission
  readonly intent: ReviewIntent
  readonly allowWrite: boolean
}

/**
 * `@dsr fix` alone grants nothing: write requires actor permission AND explicit
 * repository configuration. Otherwise anyone could shout "fix" in a PR and
 * mutate the branch.
 */
export declare function resolveTrust(input: TrustInput): TrustLevel

export declare function capabilitiesFor(trust: TrustLevel): Capabilities

/** Explains a `none` outcome in terms of the specific missing condition. */
export declare function explainDenial(input: TrustInput): string

export function apply(_ctx: Context, _config: Config): void {
  // TODO(M1): ctx.on('tools/pre-execute') → allow / deny / ask by capability.
  // TODO(M1): ctx.tools.restrict() to narrow the visible set per TrustLevel,
  //           keeping presentation, lookup, and execution aligned.
  // TODO(M3): ctx.tools.guard() for the monotonic red lines:
  //           protectedPaths, package.json `scripts`, binaries, path traversal,
  //           symlinks, and lockfiles without a matching manifest change.
  throw new Error('not implemented: M1/M3')
}
