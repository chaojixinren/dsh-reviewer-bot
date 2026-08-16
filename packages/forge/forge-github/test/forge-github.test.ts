import { describe, expect, it } from 'vitest'
import {
  anchorAt, anchorFallback, commitSha, findingId, ruleId,
} from '@dshrb/review-core'
import type { Anchor, Finding, ReviewTarget } from '@dshrb/review-core'
import { publishIdempotencyKey, runForgeConformance } from '@dshrb/forge'
import type { ConformanceFactory } from '@dshrb/forge'
import {
  CAPABILITIES, GitHubApiError, applyPatch, createGitHubGateway,
  extractIdempotencyKey, mapPermission, parseHunks, stickyMarker,
} from '../src/index.ts'
import type { Config, FetchLike } from '../src/index.ts'

/**
 * Every test drives the provider through a stubbed `fetch`. Nothing here reaches
 * the network: a live call would make the suite depend on a GitHub token and on
 * the state of a real pull request.
 */

const TOKEN = 'ghs-test-token-never-logged'

function config(overrides: Partial<Config> = {}): Config {
  return { token: TOKEN, baseUrl: 'https://api.github.com', ...overrides }
}

const TARGET: ReviewTarget = {
  repo: 'acme/widgets',
  changeRequestId: '42' as ReviewTarget['changeRequestId'],
  baseSha: commitSha('a'.repeat(40)),
  headSha: commitSha('b'.repeat(40)),
  isFork: false,
}

const BOT_ID = '77'

interface Call {
  readonly method: string
  readonly url: string
  readonly body: unknown
  readonly headers: Record<string, string>
}

interface Route {
  /** Matched as a substring of the request URL. */
  readonly match: string
  readonly method?: string
  readonly status?: number
  readonly json?: unknown
  readonly text?: string
}

/**
 * Builds a `fetch` stub that answers the first matching route and records every
 * call, so a test can assert both the response handling and the request shape.
 */
function stubFetch(routes: readonly Route[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    calls.push({
      method,
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    const route = routes.find((candidate) => url.includes(candidate.match)
      && (candidate.method === undefined || candidate.method === method))
    if (route === undefined) {
      return new Response('no stub route', { status: 599 })
    }
    const status = route.status ?? 200
    const payload = route.text ?? JSON.stringify(route.json ?? {})
    return new Response(payload, { status })
  }
  return { fetch, calls }
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    findingId: findingId('f-1'),
    severity: 'blocker',
    title: 'Unchecked index',
    body: 'This dereferences past the end of the array.',
    anchor: anchorAt('src/app.ts', 12),
    ruleId: ruleId('no-oob'),
    failureScenario: 'An empty input array makes index 0 undefined.',
    ...overrides,
  }
}

describe('capability advertisement', () => {
  it('advertises all seven forge capabilities', () => {
    expect([...CAPABILITIES].sort()).toEqual([
      'actor-resolver', 'check-reader', 'comment-sink', 'diff-source',
      'inline-comments', 'mutation-sink', 'sticky-comment',
    ])
    const gateway = createGitHubGateway(config(), stubFetch([]))
    expect(gateway.id).toBe('github')
    expect(gateway.capabilities).toEqual(CAPABILITIES)
  })

  it('implements the mutation sink instead of refusing it', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([]))
    await expect(gateway.commitPatches('acme/widgets', 'main', [], 'msg'))
      .rejects.toThrow(/received no patches/)
    await expect(gateway.openPullRequest({
      repo: 'acme/widgets', headBranch: 'fix', baseBranch: 'main', title: 't', body: 'b',
    })).rejects.toThrow(GitHubApiError)
  })
})

describe('publishIdempotencyKey', () => {
  it('is stable across runs and independent of the rendered body', () => {
    // A reworded body on retry must update the same comment, not create a second.
    const key = publishIdempotencyKey(finding())
    expect(publishIdempotencyKey(finding({ title: 'Reworded', body: 'New text' })))
      .toBe(key)
  })

  it('separates findings that differ only in anchor or rule', () => {
    const base = publishIdempotencyKey(finding())
    expect(publishIdempotencyKey(finding({ anchor: anchorAt('src/app.ts', 13) })))
      .not.toBe(base)
    expect(publishIdempotencyKey(finding({ anchor: anchorAt('src/other.ts', 12) })))
      .not.toBe(base)
    expect(publishIdempotencyKey(finding({ anchor: anchorAt('src/app.ts', 12, 'left') })))
      .not.toBe(base)
    expect(publishIdempotencyKey(finding({ ruleId: ruleId('other-rule') })))
      .not.toBe(base)
  })

  it('cannot be collided by a ruleId that forges a field boundary', () => {
    // Fields are JSON-encoded, so a delimiter inside a value cannot shift them.
    const a = finding({ anchor: anchorAt('a', 1), ruleId: ruleId('x:y') })
    const b = finding({ anchor: anchorAt('a', 1), ruleId: ruleId('x') })
    expect(publishIdempotencyKey(a)).not.toBe(publishIdempotencyKey(b))
  })
})

