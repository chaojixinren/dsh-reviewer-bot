import { describe, expect, it } from 'vitest'
import { changeRequestId, commentId, commitSha, forgeId, ruleId } from '@dshrb/review-core'
import type {
  Failure, Finding, NormalizedEvent, RawProposal, ReviewIntent, ReviewResult, ReviewTarget,
} from '@dshrb/review-core'
import { createForgeRegistry } from '@dshrb/forge'
import type {
  ActorResolver, BotIdentity, CommentSink, DiffSource, ForgePermission, ForgeRegistry, PublishStats, UnifiedDiff,
} from '@dshrb/forge'
import type { Rule } from '@dshrb/rule-registry'
import {
  assembleContext, authorize, buildSummary, ingest, report, route, runReview, shardDiff, validate,
} from '../src/index.ts'
import type { Config, StageDeps } from '../src/index.ts'

// --- Fixtures ---------------------------------------------------------------

const GITHUB = forgeId('github')
const BASE_SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)

function diffFixture(): UnifiedDiff {
  return {
    files: [
      {
        path: 'src/index.ts',
        hunks: [
          { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, text: '@@ -1,3 +1,3 @@\n-const a = 1\n+const a = 2\n' },
          { oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, text: '@@ -10,2 +10,2 @@\n-old\n+new\n' },
        ],
        binary: false,
      },
      { path: 'img.png', hunks: [], binary: true },
    ],
  }
}

function targetFixture(): ReviewTarget {
  return {
    repo: 'acme/widgets',
    changeRequestId: changeRequestId('42'),
    baseSha: commitSha(BASE_SHA),
    headSha: commitSha(HEAD_SHA),
    isFork: false,
  }
}

/** One provider object answers every capability, as a real forge gateway does. */
interface FakeGateway extends ActorResolver, DiffSource, CommentSink {}

const FULL_CAPABILITIES = ['actor-resolver', 'diff-source', 'comment-sink', 'inline-comments'] as const

function gatewayFixture(over: Partial<FakeGateway> = {}): ForgeRegistry {
  const registry = createForgeRegistry()
  const gateway: FakeGateway = {
    id: GITHUB,
    capabilities: [...FULL_CAPABILITIES],
    resolvePermission: async (): Promise<ForgePermission> => 'write',
    isFork: async () => false,
    botIdentity: async (): Promise<BotIdentity> => ({ id: '12345', login: 'dshrb[bot]' }),
    fetchDiff: async () => diffFixture(),
    fetchFile: async () => 'file content',
    createComment: async () => commentId('c-1'),
    updateComment: async () => {},
    createInlineComments: async (): Promise<PublishStats> => ({ published: 1, degradedToSummary: 0, failed: 0 }),
    findStickyComment: async () => undefined,
    ...over,
  }
  registry.register(gateway)
  return registry
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

function depsFixture(over: Partial<StageDeps> = {}): StageDeps {
  return {
    forges: gatewayFixture(),
    now: () => 0,
    allowWrite: false,
    minSeverity: 'minor',
    shardBytes: 120_000,
    matchRules: () => [ruleFixture()],
    memory: [],
    runAgent: async () => [],
    ...over,
  }
}

function configFixture(over: Partial<Config> = {}): Config {
  return {
    timeoutMinutes: 25,
    shardBytes: 120_000,
    parallelShards: true,
    snapshotReplay: true,
    allowWrite: false,
    minSeverity: 'minor',
    ...over,
  }
}

function prPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deliveryId: 'evt-1',
    action: 'opened',
    number: 42,
    repository: { full_name: 'acme/widgets' },
    sender: { login: 'alice' },
    pull_request: {
      number: 42,
      base: { sha: BASE_SHA, repo: { full_name: 'acme/widgets' } },
      head: { sha: HEAD_SHA, repo: { full_name: 'acme/widgets', fork: false } },
    },
    ...over,
  }
}

