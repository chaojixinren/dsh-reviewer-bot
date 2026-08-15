/**
 * Review rule pack registry, exposed as the `reviewRules` Cordis service.
 *
 * Rules are declarative DATA — globs, severity, guidance text, examples — never
 * executable callbacks. A third-party rule pack therefore cannot read context,
 * make network calls, or register hooks. Work that needs real logic must ship
 * as its own DSH plugin the user installs knowingly. See docs/04-trust-model.md T13.
 */
import type { RuleId, Severity } from '@dshrb/review-core'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dshrb-rule-registry'

export interface Rule {
  readonly id: RuleId
  readonly severity: Severity
  /** Glob patterns this rule applies to. */
  readonly applies: readonly string[]
  readonly excludes?: readonly string[]
  /** Guidance shown to the model. Plain text; no instructions to call tools. */
  readonly guidance: string
  readonly goodExample?: string
  readonly badExample?: string
  /**
   * When true, a finding citing this rule must carry a reproducible
   * failureScenario or it is downgraded during validation. Lets a rule author
   * own noise control at rule granularity.
   */
  readonly requiresScenario: boolean
}

export interface RulePack {
  readonly id: string
  readonly version: string
  readonly title: string
  readonly rules: readonly Rule[]
}

export interface ReviewRuleRegistry {
  /** Effect-based: the returned disposer unregisters the pack. */
  register(pack: RulePack): () => void
  /** Rules whose globs match `path`, severity-normalized and deduped. */
  match(path: string): readonly Rule[]
  /** All active packs with versions, for the auditable `rules` result field. */
  packs(): readonly Pick<RulePack, 'id' | 'version' | 'title'>[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    reviewRules: ReviewRuleRegistry
  }
}

export interface Config {
  /** Rule ids to disable repository-wide. */
  disabled: string[]
  /** Findings below this severity are not published. */
  minSeverity: Severity
}

export const Config: Schema<Config> = Schema.object({
  disabled: Schema.array(Schema.string()).default([]),
  minSeverity: Schema.union(['blocker', 'major', 'minor', 'nit', 'info'] as const).default('minor'),
})

export function apply(_ctx: Context, _config: Config): void {
  // TODO(M2): register the `reviewRules` service via ctx.effect so unload
  //           deactivates dependent rule packs automatically (reactive coeffect).
  throw new Error('not implemented: M2')
}