describe('createInlineComments', () => {
  const commentsPath = '/pulls/42/comments'

  it('posts anchored findings with path, line, side and commit_id', async () => {
    const stub = stubFetch([
      { match: commentsPath, method: 'GET', json: [] },
      { match: commentsPath, method: 'POST', json: { id: 1 } },
    ])
    const gateway = createGitHubGateway(config(), stub)

    const stats = await gateway.createInlineComments(TARGET, [finding()], BOT_ID)

    expect(stats).toEqual({ published: 1, degradedToSummary: 0, failed: 0 })
    const post = stub.calls.find((call) => call.method === 'POST')
    expect(post?.body).toMatchObject({
      commit_id: TARGET.headSha,
      path: 'src/app.ts',
      line: 12,
      side: 'RIGHT',
    })
  })

  it('maps a left-side anchor onto GitHub LEFT', async () => {
    const stub = stubFetch([
      { match: commentsPath, method: 'GET', json: [] },
      { match: commentsPath, method: 'POST', json: { id: 1 } },
    ])
    const gateway = createGitHubGateway(config(), stub)
    await gateway.createInlineComments(TARGET, [
      finding({ anchor: anchorAt('src/app.ts', 4, 'left') }),
    ], BOT_ID)
    expect(stub.calls.find((call) => call.method === 'POST')?.body)
      .toMatchObject({ side: 'LEFT' })
  })

  it('does not duplicate a comment when a retry follows a partial publish', async () => {
    // The first attempt landed this comment; the retry must recognize its own key.
    const already = finding()
    const key = publishIdempotencyKey(already)
    const stub = stubFetch([
      {
        match: commentsPath,
        method: 'GET',
        json: [{ body: `**blocker**: whatever\n\n<!-- dshrb:key:${key} -->`, user: { id: 77 } }],
      },
      { match: commentsPath, method: 'POST', json: { id: 2 } },
    ])
    const gateway = createGitHubGateway(config(), stub)

    const stats = await gateway.createInlineComments(TARGET, [already], BOT_ID)

    expect(stats).toEqual({ published: 0, degradedToSummary: 0, failed: 0 })
    expect(stub.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it('does not let a forged key from another author suppress a finding', async () => {
    // A reader can compute a key and pre-seed it, but only the bot's own comment
    // may count as "already published".
    const target = finding()
    const key = publishIdempotencyKey(target)
    const stub = stubFetch([
      {
        match: commentsPath,
        method: 'GET',
        json: [{ body: `forged\n\n<!-- dshrb:key:${key} -->`, user: { id: 1234 } }],
      },
      { match: commentsPath, method: 'POST', json: { id: 8 } },
    ])
    const gateway = createGitHubGateway(config(), stub)

    const stats = await gateway.createInlineComments(TARGET, [target], BOT_ID)

    expect(stats).toEqual({ published: 1, degradedToSummary: 0, failed: 0 })
    expect(stub.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('publishes only the findings a partial publish missed', async () => {
    const landed = finding()
    const missed = finding({ findingId: findingId('f-2'), anchor: anchorAt('src/b.ts', 7) })
    const stub = stubFetch([
      {
        match: commentsPath,
        method: 'GET',
        json: [{ body: `x\n\n<!-- dshrb:key:${publishIdempotencyKey(landed)} -->`, user: { id: 77 } }],
      },
      { match: commentsPath, method: 'POST', json: { id: 3 } },
    ])
    const gateway = createGitHubGateway(config(), stub)

    const stats = await gateway.createInlineComments(TARGET, [landed, missed], BOT_ID)

    expect(stats).toEqual({ published: 1, degradedToSummary: 0, failed: 0 })
    const posts = stub.calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toMatchObject({ path: 'src/b.ts', line: 7 })
  })

  it('embeds a recoverable key in the posted body', async () => {
    const stub = stubFetch([
      { match: commentsPath, method: 'GET', json: [] },
      { match: commentsPath, method: 'POST', json: { id: 4 } },
    ])
    const gateway = createGitHubGateway(config(), stub)
    const target = finding()
    await gateway.createInlineComments(TARGET, [target], BOT_ID)

    const post = stub.calls.find((call) => call.method === 'POST')
    const posted = (post?.body as { body: string } | undefined)?.body
    expect(extractIdempotencyKey(posted)).toBe(publishIdempotencyKey(target))
  })

  it('deduplicates two identical findings inside one batch', async () => {
    const stub = stubFetch([
      { match: commentsPath, method: 'GET', json: [] },
      { match: commentsPath, method: 'POST', json: { id: 5 } },
    ])
    const gateway = createGitHubGateway(config(), stub)

    const stats = await gateway.createInlineComments(TARGET, [finding(), finding()], BOT_ID)

    expect(stats).toEqual({ published: 1, degradedToSummary: 0, failed: 0 })
    expect(stub.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('degrades an unanchored finding to the summary instead of misplacing it', async () => {
    const stub = stubFetch([
      { match: commentsPath, method: 'GET', json: [] },
      { match: commentsPath, method: 'POST', json: { id: 6 } },
    ])
    const gateway = createGitHubGateway(config(), stub)

    const stats = await gateway.createInlineComments(TARGET, [
      finding({ anchor: anchorFallback('src/app.ts', 12, 'outside every hunk') as Anchor }),
    ], BOT_ID)

    expect(stats).toEqual({ published: 0, degradedToSummary: 1, failed: 0 })
    expect(stub.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it('counts a per-finding failure and still publishes the rest', async () => {
    let posts = 0
    const calls: Call[] = []
    const fetch: FetchLike = async (url, init) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url, body: undefined, headers: {} })
      if (method === 'GET') {
        return new Response('[]', { status: 200 })
      }
      posts += 1
      // The first POST fails; the loop must continue rather than abort.
      return posts === 1
        ? new Response('unprocessable', { status: 422 })
        : new Response(JSON.stringify({ id: 7 }), { status: 200 })
    }
    const gateway = createGitHubGateway(config(), { fetch })

    const stats = await gateway.createInlineComments(TARGET, [
      finding(),
      finding({ findingId: findingId('f-2'), anchor: anchorAt('src/b.ts', 3) }),
    ], BOT_ID)

    expect(stats).toEqual({ published: 1, degradedToSummary: 0, failed: 1 })
  })
})

describe('extractIdempotencyKey', () => {
  it('extracts the trailing authoritative key, not an earlier marker in the body', () => {
    const forged = 'a'.repeat(64)
    const real = 'b'.repeat(64)
    const body = `finding quotes <!-- dshrb:key:${forged} --> inline\n\n<!-- dshrb:key:${real} -->`
    expect(extractIdempotencyKey(body)).toBe(real)
  })

  it('ignores a marker buried in prose rather than appended as the authoritative key', () => {
    const body = `note: <!-- dshrb:key:${'a'.repeat(64)} --> is quoted from untrusted content`
    expect(extractIdempotencyKey(body)).toBeUndefined()
  })
})

describe('isFork', () => {
  it('reads head.repo.fork rather than comparing logins', async () => {
    const forked = createGitHubGateway(config(), stubFetch([
      { match: '/pulls/42', json: { head: { repo: { fork: true, owner: { login: 'acme' } } } } },
    ]))
    expect(await forked.isFork(TARGET)).toBe(true)

    const internal = createGitHubGateway(config(), stubFetch([
      { match: '/pulls/42', json: { head: { repo: { fork: false, owner: { login: 'someone' } } } } },
    ]))
    // Same-repo branch opened by a different login is still not a fork.
    expect(await internal.isFork(TARGET)).toBe(false)
  })

  it('treats a deleted head repo as a fork, the safe assumption', async () => {
    for (const head of [{ repo: null }, {}]) {
      const gateway = createGitHubGateway(config(), stubFetch([
        { match: '/pulls/42', json: { head } },
      ]))
      expect(await gateway.isFork(TARGET)).toBe(true)
    }
  })

  it('fails closed to fork when the fork flag is absent', async () => {
    // `fork` absent on a present repo object means the API changed shape; the
    // provider must not silently report "trusted".
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/pulls/42', json: { head: { repo: { owner: { login: 'acme' } } } } },
    ]))
    expect(await gateway.isFork(TARGET)).toBe(true)
  })
})

describe('mapPermission', () => {
  it('maps every documented GitHub tier onto ForgePermission', () => {
    expect(mapPermission('admin')).toBe('admin')
    expect(mapPermission('maintain')).toBe('maintain')
    expect(mapPermission('write')).toBe('write')
    expect(mapPermission('triage')).toBe('triage')
    expect(mapPermission('read')).toBe('read')
    expect(mapPermission('none')).toBe('none')
  })

  it('accepts the push/pull spelling used by some responses and by GHES', () => {
    expect(mapPermission('push')).toBe('write')
    expect(mapPermission('pull')).toBe('read')
  })

  it('normalizes case and surrounding whitespace', () => {
    expect(mapPermission(' ADMIN ')).toBe('admin')
    expect(mapPermission('Write')).toBe('write')
  })

  it('fails closed to none for anything unknown', () => {
    // Over-granting here would hand an unknown actor write capability.
    for (const raw of ['superadmin', '', 'owner', null, undefined, 42, {}, ['admin']]) {
      expect(mapPermission(raw)).toBe('none')
    }
  })

  it('does not inherit a permission from Object.prototype', () => {
    expect(mapPermission('constructor')).toBe('none')
    expect(mapPermission('toString')).toBe('none')
  })
})

describe('resolvePermission', () => {
  it('maps the permission field from the collaborator endpoint', async () => {
    const stub = stubFetch([{ match: '/permission', json: { permission: 'maintain' } }])
    const gateway = createGitHubGateway(config(), stub)
    expect(await gateway.resolvePermission('acme/widgets', 'octocat')).toBe('maintain')
  })

  it('treats 403 and 404 as none, since both mean not a visible collaborator', async () => {
    for (const status of [403, 404]) {
      const gateway = createGitHubGateway(config(), stubFetch([
        { match: '/permission', status, text: 'Not Found' },
      ]))
      expect(await gateway.resolvePermission('acme/widgets', 'stranger')).toBe('none')
    }
  })

  it('propagates a real fault instead of silently downgrading to none', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/permission', status: 500, text: 'boom' },
    ]))
    await expect(gateway.resolvePermission('acme/widgets', 'octocat'))
      .rejects.toThrow(GitHubApiError)
  })

  it('rejects a login that would escape its URL path segment', async () => {
    const stub = stubFetch([{ match: '/permission', json: { permission: 'admin' } }])
    const gateway = createGitHubGateway(config(), stub)
    await expect(gateway.resolvePermission('acme/widgets', '../../orgs/acme'))
      .rejects.toThrow(TypeError)
    expect(stub.calls).toHaveLength(0)
  })

  it('accepts a GitHub App bot login and percent-encodes it in the path', async () => {
    const stub = stubFetch([{ match: '/permission', json: { permission: 'none' } }])
    const gateway = createGitHubGateway(config(), stub)
    expect(await gateway.resolvePermission('acme/widgets', 'dependabot[bot]')).toBe('none')
    expect(stub.calls[0]?.url).toContain('dependabot%5Bbot%5D')
  })
})

describe('findStickyComment', () => {
  const marker = 'summary'
  const body = `${stickyMarker(marker)}\n\nPrevious review.`

  it('returns a comment authored by the bot id and marked on the first line', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/issues/42/comments', json: [{ id: 900, body, user: { id: 77 } }] },
    ]))
    expect(await gateway.findStickyComment(TARGET, marker, '77')).toBe('900')
  })

  it('ignores a forged marker from another author, never updating it', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/issues/42/comments', json: [{ id: 901, body, user: { id: 1234 } }] },
    ]))
    expect(await gateway.findStickyComment(TARGET, marker, '77')).toBeUndefined()
  })

  it('ignores a marker that is not on the first line', async () => {
    const buried = `Looks good to me.\n${stickyMarker(marker)}\ntail`
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/issues/42/comments', json: [{ id: 902, body: buried, user: { id: 77 } }] },
    ]))
    expect(await gateway.findStickyComment(TARGET, marker, '77')).toBeUndefined()
  })

  it('ignores our own unmarked comments', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/issues/42/comments', json: [{ id: 903, body: 'plain note', user: { id: 77 } }] },
    ]))
    expect(await gateway.findStickyComment(TARGET, marker, '77')).toBeUndefined()
  })

  it('does not match a different marker name', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/issues/42/comments', json: [{ id: 904, body, user: { id: 77 } }] },
    ]))
    expect(await gateway.findStickyComment(TARGET, 'other', '77')).toBeUndefined()
  })

  it('skips comments whose author was deleted', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/issues/42/comments', json: [{ id: 905, body, user: null }] },
    ]))
    expect(await gateway.findStickyComment(TARGET, marker, '77')).toBeUndefined()
  })
})