function commentPayload(body: string): Record<string, unknown> {
  return {
    deliveryId: 'evt-2',
    repository: { full_name: 'acme/widgets' },
    sender: { login: 'bob' },
    comment: { body, user: { login: 'bob' } },
    issue: { number: 42 },
    // The driver enriches a comment event with the PR's target (no shas arrive
    // on an issue_comment webhook), so the top-level pull_request is present.
    pull_request: {
      number: 42,
      base: { sha: BASE_SHA },
      head: { sha: HEAD_SHA, repo: { full_name: 'acme/widgets', fork: false } },
    },
  }
}

function validProposal(over: Partial<RawProposal> = {}): RawProposal {
  return {
    severity: 'major',
    title: 'loose equality',
    body: 'use strict equality',
    path: 'src/index.ts',
    line: 2,
    ...over,
  }
}

// --- route (acceptance gate 3) ---------------------------------------------

describe('route', () => {
  function comment(body: string): NormalizedEvent {
    return {
      forgeId: GITHUB,
      deliveryId: 'd',
      kind: 'comment',
      target: targetFixture(),
      actorLogin: 'bob',
      commentBody: body,
    }
  }

  it('maps a change-request to review', () => {
    expect(route({ ...comment(''), kind: 'change-request' })).toBe('review')
  })

  it('maps a check-failed to diagnose', () => {
    expect(route({ ...comment(''), kind: 'check-failed' })).toBe('diagnose')
  })

  it('parses a first-line @dsr review command', () => {
    expect(route(comment('@dsr review\nplease look'))).toBe('review')
  })

  it('parses every documented command case-insensitively', () => {
    const cases: readonly [string, ReviewIntent][] = [
      ['@dsr review', 'review'],
      ['@dsr explain', 'explain'],
      ['@dsr diagnose', 'diagnose'],
      ['@dsr fix', 'fix'],
      ['@dsr rules', 'rules'],
      ['@DSR REVIEW', 'review'],
    ]
    for (const [line, intent] of cases) {
      expect(route(comment(line)), line).toBe(intent)
    }
  })

  it('ignores an @dsr command that is not on the first line (regression)', () => {
    expect(route(comment('just quoting someone\n@dsr review'))).toBe('none')
  })

  it('ignores a bare comment with no command', () => {
    expect(route(comment('looks fine'))).toBe('none')
  })

  it('routes an unknown command to none', () => {
    expect(route(comment('@dsr summarize'))).toBe('none')
  })
})

// --- ingest -----------------------------------------------------------------

describe('ingest', () => {
  it('normalizes a pull_request event into a change-request', async () => {
    const event = await ingest(prPayload(), depsFixture())
    expect(event.kind).toBe('change-request')
    expect(event.actorLogin).toBe('alice')
    expect(event.target.repo).toBe('acme/widgets')
    expect(event.target.isFork).toBe(false)
  })

  it('marks a fork PR as isFork', async () => {
    const event = await ingest(prPayload({
      pull_request: {
        number: 42,
        base: { sha: BASE_SHA },
        head: { sha: HEAD_SHA, repo: { full_name: 'forker/widgets', fork: true } },
      },
    }), depsFixture())
    expect(event.target.isFork).toBe(true)
  })

  it('normalizes an issue_comment event into a comment', async () => {
    const event = await ingest(commentPayload('@dsr review'), depsFixture())
    expect(event.kind).toBe('comment')
    expect(event.commentBody).toBe('@dsr review')
    expect(event.actorLogin).toBe('bob')
  })

  it('normalizes a failing check_run into a check-failed event', async () => {
    const event = await ingest({
      deliveryId: 'evt-3',
      check_run: {
        conclusion: 'failure',
        pull_requests: [{
          number: 42,
          base: { sha: BASE_SHA, repository: { full_name: 'acme/widgets' } },
          head: { sha: HEAD_SHA, repo: { full_name: 'acme/widgets', fork: false } },
        }],
      },
    }, depsFixture())
    expect(event.kind).toBe('check-failed')
    expect(event.target.repo).toBe('acme/widgets')
  })

  it('rejects a non-failing check_run as not needing diagnosis', async () => {
    await expect(ingest({ deliveryId: 'e', check_run: { conclusion: 'success' } }, depsFixture()))
      .rejects.toThrow(/does not need diagnosis/)
  })

  it('rejects an unknown payload shape', async () => {
    await expect(ingest({ deliveryId: 'e', something: true }, depsFixture()))
      .rejects.toThrow(/unsupported event payload/)
  })

  it('rejects a missing deliveryId', async () => {
    await expect(ingest({ pull_request: {} }, depsFixture())).rejects.toThrow(/deliveryId/)
  })
})

