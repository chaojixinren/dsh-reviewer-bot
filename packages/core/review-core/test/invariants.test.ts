import { describe, expect, it } from 'vitest'
import {
  NO_CAPABILITIES,
  SEVERITY_BADGE_COLOR,
  SEVERITY_ORDER,
  anchorAt,
  anchorFallback,
  buildFindingBadge,
  capabilities,
  changeRequestId,
  commentId,
  commitSha,
  compareSeverity,
  countBlockers,
  downgradeSeverity,
  effectiveSeverity,
  findingCategory,
  findingDedupeKey,
  findingId,
  findingInvariantViolation,
  findingMemoryKey,
  forgeId,
  isAnchored,
  isSafeRelativePath,
  isSeverity,
  matchesGlob,
  meetsSeverityThreshold,
  memoryKey,
  narrowPatchProposal,
  narrowProposal,
  requestId,
  ruleId,
  severityRank,
  toDiscarded,
} from '../src/index.ts'
import type { Anchor, Finding, RawProposal, Severity } from '../src/index.ts'

/**
 * These helpers are the only sanctioned path from untrusted model output into a
 * publishable Finding, so the negative cases carry as much weight as the happy
 * path: each one is a proposal that must NOT become a comment.
 */

const id = findingId('f1')

function proposal(overrides: RawProposal = {}): RawProposal {
  return {
    severity: 'major',
    title: 'Off-by-one in page offset',
    body: 'The offset is computed from a 1-based page number without subtracting 1.',
    path: 'src/paginate.ts',
    line: 42,
    ...overrides,
  }
}

function accept(raw: RawProposal, requiresScenario?: boolean): Finding {
  const result = narrowProposal(raw, {
    findingId: id,
    anchor: anchorAt('src/paginate.ts', 42),
    ...(requiresScenario === undefined ? {} : { requiresScenario }),
  })
  if (!result.ok) {
    throw new Error(`expected acceptance, got ${result.reason}: ${result.message}`)
  }
  return result.value
}

describe('branded id constructors', () => {
  it('trims and rejects empty ids instead of minting an invalid brand', () => {
    expect(requestId('  run-7  ')).toBe('run-7')
    expect(() => requestId('   ')).toThrow(/RequestId/)
    expect(() => findingId('')).toThrow(/non-empty/)
  })

  it('applies the same rule to every id kind, so none is left castable', () => {
    // Enumerated rather than spot-checked: a new branded id whose constructor
    // forgets the empty check would otherwise ship untested.
    const constructors = { forgeId, changeRequestId, commentId, ruleId }
    for (const [kind, construct] of Object.entries(constructors)) {
      expect(construct(`  ${kind}-value  `)).toBe(`${kind}-value`)
      expect(() => construct('')).toThrow(/non-empty/)
      expect(() => construct('\t\n ')).toThrow(/non-empty/)
    }
  })

  it('normalizes a sha to lowercase and rejects a malformed one', () => {
    expect(commitSha('DEADBEEF')).toBe('deadbeef')
    expect(() => commitSha('deadbee')).not.toThrow()
    expect(() => commitSha('nope!')).toThrow(/7-40 hex/)
    expect(() => commitSha('abc')).toThrow(/7-40 hex/)
  })
})

describe('severity ordering', () => {
  it('orders by rank, not alphabetically', () => {
    // 'major' < 'minor' as strings, so a bare comparison would agree by luck
    // here but disagree for 'blocker' vs 'info'.
    expect(severityRank('blocker')).toBeLessThan(severityRank('info'))
    expect([...SEVERITY_ORDER].sort(compareSeverity)).toEqual([...SEVERITY_ORDER])
  })

  it('accepts only the five known severities', () => {
    expect(isSeverity('blocker')).toBe(true)
    expect(isSeverity('critical')).toBe(false)
    expect(isSeverity(undefined)).toBe(false)
  })

  it('applies a min-severity threshold inclusively', () => {
    expect(meetsSeverityThreshold('blocker', 'minor')).toBe(true)
    expect(meetsSeverityThreshold('minor', 'minor')).toBe(true)
    expect(meetsSeverityThreshold('nit', 'minor')).toBe(false)
  })

  it('floors downgrade at info', () => {
    expect(downgradeSeverity('blocker')).toBe('major')
    expect(downgradeSeverity('info')).toBe('info')
  })
})