describe('botIdentity', () => {
  it('returns the numeric id, which cannot be renamed', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/user', json: { id: 77, login: 'dsh-reviewer[bot]' } },
    ]))
    expect(await gateway.botIdentity()).toEqual({ id: '77', login: 'dsh-reviewer[bot]' })
  })

  it('throws when the id is missing rather than inventing an identity', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/user', json: { login: 'dsh-reviewer[bot]' } },
    ]))
    await expect(gateway.botIdentity()).rejects.toThrow(TypeError)
  })

  it('falls back to github-actions[bot] when the token is an integration (403 /user)', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/user', status: 403, text: '{"message":"Resource not accessible by integration"}' },
    ]))
    expect(await gateway.botIdentity()).toEqual({ id: '41898282', login: 'github-actions[bot]' })
  })
})

describe('fetchDiff', () => {
  it('parses files and hunks and flags binary blobs', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      {
        match: '/pulls/42/files',
        json: [
          { filename: 'src/app.ts', patch: '@@ -1,2 +1,3 @@\n ctx\n+added' },
          { filename: 'logo.png' },
          { filename: 'src/new.ts', previous_filename: 'src/old.ts', patch: '@@ -3 +3 @@\n-a\n+b' },
        ],
      },
    ]))

    const diff = await gateway.fetchDiff(TARGET)

    expect(diff.files.map((file) => file.path))
      .toEqual(['src/app.ts', 'logo.png', 'src/new.ts'])
    expect(diff.files[0]?.binary).toBe(false)
    expect(diff.files[0]?.hunks[0]).toMatchObject({
      oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
    })
    // GitHub omits `patch` for binaries and oversized files.
    expect(diff.files[1]?.binary).toBe(true)
    expect(diff.files[1]?.hunks).toEqual([])
    expect(diff.files[2]?.previousPath).toBe('src/old.ts')
  })

  it('drops a path that escapes the repo instead of anchoring onto it', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      {
        match: '/pulls/42/files',
        json: [
          { filename: '../../etc/passwd', patch: '@@ -1 +1 @@\n+x' },
          { filename: '/abs/path', patch: '@@ -1 +1 @@\n+x' },
          { filename: 'src/ok.ts', patch: '@@ -1 +1 @@\n+x' },
        ],
      },
    ]))
    const diff = await gateway.fetchDiff(TARGET)
    expect(diff.files.map((file) => file.path)).toEqual(['src/ok.ts'])
  })

  it('rejects a repo that is not owner/name before issuing a request', async () => {
    const stub = stubFetch([{ match: '/files', json: [] }])
    const gateway = createGitHubGateway(config(), stub)
    await expect(gateway.fetchDiff({ ...TARGET, repo: '../../evil' }))
      .rejects.toThrow(TypeError)
    expect(stub.calls).toHaveLength(0)
  })

  it('rejects a non-numeric pull request id', async () => {
    const stub = stubFetch([{ match: '/files', json: [] }])
    const gateway = createGitHubGateway(config(), stub)
    await expect(gateway.fetchDiff({
      ...TARGET,
      changeRequestId: '42/../99' as ReviewTarget['changeRequestId'],
    })).rejects.toThrow(TypeError)
    expect(stub.calls).toHaveLength(0)
  })
})

