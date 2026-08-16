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
import { NO_CAPABILITIES, capabilities, isSafeRelativePath, matchesGlob } from '@dshrb/review-core'
import type { ForgePermission } from '@dshrb/forge'
import type { DshrbConfigService } from '@dshrb/config'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution, ToolRestriction } from '@deepseek-ai/dsh-tools'
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
  accept: 'trusted-read',
  forget: 'trusted-read',
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

/** Explains an insufficient-trust outcome in terms of the specific missing condition. */
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
 *
 * Parity is pinned by a CI test in `test/trust-policy.test.ts` asserting
 * `TOOL_NAMES ⊆ GOVERNED_TOOLS` (and the reverse). A tool-review tool missing
 * from this table would be hidden by `restrictScope`'s allow-list, but the
 * waterfall would abstain (fail open) — the parity test keeps the two lists
 * from drifting.
 */
export const TOOL_REQUIREMENTS: Readonly<Record<string, ToolRequirement>> = Object.freeze({
  read_diff_shard: 'readDiff',
  list_applicable_rules: 'always',
  report_finding: 'publishComments',
  read_repo_file: 'readRepoFiles',
  read_check_log: 'readCheckLogs',
  propose_patch: 'proposePatches',
})

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
 * Every shortfall is a `deny`, never an `ask`: `allowWrite` is repository
 * configuration held by the maintainer, not something a per-call approval
 * prompt can grant. The message names the missing condition via
 * `explainDenialReason`, so the user learns which of fork / permission /
 * allowWrite / intent to change.
 */
export function decideToolCall(input: TrustInput, toolName: string): PreToolDecision | undefined {
  const requirement = TOOL_REQUIREMENTS[toolName]
  if (requirement === undefined) return undefined

  const trust = resolveTrust(input)
  if (grants(trust, requirement)) return { kind: 'allow' }

  const detail = explainDenialReason(input)
    ?? `trust '${trust}' does not grant '${requirement}'`
  return { kind: 'deny', reason: `${toolName} denied — ${detail}` }
}

// ---------------------------------------------------------------------------
// Write red lines (monotonic guard)
// ---------------------------------------------------------------------------

/**
 * Change-set facts the monotonic write guard reads. Bound per run by the
 * controller once it has fetched the diff; the guard itself never touches the
 * filesystem, which is what keeps it a pure, table-testable function.
 */
export interface WriteGuardContext {
  /** Every repo-relative path touched by this change request. */
  readonly changedPaths: readonly string[]
  /** Paths the forge diff flagged as binary (no hunk text; must not be written). */
  readonly binaryPaths: readonly string[]
}

/** One candidate write the guard evaluates. */
export interface WriteRedLine extends WriteGuardContext {
  /** Repo-relative path the write targets. */
  readonly path: string
  /** The unified diff text for that path (for the field-level `package.json` check). */
  readonly diff: string
}

/** Lockfile basenames whose write is gated on a matching `package.json` change. */
const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
])

