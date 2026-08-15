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
import { NO_CAPABILITIES, capabilities } from '@dshrb/review-core'
import type { ForgePermission } from '@dshrb/forge'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolRestriction } from '@deepseek-ai/dsh-tools'
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
 * The event-derived half of a `TrustInput`. `allowWrite` is deliberately absent:
 * it is composed in from plugin config, so no caller carrying attacker-influenced
 * data has a parameter through which to raise it. See `TrustPolicy.activate`.
 */
export type ActorContext = Omit<TrustInput, 'allowWrite'>

// ---------------------------------------------------------------------------
// Trust resolution
// ---------------------------------------------------------------------------

/** Permissions that make an actor a repository collaborator, not a visitor. */
const WRITE_PERMISSIONS: readonly ForgePermission[] = ['write', 'maintain', 'admin']

/** Intents that mutate the repository, so they additionally require `allowWrite`. */
const WRITE_INTENTS: readonly ReviewIntent[] = ['fix']

/**
 * Minimum trust each intent requires, from the routing table in
 * docs/03-review-pipeline.md. Used by `explainDenial` to name `isFork` as the
 * blocker: a fork caps at `untrusted`, so an intent needing more is refused by
 * the fork condition rather than by permission or configuration.
 */
export const INTENT_MIN_TRUST: Readonly<Record<ReviewIntent, TrustLevel>> = Object.freeze({
  review: 'untrusted',
  explain: 'untrusted',
  rules: 'untrusted',
  diagnose: 'trusted-read',
  fix: 'trusted-write',
  none: 'none',
})

const TRUST_ORDER: readonly TrustLevel[] = ['none', 'untrusted', 'trusted-read', 'trusted-write']

/** True when `trust` is at or above `minimum` on the four-level ladder. */
export function meetsTrust(trust: TrustLevel, minimum: TrustLevel): boolean {
  return TRUST_ORDER.indexOf(trust) >= TRUST_ORDER.indexOf(minimum)
}

/** True when the actor's own permission would allow writing, ignoring config. */
function actorMayWrite(permission: ForgePermission): boolean {
  return WRITE_PERMISSIONS.includes(permission)
}

/** True when the intent asks to mutate the repository. */
function intentNeedsWrite(intent: ReviewIntent): boolean {
  return WRITE_INTENTS.includes(intent)
}

/**
 * `@dsr fix` alone grants nothing: write requires actor permission AND explicit
 * repository configuration. Otherwise anyone could shout "fix" in a PR and
 * mutate the branch.
 */
export function resolveTrust(input: TrustInput): TrustLevel {
  // An unrouted event authorizes nothing; there is no action to weigh.
  if (input.intent === 'none') return 'none'
  // A fork is never above untrusted, whatever the actor's permission says: the
  // head commit is attacker-controlled code (T1).
  if (input.isFork) return 'untrusted'
  if (!actorMayWrite(input.permission)) return 'none'
  if (!intentNeedsWrite(input.intent)) return 'trusted-read'
  // Permission holds; the repository must additionally have opted in (T7).
  return input.allowWrite ? 'trusted-write' : 'none'
}

export function capabilitiesFor(trust: TrustLevel): Capabilities {
  switch (trust) {
    case 'none':
      return NO_CAPABILITIES
    // No repository-file capability by design: acceptance gate 2 in the M1
    // roadmap asserts a fork PR has no repo-reading tool at all, and the tool
    // allowlist is derived from this record.
    case 'untrusted':
      return capabilities({ readDiff: true, publishComments: true })
    case 'trusted-read':
      return capabilities({
        readDiff: true,
        readRepoFiles: true,
        readCheckLogs: true,
        publishComments: true,
      })
    case 'trusted-write':
      return capabilities({
        readDiff: true,
        readRepoFiles: true,
        readCheckLogs: true,
        publishComments: true,
        proposePatches: true,
        commitPatches: true,
      })
  }
}

/**
 * Explains a refusal in terms of the specific missing condition, so a user can
 * act on it. Returns `undefined` when nothing is missing — the resolved trust
 * satisfies the intent's minimum.
 */