describe('finding badge', () => {
  it('maps every severity to a shields.io color', () => {
    expect(Object.keys(SEVERITY_BADGE_COLOR).sort()).toEqual([...SEVERITY_ORDER].sort())
    for (const color of Object.values(SEVERITY_BADGE_COLOR)) {
      expect(color).toMatch(/^[a-z]+$/)
    }
  })

  it('renders category-severity when the ruleId has a category prefix', () => {
    const finding = accept(proposal({ severity: 'major', ruleId: 'security/secret-in-source' }))
    expect(buildFindingBadge(finding)).toBe(
      '![security · major](https://img.shields.io/badge/security-major-red)',
    )
  })

  it('renders severity only when there is no ruleId', () => {
    const finding = accept(proposal({ severity: 'minor' }))
    expect(buildFindingBadge(finding)).toBe(
      '![minor](https://img.shields.io/badge/minor--orange)',
    )
  })

  it('doubles a hyphen in a category so shields.io keeps it in the label', () => {
    // `api-contract` is a real baseline category: a bare `-` would 404 or
    // re-split into label=api, message=contract.
    const finding = accept(proposal({ severity: 'minor', ruleId: 'api-contract/schema-change' }))
    expect(buildFindingBadge(finding)).toBe(
      '![api-contract · minor](https://img.shields.io/badge/api--contract-minor-orange)',
    )
  })

  it('does not invent a category from a slash-less or empty ruleId', () => {
    expect(findingCategory(undefined)).toBeUndefined()
    expect(findingCategory(ruleId('no-oob'))).toBeUndefined()
    expect(findingCategory(ruleId('/leading-empty'))).toBeUndefined()
    expect(findingCategory(ruleId('security/secret-in-source'))).toBe('security')
  })

  it('escapes markdown-special and URL-special characters', () => {
    // A third-party ruleId is only non-empty-branded, not charset-restricted.
    const bracket = accept(proposal({ severity: 'major', ruleId: 'sec[x/y' }))
    expect(buildFindingBadge(bracket)).toBe(
      '![sec\\[x · major](https://img.shields.io/badge/sec%5Bx-major-red)',
    )

    // `)` closes a Markdown link destination, so it must be percent-encoded.
    const paren = accept(proposal({ severity: 'major', ruleId: 'foo)bar/rule' }))
    expect(buildFindingBadge(paren)).toBe(
      '![foo)bar · major](https://img.shields.io/badge/foo%29bar-major-red)',
    )

    // `_` is a shields.io separator; `\` and `]` are structural in the alt.
    const underscore = accept(proposal({ severity: 'nit', ruleId: 'sec_ure/rule' }))
    expect(buildFindingBadge(underscore)).toBe(
      '![sec_ure · nit](https://img.shields.io/badge/sec__ure-nit-green)',
    )
  })
})

describe('effectiveSeverity', () => {
  it('downgrades a blocker with no failure scenario', () => {
    expect(effectiveSeverity({ severity: 'blocker' })).toBe('major')
    expect(effectiveSeverity({ severity: 'blocker', failureScenario: '   ' })).toBe('major')
  })

  it('keeps a blocker that describes how it fails', () => {
    expect(effectiveSeverity({ severity: 'blocker', failureScenario: 'page=1 returns rows 11-20' }))
      .toBe('blocker')
  })

  it('honors a rule author opting into the scenario requirement', () => {
    expect(effectiveSeverity({ severity: 'minor', requiresScenario: true })).toBe('nit')
    expect(effectiveSeverity({ severity: 'minor' })).toBe('minor')
  })
})

describe('anchors', () => {
  it('narrows an anchored anchor and rejects a bad path or line', () => {
    const anchor = anchorAt('src/a.ts', 3)
    expect(isAnchored(anchor)).toBe(true)
    expect(anchor.side).toBe('right')
    expect(() => anchorAt('/etc/passwd', 3)).toThrow(/repo-relative/)
    expect(() => anchorAt('src/a.ts', 0)).toThrow(/positive integer/)
  })

  it('requires a reason on a fallback anchor', () => {
    const fallback = anchorFallback('src/a.ts', 3, 'line is outside every diff hunk')
    expect(isAnchored(fallback)).toBe(false)
    expect(fallback.fallbackReason).toBe('line is outside every diff hunk')
    expect(() => anchorFallback('src/a.ts', 3, ' ')).toThrow(/why anchoring failed/)
  })

  it('rejects traversal, absolute, drive, and NUL paths', () => {
    expect(isSafeRelativePath('src/a.ts')).toBe(true)
    expect(isSafeRelativePath('../../etc/passwd')).toBe(false)
    expect(isSafeRelativePath('src/../../etc/passwd')).toBe(false)
    expect(isSafeRelativePath('/abs')).toBe(false)
    expect(isSafeRelativePath('C:\\win')).toBe(false)
    expect(isSafeRelativePath('C:foo')).toBe(false)
    expect(isSafeRelativePath('src\\..\\..\\win')).toBe(false)
    expect(isSafeRelativePath('src/a\0.ts')).toBe(false)
    expect(isSafeRelativePath('')).toBe(false)
    // A filename that merely contains dots is fine; only a `..` segment is not.
    expect(isSafeRelativePath('src/..a.ts')).toBe(true)
  })
})