describe('parseHunks', () => {
  it('defaults an omitted line count to one line, not zero', () => {
    const [hunk] = parseHunks('@@ -3 +4 @@\n-a\n+b')
    expect(hunk).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 4, newLines: 1 })
  })

  it('splits multiple hunks and keeps each hunk text with its header', () => {
    const hunks = parseHunks('@@ -1,2 +1,2 @@\n a\n+b\n@@ -10,1 +11,2 @@\n c\n+d')
    expect(hunks).toHaveLength(2)
    expect(hunks[0]?.text).toBe('@@ -1,2 +1,2 @@\n a\n+b')
    expect(hunks[1]?.text.startsWith('@@ -10,1 +11,2 @@')).toBe(true)
  })

  it('returns nothing for a patch with no hunk header', () => {
    expect(parseHunks('')).toEqual([])
    expect(parseHunks('no header here')).toEqual([])
  })
})

describe('listFailedChecks', () => {
  it('returns only the runs that did not pass', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      {
        match: '/check-runs',
        json: {
          check_runs: [
            { id: 1, name: 'build', conclusion: 'failure' },
            { id: 2, name: 'lint', conclusion: 'success' },
            { id: 3, name: 'e2e', conclusion: 'timed_out' },
            { id: 4, name: 'flaky', conclusion: 'cancelled' },
            { id: 5, name: 'skipped', conclusion: 'neutral' },
            { id: 6, name: 'weird', conclusion: 'unrecognized_value' },
            { id: 7, name: 'running', conclusion: null },
          ],
        },
      },
    ]))

    const failed = await gateway.listFailedChecks('acme/widgets', TARGET.headSha)

    expect(failed.map((run) => run.name)).toEqual(['build', 'e2e', 'flaky'])
    expect(failed[0]).toEqual({ id: '1', name: 'build', conclusion: 'failure' })
  })

  it('tolerates a payload without a check_runs array', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/check-runs', json: { total_count: 0 } },
    ]))
    expect(await gateway.listFailedChecks('acme/widgets', TARGET.headSha)).toEqual([])
  })
})

