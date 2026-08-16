/**
 * Shared provider conformance suite (docs/06-forge-abstraction.md:147).
 *
 * Every forge provider that ships real capabilities must pass the SAME set of
 * semantic cases, so GitHub / GitLab / Gitea / local cannot drift into three
 * different readings of the `ForgeGateway` contract (docs/06:150). The suite is
 * exported from `@dshrb/forge` and is deliberately transport-agnostic: a caller
 * supplies a factory that builds a fresh gateway wired to an in-memory
 * transport, so nothing here reaches the network or needs a credential.
 *
 * The suite asserts SEMANTIC consistency, never implementation details:
 *   - anchoring failure degrades to a summary entry, never silently drops
 *   - `PublishStats` three-term conservation (published + degraded + failed)
 *   - sticky updates only match the bot's own numeric-id comment
 *   - `isFork` resolves to a boolean, `resolvePermission` lands inside the
 *     `ForgePermission` vocabulary, `listFailedChecks` returns only failures
 *
 * A capability the provider does not declare is skipped, not failed. A
 * capability that is declared but not yet implemented (an explicit M-boundary,
 * e.g. `forge-github`'s `mutation-sink`) is listed in `unimplemented` and
 * skipped the same way.
 */
import { strict as assert } from 'node:assert'
import {
  anchorAt, anchorFallback, findingId, isSafeRelativePath, ruleId,
} from '@dshrb/review-core'
import type { Finding, ReviewTarget } from '@dshrb/review-core'
import type {
  ActorResolver, CheckReader, CheckRun, CommentSink, DiffSource, ForgeCapability,
  ForgeGateway, ForgePermission, MutationSink,
} from './index.js'

/** The suite is grouped by capability; a group maps 1:1 onto `ForgeCapability`. */
export type ConformanceCapability = ForgeCapability

/**
 * One scenario the suite can request from a factory. Each case builds a fresh
 * gateway through `factory(ctx)`, where `ctx.scenario` names the transport
 * fixture the caller must wire (e.g. "an existing bot comment carrying the
 * idempotency key of `anchoredFinding`").
 */
export type ConformanceScenario =
  | 'diff-source'
  | 'comment-sink'
  | 'inline-publish'
  | 'sticky-found'
  | 'sticky-forged'
  | 'actor'
  | 'checks'
  | 'log'
  | 'mutation'

/** Everything a factory needs to wire a scenario's in-memory transport. */
export interface ConformanceFactoryContext {
  readonly scenario: ConformanceScenario
  readonly target: ReviewTarget
  readonly botId: string
  readonly marker: string
  /** Anchored finding (path+line inside a hunk); the "happy path" fixture. */
  readonly anchoredFinding: Finding
  /** Unanchored finding; must degrade to a summary entry, never drop. */
  readonly unanchoredFinding: Finding
  /** A second anchored finding with a distinct idempotency key. */
  readonly secondFinding: Finding
}

/**
 * The methods the suite exercises, all optional so a provider implements only
 * what its `capabilities` advertise. The suite checks `capabilities` before
 * touching a method, so an absent method is never called.
 */
export interface ConformanceGateway extends ForgeGateway {
  readonly fetchDiff?: DiffSource['fetchDiff']
  readonly fetchFile?: DiffSource['fetchFile']
  readonly createComment?: CommentSink['createComment']
  readonly updateComment?: CommentSink['updateComment']
  readonly createInlineComments?: CommentSink['createInlineComments']
  readonly findStickyComment?: CommentSink['findStickyComment']
  readonly resolvePermission?: ActorResolver['resolvePermission']
  readonly isFork?: ActorResolver['isFork']
  readonly botIdentity?: ActorResolver['botIdentity']
  readonly listFailedChecks?: CheckReader['listFailedChecks']
  readonly fetchLog?: CheckReader['fetchLog']
  readonly commitPatches?: MutationSink['commitPatches']
  readonly openPullRequest?: MutationSink['openPullRequest']
}

export type ConformanceFactory =
  (ctx: ConformanceFactoryContext) => ConformanceGateway | Promise<ConformanceGateway>

export interface ConformanceOptions {
  /** Capabilities the provider advertises; groups outside this set are skipped. */
  readonly capabilities: readonly ForgeCapability[]
  /** Declared but not yet implemented capabilities (explicit M-boundary); skipped. */
  readonly unimplemented?: readonly ForgeCapability[]
  readonly target: ReviewTarget
  /** Numeric bot id the author gate compares against. */
  readonly botId: string
  /** Sticky marker name; `findStickyComment` must match it on the first line. */
  readonly marker: string
}

export interface ConformanceCase {
  readonly group: ConformanceCapability
  readonly name: string
  readonly run: () => Promise<void>
}