describe('matchesGlob', () => {
  it('matches literal segments exactly', () => {
    expect(matchesGlob('Jenkinsfile', 'Jenkinsfile')).toBe(true)
    expect(matchesGlob('Jenkinsfile', 'src/Jenkinsfile')).toBe(false)
  })

  it('matches a trailing ** across any number of segments', () => {
    expect(matchesGlob('.github/**', '.github/workflows/ci.yml')).toBe(true)
    expect(matchesGlob('.github/**', '.github')).toBe(true)
    expect(matchesGlob('.github/**', 'src/.github/x')).toBe(false)
  })

  it('matches * within one segment only', () => {
    expect(matchesGlob('*.yml', '.gitlab-ci.yml')).toBe(true)
    expect(matchesGlob('src/*.ts', 'src/index.ts')).toBe(true)
    expect(matchesGlob('src/*.ts', 'src/nested/index.ts')).toBe(false)
  })

  it('matches a ** in the middle across zero or more segments', () => {
    expect(matchesGlob('src/**/generated/**', 'src/generated/x.ts')).toBe(true)
    expect(matchesGlob('src/**/generated/**', 'src/a/b/generated')).toBe(true)
  })
})

describe('capabilities', () => {
  it('denies by default and grants only what is asked for', () => {
    const caps = capabilities({ readDiff: true, publishComments: true })
    expect(caps.readDiff).toBe(true)
    expect(caps.publishComments).toBe(true)
    expect(caps.readRepoFiles).toBe(false)
    expect(caps.commitPatches).toBe(false)
  })

  it('keeps the shared baseline immutable', () => {
    expect(Object.isFrozen(NO_CAPABILITIES)).toBe(true)
    capabilities({ readDiff: true })
    expect(NO_CAPABILITIES.readDiff).toBe(false)
  })
})