function basename(path: string): string {
  const segments = path.split('/')
  return segments[segments.length - 1] ?? path
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/** True when `path` is a `package.json` manifest at any depth. */
function isManifest(path: string): boolean {
  return basename(path) === 'package.json'
}

/**
 * The `package.json` a lockfile must ship alongside, or `undefined` when `path`
 * is not a known lockfile. The pairing is same-directory: `packages/x/yarn.lock`
 * requires `packages/x/package.json` to change in the same request.
 */
function manifestForLockfile(path: string): string | undefined {
  if (!LOCKFILE_NAMES.has(basename(path))) return undefined
  const dir = dirname(path)
  return dir === '' ? 'package.json' : `${dir}/package.json`
}

/**
 * True when a `package.json` unified diff touches the `scripts` object.
 *
 * Field-level, not whole-file: a change to `dependencies` does not trip this.
 * The check is deliberately textual and conservative — any hunk whose body
 * mentions the `"scripts"` key (as a context line around a script edit, or as a
 * changed line adding/removing the field) is refused. A single hunk that spans
 * both `scripts` and another field is over-denied, which is the safe direction
 * for a permanent red line.
 */
function diffTouchesScripts(diff: string): boolean {
  return /"scripts"\s*:/u.test(diff)
}

/**
 * Parses a manifest's `scripts` field for the authoritative red line. An empty
 * string is a newly-created manifest and has no `scripts`; a non-empty manifest
 * that fails to parse returns `undefined`, which the caller treats as a
 * fail-closed signal rather than "assume safe".
 */
function parsedScripts(content: string): { scripts: unknown } | undefined {
  if (content.trim() === '') return { scripts: undefined }
  try {
    return { scripts: (JSON.parse(content) as Record<string, unknown>).scripts }
  } catch {
    return undefined
  }
}

/**
 * Authoritative `package.json` `scripts` red line, evaluated where the file's
 * before/after content is available (the mutate stage). A structural compare of
 * the parsed `scripts` field catches an edit to a script VALUE whose diff hunk
 * context never reaches the `"scripts"` key — the exact case the text-only
 * guard cannot see. Fails closed: a manifest that cannot be parsed counts as a
 * change, so an unreadable package.json is refused rather than assumed safe.
 */
export function scriptsFieldChanged(before: string, after: string): boolean {
  const beforeScripts = parsedScripts(before)
  const afterScripts = parsedScripts(after)
  if (beforeScripts === undefined || afterScripts === undefined) return true
  return JSON.stringify(beforeScripts.scripts) !== JSON.stringify(afterScripts.scripts)
}

/**
 * Normalizes a write path before red-line checks: trims whitespace and strips a
 * leading `./`, so `./.github/x` and ` .github/x` resolve to the same protected
 * target the filesystem will write, instead of missing the `.github/**` glob.
 */
function normalizeWritePath(path: string): string {
  let normalized = path.trim()
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }
  return normalized
}

/** Caps untrusted text before it lands in a denial reason. */
function excerpt(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value
}

/**
 * The monotonic write red lines (docs/03-review-pipeline.md). Returns a denial
 * reason or `undefined` to abstain. Pure: no filesystem, no symlink resolution
 * — a symlink is the sandbox layer's concern (#33), not this guard's. Each red
 * line is checked once, and a denial is final by construction: a guard has no
 * `allow` result, so a later listener cannot turn it back into permission.
 */
export function writeRedLineViolation(write: WriteRedLine, protectedPaths: readonly string[]): string | undefined {
  // Normalize once, up front, so every red line (and the denial message) agrees
  // with the path the filesystem will actually write. `./` and stray whitespace
  // must not let a protected path dodge its glob.
  const path = normalizeWritePath(write.path)
  if (!isSafeRelativePath(path)) {
    return `path '${excerpt(path)}' is not a safe repo-relative path (absolute, drive, '..', or NUL)`
  }
  const protectedPattern = protectedPaths.find((pattern) => matchesGlob(pattern, path))
  if (protectedPattern !== undefined) {
    return `path '${excerpt(path)}' is protected by '${protectedPattern}'`
  }
  if (write.binaryPaths.includes(path)) {
    return `path '${excerpt(path)}' is a binary file`
  }
  if (isManifest(path) && diffTouchesScripts(write.diff)) {
    return `path '${excerpt(path)}' would modify the package.json 'scripts' field, a permanent red line`
  }
  const manifest = manifestForLockfile(path)
  if (manifest !== undefined && !write.changedPaths.includes(manifest)) {
    return `lockfile '${excerpt(path)}' requires a matching change to '${manifest}' in the same request`
  }
  return undefined
}

/** Extracts the `{ path, diff }` patch from a write tool's parsed arguments. */
function patchArguments(arguments_: unknown): { path: string; diff: string } | undefined {
  if (typeof arguments_ !== 'object' || arguments_ === null) return undefined
  const record = arguments_ as Record<string, unknown>
  if (typeof record.path !== 'string' || typeof record.diff !== 'string') return undefined
  return { path: record.path, diff: record.diff }
}

/**
 * Adapts one tool execution to the pure red-line check. Only the write tool is
 * governed (the one whose requirement is the `proposePatches` capability);
 * every other tool abstains so unrelated plugins keep their say.
 */