export function explainDenialReason(input: TrustInput): string | undefined {
  const trust = resolveTrust(input)
  const minimum = INTENT_MIN_TRUST[input.intent]
  if (meetsTrust(trust, minimum) && trust !== 'none') return undefined

  if (input.intent === 'none') {
    return 'intent: no supported command was recognized, so there is nothing to authorize'
  }
  if (input.isFork) {
    return `isFork: a pull request from a fork is capped at 'untrusted', but intent '${input.intent}' requires '${minimum}'`
  }
  if (!actorMayWrite(input.permission)) {
    return `permission: actor has '${input.permission}', but one of ${WRITE_PERMISSIONS.join(' / ')} is required`
  }
  if (intentNeedsWrite(input.intent) && !input.allowWrite) {
    return `allowWrite: intent '${input.intent}' needs write mode, which the repository has not enabled (set allow-write in the Action inputs or bundle config)`
  }
  return `intent: '${input.intent}' requires '${minimum}', but the resolved trust is '${trust}'`
}

/** Explains a `none` outcome in terms of the specific missing condition. */
export function explainDenial(input: TrustInput): string {
  return explainDenialReason(input) ?? `intent '${input.intent}' is authorized at '${resolveTrust(input)}'`
}

// ---------------------------------------------------------------------------
// Tool gating
// ---------------------------------------------------------------------------

/**
 * The capability a tool consumes. `'always'` means the tool needs no capability
 * beyond a trust level above `none` — it neither reads privileged data nor
 * proposes a change (rule lookup, finding receipts).
 */
export type ToolRequirement = keyof Capabilities | 'always'

/**
 * Model-facing tool -> required capability. Must stay in sync with
 * `TOOL_NAMES` in `@dshrb/tool-review`; that package is not imported because
 * the dependency direction is the other way round (its tools are gated here).
 * A tool absent from this table is not ours: the waterfall abstains and calls
 * `next()` rather than deciding for another plugin.
 */
export const TOOL_REQUIREMENTS: Readonly<Record<string, ToolRequirement>> = Object.freeze({
  read_diff_shard: 'readDiff',
  list_applicable_rules: 'always',
  report_finding: 'always',
  read_repo_file: 'readRepoFiles',
  read_check_log: 'readCheckLogs',
  propose_patch: 'proposePatches',
})

/** Requirements that only a write-mode trust level can satisfy. */
const WRITE_REQUIREMENTS: readonly ToolRequirement[] = ['proposePatches', 'commitPatches']

/** Tool names this policy governs, in table order. */
export const GOVERNED_TOOLS: readonly string[] = Object.freeze(Object.keys(TOOL_REQUIREMENTS))

/** True when a capability is granted at `trust`. */
function grants(trust: TrustLevel, requirement: ToolRequirement): boolean {
  if (requirement === 'always') return trust !== 'none'
  return capabilitiesFor(trust)[requirement]
}

/**
 * The tools visible at a trust level. Presentation, lookup, and execution all
 * read this one set: a tool the model can see but not call is a worse failure
 * than one it never sees.
 */
export function visibleTools(trust: TrustLevel): readonly string[] {
  return GOVERNED_TOOLS.filter((tool) => grants(trust, TOOL_REQUIREMENTS[tool] as ToolRequirement))
}

/**
 * The `ctx.tools.restrict()` filter for a trust level. An `allow` list, not a
 * `deny` list: a tool added later is invisible until it is classified here,
 * which fails closed.
 */
export function toolRestrictionFor(trust: TrustLevel): ToolRestriction {
  return { allow: visibleTools(trust) }
}

/**
 * The pre-execute decision for one call, or `undefined` to abstain because the
 * tool is not ours.
 *
 * `ask` is returned only where an approval service can legitimately resolve the
 * gap: the actor holds write permission and the intent is a write intent, but
 * the repository has not set `allowWrite`. Every other shortfall is a `deny` —
 * no approval prompt can grant a fork write access.
 */