describe('narrowProposal', () => {
  it('produces a Finding with branded ids and the caller-supplied anchor', () => {
    const finding = accept(proposal({ ruleId: 'baseline/off-by-one' }))
    expect(finding.findingId).toBe(id)
    expect(finding.severity).toBe('major')
    expect(finding.ruleId).toBe('baseline/off-by-one')
    expect(finding.anchor.anchored).toBe(true)
    expect(findingInvariantViolation(finding)).toBeUndefined()
  })

  it('trims text and omits absent optional fields rather than setting undefined', () => {
    const finding = accept(proposal({ title: '  Padded title  ', ruleId: '   ' }))
    expect(finding.title).toBe('Padded title')
    expect('ruleId' in finding).toBe(false)
    expect('failureScenario' in finding).toBe(false)
    expect('suggestedPatch' in finding).toBe(false)
  })

  it('downgrades an unsupported blocker instead of rejecting it', () => {
    expect(accept(proposal({ severity: 'blocker' })).severity).toBe('major')
    const supported = accept(proposal({ severity: 'blocker', failureScenario: 'page=1 skips row 1' }))
    expect(supported.severity).toBe('blocker')
    expect(supported.failureScenario).toBe('page=1 skips row 1')
  })

  it('applies the rule-level scenario requirement passed by the caller', () => {
    expect(accept(proposal({ severity: 'major' }), true).severity).toBe('minor')
  })

  it.each<[string, RawProposal, string]>([
    ['missing-title', { ...proposal(), title: '  ' }, 'missing-title'],
    ['missing-body', { ...proposal(), body: undefined }, 'missing-body'],
    ['missing-severity', { ...proposal(), severity: undefined }, 'missing-severity'],
    ['unknown-severity', { ...proposal(), severity: 'critical' }, 'unknown-severity'],
    ['missing-path', { ...proposal(), path: '' }, 'missing-path'],
    ['unsafe-path', { ...proposal(), path: '../../etc/passwd' }, 'unsafe-path'],
    ['non-integer line', { ...proposal(), line: 4.5 }, 'invalid-line'],
    ['absent line', { ...proposal(), line: undefined }, 'invalid-line'],
    ['patch escaping the repo', { ...proposal(), patch: { path: '../x', diff: 'd' } }, 'invalid-patch'],
    ['patch with no diff', { ...proposal(), patch: { path: 'src/a.ts', diff: '  ' } }, 'invalid-patch'],
  ])('rejects %s', (_label, raw, reason) => {
    const result = narrowProposal(raw, { findingId: id, anchor: anchorAt('src/paginate.ts', 42) })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toBe(reason)
    expect(result.message).not.toBe('')
  })

  it('keeps a suggested patch diff verbatim', () => {
    const diff = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n'
    const finding = accept(proposal({ patch: { path: 'src/paginate.ts', diff } }))
    expect(finding.suggestedPatch).toEqual({ path: 'src/paginate.ts', diff })
  })

  it('treats a JSON null patch as absent instead of crashing', () => {
    const raw = { ...proposal(), patch: null } as unknown as RawProposal
    const result = narrowProposal(raw, { findingId: id, anchor: anchorAt('src/paginate.ts', 42) })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect('suggestedPatch' in result.value).toBe(false)
    }
  })

  it('caps untrusted text in rejection messages', () => {
    const long = 'x'.repeat(200)
    const result = narrowProposal({ ...proposal(), severity: long }, {
      findingId: id,
      anchor: anchorAt('src/paginate.ts', 42),
    })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.message.length).toBeLessThan(120)
    expect(result.message).toContain('…')
    expect(toDiscarded({ ...proposal(), title: long }, result).rawTitle).toContain('…')
  })

  it('records the rejection reason and raw title for the audit trail', () => {
    const raw = { ...proposal(), severity: 'critical' }
    const result = narrowProposal(raw, { findingId: id, anchor: anchorAt('src/paginate.ts', 42) })
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    const discarded = toDiscarded(raw, result)
    expect(discarded.reason).toContain('unknown-severity')
    expect(discarded.rawTitle).toBe('Off-by-one in page offset')
  })
})

describe('narrowPatchProposal', () => {
  it('accepts a safe patch and keeps the diff verbatim', () => {
    const diff = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n'
    const result = narrowPatchProposal({ path: 'src/paginate.ts', diff })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ path: 'src/paginate.ts', diff })
  })

  it.each<[string, { path?: string; diff?: string }]>([
    ['missing path', { path: '  ', diff: 'd' }],
    ['path escaping the repo', { path: '../x', diff: 'd' }],
    ['absolute path', { path: '/etc/passwd', diff: 'd' }],
    ['empty diff', { path: 'src/a.ts', diff: '   ' }],
  ])('rejects a %s with the invalid-patch code', (_label, raw) => {
    const result = narrowPatchProposal(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-patch')
  })
})

describe('findingInvariantViolation', () => {
  function finding(overrides: Partial<Finding> = {}): Finding {
    return {
      findingId: id,
      severity: 'major',
      title: 'Title',
      body: 'Body',
      anchor: anchorAt('src/a.ts', 1),
      ...overrides,
    }
  }

  it('abstains on a well-formed finding', () => {
    expect(findingInvariantViolation(finding())).toBeUndefined()
    expect(findingInvariantViolation(finding({
      severity: 'blocker',
      failureScenario: 'page=1 skips row 1',
    }))).toBeUndefined()
    expect(findingInvariantViolation(finding({
      anchor: anchorFallback('src/a.ts', 1, 'outside every hunk'),
    }))).toBeUndefined()
  })

  it('catches a blocker assembled by hand without a failure scenario', () => {
    // narrowProposal would have downgraded this; the net is for every other
    // route into a Finding, such as a replay snapshot.
    expect(findingInvariantViolation(finding({ severity: 'blocker' })))
      .toMatch(/require a reproducible failureScenario/)
  })

  it('catches both directions of an inconsistent anchor', () => {
    const unanchored: Anchor = { path: 'src/a.ts', line: 1, side: 'right', anchored: false }
    expect(findingInvariantViolation(finding({ anchor: unanchored })))
      .toMatch(/must record a fallbackReason/)

    const contradictory: Anchor = {
      path: 'src/a.ts', line: 1, side: 'right', anchored: true, fallbackReason: 'stale',
    }
    expect(findingInvariantViolation(finding({ anchor: contradictory })))
      .toMatch(/must not carry a fallbackReason/)
  })

  it('catches empty text and unusable anchor coordinates', () => {
    expect(findingInvariantViolation(finding({ title: '   ' }))).toMatch(/empty title/)
    expect(findingInvariantViolation(finding({ body: '' }))).toMatch(/empty body/)
    const escaping: Anchor = { path: '../x', line: 1, side: 'right', anchored: true }
    expect(findingInvariantViolation(finding({ anchor: escaping }))).toMatch(/repo-relative/)
    const badLine: Anchor = { path: 'src/a.ts', line: -1, side: 'right', anchored: true }
    expect(findingInvariantViolation(finding({ anchor: badLine }))).toMatch(/positive integer/)
  })

  it('catches an invalid severity and an empty finding id smuggled past the types', () => {
    // Only reachable via an unsafe cast or a hand-edited replay snapshot, which
    // is exactly what this net exists to catch.
    expect(findingInvariantViolation(finding({ severity: 'critical' as Severity })))
      .toMatch(/invalid severity/)
    expect(findingInvariantViolation(finding({ findingId: '' as Finding['findingId'] })))
      .toMatch(/empty findingId/)
  })
})