function writeGuardDenial(
  execution: Readonly<ToolExecution>,
  policy: TrustPolicy,
  protectedPaths: readonly string[],
): string | undefined {
  if (TOOL_REQUIREMENTS[execution.name] !== 'proposePatches') return undefined

  const patch = patchArguments(execution.arguments)
  if (patch === undefined) {
    return `${execution.name} denied — a write call must carry string 'path' and 'diff' arguments`
  }

  const context = policy.writeContext
  if (context === undefined) {
    return `${execution.name} denied — no write-guard context is bound for this run`
  }

  return writeRedLineViolation(
    { path: patch.path, diff: patch.diff, changedPaths: context.changedPaths, binaryPaths: context.binaryPaths },
    protectedPaths,
  )
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
  /** The bound change-set facts the write guard reads, or `undefined` before binding. */
  readonly writeContext: WriteGuardContext | undefined
  /**
   * Bind the change-set facts (touched paths, binary paths) the write guard
   * reads. The controller calls this once it has fetched the diff, before the
   * agent runs; the guard reads it for lockfile↔manifest pairing and binary
   * detection. @returns a disposer restoring the previous context.
   */
  bindWriteContext(context: WriteGuardContext): () => void
  /**
   * Authoritative write red-line check for the mutate stage, run after a patch
   * has been applied to the file's current content. The tool-call guard fires
   * before the session event that records the patch, so a guard denial does not
   * by itself stop a proposal; this re-check is what actually prevents a
   * red-lined patch from landing on disk. It additionally sees the file's
   * before/after content, so it can detect a `package.json` `scripts` edit even
   * when the diff hunk's context never reaches the `"scripts"` key. Returns a
   * denial reason, or `undefined` to allow.
   */
  rejectWrite(path: string, diff: string, before: string, after: string): string | undefined
}

class TrustPolicyState implements TrustPolicy {
  #input: TrustInput | undefined
  #writeContext: WriteGuardContext | undefined

  /** Mutable so the Web UI toggle can take effect on the next run without a restart. */
  allowWrite: boolean

  constructor(allowWrite: boolean, private readonly protectedPaths: readonly string[]) {
    this.allowWrite = allowWrite
  }

  get input(): TrustInput | undefined {
    return this.#input
  }

  get level(): TrustLevel {
    return this.#input === undefined ? 'none' : resolveTrust(this.#input)
  }

  get capabilities(): Capabilities {
    return capabilitiesFor(this.level)
  }

  get writeContext(): WriteGuardContext | undefined {
    return this.#writeContext
  }

  activate(actor: ActorContext): () => void {
    const previous = this.#input
    this.#input = { ...actor, allowWrite: this.allowWrite }
    return () => {
      this.#input = previous
    }
  }

  bindWriteContext(context: WriteGuardContext): () => void {
    const previous = this.#writeContext
    this.#writeContext = context
    return () => {
      this.#writeContext = previous
    }
  }

  rejectWrite(path: string, diff: string, before: string, after: string): string | undefined {
    const context = this.#writeContext
    if (context === undefined) {
      return 'write denied — no write-guard context is bound for this run'
    }
    const redLine = writeRedLineViolation(
      { path, diff, changedPaths: context.changedPaths, binaryPaths: context.binaryPaths },
      this.protectedPaths,
    )
    if (redLine !== undefined) return redLine
    // The authoritative scripts red line: structural compare of before/after,
    // which catches a script-value edit the text-only guard's diff check missed.
    if (isManifest(path) && scriptsFieldChanged(before, after)) {
      return `path '${excerpt(path)}' would modify the package.json 'scripts' field, a permanent red line`
    }
    return undefined
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
  return new TrustPolicyState(config.allowWrite, config.protectedPaths)
}

export function apply(ctx: Context, config: Config): void {
  const dshrb = ctx.get('dshrb') as DshrbConfigService | undefined
  const policy = new TrustPolicyState(
    dshrb === undefined ? config.allowWrite : dshrb.get().allowWrite,
    config.protectedPaths,
  )
  // Fiber-owned: the service unregisters when this plugin's fiber unloads.
  ctx.provide('trustPolicy', policy)

  // Reactive allowWrite: a Web UI toggle change applies to the next review
  // run without a profile restart. (Tokens are already re-read per request by
  // the forge gateways; this closes the same gap for the write mode.)
  if (dshrb !== undefined) {
    ctx.effect(() => dshrb.watch((next) => {
      policy.allowWrite = next.allowWrite
    }))
  }

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
  //
  // A guard is different from a restriction: it can only DENY, never hide or
  // force-allow, so registering it here (a plain-context, process-global guard)
  // is correct — the red lines are absolute invariants that must hold for every
  // agent, unlike the per-trust-level visibility `restrictScope` narrows. The
  // write-tool call is the only one governed; every other tool abstains.
  ctx.tools.guard((execution) => writeGuardDenial(execution, policy, config.protectedPaths))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    trustPolicy: TrustPolicy
  }
}