export function decideToolCall(input: TrustInput, toolName: string): PreToolDecision | undefined {
  const requirement = TOOL_REQUIREMENTS[toolName]
  if (requirement === undefined) return undefined

  const trust = resolveTrust(input)
  if (grants(trust, requirement)) return { kind: 'allow' }

  if (
    WRITE_REQUIREMENTS.includes(requirement)
    && !input.isFork
    && actorMayWrite(input.permission)
    && intentNeedsWrite(input.intent)
    && !input.allowWrite
  ) {
    return { kind: 'ask', reason: `${toolName} needs write mode; the repository has not enabled allow-write` }
  }

  const detail = explainDenialReason(input)
    ?? `trust '${trust}' does not grant '${requirement}'`
  return { kind: 'deny', reason: `${toolName} denied — ${detail}` }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * The per-run trust decision, shared by the waterfall and by whoever narrows an
 * agent's visible tool set.
 */
export interface TrustPolicy {
  /** The active decision input, or `undefined` before a run is authorized. */
  readonly input: TrustInput | undefined
  /** Resolved level for the active input; `none` while nothing is active. */
  readonly level: TrustLevel
  /** Capabilities for the active level. */
  readonly capabilities: Capabilities
  /**
   * Bind the trust decision for one review run. `allowWrite` is composed in
   * from plugin config and cannot be supplied here, so a repository-supplied
   * `.dshrb.yml` or a comment argument has no path to raising it.
   * @returns a disposer restoring the previous decision.
   */
  activate(actor: ActorContext): () => void
  /**
   * Narrow an agent's visible tools to the active trust level.
   * `ctx.tools.restrict()` rejects an unscoped context upstream, so pass the
   * agent's own `agent.ctx` — a process-global restriction would mask every
   * agent instead of the one being reviewed.
   * @returns the disposer that lifts the restriction.
   */
  restrictScope(scoped: Context): () => void
  /** The decision the waterfall would reach for one tool name. */
  decide(toolName: string): PreToolDecision | undefined
}

class TrustPolicyState implements TrustPolicy {
  #input: TrustInput | undefined

  constructor(private readonly allowWrite: boolean) {}

  get input(): TrustInput | undefined {
    return this.#input
  }

  get level(): TrustLevel {
    return this.#input === undefined ? 'none' : resolveTrust(this.#input)
  }

  get capabilities(): Capabilities {
    return capabilitiesFor(this.level)
  }

  activate(actor: ActorContext): () => void {
    const previous = this.#input
    this.#input = { ...actor, allowWrite: this.allowWrite }
    return () => {
      this.#input = previous
    }
  }

  restrictScope(scoped: Context): () => void {
    return scoped.tools.restrict(toolRestrictionFor(this.level))
  }

  decide(toolName: string): PreToolDecision | undefined {
    const input = this.#input
    if (input === undefined) {
      // Fail closed: an un-authorized run must not reach a governed tool.
      return TOOL_REQUIREMENTS[toolName] === undefined
        ? undefined
        : { kind: 'deny', reason: `${toolName} denied — no trust decision is active for this run` }
    }
    return decideToolCall(input, toolName)
  }
}

export function createTrustPolicy(config: Config): TrustPolicy {
  return new TrustPolicyState(config.allowWrite)
}

export function apply(ctx: Context, config: Config): void {
  const policy = createTrustPolicy(config)
  // Fiber-owned: the service unregisters when this plugin's fiber unloads.
  ctx.provide('trustPolicy', policy)

  // A waterfall, not a listener: it must return a PreToolDecision and hand
  // unknown tools to next() so other plugins keep their say.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    return policy.decide(exec.name) ?? await next()
  })

  // `ctx.tools.restrict()` is deliberately NOT called here: upstream rejects an
  // unscoped context, because a process-global restriction masks every agent
  // rather than the one under review. `review-runtime` calls
  // `ctx.trustPolicy.restrictScope(agent.ctx)` once the agent exists, on the
  // same resolved level the waterfall enforces.

  // TODO(M3): ctx.tools.guard() for the monotonic red lines:
  //           config.protectedPaths, package.json `scripts`, binaries, path
  //           traversal, symlinks, and lockfiles without a matching manifest
  //           change. Left whole rather than half-built: a guard that covers
  //           some red lines reads as protection that is not there.
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    trustPolicy: TrustPolicy
  }
}