describe('findingDedupeKey', () => {
  it('collapses the same problem reported twice and separates different ones', () => {
    const base = accept(proposal({ ruleId: 'baseline/off-by-one' }))
    const restated = accept(proposal({
      ruleId: 'baseline/off-by-one',
      title: '  off-by-one in page OFFSET  ',
      body: 'Reported again from another shard.',
    }))
    expect(findingDedupeKey(restated)).toBe(findingDedupeKey(base))

    const elsewhere = narrowProposal(proposal({ ruleId: 'baseline/off-by-one' }), {
      findingId: id,
      anchor: anchorAt('src/paginate.ts', 43),
    })
    expect(elsewhere.ok).toBe(true)
    if (elsewhere.ok) {
      expect(findingDedupeKey(elsewhere.value)).not.toBe(findingDedupeKey(base))
    }
  })

  it('keeps an embedded NUL from shifting field boundaries', () => {
    // Under a bare `join('\0')`, ruleId='a' + title='b\0c' and
    // ruleId='a\0b' + title='c' would serialize to the same key.
    const a = accept(proposal({ ruleId: 'a', title: 'b\u0000c' }))
    const b = accept(proposal({ ruleId: 'a\u0000b', title: 'c' }))
    expect(findingDedupeKey(a)).not.toBe(findingDedupeKey(b))
  })
})

describe('findingMemoryKey', () => {
  it('is a distinct identity from the cross-shard dedupe key', () => {
    const finding = accept(proposal({ ruleId: 'correctness/eq', title: 'loose equality' }))
    expect(findingMemoryKey(finding)).not.toBe(findingDedupeKey(finding))
  })

  it('is line-agnostic so the same problem matches across revisions', () => {
    const base = accept(proposal({ ruleId: 'correctness/eq', title: 'loose equality' }))
    const shifted: Finding = { ...base, anchor: anchorAt('src/paginate.ts', 999) }
    expect(findingMemoryKey(shifted)).toBe(findingMemoryKey(base))
    expect(findingDedupeKey(shifted)).not.toBe(findingDedupeKey(base))
  })

  it('normalizes the title case and trims, like the dedupe key', () => {
    const a = accept(proposal({ ruleId: 'correctness/eq', title: '  Loose Equality  ' }))
    const b = accept(proposal({ ruleId: 'correctness/eq', title: 'loose equality' }))
    expect(findingMemoryKey(a)).toBe(findingMemoryKey(b))
  })

  it('memoryKey keeps a NUL from shifting field boundaries', () => {
    expect(memoryKey('src/a.ts', 'a', 'b\u0000c')).not.toBe(memoryKey('src/a.ts', 'a\u0000b', 'c'))
  })
})

describe('countBlockers', () => {
  it('counts only blocker-severity findings', () => {
    const findings = (['blocker', 'blocker', 'major', 'info'] satisfies Severity[])
      .map((severity, index): Finding => ({
        findingId: findingId(`f${index}`),
        severity,
        title: 'Title',
        body: 'Body',
        anchor: anchorAt('src/a.ts', index + 1),
        ...(severity === 'blocker' ? { failureScenario: 'concrete repro' } : {}),
      }))
    expect(countBlockers(findings)).toBe(2)
    expect(countBlockers([])).toBe(0)
  })
})
