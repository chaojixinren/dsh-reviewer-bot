import { describe, expect, expectTypeOf, it } from 'vitest'
import { ruleId } from '@dshrb/review-core'
import { createReviewRuleRegistry } from '../src/index.ts'
import type { Config, Rule, RulePack } from '../src/index.ts'

/**
 * Pure unit tests for the deterministic half of the rule registry: glob
 * matching, excludes priority, disabled filtering, severity normalization,
 * dedupe, and the auditable packs() shape. No network, credentials, or DSH
 * runtime (CONTRIBUTING line 131) — the Cordis wiring in `apply` is exercised
 * by the signature probe and the composed profile, not here.
 */

function configFixture(over: Partial<Config> = {}): Config {
  return { disabled: [], minSeverity: 'minor', ...over }
}

function ruleFixture(over: Partial<Rule> = {}): Rule {
  return {
    id: ruleId('correctness/eq'),
    severity: 'major',
    applies: ['src/**'],
    guidance: 'avoid == with non-null types',
    requiresScenario: false,
    ...over,
  }
}

function packFixture(over: Partial<RulePack> = {}): RulePack {
  return {
    id: 'baseline',
    version: '1.0.0',
    title: 'Baseline rules',
    rules: [ruleFixture()],
    ...over,
  }
}

describe('register / dispose', () => {
  it('registers a pack and unregisters on dispose', () => {
    const registry = createReviewRuleRegistry(configFixture())
    const dispose = registry.register(packFixture())

    expect(registry.match('src/index.ts')).toHaveLength(1)
    expect(registry.packs()).toHaveLength(1)

    dispose()
    expect(registry.match('src/index.ts')).toHaveLength(0)
    expect(registry.packs()).toHaveLength(0)
  })

  it('re-registering the same pack id replaces the previous pack', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(packFixture({ rules: [ruleFixture({ id: ruleId('first') })] }))
    registry.register(packFixture({
      version: '2.0.0',
      rules: [ruleFixture({ id: ruleId('second') })],
    }))

    expect(registry.match('src/index.ts').map((rule) => rule.id)).toEqual([ruleId('second')])
    expect(registry.packs()).toEqual([{ id: 'baseline', version: '2.0.0', title: 'Baseline rules' }])
  })

  it('a stale disposer does not evict a same-id replacement pack', () => {
    const registry = createReviewRuleRegistry(configFixture())
    const disposeFirst = registry.register(
      packFixture({ version: '1.0.0', rules: [ruleFixture({ id: ruleId('first') })] }),
    )
    registry.register(
      packFixture({ version: '2.0.0', rules: [ruleFixture({ id: ruleId('second') })] }),
    )

    // Running the earlier disposer must leave the replacement pack untouched.
    disposeFirst()

    expect(registry.match('src/index.ts').map((rule) => rule.id)).toEqual([ruleId('second')])
    expect(registry.packs()).toEqual([{ id: 'baseline', version: '2.0.0', title: 'Baseline rules' }])
  })
})

describe('glob matching', () => {
  it('matches `**` across segments and `*` within a segment', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(packFixture({
      rules: [
        ruleFixture({ id: ruleId('all'), applies: ['**'] }),
        ruleFixture({ id: ruleId('nested'), applies: ['src/**'] }),
        ruleFixture({ id: ruleId('top-ts'), applies: ['*.ts'] }),
      ],
    }))

    expect(registry.match('src/index.ts').map((rule) => rule.id)).toEqual([
      ruleId('all'), ruleId('nested'),
    ])
    expect(registry.match('README.md').map((rule) => rule.id)).toEqual([ruleId('all')])
    expect(registry.match('lib/util.ts').map((rule) => rule.id)).toEqual([ruleId('all')])
    expect(registry.match('index.ts').map((rule) => rule.id)).toEqual([ruleId('all'), ruleId('top-ts')])
  })

  it('supports `?` and a middle `**`', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(packFixture({
      rules: [
        ruleFixture({ id: ruleId('single'), applies: ['src/file?.ts'] }),
        ruleFixture({ id: ruleId('deep'), applies: ['src/**/test/**'] }),
      ],
    }))

    expect(registry.match('src/file1.ts').map((rule) => rule.id)).toEqual([ruleId('single')])
    expect(registry.match('src/file.ts').map((rule) => rule.id)).toEqual([])
    expect(registry.match('src/nested/test/unit.ts').map((rule) => rule.id)).toEqual([ruleId('deep')])
    expect(registry.match('src/test/unit.ts').map((rule) => rule.id)).toEqual([ruleId('deep')])
  })

  it('does not match when no pattern applies', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(packFixture({ rules: [ruleFixture({ applies: ['docs/**'] })] }))
    expect(registry.match('src/index.ts')).toHaveLength(0)
  })
})

describe('excludes priority', () => {
  it('excludes wins over applies', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(packFixture({
      rules: [ruleFixture({
        id: ruleId('no-generated'),
        applies: ['src/**'],
        excludes: ['src/generated/**'],
      })],
    }))

    expect(registry.match('src/hand.ts').map((rule) => rule.id)).toEqual([ruleId('no-generated')])
    expect(registry.match('src/generated/schema.ts')).toHaveLength(0)
  })

  it('a single matching exclude is enough to drop the rule', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(packFixture({
      rules: [ruleFixture({
        id: ruleId('no-vendor'),
        applies: ['**'],
        excludes: ['vendor/**', 'third_party/**'],
      })],
    }))

    expect(registry.match('src/index.ts')).toHaveLength(1)
    expect(registry.match('vendor/lib.ts')).toHaveLength(0)
    expect(registry.match('third_party/dep.ts')).toHaveLength(0)
  })
})

