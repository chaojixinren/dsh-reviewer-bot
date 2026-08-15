import { describe, expect, expectTypeOf, it } from 'vitest'
import { isSeverity, ruleId } from '@dshrb/review-core'
import { createReviewRuleRegistry } from '@dshrb/rule-registry'
import type { Config, Rule } from '@dshrb/rule-registry'
import { baselinePack } from '../src/index.ts'

/**
 * Pure unit tests for the baseline rule pack: pack shape, rule-id uniqueness,
 * severity discipline, register → match → dispose through the real registry,
 * and the T13 negative assertion that rules are data and never callbacks. No
 * network, credentials, or DSH runtime (CONTRIBUTING line 131) — the Cordis
 * wiring in `apply` is exercised by the signature probe and the composed
 * profile, not here.
 */

function configFixture(over: Partial<Config> = {}): Config {
  return { disabled: [], minSeverity: 'minor', ...over }
}

describe('baselinePack shape', () => {
  it('is a well-formed pack with non-empty identity and rules', () => {
    expect(baselinePack.id.trim()).not.toBe('')
    expect(baselinePack.version.trim()).not.toBe('')
    expect(baselinePack.title.trim()).not.toBe('')
    expect(baselinePack.rules.length).toBeGreaterThan(0)
  })

  it('covers all five planned groups', () => {
    const prefixes = new Set<string>()
    for (const rule of baselinePack.rules) {
      const group = rule.id.split('/')[0]
      if (group !== undefined) prefixes.add(group)
    }
    expect(prefixes).toEqual(new Set(['correctness', 'security', 'api-contract', 'maintainability', 'tests']))
  })

  it('every rule carries the required declarative fields', () => {
    for (const rule of baselinePack.rules) {
      expect(rule.id.trim()).not.toBe('')
      expect(isSeverity(rule.severity)).toBe(true)
      expect(rule.applies.length).toBeGreaterThan(0)
      expect(rule.guidance.trim()).not.toBe('')
      expect(typeof rule.requiresScenario).toBe('boolean')
    }
  })

  it('has no duplicate rule ids', () => {
    const ids = baselinePack.rules.map((rule) => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reserves blocker for reproducible failures — advisory rules stay major or below', () => {
    for (const rule of baselinePack.rules) {
      expect(rule.severity).not.toBe('blocker')
    }
  })

  it('marks scenario-dependent rules and keeps directly-verifiable ones unflagged', () => {
    const byId = new Map(baselinePack.rules.map((rule) => [rule.id, rule.requiresScenario]))
    expect(byId.get(ruleId('correctness/off-by-one'))).toBe(true)
    expect(byId.get(ruleId('security/secret-in-source'))).toBe(false)
  })
})

describe('registration through reviewRules', () => {
  it('matches expected rules by path and stops matching after dispose', () => {
    const registry = createReviewRuleRegistry(configFixture())
    const dispose = registry.register(baselinePack)

    const sourceIds = registry.match('src/index.ts').map((rule) => rule.id)
    expect(sourceIds).toContain(ruleId('correctness/null-undefined'))
    expect(sourceIds).toContain(ruleId('security/path-traversal'))
    // Missing-coverage targets branches in source, so it must load for a
    // source-only change; skip/only are test-file constructs and stay on the
    // test globs.
    expect(sourceIds).toContain(ruleId('tests/missing-branch-coverage'))
    expect(sourceIds).not.toContain(ruleId('tests/skip-only-leftover'))

    const testIds = registry.match('src/thing.test.ts').map((rule) => rule.id)
    expect(testIds).toContain(ruleId('tests/skip-only-leftover'))
    // A test file is still code: the code rules apply alongside the test rules.
    expect(testIds).toContain(ruleId('correctness/null-undefined'))

    expect(registry.match('README.md')).toHaveLength(0)

    dispose()
    expect(registry.match('src/index.ts')).toHaveLength(0)
  })

  it('reports the baseline pack identity through packs()', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(baselinePack)

    expect(registry.packs()).toEqual([
      { id: baselinePack.id, version: baselinePack.version, title: baselinePack.title },
    ])
  })
})

describe('rules are data, never callbacks', () => {
  it('has no callable surface on Rule, so a pack cannot register code', () => {
    // Compile-time only (enforced by `tsc -p tsconfig.test.json`): a rule pack
    // cannot smuggle in a callback, read context, or hook the pipeline.
    expectTypeOf<Rule>().not.toHaveProperty('execute')
    expectTypeOf<Rule>().not.toHaveProperty('handler')
    expectTypeOf<Rule>().not.toHaveProperty('on')
  })

  it('baselinePack contains no executable value anywhere', () => {
    const containsFunction = (value: unknown): boolean => {
      if (typeof value === 'function') return true
      if (Array.isArray(value)) return value.some(containsFunction)
      if (value !== null && typeof value === 'object') {
        return Object.values(value).some(containsFunction)
      }
      return false
    }
    expect(containsFunction(baselinePack)).toBe(false)
  })

  it('a callback smuggled past the type is never invoked at runtime', () => {
    const registry = createReviewRuleRegistry(configFixture())
    let invoked = false
    const hostile = {
      ...(baselinePack.rules[0] as Rule),
      execute: () => {
        invoked = true
      },
    } as unknown as Rule
    registry.register({ id: 'hostile', version: '1.0.0', title: 'Hostile', rules: [hostile] })

    // match() and packs() read the declarative surface and never call the field.
    registry.match('src/index.ts')
    registry.packs()
    expect(invoked).toBe(false)
  })
})