const FORGE_PERMISSIONS: readonly ForgePermission[] = [
  'none', 'read', 'triage', 'write', 'maintain', 'admin',
]

const FAILED_CONCLUSIONS: readonly CheckRun['conclusion'][] = ['failure', 'cancelled', 'timed_out']

const SHA_PATTERN = /^[0-9a-f]{7,40}$/u

/** Builds the fixtures the suite owns, shared across every case. */
function buildFindings(): {
  readonly anchored: Finding
  readonly unanchored: Finding
  readonly second: Finding
} {
  return {
    anchored: {
      findingId: findingId('conformance-anchored'),
      severity: 'major',
      title: 'Anchored finding',
      body: 'Anchored onto a diff line inside a hunk.',
      anchor: anchorAt('src/app.ts', 12),
      ruleId: ruleId('conformance-rule'),
    },
    unanchored: {
      findingId: findingId('conformance-unanchored'),
      severity: 'major',
      title: 'Unanchored finding',
      body: 'Fell outside every hunk and must degrade to a summary entry.',
      anchor: anchorFallback('src/app.ts', 99, 'outside every diff hunk'),
    },
    second: {
      findingId: findingId('conformance-second'),
      severity: 'minor',
      title: 'Second anchored finding',
      body: 'A distinct anchored finding in another file.',
      anchor: anchorAt('src/other.ts', 7),
    },
  }
}

async function gatewayFor(
  factory: ConformanceFactory, ctx: ConformanceFactoryContext,
): Promise<ConformanceGateway> {
  return await factory(ctx)
}

/**
 * Builds the conformance cases for a provider. Returns one flat, ordered list
 * of `{ group, name, run }` cases; the caller iterates it inside its own
 * `describe`/`it` block (vitest), e.g.:
 *
 *   for (const testCase of runForgeConformance(factory, options)) {
 *     it(`${testCase.group} · ${testCase.name}`, testCase.run)
 *   }
 *
 * A capability absent from `options.capabilities` (or present in
 * `options.unimplemented`) produces no cases — skipped, not failed.
 */