describe('fetchLog', () => {
  it('returns the job log text', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/actions/jobs/55/logs', text: 'line one\nline two' },
    ]))
    expect(await gateway.fetchLog('acme/widgets', '55')).toBe('line one\nline two')
  })

  it('rejects a non-numeric check id before issuing a request', async () => {
    const stub = stubFetch([{ match: '/logs', text: '' }])
    const gateway = createGitHubGateway(config(), stub)
    await expect(gateway.fetchLog('acme/widgets', '55/../../secrets'))
      .rejects.toThrow(TypeError)
    expect(stub.calls).toHaveLength(0)
  })
})

describe('fetchFile', () => {
  it('requests the raw blob at the given ref', async () => {
    const stub = stubFetch([{ match: '/contents/', text: 'file body' }])
    const gateway = createGitHubGateway(config(), stub)

    const content = await gateway.fetchFile('acme/widgets', 'src/app.ts', TARGET.headSha)

    expect(content).toBe('file body')
    const [call] = stub.calls
    expect(call?.url).toContain('/repos/acme/widgets/contents/src/app.ts')
    expect(call?.url).toContain(`ref=${TARGET.headSha}`)
    // The JSON form would need a base64 round-trip and caps at 1MB.
    expect(call?.headers.accept).toBe('application/vnd.github.raw')
  })

  it('rejects a traversal path before issuing a request', async () => {
    const stub = stubFetch([{ match: '/contents/', text: '' }])
    const gateway = createGitHubGateway(config(), stub)
    await expect(gateway.fetchFile('acme/widgets', '../../../etc/passwd', TARGET.headSha))
      .rejects.toThrow(TypeError)
    expect(stub.calls).toHaveLength(0)
  })
})

