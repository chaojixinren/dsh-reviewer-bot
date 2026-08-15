/**
 * Review rule pack registry, exposed as the `reviewRules` Cordis service.
 *
 * Rules are declarative DATA — globs, severity, guidance text, examples — never
 * executable callbacks. A third-party rule pack therefore cannot read context,
 * make network calls, or register hooks. Work that needs real logic must ship
 * as its own DSH plugin the user installs knowingly. See docs/04-trust-model.md T13.
 */
import { severityRank } from '@dshrb/review-core'
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

/** A matched rule plus the pack its winning registration came from. */
export interface MatchedRule {
  readonly rule: Rule
  /** The pack id whose registration won (most severe, first-seen on a tie). */
  readonly packId: string
}

export interface ReviewRuleRegistry {
  /** Effect-based: the returned disposer unregisters the pack. */
  register(pack: RulePack): () => void
  /** Rules whose globs match `path`, severity-normalized and deduped. */
  match(path: string): readonly Rule[]
  /**
   * Like `match`, but each entry carries the pack its rule came from, so
   * `dshrb rules --explain <path>` can name the source pack. The winning rule
   * is the same one `match` returns; this only adds provenance.
   */
  matchWithPacks(path: string): readonly MatchedRule[]
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

export function apply(ctx: Context, config: Config): void {
  // `ctx.provide` is fiber-owned: unloading this plugin removes the service,
  // and the reactive coeffect on `inject: ['reviewRules']` then deactivates
  // every dependent pack. A pack registers through
  // `ctx.effect(() => ctx.reviewRules.register(pack))` (the tool-review
  // pattern), so unloading the PACK also runs the disposer returned here.
  ctx.provide('reviewRules', createReviewRuleRegistry(config))
}

/**
 * The registry without the Cordis wiring, so the deterministic behavior is
 * unit-testable without booting a DSH runtime (CONTRIBUTING line 131).
 *
 * Match semantics, kept deliberately small so they are easy to audit:
 *
 * - `applies` patterns are OR'd; `excludes` patterns are OR'd and, when any
 *   matches, the rule does not apply (`excludes` wins over `applies`).
 * - A rule id listed in `config.disabled` never enters a `match()` result.
 * - When several packs register the same rule id, `match()` returns one rule:
 *   the most severe registration wins, and the first registration keeps its
 *   position on a tie — so a duplicate can never silently downgrade a finding,
 *   and the output order is deterministic (pack registration order).
 */
export function createReviewRuleRegistry(config: Config): ReviewRuleRegistry {
  const disabled = new Set(config.disabled)
  const packs = new Map<string, RulePack>()

  function register(pack: RulePack): () => void {
    packs.set(pack.id, pack)
    return () => {
      // Only evict when the stored pack is still the one this disposer owns.
      // A same-id re-register replaces the entry, so running the STALE disposer
      // must not remove the replacement pack that a newer fiber still depends on.
      if (packs.get(pack.id) === pack) {
        packs.delete(pack.id)
      }
    }
  }

  function matchWithPacks(path: string): readonly MatchedRule[] {
    const byId = new Map<string, MatchedRule>()
    for (const pack of packs.values()) {
      for (const rule of pack.rules) {
        if (disabled.has(rule.id) || !appliesTo(rule, path)) continue
        const current = byId.get(rule.id)
        if (current === undefined || severityRank(rule.severity) < severityRank(current.rule.severity)) {
          // `Map.set` on an existing key updates the value without moving it,
          // preserving the first-seen position while the winning registration
          // (and its source pack) is replaced by the more severe one.
          byId.set(rule.id, { rule, packId: pack.id })
        }
      }
    }
    return [...byId.values()]
  }

  function match(path: string): readonly Rule[] {
    return matchWithPacks(path).map((entry) => entry.rule)
  }

  function listPacks(): readonly Pick<RulePack, 'id' | 'version' | 'title'>[] {
    return [...packs.values()].map(({ id, version, title }) => ({ id, version, title }))
  }

  return { register, match, matchWithPacks, packs: listPacks }
}

function appliesTo(rule: Rule, path: string): boolean {
  if (rule.excludes !== undefined && rule.excludes.some((pattern) => matchesGlob(pattern, path))) {
    return false
  }
  return rule.applies.some((pattern) => matchesGlob(pattern, path))
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Minimal glob matcher for repo-relative `/`-separated paths, shared by
 * `applies` and `excludes` so both lists agree on semantics. Supported syntax:
 *
 * - `*`      any run of characters within one path segment (no `/`)
 * - `**`     any run of path segments, including none
 * - `?`      exactly one character within a segment (no `/`)
 * - `[...]`  a character class; `[!...]` negates
 *
 * A backslash escapes the next character. Patterns are split on `/` and never
 * anchored to a directory, so `src/**` also matches the (unlikely) file path
 * `src` itself — harmless here because `match()` is only ever fed file paths.
 */
function matchesGlob(pattern: string, path: string): boolean {
  return matchSegments(pattern.split('/'), path.split('/'))
}

function matchSegments(pattern: readonly string[], path: readonly string[], pi = 0, si = 0): boolean {
  while (pi < pattern.length) {
    const segment = pattern[pi]
    if (segment === undefined) {
      return si === path.length
    }
    if (segment === '**') {
      if (pi === pattern.length - 1) {
        // A trailing `**` matches whatever remains, including nothing.
        return true
      }
      // A `**` in the middle matches zero or more whole segments.
      for (let skip = si; skip <= path.length; skip++) {
        if (matchSegments(pattern, path, pi + 1, skip)) {
          return true
        }
      }
      return false
    }
    const value = path[si]
    if (value === undefined || !matchesSegment(segment, value)) {
      return false
    }
    pi++
    si++
  }
  return si === path.length
}

function matchesSegment(pattern: string, value: string): boolean {
  // Fast path: a segment with no metacharacters compares literally.
  return hasMeta(pattern) ? segmentToRegExp(pattern).test(value) : pattern === value
}

function hasMeta(segment: string): boolean {
  return /[*?[\\]/.test(segment)
}

function segmentToRegExp(segment: string): RegExp {
  let source = ''
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]
    if (char === undefined) break
    if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '[') {
      const close = segment.indexOf(']', i + 1)
      if (close === -1) {
        // An unclosed class is a literal bracket.
        source += '\\['
      } else {
        let body = segment.slice(i + 1, close)
        if (body.startsWith('!')) {
          body = `^${body.slice(1)}`
        } else if (body.startsWith('^')) {
          body = `\\${body}`
        }
        source += `[${body}]`
        i = close
      }
    } else if (char === '\\' && i + 1 < segment.length) {
      source += escapeRegExp(segment[i + 1] ?? '')
      i++
    } else {
      source += escapeRegExp(char)
    }
  }
  return new RegExp(`^${source}$`)
}

function escapeRegExp(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
}