export function runForgeConformance(
  factory: ConformanceFactory, options: ConformanceOptions,
): readonly ConformanceCase[] {
  const { target, botId, marker } = options
  const declared = new Set(options.capabilities)
  const skipped = new Set(options.unimplemented ?? [])
  const active = (cap: ForgeCapability): boolean => declared.has(cap) && !skipped.has(cap)

  const { anchored, unanchored, second } = buildFindings()
  const cases: ConformanceCase[] = []

  const push = (
    group: ConformanceCapability, name: string, run: () => Promise<void>,
  ): void => {
    cases.push({ group, name, run })
  }

  // -- DiffSource -----------------------------------------------------------

  if (active('diff-source')) {
    push('diff-source', 'parses a diff into safe paths with hunks and a binary flag', async () => {
      const gateway = await gatewayFor(factory, {
        scenario: 'diff-source', target, botId, marker,
        anchoredFinding: anchored, unanchoredFinding: unanchored, secondFinding: second,
      })
      assert(gateway.fetchDiff !== undefined && gateway.fetchFile !== undefined)
      const diff = await gateway.fetchDiff(target)
      assert(Array.isArray(diff.files))
      for (const file of diff.files) {
        assert(typeof file.path === 'string' && isSafeRelativePath(file.path),
          `diff path must be a safe repo-relative path, got '${String(file.path)}'`)
        assert(typeof file.binary === 'boolean')
        assert(Array.isArray(file.hunks))
      }
      const content = await gateway.fetchFile(target.repo, 'src/app.ts', target.baseSha)
      assert(typeof content === 'string')
    })
  }

  // -- CommentSink (summary) ------------------------------------------------

  if (active('comment-sink')) {
    push('comment-sink', 'creates a summary comment and updates it by id', async () => {
      const gateway = await gatewayFor(factory, {
        scenario: 'comment-sink', target, botId, marker,
        anchoredFinding: anchored, unanchoredFinding: unanchored, secondFinding: second,
      })
      assert(gateway.createComment !== undefined && gateway.updateComment !== undefined)
      const id = await gateway.createComment(target, 'conformance summary')
      assert(typeof id === 'string' && id.trim() !== '', 'createComment must return a non-empty id')
      await gateway.updateComment(target.repo, id, 'conformance summary (revised)')
    })
  }

  // -- CommentSink (inline) -------------------------------------------------

  if (active('inline-comments')) {
    push('inline-comments', 'counts anchored, degraded and failed without dropping', async () => {
      const gateway = await gatewayFor(factory, {
        scenario: 'inline-publish', target, botId, marker,
        anchoredFinding: anchored, unanchoredFinding: unanchored, secondFinding: second,
      })
      assert(gateway.createInlineComments !== undefined)
      const stats = await gateway.createInlineComments(target, [anchored, unanchored, second], botId)
      assert.deepEqual(stats, { published: 2, degradedToSummary: 1, failed: 0 })
    })
  }

  // -- CommentSink (sticky) -------------------------------------------------

  if (active('sticky-comment')) {
    push('sticky-comment', 'finds the bot-authored comment carrying the marker', async () => {
      const gateway = await gatewayFor(factory, {
        scenario: 'sticky-found', target, botId, marker,
        anchoredFinding: anchored, unanchoredFinding: unanchored, secondFinding: second,
      })
      assert(gateway.findStickyComment !== undefined)
      const found = await gateway.findStickyComment(target, marker, botId)
      assert(typeof found === 'string' && found.trim() !== '')
    })

    push('sticky-comment', 'ignores a forged marker and the bot\'s own unmarked comments', async () => {
      const gateway = await gatewayFor(factory, {
        scenario: 'sticky-forged', target, botId, marker,
        anchoredFinding: anchored, unanchoredFinding: unanchored, secondFinding: second,
      })
      assert(gateway.findStickyComment !== undefined)
      const found = await gateway.findStickyComment(target, marker, botId)
      assert.equal(found, undefined)
    })
  }

  // -- ActorResolver --------------------------------------------------------

  if (active('actor-resolver')) {
    push('actor-resolver', 'maps permission into the vocabulary and resolves identity/fork', async () => {
      const gateway = await gatewayFor(factory, {
        scenario: 'actor', target, botId, marker,
        anchoredFinding: anchored, unanchoredFinding: unanchored, secondFinding: second,
      })
      assert(gateway.resolvePermission !== undefined
        && gateway.isFork !== undefined && gateway.botIdentity !== undefined)
      const permission = await gateway.resolvePermission(target.repo, 'conformance-actor')
      assert(FORGE_PERMISSIONS.includes(permission),
        `resolvePermission must land in the ForgePermission vocabulary, got '${String(permission)}'`)
      const fork = await gateway.isFork(target)
      assert(typeof fork === 'boolean', 'isFork must resolve to a boolean')
      const identity = await gateway.botIdentity()
      assert(typeof identity.id === 'string' && identity.id.trim() !== '')
      assert(typeof identity.login === 'string')
    })
  }

  // -- CheckReader ----------------------------------------------------------

  if (active('check-reader')) {
    push('check-reader', 'lists only the checks that did not pass', async () => {
      const gateway = await gatewayFor(factory, {
        scenario: 'checks', target, botId, marker,
        anchoredFinding: anchored, unanchoredFinding: unanchored, secondFinding: second,
      })
      assert(gateway.listFailedChecks !== undefined)
      const checks = await gateway.listFailedChecks(target.repo, target.headSha)
      assert(Array.isArray(checks))
      for (const check of checks) {
        assert(FAILED_CONCLUSIONS.includes(check.conclusion),
          `listFailedChecks must return only failed conclusions, got '${String(check.conclusion)}'`)
        assert(typeof check.id === 'string' && typeof check.name === 'string')
      }
    })

    push('check-reader', 'returns the check log as text', async () => {
      const gateway = await gatewayFor(factory, {
        scenario: 'log', target, botId, marker,
        anchoredFinding: anchored, unanchoredFinding: unanchored, secondFinding: second,
      })
      assert(gateway.fetchLog !== undefined)
      const log = await gateway.fetchLog(target.repo, '123')
      assert(typeof log === 'string')
    })
  }

  // -- MutationSink ---------------------------------------------------------

  if (active('mutation-sink')) {
    push('mutation-sink', 'commits patches to a CommitSha and opens a pull request', async () => {
      const gateway = await gatewayFor(factory, {
        scenario: 'mutation', target, botId, marker,
        anchoredFinding: anchored, unanchoredFinding: unanchored, secondFinding: second,
      })
      assert(gateway.commitPatches !== undefined && gateway.openPullRequest !== undefined)
      const sha = await gateway.commitPatches(
        target.repo, 'fix/conformance',
        [{ path: 'src/app.ts', diff: '@@ -0,0 +1,1 @@\n+conformance\n' }],
        'conformance commit',
      )
      assert(SHA_PATTERN.test(sha),
        `commitPatches must return a 7-40 hex CommitSha, got '${String(sha)}'`)
      const url = await gateway.openPullRequest({
        repo: target.repo, headBranch: 'fix/conformance', baseBranch: 'main',
        title: 'conformance', body: 'conformance',
      })
      assert(typeof url === 'string' && url.trim() !== '')
    })
  }

  return cases
}