describe('comment sink routing', () => {
  it('creates a summary comment on the issue thread', async () => {
    const stub = stubFetch([
      { match: '/issues/42/comments', method: 'POST', json: { id: 555 } },
    ])
    const gateway = createGitHubGateway(config(), stub)

    expect(await gateway.createComment(TARGET, 'hello')).toBe('555')
    expect(stub.calls[0]?.body).toEqual({ body: 'hello' })
  })

  it('updates an existing comment by id', async () => {
    const stub = stubFetch([
      { match: '/issues/comments/555', method: 'PATCH', json: {} },
    ])
    const gateway = createGitHubGateway(config(), stub)

    await gateway.updateComment('acme/widgets', '555' as Parameters<typeof gateway.updateComment>[1], 'revised')

    expect(stub.calls[0]?.method).toBe('PATCH')
    expect(stub.calls[0]?.url).toContain('/repos/acme/widgets/issues/comments/555')
    expect(stub.calls[0]?.body).toEqual({ body: 'revised' })
  })
})

describe('transport', () => {
  it('honors baseUrl so GitHub Enterprise Server works', async () => {
    const stub = stubFetch([{ match: '/user', json: { id: 5, login: 'bot' } }])
    const gateway = createGitHubGateway(
      config({ baseUrl: 'https://ghe.corp.example/api/v3/' }),
      stub,
    )
    await gateway.botIdentity()
    // Trailing slash trimmed, so no double slash in the path.
    expect(stub.calls[0]?.url).toBe('https://ghe.corp.example/api/v3/user')
  })

  it('sends the credential as a bearer token with the pinned API version', async () => {
    const stub = stubFetch([{ match: '/user', json: { id: 5, login: 'bot' } }])
    const gateway = createGitHubGateway(config(), stub)
    await gateway.botIdentity()
    expect(stub.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(stub.calls[0]?.headers['x-github-api-version']).toBe('2022-11-28')
  })

  it('never puts the token in an error message', async () => {
    const gateway = createGitHubGateway(config(), stubFetch([
      { match: '/user', status: 401, text: 'Bad credentials' },
    ]))
    const error = await gateway.botIdentity().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitHubApiError)
    const serialized = `${String((error as Error).message)}${JSON.stringify(error)}`
    expect(serialized).not.toContain(TOKEN)
    expect((error as GitHubApiError).status).toBe(401)
  })

  it('stops paginating on a short page', async () => {
    const stub = stubFetch([{ match: '/pulls/42/files', json: [{ filename: 'a.ts' }] }])
    const gateway = createGitHubGateway(config(), stub)
    await gateway.fetchDiff(TARGET)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.url).toContain('per_page=100')
  })
})

