import { describe, expect, it } from 'vitest'
import { findingInvariantViolation, ruleId } from '@dshrb/review-core'
import type { Finding, RawProposal } from '@dshrb/review-core'
import type { Rule } from '@dshrb/rule-registry'
import type { UnifiedDiff } from '@dshrb/forge'
import { validate } from '../src/index.ts'

/**
 * `validate()` is the trust boundary: untrusted model output becomes a
 * publishable Finding here or is rejected with a recorded reason. These tests
 * assert both directions — what is accepted and what is discarded — and that
 * no proposal is ever silently swallowed.
 */

function proposal(over: RawProposal = {}): RawProposal {
  return {
    severity: 'major',
    title: 'Off-by-one in page offset',
    body: 'The offset is computed from a 1-based page number without subtracting 1.',
    path: 'src/paginate.ts',
    line: 42,
    ...over,
  }
}

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: ruleId('baseline/off-by-one'),
    severity: 'major',
    applies: ['**'],
    guidance: 'Use zero-based offsets.',
    requiresScenario: false,
    ...over,
  }
}

/** One file, hunks covering new lines 40-49 (and old lines 40-49). */
const diff: UnifiedDiff = {
  files: [{
    path: 'src/paginate.ts',
    hunks: [{ oldStart: 40, oldLines: 10, newStart: 40, newLines: 10, text: '@@' }],
    binary: false,
  }],
}

function reasons(discarded: readonly { reason: string }[]): readonly string[] {
  return discarded.map((entry) => entry.reason)
}

describe('validate', () => {
  it('accepts a well-formed proposal, anchored and invariant-clean', () => {
    const { findings, discarded } = validate([proposal()], diff, [])
    expect(discarded).toEqual([])
    expect(findings).toHaveLength(1)
    const finding = findings[0]
    expect(finding?.severity).toBe('major')
    expect(finding?.anchor).toEqual({ path: 'src/paginate.ts', line: 42, side: 'right', anchored: true })
    expect(findingInvariantViolation(finding as Finding)).toBeUndefined()
  })

  it('rejects traversal and absolute paths during normalization', () => {
    const traversal = validate([proposal({ path: '../../etc/passwd' })], diff, [])
    expect(traversal.findings).toEqual([])
    expect(reasons(traversal.discarded)[0]).toMatch(/^unsafe-path:/)

    const absolute = validate([proposal({ path: '/etc/passwd' })], diff, [])
    expect(reasons(absolute.discarded)[0]).toMatch(/^unsafe-path:/)

    const missing = validate([proposal({ path: '' })], diff, [])
    expect(reasons(missing.discarded)[0]).toMatch(/^missing-path:/)
  })

  it('rejects a proposal with no usable line number', () => {
    for (const line of [0, -1, 4.5, undefined]) {
      const { findings, discarded } = validate([proposal({ line })], diff, [])
      expect(findings).toEqual([])
      expect(reasons(discarded)[0]).toMatch(/^invalid-line:/)
    }
  })

  it('keeps a finding whose line is outside the diff, degraded with a reason', () => {
    const { findings, discarded } = validate([proposal({ path: 'src/absent.ts', line: 1 })], diff, [])
    expect(discarded).toEqual([])
    expect(findings).toHaveLength(1)
    const anchor = findings[0]?.anchor
    expect(anchor?.anchored).toBe(false)
    expect(anchor?.fallbackReason).toMatch(/not in the diff/)
    expect(findingInvariantViolation(findings[0] as Finding)).toBeUndefined()
  })

  it('downgrades a scenario-less blocker to major rather than dropping it', () => {
    const { findings, discarded } = validate([proposal({ severity: 'blocker' })], diff, [])
    expect(discarded).toEqual([])
    expect(findings[0]?.severity).toBe('major')
  })

  it('keeps a blocker that describes how it fails', () => {
    const { findings } = validate([proposal({ severity: 'blocker', failureScenario: 'page=1 skips row 1' })], diff, [])
    expect(findings[0]?.severity).toBe('blocker')
  })

  it('applies a cited rule requiring a failureScenario', () => {
    const requires = rule({ id: ruleId('baseline/needs-repro'), requiresScenario: true })
    const { findings } = validate(
      [proposal({ severity: 'major', ruleId: 'baseline/needs-repro' })], diff, [requires],
    )
    expect(findings[0]?.severity).toBe('minor')
  })

  it('dedupes proposals resolving to the same path + anchor + ruleId', () => {
    const inputs = [
      proposal({ ruleId: 'baseline/off-by-one' }),
      proposal({ ruleId: 'baseline/off-by-one', title: 'restated, same location', body: 'Second phrasing.' }),
    ]
    const { findings, discarded } = validate(inputs, diff, [rule()])
    expect(findings).toHaveLength(1)
    expect(reasons(discarded)[0]).toMatch(/^duplicate:/)
  })

  it('does not collapse different locations or different rules', () => {
    const inputs = [
      proposal({ ruleId: 'baseline/off-by-one' }),
      proposal({ ruleId: 'baseline/off-by-one', line: 43 }),
      proposal({ ruleId: 'baseline/other' }),
    ]
    const { findings, discarded } = validate(inputs, diff, [rule(), rule({ id: ruleId('baseline/other') })])
    expect(findings).toHaveLength(3)
    expect(discarded).toEqual([])
  })

  it('rejects a finding whose text exceeds the size cap', () => {
    const longTitle = validate([proposal({ title: 'x'.repeat(300) })], diff, [])
    expect(reasons(longTitle.discarded)[0]).toMatch(/^size-cap:/)

    const longBody = validate([proposal({ body: 'y'.repeat(9000) })], diff, [])
    expect(reasons(longBody.discarded)[0]).toMatch(/^size-cap:/)
  })

  it('reports every schema rejection with its machine-readable code', () => {
    const cases: readonly [string, RawProposal, RegExp][] = [
      ['missing-title', proposal({ title: '   ' }), /^missing-title:/],
      ['missing-body', proposal({ body: undefined }), /^missing-body:/],
      ['missing-severity', proposal({ severity: undefined }), /^missing-severity:/],
      ['unknown-severity', proposal({ severity: 'critical' }), /^unknown-severity:/],
      ['invalid-patch', proposal({ patch: { path: '../x', diff: 'd' } }), /^invalid-patch:/],
    ]
    for (const [label, raw, pattern] of cases) {
      const { findings, discarded } = validate([raw], diff, [])
      expect(findings, label).toEqual([])
      expect(reasons(discarded)[0], label).toMatch(pattern)
    }
  })

  it('never swallows a proposal: findings + discarded account for every input', () => {
    const inputs = [
      proposal(),
      proposal({ severity: 'blocker', failureScenario: 'page=1 skips row 1' }),
      proposal({ path: '../../etc/passwd' }),
      proposal({ line: 0 }),
      proposal({ title: '   ' }),
      proposal({ title: 'restated, same location' }),
      proposal({ body: 'y'.repeat(9000) }),
      proposal({ path: 'src/absent.ts', line: 1 }),
    ]
    const { findings, discarded } = validate(inputs, diff, [])
    expect(findings.length + discarded.length).toBe(inputs.length)
    for (const finding of findings) {
      expect(findingInvariantViolation(finding)).toBeUndefined()
    }
  })
})