// --- authorize --------------------------------------------------------------

describe('authorize', () => {
  it('resolves a collaborator review to trusted-read', async () => {
    const event = await ingest(prPayload(), depsFixture())
    const request = await authorize(event, 'review', depsFixture())
    expect(request.trust).toBe('trusted-read')
    expect(request.capabilities.readRepoFiles).toBe(true)
    expect(request.capabilities.commitPatches).toBe(false)
  })

  it('denies a fix intent while allowWrite is off', async () => {
    const event = await ingest(prPayload(), depsFixture())
    const request = await authorize(event, 'fix', depsFixture({ allowWrite: false }))
    expect(request.trust).toBe('none')
  })

  it('grants trusted-write for a fix intent when allowWrite is on', async () => {
    const event = await ingest(prPayload(), depsFixture())
    const request = await authorize(event, 'fix', depsFixture({ allowWrite: true }))
    expect(request.trust).toBe('trusted-write')
    expect(request.capabilities.commitPatches).toBe(true)
  })
})

// --- assembleContext / shardDiff -------------------------------------------

describe('shardDiff', () => {
  it('keeps a small diff in one untruncated shard', () => {
    const shards = shardDiff(diffFixture(), 120_000)
    expect(shards).toHaveLength(1)
    expect(shards[0]?.truncated).toBe(false)
    expect(shards[0]?.files).toEqual(['src/index.ts'])
  })

  it('splits between hunks under a tiny budget and marks truncation', () => {
    const shards = shardDiff(diffFixture(), 30)
    expect(shards.length).toBeGreaterThan(1)
    expect(shards[0]?.truncated).toBe(true)
    expect(shards[shards.length - 1]?.truncated).toBe(true)
  })

  it('skips binary files', () => {
    const shards = shardDiff(diffFixture(), 120_000)
    for (const shard of shards) {
      expect(shard.files).not.toContain('img.png')
    }
  })
})

describe('assembleContext', () => {
  it('collects rules matching touched paths', async () => {
    const event = await ingest(prPayload(), depsFixture())
    const request = await authorize(event, 'review', depsFixture())
    const bounded = assembleContext(request, diffFixture(), depsFixture())
    expect(bounded.rules.map((rule) => rule.id)).toEqual([ruleId('correctness/eq')])
    expect(bounded.shards.length).toBeGreaterThan(0)
  })
})

// --- validate ---------------------------------------------------------------

describe('validate', () => {
  it('accepts a valid anchored proposal', () => {
    const { findings, discarded } = validate([validProposal()], diffFixture(), [])
    expect(discarded).toEqual([])
    expect(findings).toHaveLength(1)
    expect(findings[0]?.anchor.anchored).toBe(true)
    expect(findings[0]?.anchor.side).toBe('right')
  })

  it('rejects an unsafe path', () => {
    const { findings, discarded } = validate([validProposal({ path: '../etc/passwd' })], diffFixture(), [])
    expect(findings).toEqual([])
    expect(discarded[0]?.reason).toMatch(/^unsafe-path:/)
  })

  it('downgrades a blocker without a failureScenario', () => {
    const { findings } = validate([validProposal({ severity: 'blocker', failureScenario: undefined })], diffFixture(), [])
    expect(findings[0]?.severity).toBe('major')
  })

  it('keeps a blocker that names a reproducible scenario', () => {
    const { findings } = validate(
      [validProposal({ severity: 'blocker', failureScenario: 'null x reaches ==' })],
      diffFixture(), [],
    )
    expect(findings[0]?.severity).toBe('blocker')
  })

  it('dedupes proposals that collapse onto the same anchor and rule', () => {
    const { findings, discarded } = validate(
      [validProposal(), validProposal({ title: 'same spot reworded' })],
      diffFixture(), [],
    )
    expect(findings).toHaveLength(1)
    expect(discarded[0]?.reason).toMatch(/duplicate/)
  })

  it('downgrades a severity whose cited rule requires a scenario', () => {
    const rules = [ruleFixture({ severity: 'major', requiresScenario: true })]
    const { findings } = validate(
      [validProposal({ severity: 'major', ruleId: 'correctness/eq', failureScenario: undefined })],
      diffFixture(), rules,
    )
    expect(findings[0]?.severity).toBe('minor')
  })
})