describe('mutation sink', () => {
  it('creates a commit with a new file when the base file is missing', async () => {
    const stub = stubFetch([
      { match: '/commits/main', json: { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } } },
      { match: '/contents/src/app.ts', status: 404, text: 'Not Found' },
      { match: '/git/blobs', method: 'POST', json: { sha: 'c'.repeat(40) } },
      { match: '/git/trees', method: 'POST', json: { sha: 'd'.repeat(40) } },
      { match: '/git/commits', method: 'POST', json: { sha: 'e'.repeat(40) } },
      { match: '/git/refs', method: 'POST', json: {} },
      { match: '/repos/acme/widgets', json: { default_branch: 'main' } },
    ])
    const gateway = createGitHubGateway(config(), stub)

    const sha = await gateway.commitPatches('acme/widgets', 'fix/1', [
      { path: 'src/app.ts', diff: '@@ -0,0 +1,2 @@\n+hello\n+world' },
    ], 'apply suggestions')

    expect(sha).toBe('e'.repeat(40))
    const treePost = stub.calls.find((call) => call.url.includes('/git/trees'))
    expect(treePost?.body).toMatchObject({
      base_tree: 'b'.repeat(40),
      tree: [{ path: 'src/app.ts', mode: '100644', type: 'blob', sha: 'c'.repeat(40) }],
    })
    const commitPost = stub.calls.find((call) => call.url.includes('/git/commits'))
    expect(commitPost?.body).toMatchObject({
      message: 'apply suggestions', tree: 'd'.repeat(40), parents: ['a'.repeat(40)],
    })
    const refPost = stub.calls.find((call) => call.url.includes('/git/refs'))
    expect(refPost?.body).toMatchObject({ ref: 'refs/heads/fix/1', sha: 'e'.repeat(40) })
  })

  it('updates an existing file by applying the diff to its base content', async () => {
    const stub = stubFetch([
      { match: '/commits/main', json: { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } } },
      { match: '/contents/src/app.ts', text: 'aaa\nccc\n' },
      { match: '/git/blobs', method: 'POST', json: { sha: 'c'.repeat(40) } },
      { match: '/git/trees', method: 'POST', json: { sha: 'd'.repeat(40) } },
      { match: '/git/commits', method: 'POST', json: { sha: 'e'.repeat(40) } },
      { match: '/git/refs', method: 'POST', json: {} },
      { match: '/repos/acme/widgets', json: { default_branch: 'main' } },
    ])
    const gateway = createGitHubGateway(config(), stub)
    await gateway.commitPatches('acme/widgets', 'fix/1', [
      { path: 'src/app.ts', diff: '@@ -1,2 +1,2 @@\n-aaa\n+bbb' },
    ], 'apply suggestions')
    const blobPost = stub.calls.find((call) => call.url.includes('/git/blobs'))
    expect(blobPost?.body).toMatchObject({ content: 'bbb\nccc\n', encoding: 'utf-8' })
  })

  it('folds multiple patches on the same file into one cumulative tree entry', async () => {
    const stub = stubFetch([
      { match: '/commits/main', json: { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } } },
      { match: '/contents/src/app.ts', text: 'aaa\nbbb\n' },
      { match: '/git/blobs', method: 'POST', json: { sha: 'c'.repeat(40) } },
      { match: '/git/trees', method: 'POST', json: { sha: 'd'.repeat(40) } },
      { match: '/git/commits', method: 'POST', json: { sha: 'e'.repeat(40) } },
      { match: '/git/refs', method: 'POST', json: {} },
      { match: '/repos/acme/widgets', json: { default_branch: 'main' } },
    ])
    const gateway = createGitHubGateway(config(), stub)
    await gateway.commitPatches('acme/widgets', 'fix/1', [
      { path: 'src/app.ts', diff: '@@ -1,1 +1,1 @@\n-aaa\n+AAA' },
      { path: 'src/app.ts', diff: '@@ -2,1 +2,1 @@\n-bbb\n+BBB' },
    ], 'apply suggestions')
    // One blob, one tree entry — never duplicate entries for the same path.
    expect(stub.calls.filter((call) => call.url.includes('/git/blobs'))).toHaveLength(1)
    const treePost = stub.calls.find((call) => call.url.includes('/git/trees'))
    expect(treePost?.body).toMatchObject({ tree: [{ path: 'src/app.ts' }] })
  })

  it('rejects a patch that does not line up with the base content before creating a blob', async () => {
    const stub = stubFetch([
      { match: '/commits/main', json: { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } } },
      { match: '/contents/src/app.ts', text: 'zzz\n' },
      { match: '/git/blobs', method: 'POST', json: { sha: 'c'.repeat(40) } },
      { match: '/repos/acme/widgets', json: { default_branch: 'main' } },
    ])
    const gateway = createGitHubGateway(config(), stub)
    await expect(gateway.commitPatches('acme/widgets', 'fix/1', [
      { path: 'src/app.ts', diff: '@@ -1,1 +1,1 @@\n-aaa\n+bbb' },
    ], 'apply suggestions')).rejects.toThrow(/does not apply/)
    expect(stub.calls.filter((call) => call.url.includes('/git/blobs'))).toHaveLength(0)
  })

  it('rejects an empty patch set before issuing any request', async () => {
    const stub = stubFetch([])
    const gateway = createGitHubGateway(config(), stub)
    await expect(gateway.commitPatches('acme/widgets', 'fix/1', [], 'msg'))
      .rejects.toThrow(/received no patches/)
    expect(stub.calls).toHaveLength(0)
  })

  it('opens a pull request from head to base branch', async () => {
    const stub = stubFetch([
      { match: '/pulls', method: 'POST', json: { html_url: 'https://github.com/acme/widgets/pull/12' } },
    ])
    const gateway = createGitHubGateway(config(), stub)
    const url = await gateway.openPullRequest({
      repo: 'acme/widgets', headBranch: 'fix/1', baseBranch: 'main', title: 't', body: 'b',
    })
    expect(url).toBe('https://github.com/acme/widgets/pull/12')
    expect(stub.calls[0]?.body).toMatchObject({ head: 'fix/1', base: 'main', title: 't', body: 'b' })
  })
})