describe('disabled filtering', () => {
  it('disabled rule ids never enter a match result', () => {
    const registry = createReviewRuleRegistry(configFixture({ disabled: ['correctness/eq'] }))
    registry.register(packFixture({
      rules: [
        ruleFixture({ id: ruleId('correctness/eq') }),
        ruleFixture({ id: ruleId('security/xss') }),
      ],
    }))

    expect(registry.match('src/index.ts').map((rule) => rule.id)).toEqual([ruleId('security/xss')])
  })

  it('disabled rules are still audited by packs()', () => {
    const registry = createReviewRuleRegistry(configFixture({ disabled: ['correctness/eq'] }))
    registry.register(packFixture())
    // packs() reports what is installed, not what is active for a path.
    expect(registry.packs()).toEqual([{ id: 'baseline', version: '1.0.0', title: 'Baseline rules' }])
    expect(registry.match('src/index.ts')).toHaveLength(0)
  })
})

describe('severity normalization and dedupe', () => {
  it('dedupes by rule id and keeps the most severe registration', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(packFixture({ id: 'pack-a', rules: [ruleFixture({ id: ruleId('shared'), severity: 'minor' })] }))
    registry.register(packFixture({ id: 'pack-b', rules: [ruleFixture({ id: ruleId('shared'), severity: 'blocker' })] }))

    const matched = registry.match('src/index.ts')
    expect(matched).toHaveLength(1)
    expect(matched[0]?.id).toBe(ruleId('shared'))
    expect(matched[0]?.severity).toBe('blocker')
  })

  it('never lets a less-severe duplicate downgrade a blocker', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(packFixture({ id: 'pack-a', rules: [ruleFixture({ id: ruleId('shared'), severity: 'blocker' })] }))
    registry.register(packFixture({ id: 'pack-b', rules: [ruleFixture({ id: ruleId('shared'), severity: 'nit' })] }))

    expect(registry.match('src/index.ts')[0]?.severity).toBe('blocker')
  })

  it('keeps the first registration on a severity tie', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(packFixture({ id: 'pack-a', rules: [ruleFixture({ id: ruleId('shared'), guidance: 'first' })] }))
    registry.register(packFixture({ id: 'pack-b', rules: [ruleFixture({ id: ruleId('shared'), guidance: 'second' })] }))

    expect(registry.match('src/index.ts')[0]?.guidance).toBe('first')
  })

  it('keeps first-seen order while a later registration upgrades severity', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(packFixture({
      id: 'pack-a',
      rules: [
        ruleFixture({ id: ruleId('upgraded'), severity: 'minor' }),
        ruleFixture({ id: ruleId('anchor'), severity: 'major' }),
      ],
    }))
    registry.register(packFixture({
      id: 'pack-b',
      rules: [ruleFixture({ id: ruleId('upgraded'), severity: 'blocker' })],
    }))

    expect(registry.match('src/index.ts').map((rule) => [rule.id, rule.severity])).toEqual([
      [ruleId('upgraded'), 'blocker'],
      [ruleId('anchor'), 'major'],
    ])
  })
})

describe('packs()', () => {
  it('returns only id/version/title in registration order', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(packFixture({ id: 'b-pack', version: '2.0.0', title: 'B' }))
    registry.register(packFixture({ id: 'a-pack', version: '1.0.0', title: 'A' }))

    expect(registry.packs()).toEqual([
      { id: 'b-pack', version: '2.0.0', title: 'B' },
      { id: 'a-pack', version: '1.0.0', title: 'A' },
    ])
  })

  it('omits rules and every other field (the auditable shape)', () => {
    const registry = createReviewRuleRegistry(configFixture())
    registry.register(packFixture())
    const [pack] = registry.packs()
    expect(Object.keys(pack ?? {}).sort()).toEqual(['id', 'title', 'version'])
  })
})

describe('T13: declarative data', () => {
  it('has no callable surface on Rule, so a pack cannot register code', () => {
    // Compile-time only (enforced by `tsc -p tsconfig.test.json`): a third-party
    // pack cannot smuggle in a callback, read context, or hook the pipeline.
    expectTypeOf<Rule>().not.toHaveProperty('execute')
    expectTypeOf<Rule>().not.toHaveProperty('handler')
    expectTypeOf<Rule>().not.toHaveProperty('on')
  })

  it('never invokes a rule field — rules are read as data, never called', () => {
    const registry = createReviewRuleRegistry(configFixture())
    const hostile = {
      ...ruleFixture({ id: ruleId('declarative') }),
      // Even if a hostile pack casts an executable field past the type, the
      // registry only reads the declarative surface and never calls it.
      execute: () => {
        throw new Error('must never run')
      },
    } as unknown as Rule
    registry.register(packFixture({ rules: [hostile] }))

    // match() and packs() read id/severity/applies/guidance; nothing is invoked.
    const matched = registry.match('src/index.ts')
    expect(matched).toHaveLength(1)
    expect(matched[0]?.guidance).toBe('avoid == with non-null types')
    expect(registry.packs()).toEqual([{ id: 'baseline', version: '1.0.0', title: 'Baseline rules' }])
  })
})