// --- buildSummary -----------------------------------------------------------

describe('buildSummary', () => {
  it('includes degraded findings so nothing vanishes', () => {
    const anchor = validate([validProposal()], diffFixture(), []).findings[0] as Finding
    const text = buildSummary([anchor], { published: 1, degradedToSummary: 1, failed: 0 }, [anchor])
    expect(text).toContain('summary only')
    expect(text).toContain(anchor.title)
  })

  it('says no findings when empty', () => {
    expect(buildSummary([], { published: 0, degradedToSummary: 0, failed: 0 }, [])).toContain('No findings.')
  })
})

// --- report -----------------------------------------------------------------

describe('report', () => {
  it('maps a timeout failure to a timed_out status', () => {
    const failure: Failure = {
      code: 'E_TIMEOUT', phase: 'reason', title: 'timed out', message: 'x', guidance: 'y', retryable: true,
    }
    const result = report({}, failure)
    expect(result.verdict.status).toBe('timed_out')
    expect(result.failure?.code).toBe('E_TIMEOUT')
  })

  it('never throws and always returns a terminal result', () => {
    const result = report({})
    expect(result.verdict.status).toBe('failed')
    expect(result.findings).toEqual([])
  })
})

// --- runReview --------------------------------------------------------------

describe('runReview', () => {
  it('runs the full pipeline and returns a success result', async () => {
    const deps = depsFixture({ runAgent: async () => [validProposal()] })
    const result = await runReview(prPayload(), deps, configFixture())
    expect(result.verdict.status).toBe('success')
    expect(result.verdict.findingsCount).toBe(1)
    expect(result.operation).toBe('review')
    expect(result.trust).toBe('trusted-read')
    expect(result.forgeId).toBe(GITHUB)
    expect(result.summary).toContain('loose equality')
  })

  it('returns neutral without publishing when nothing is routed', async () => {
    const result = await runReview(commentPayload('no command here'), depsFixture(), configFixture())
    expect(result.verdict.status).toBe('neutral')
    expect(result.operation).toBe('none')
  })

  it('finalizes a complete timed_out result when the agent ignores the budget (gate 6)', async () => {
    const deps = depsFixture({
      runAgent: (_bounded, signal) => new Promise<readonly RawProposal[]>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')))
      }),
    })
    const result = await runReview(prPayload(), deps, configFixture({ timeoutMinutes: 0.001 }))
    expect(result.verdict.status).toBe('timed_out')
    expect(result.failure?.code).toBe('E_TIMEOUT')
    // A complete terminal result, not a partial: every output field is present.
    const complete: ReviewResult = result
    expect(complete.verdict.durationMs).toBeGreaterThanOrEqual(0)
    expect(complete.findings).toEqual([])
    expect(complete.discarded).toEqual([])
  })

  it('surfaces a publish-side failure without throwing', async () => {
    const deps = depsFixture({
      forges: gatewayFixture({
        createInlineComments: async () => { throw new Error('network down') },
      }),
      runAgent: async () => [validProposal()],
    })
    const result = await runReview(prPayload(), deps, configFixture())
    expect(result.verdict.status).toBe('failed')
    expect(result.failure?.phase).toBe('publish')
  })
})