describe('applyPatch', () => {
  it('applies a replace hunk and a pure insertion', () => {
    expect(applyPatch('aaa\nccc\n', '@@ -1,2 +1,2 @@\n-aaa\n+bbb')).toEqual({
      ok: true, content: 'bbb\nccc\n',
    })
    expect(applyPatch('', '@@ -0,0 +1,2 @@\n+hello\n+world')).toEqual({
      ok: true, content: 'hello\nworld\n',
    })
  })

  it('fails when a hunk does not line up with the content', () => {
    const result = applyPatch('zzz\n', '@@ -1,1 +1,1 @@\n-aaa\n+bbb')
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Shared provider conformance suite
// ---------------------------------------------------------------------------

const githubConformanceFactory: ConformanceFactory = (ctx) => {
  const routes: Route[] = []

  switch (ctx.scenario) {
    case 'diff-source':
      routes.push(
        {
          match: '/pulls/42/files',
          json: [
            { filename: 'src/app.ts', patch: '@@ -1,2 +1,3 @@\n ctx\n+added' },
            { filename: 'logo.png' },
          ],
        },
        { match: '/contents/src/app.ts', text: 'file body' },
      )
      break
    case 'comment-sink':
      routes.push(
        { match: '/issues/42/comments', method: 'POST', json: { id: 555 } },
        { match: '/issues/comments/555', method: 'PATCH', json: {} },
      )
      break
    case 'inline-publish':
      routes.push(
        { match: '/pulls/42/comments', method: 'GET', json: [] },
        { match: '/pulls/42/comments', method: 'POST', json: { id: 1 } },
      )
      break
    case 'sticky-found':
      routes.push(
        {
          match: '/issues/42/comments',
          json: [{ id: 900, body: `${stickyMarker(ctx.marker)}\n\nprev`, user: { id: Number(ctx.botId) } }],
        },
      )
      break
    case 'sticky-forged':
      routes.push(
        {
          match: '/issues/42/comments',
          json: [
            { id: 901, body: `${stickyMarker(ctx.marker)}\n\nforged`, user: { id: 1234 } },
            { id: 902, body: 'plain note', user: { id: Number(ctx.botId) } },
          ],
        },
      )
      break
    case 'actor':
      routes.push(
        { match: '/collaborators/conformance-actor/permission', json: { permission: 'maintain' } },
        { match: '/user', json: { id: 77, login: 'dsh-reviewer[bot]' } },
        { match: '/pulls/42', json: { head: { repo: { fork: true } } } },
      )
      break
    case 'checks':
      routes.push(
        {
          match: '/check-runs',
          json: {
            check_runs: [
              { id: 1, name: 'build', conclusion: 'failure' },
              { id: 2, name: 'lint', conclusion: 'success' },
            ],
          },
        },
      )
      break
    case 'log':
      routes.push({ match: '/actions/jobs/123/logs', text: 'log line' })
      break
    case 'mutation':
      routes.push(
        { match: '/commits/main', json: { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } } },
        { match: '/contents/src/app.ts', status: 404, text: 'Not Found' },
        { match: '/git/blobs', method: 'POST', json: { sha: 'c'.repeat(40) } },
        { match: '/git/trees', method: 'POST', json: { sha: 'd'.repeat(40) } },
        { match: '/git/commits', method: 'POST', json: { sha: 'e'.repeat(40) } },
        { match: '/git/refs', method: 'POST', json: {} },
        { match: '/pulls', method: 'POST', json: { html_url: 'https://github.com/acme/widgets/pull/12' } },
        { match: '/repos/acme/widgets', json: { default_branch: 'main' } },
      )
      break
    default:
      throw new Error(`unexpected scenario ${ctx.scenario}`)
  }

  return createGitHubGateway(config(), stubFetch(routes))
}

describe('forge conformance', () => {
  const cases = runForgeConformance(githubConformanceFactory, {
    capabilities: CAPABILITIES,
    target: TARGET,
    botId: BOT_ID,
    marker: 'summary',
  })

  for (const testCase of cases) {
    it(`${testCase.group} · ${testCase.name}`, testCase.run)
  }
})
