import { describe, expect, it } from 'vitest'
import {
  anchorAt, anchorFallback, changeRequestId, commitSha, findingId, ruleId,
} from '@dshrb/review-core'
import type { Anchor, Finding, ReviewTarget } from '@dshrb/review-core'
import { publishIdempotencyKey, runForgeConformance } from '@dshrb/forge'
import type { ConformanceFactory } from '@dshrb/forge'
import {
  CAPABILITIES, GitLabApiError, applyPatch, createGitLabGateway,
  mapAccessLevel, normalizeMergeRequest, parseHunks, stickyMarker, verifyGitLabToken,
} from '../src/index.ts'
import type { Config, FetchLike } from '../src/index.ts'

/**
 * Every test drives the provider through a stubbed `fetch`. Nothing here reaches
 * the network: a live call would depend on a GitLab token and the state of a
 * real merge request.
 */

const TOKEN = 'glpat-test-token-never-logged'

function config(overrides: Partial<Config> = {}): Config {
  return { token: TOKEN, baseUrl: 'https://gitlab.com/api/v4', ...overrides }
}

const TARGET: ReviewTarget = {
  repo: 'acme/widgets',
  changeRequestId: changeRequestId('7'),
  baseSha: commitSha('a'.repeat(40)),
  headSha: commitSha('b'.repeat(40)),
  isFork: false,
}

const BOT_ID = '77'
const DIFF_REFS = {
  base_sha: 'c'.repeat(40),
  head_sha: TARGET.headSha,
  start_sha: 'd'.repeat(40),
}

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

interface GitLabPosition {
  readonly base_sha?: string
  readonly head_sha?: string
  readonly start_sha?: string
  readonly old_path?: string
  readonly new_path?: string
  readonly old_line?: number | null
  readonly new_line?: number | null
  readonly position_type?: string
}

interface CommitAction {
  readonly action: string
  readonly file_path: string
  readonly content: string
}

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
    severity: 'major',
    title: 'Unchecked index',
    body: 'This dereferences past the end of the array.',
    anchor: anchorAt('src/app.ts', 12),
    ruleId: ruleId('no-oob'),
    ...overrides,
  }
}

describe('capability advertisement', () => {
  it('advertises all seven forge capabilities', () => {
    expect([...CAPABILITIES].sort()).toEqual([
      'actor-resolver', 'check-reader', 'comment-sink', 'diff-source',
      'inline-comments', 'mutation-sink', 'sticky-comment',
    ])
    const gateway = createGitLabGateway(config(), stubFetch([]))
    expect(gateway.id).toBe('gitlab')
    expect(gateway.capabilities).toEqual(CAPABILITIES)
  })
})

describe('iid regression (docs/06:100)', () => {
  it('normalizes a payload with id != iid onto the iid only', () => {
    const normalized = normalizeMergeRequest({
      project: { path_with_namespace: 'acme/widgets' },
      object_attributes: {
        id: 99991,
        iid: 7,
        source_project_id: 100,
        target_project_id: 200,
      },
    })
    expect(normalized.changeRequestId).toBe('7')
    expect(normalized.isFork).toBe(true)
    expect(normalized.repo).toBe('acme/widgets')
  })

  it('routes every iid-consuming API call through the iid path segment, never the id', async () => {
    const stub = stubFetch([
      { match: '/merge_requests/7/changes', json: { changes: [] } },
    ])
    const gateway = createGitLabGateway(config(), stub)
    await gateway.fetchDiff(TARGET)
    // The provider never saw the global id (99991) — it only ever used the iid.
    expect(stub.calls[0]?.url).toContain('/projects/acme%2Fwidgets/merge_requests/7/changes')
    expect(JSON.stringify(stub.calls)).not.toContain('99991')
  })

  it('rejects a payload that has an id but no iid instead of falling back', () => {
    expect(() => normalizeMergeRequest({
      project: { path_with_namespace: 'acme/widgets' },
      object_attributes: { id: 99991, source_project_id: 100, target_project_id: 100 },
    })).toThrow(/iid/)
  })

  it('keeps the global id out of the domain layer entirely', () => {
    // The global id is present in the payload, but the normalized result carries
    // only the iid — asserting `id` never leaks into `ChangeRequestId`.
    const normalized = normalizeMergeRequest({
      project: { path_with_namespace: 'acme/widgets' },
      object_attributes: { id: 99991, iid: 7, source_project_id: 100, target_project_id: 100 },
    })
    expect(JSON.stringify(normalized)).not.toContain('99991')
    expect(normalized.changeRequestId).toBe('7')
  })
})

describe('normalizeMergeRequest', () => {
  it('compares source_project_id against target_project_id for isFork', () => {
    const internal = normalizeMergeRequest({
      project: { path_with_namespace: 'acme/widgets' },
      object_attributes: { iid: 7, source_project_id: 100, target_project_id: 100 },
    })
    expect(internal.isFork).toBe(false)

    const forked = normalizeMergeRequest({
      project: { path_with_namespace: 'acme/widgets' },
      object_attributes: { iid: 7, source_project_id: 200, target_project_id: 100 },
    })
    expect(forked.isFork).toBe(true)
  })

  it('fails closed to fork when the project ids are missing', () => {
    const normalized = normalizeMergeRequest({
      project: { path_with_namespace: 'acme/widgets' },
      object_attributes: { iid: 7 },
    })
    expect(normalized.isFork).toBe(true)
  })
})

describe('verifyGitLabToken', () => {
  it('accepts an exact match and rejects any difference', () => {
    expect(verifyGitLabToken('secret', 'secret')).toBe(true)
    expect(verifyGitLabToken('secret', 'Secret')).toBe(false)
    expect(verifyGitLabToken('secret', 'secret ')).toBe(false)
    expect(verifyGitLabToken('secret', 'secret-longer')).toBe(false)
  })

  it('rejects empty credentials', () => {
    expect(verifyGitLabToken('', 'secret')).toBe(false)
    expect(verifyGitLabToken('secret', '')).toBe(false)
  })
})

describe('mapAccessLevel', () => {
  it('maps numeric access_level onto the ForgePermission vocabulary', () => {
    expect(mapAccessLevel(50)).toBe('admin')
    expect(mapAccessLevel(40)).toBe('maintain')
    expect(mapAccessLevel(30)).toBe('write')
    expect(mapAccessLevel(20)).toBe('read')
    expect(mapAccessLevel(10)).toBe('read')
    expect(mapAccessLevel(5)).toBe('none')
    expect(mapAccessLevel(0)).toBe('none')
  })

  it('fails closed to none for anything unknown', () => {
    for (const raw of [42, -1, 1.5, '30', null, undefined, NaN]) {
      expect(mapAccessLevel(raw)).toBe('none')
    }
  })
})

describe('fetchDiff', () => {
  it('parses changes into safe paths, hunks and binary flags', async () => {
    const gateway = createGitLabGateway(config(), stubFetch([
      {
        match: '/merge_requests/7/changes',
        json: {
          changes: [
            { new_path: 'src/app.ts', old_path: 'src/app.ts', diff: '@@ -1,2 +1,3 @@\n ctx\n+added' },
            { new_path: 'logo.png', old_path: 'logo.png', diff: '' },
            { new_path: 'src/new.ts', old_path: 'src/old.ts', diff: '@@ -3 +3 @@\n-a\n+b' },
          ],
        },
      },
    ]))

    const diff = await gateway.fetchDiff(TARGET)

    expect(diff.files.map((file) => file.path)).toEqual(['src/app.ts', 'logo.png', 'src/new.ts'])
    expect(diff.files[0]?.binary).toBe(false)
    expect(diff.files[0]?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3 })
    expect(diff.files[1]?.binary).toBe(true)
    expect(diff.files[1]?.hunks).toEqual([])
    expect(diff.files[2]?.previousPath).toBe('src/old.ts')
  })

  it('drops a path that escapes the repo', async () => {
    const gateway = createGitLabGateway(config(), stubFetch([
      {
        match: '/changes',
        json: {
          changes: [
            { new_path: '../../etc/passwd', diff: '@@ -1 +1 @@\n+x' },
            { new_path: 'src/ok.ts', diff: '@@ -1 +1 @@\n+x' },
          ],
        },
      },
    ]))
    const diff = await gateway.fetchDiff(TARGET)
    expect(diff.files.map((file) => file.path)).toEqual(['src/ok.ts'])
  })
})

describe('parseHunks', () => {
  it('defaults an omitted line count to one line', () => {
    const [hunk] = parseHunks('@@ -3 +4 @@\n-a\n+b')
    expect(hunk).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 4, newLines: 1 })
  })
})

describe('fetchFile', () => {
  it('requests the raw blob at the given ref with the path percent-encoded', async () => {
    const stub = stubFetch([{ match: '/repository/files/src%2Fapp.ts/raw', text: 'file body' }])
    const gateway = createGitLabGateway(config(), stub)
    const content = await gateway.fetchFile('acme/widgets', 'src/app.ts', TARGET.headSha)
    expect(content).toBe('file body')
    expect(stub.calls[0]?.url).toContain('/projects/acme%2Fwidgets/repository/files/src%2Fapp.ts/raw')
    expect(stub.calls[0]?.url).toContain(`ref=${TARGET.headSha}`)
  })

  it('rejects a traversal path before issuing a request', async () => {
    const stub = stubFetch([{ match: '/raw', text: '' }])
    const gateway = createGitLabGateway(config(), stub)
    await expect(gateway.fetchFile('acme/widgets', '../../../etc/passwd', TARGET.headSha))
      .rejects.toThrow(TypeError)
    expect(stub.calls).toHaveLength(0)
  })
})

describe('comment sink', () => {
  it('creates a summary note and returns an iid-prefixed id', async () => {
    const stub = stubFetch([
      { match: '/merge_requests/7/notes', method: 'POST', json: { id: 555 } },
    ])
    const gateway = createGitLabGateway(config(), stub)
    expect(await gateway.createComment(TARGET, 'hello')).toBe('7:555')
    expect(stub.calls[0]?.body).toEqual({ body: 'hello' })
  })

  it('updates a note by its iid-prefixed id', async () => {
    const stub = stubFetch([
      { match: '/merge_requests/7/notes/555', method: 'PUT', json: {} },
    ])
    const gateway = createGitLabGateway(config(), stub)
    await gateway.updateComment('acme/widgets', '7:555' as Parameters<typeof gateway.updateComment>[1], 'revised')
    expect(stub.calls[0]?.method).toBe('PUT')
    expect(stub.calls[0]?.url).toContain('/projects/acme%2Fwidgets/merge_requests/7/notes/555')
    expect(stub.calls[0]?.body).toEqual({ body: 'revised' })
  })

  it('rejects a comment id that does not carry its iid', async () => {
    const gateway = createGitLabGateway(config(), stubFetch([]))
    await expect(gateway.updateComment('acme/widgets', '555' as Parameters<typeof gateway.updateComment>[1], 'x'))
      .rejects.toThrow(/iid.*noteId/)
  })
})

describe('createInlineComments', () => {
  it('posts an anchored note with position built from diff_refs, not the head sha', async () => {
    const stub = stubFetch([
      { match: '/merge_requests/7/notes', method: 'GET', json: [] },
      { match: '/merge_requests/7/notes', method: 'POST', json: { id: 1 } },
      { match: '/merge_requests/7', method: 'GET', json: { diff_refs: DIFF_REFS } },
    ])
    const gateway = createGitLabGateway(config(), stub)

    const stats = await gateway.createInlineComments(TARGET, [finding()], BOT_ID)

    expect(stats).toEqual({ published: 1, degradedToSummary: 0, failed: 0 })
    const post = stub.calls.find((call) => call.method === 'POST')
    expect(post?.body).toMatchObject({
      position: {
        base_sha: DIFF_REFS.base_sha,
        head_sha: DIFF_REFS.head_sha,
        start_sha: DIFF_REFS.start_sha,
        new_path: 'src/app.ts',
        new_line: 12,
        position_type: 'text',
      },
    })
    // The head sha is the real head, but the three position SHAs must be the
    // diff_refs triple — asserting the base/start sha are NOT the head sha.
    const position = (post?.body as { position?: GitLabPosition } | undefined)?.position
    expect(position?.base_sha).toBe(DIFF_REFS.base_sha)
    expect(position?.start_sha).toBe(DIFF_REFS.start_sha)
  })

  it('maps a left-side anchor onto old_path + old_line', async () => {
    const stub = stubFetch([
      { match: '/merge_requests/7/notes', method: 'GET', json: [] },
      { match: '/merge_requests/7/notes', method: 'POST', json: { id: 1 } },
      { match: '/merge_requests/7', method: 'GET', json: { diff_refs: DIFF_REFS } },
    ])
    const gateway = createGitLabGateway(config(), stub)
    await gateway.createInlineComments(TARGET, [
      finding({ anchor: anchorAt('src/app.ts', 4, 'left') }),
    ], BOT_ID)
    const post = stub.calls.find((call) => call.method === 'POST')
    const position = (post?.body as { position?: GitLabPosition } | undefined)?.position
    expect(position).toMatchObject({ old_path: 'src/app.ts', old_line: 4 })
  })

  it('degrades an unanchored finding to the summary instead of misplacing it', async () => {
    const stub = stubFetch([
      { match: '/merge_requests/7/notes', method: 'GET', json: [] },
      { match: '/merge_requests/7/notes', method: 'POST', json: { id: 2 } },
      { match: '/merge_requests/7', method: 'GET', json: { diff_refs: DIFF_REFS } },
    ])
    const gateway = createGitLabGateway(config(), stub)
    const stats = await gateway.createInlineComments(TARGET, [
      finding({ anchor: anchorFallback('src/app.ts', 99, 'outside every hunk') as Anchor }),
    ], BOT_ID)
    expect(stats).toEqual({ published: 0, degradedToSummary: 1, failed: 0 })
    expect(stub.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it('does not duplicate a comment on a retry after a partial publish', async () => {
    const already = finding()
    const key = publishIdempotencyKey(already)
    const stub = stubFetch([
      {
        match: '/merge_requests/7/notes',
        method: 'GET',
        json: [{ body: `**major**: x\n\n<!-- dshrb:key:${key} -->`, author: { id: 77 } }],
      },
      { match: '/merge_requests/7/notes', method: 'POST', json: { id: 3 } },
      { match: '/merge_requests/7', method: 'GET', json: { diff_refs: DIFF_REFS } },
    ])
    const gateway = createGitLabGateway(config(), stub)
    const stats = await gateway.createInlineComments(TARGET, [already], BOT_ID)
    expect(stats).toEqual({ published: 0, degradedToSummary: 0, failed: 0 })
    expect(stub.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it('ignores a forged key from another author', async () => {
    const target = finding()
    const key = publishIdempotencyKey(target)
    const stub = stubFetch([
      {
        match: '/merge_requests/7/notes',
        method: 'GET',
        json: [{ body: `forged\n\n<!-- dshrb:key:${key} -->`, author: { id: 1234 } }],
      },
      { match: '/merge_requests/7/notes', method: 'POST', json: { id: 4 } },
      { match: '/merge_requests/7', method: 'GET', json: { diff_refs: DIFF_REFS } },
    ])
    const gateway = createGitLabGateway(config(), stub)
    const stats = await gateway.createInlineComments(TARGET, [target], BOT_ID)
    expect(stats).toEqual({ published: 1, degradedToSummary: 0, failed: 0 })
  })

  it('throws explicitly when diff_refs is missing rather than fabricating a sha', async () => {
    const stub = stubFetch([
      { match: '/merge_requests/7/notes', method: 'GET', json: [] },
      { match: '/merge_requests/7', method: 'GET', json: {} },
    ])
    const gateway = createGitLabGateway(config(), stub)
    await expect(gateway.createInlineComments(TARGET, [finding()], BOT_ID))
      .rejects.toThrow(/diff_refs/)
  })

  it('degrades unanchored findings to the summary even when diff_refs is absent', async () => {
    const stub = stubFetch([
      { match: '/merge_requests/7/notes', method: 'GET', json: [] },
      { match: '/merge_requests/7', method: 'GET', json: {} },
    ])
    const gateway = createGitLabGateway(config(), stub)
    const stats = await gateway.createInlineComments(TARGET, [
      finding({ anchor: anchorFallback('src/app.ts', 99, 'outside every hunk') as Anchor }),
    ], BOT_ID)
    expect(stats).toEqual({ published: 0, degradedToSummary: 1, failed: 0 })
    // An unanchored finding needs no position, so the diff_refs lookup is never issued.
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.url).toContain('/merge_requests/7/notes')
  })
})

describe('findStickyComment', () => {
  const marker = 'summary'
  const body = `${stickyMarker(marker)}\n\nPrevious review.`

  it('returns the bot-authored note carrying the marker on the first line', async () => {
    const gateway = createGitLabGateway(config(), stubFetch([
      { match: '/merge_requests/7/notes', json: [{ id: 900, body, author: { id: 77 } }] },
    ]))
    expect(await gateway.findStickyComment(TARGET, marker, '77')).toBe('7:900')
  })

  it('ignores a forged marker from another author', async () => {
    const gateway = createGitLabGateway(config(), stubFetch([
      { match: '/merge_requests/7/notes', json: [{ id: 901, body, author: { id: 1234 } }] },
    ]))
    expect(await gateway.findStickyComment(TARGET, marker, '77')).toBeUndefined()
  })

  it('ignores a marker that is not on the first line', async () => {
    const buried = `Looks good.\n${stickyMarker(marker)}\ntail`
    const gateway = createGitLabGateway(config(), stubFetch([
      { match: '/merge_requests/7/notes', json: [{ id: 902, body: buried, author: { id: 77 } }] },
    ]))
    expect(await gateway.findStickyComment(TARGET, marker, '77')).toBeUndefined()
  })
})

describe('actor resolver', () => {
  it('resolves a login to a user id then maps access_level', async () => {
    const stub = stubFetch([
      { match: '/users?username=octocat', json: [{ id: 44 }] },
      { match: '/members/44', json: { access_level: 40 } },
    ])
    const gateway = createGitLabGateway(config(), stub)
    expect(await gateway.resolvePermission('acme/widgets', 'octocat')).toBe('maintain')
  })

  it('treats 404 and 403 as none', async () => {
    for (const status of [403, 404]) {
      const gateway = createGitLabGateway(config(), stubFetch([
        { match: '/users?username=stranger', json: [{ id: 45 }] },
        { match: '/members/45', status, text: 'Not Found' },
      ]))
      expect(await gateway.resolvePermission('acme/widgets', 'stranger')).toBe('none')
    }
  })

  it('returns the numeric id as identity', async () => {
    const gateway = createGitLabGateway(config(), stubFetch([
      { match: '/user', json: { id: 77, username: 'dsh-reviewer' } },
    ]))
    expect(await gateway.botIdentity()).toEqual({ id: '77', login: 'dsh-reviewer' })
  })

  it('reads isFork from source vs target project id', async () => {
    const forked = createGitLabGateway(config(), stubFetch([
      { match: '/merge_requests/7', json: { source_project_id: 200, target_project_id: 100 } },
    ]))
    expect(await forked.isFork(TARGET)).toBe(true)

    const internal = createGitLabGateway(config(), stubFetch([
      { match: '/merge_requests/7', json: { source_project_id: 100, target_project_id: 100 } },
    ]))
    expect(await internal.isFork(TARGET)).toBe(false)
  })
})

describe('check reader', () => {
  it('maps failed pipelines to their failed jobs', async () => {
    const stub = stubFetch([
      { match: '/pipelines?sha=', json: [{ id: 10, status: 'failed' }, { id: 11, status: 'success' }] },
      { match: '/pipelines/10/jobs', json: [
        { id: 1, name: 'build', status: 'failed' },
        { id: 2, name: 'lint', status: 'success' },
        { id: 3, name: 'e2e', status: 'canceled' },
      ] },
    ])
    const gateway = createGitLabGateway(config(), stub)
    const failed = await gateway.listFailedChecks('acme/widgets', TARGET.headSha)
    expect(failed.map((run) => run.name)).toEqual(['build', 'e2e'])
    expect(failed[0]).toEqual({ id: '1', name: 'build', conclusion: 'failure' })
  })

  it('returns the job trace as text', async () => {
    const gateway = createGitLabGateway(config(), stubFetch([
      { match: '/jobs/55/trace', text: 'line one\nline two' },
    ]))
    expect(await gateway.fetchLog('acme/widgets', '55')).toBe('line one\nline two')
  })
})

describe('mutation sink', () => {
  it('creates a new file action for a patch on a missing base file', async () => {
    const stub = stubFetch([
      { match: '/repository/files/src%2Fapp.ts/raw', status: 404, text: 'Not Found' },
      { match: '/repository/commits', method: 'POST', json: { id: 'e'.repeat(40) } },
      { match: '/projects/acme%2Fwidgets', json: { default_branch: 'main' } },
    ])
    const gateway = createGitLabGateway(config(), stub)
    const sha = await gateway.commitPatches('acme/widgets', 'fix/1', [
      { path: 'src/app.ts', diff: '@@ -0,0 +1,2 @@\n+hello\n+world' },
    ], 'apply suggestions')
    expect(sha).toBe('e'.repeat(40))
    const post = stub.calls.find((call) => call.method === 'POST')
    expect(post?.body).toMatchObject({
      branch: 'fix/1',
      start_branch: 'main',
      actions: [{ action: 'create', file_path: 'src/app.ts', content: 'hello\nworld\n' }],
    })
  })

  it('updates an existing file by applying the diff to its base content', async () => {
    const stub = stubFetch([
      { match: '/repository/files/src%2Fapp.ts/raw', text: 'aaa\nccc\n' },
      { match: '/repository/commits', method: 'POST', json: { id: 'f'.repeat(40) } },
      { match: '/projects/acme%2Fwidgets', json: { default_branch: 'main' } },
    ])
    const gateway = createGitLabGateway(config(), stub)
    await gateway.commitPatches('acme/widgets', 'fix/1', [
      { path: 'src/app.ts', diff: '@@ -1,2 +1,2 @@\n-aaa\n+bbb' },
    ], 'apply suggestions')
    const post = stub.calls.find((call) => call.method === 'POST')
    const actions = (post?.body as { actions?: readonly CommitAction[] } | undefined)?.actions
    expect(actions).toEqual([
      { action: 'update', file_path: 'src/app.ts', content: 'bbb\nccc\n' },
    ])
  })

  it('folds multiple patches on the same file into one cumulative action', async () => {
    const stub = stubFetch([
      { match: '/repository/files/src%2Fapp.ts/raw', text: 'aaa\nbbb\n' },
      { match: '/repository/commits', method: 'POST', json: { id: 'a'.repeat(40) } },
      { match: '/projects/acme%2Fwidgets', json: { default_branch: 'main' } },
    ])
    const gateway = createGitLabGateway(config(), stub)
    await gateway.commitPatches('acme/widgets', 'fix/1', [
      { path: 'src/app.ts', diff: '@@ -1,1 +1,1 @@\n-aaa\n+AAA' },
      { path: 'src/app.ts', diff: '@@ -2,1 +2,1 @@\n-bbb\n+BBB' },
    ], 'apply suggestions')
    const post = stub.calls.find((call) => call.method === 'POST')
    const actions = (post?.body as { actions?: readonly CommitAction[] } | undefined)?.actions
    expect(actions).toEqual([
      { action: 'update', file_path: 'src/app.ts', content: 'AAA\nBBB\n' },
    ])
  })

  it('opens a merge request from head to base branch', async () => {
    const stub = stubFetch([
      { match: '/merge_requests', method: 'POST', json: { web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/12' } },
    ])
    const gateway = createGitLabGateway(config(), stub)
    const url = await gateway.openPullRequest({
      repo: 'acme/widgets', headBranch: 'fix/1', baseBranch: 'main', title: 't', body: 'b',
    })
    expect(url).toBe('https://gitlab.com/acme/widgets/-/merge_requests/12')
    expect(stub.calls[0]?.body).toMatchObject({ source_branch: 'fix/1', target_branch: 'main' })
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

describe('transport', () => {
  it('honors baseUrl and strips the trailing slash', async () => {
    const stub = stubFetch([{ match: '/user', json: { id: 5, username: 'bot' } }])
    const gateway = createGitLabGateway(config({ baseUrl: 'https://gitlab.corp/api/v4/' }), stub)
    await gateway.botIdentity()
    expect(stub.calls[0]?.url).toBe('https://gitlab.corp/api/v4/user')
  })

  it('rejects a non-http(s) baseUrl', () => {
    expect(() => createGitLabGateway(config({ baseUrl: 'javascript:alert(1)' }), stubFetch([])))
      .toThrow(/http\(s\)/)
  })

  it('sends the credential as a PRIVATE-TOKEN header', async () => {
    const stub = stubFetch([{ match: '/user', json: { id: 5, username: 'bot' } }])
    const gateway = createGitLabGateway(config(), stub)
    await gateway.botIdentity()
    expect(stub.calls[0]?.headers['PRIVATE-TOKEN']).toBe(TOKEN)
  })

  it('never puts the token in an error message', async () => {
    const gateway = createGitLabGateway(config(), stubFetch([
      { match: '/user', status: 401, text: 'Unauthorized' },
    ]))
    const error = await gateway.botIdentity().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitLabApiError)
    const serialized = `${String((error as Error).message)}${JSON.stringify(error)}`
    expect(serialized).not.toContain(TOKEN)
  })

  it('stops paginating on a short page', async () => {
    const stub = stubFetch([{ match: '/notes', json: [{ id: 1 }] }])
    const gateway = createGitLabGateway(config(), stub)
    await gateway.findStickyComment(TARGET, 'summary', BOT_ID)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.url).toContain('per_page=100')
  })
})

// ---------------------------------------------------------------------------
// Shared provider conformance suite
// ---------------------------------------------------------------------------

const conformanceFactory: ConformanceFactory = (ctx) => {
  const routes: Route[] = []

  switch (ctx.scenario) {
    case 'diff-source':
      routes.push(
        { match: '/merge_requests/7/changes', json: { changes: [
          { new_path: 'src/app.ts', old_path: 'src/app.ts', diff: '@@ -1,2 +1,3 @@\n ctx\n+added' },
          { new_path: 'logo.png', old_path: 'logo.png', diff: '' },
        ] } },
        { match: '/repository/files/src%2Fapp.ts/raw', text: 'file body' },
      )
      break
    case 'comment-sink':
      routes.push(
        { match: '/merge_requests/7/notes', method: 'POST', json: { id: 555 } },
        { match: '/merge_requests/7/notes/555', method: 'PUT', json: {} },
      )
      break
    case 'inline-publish':
      routes.push(
        { match: '/merge_requests/7/notes', method: 'GET', json: [] },
        { match: '/merge_requests/7/notes', method: 'POST', json: { id: 1 } },
        { match: '/merge_requests/7', method: 'GET', json: { diff_refs: DIFF_REFS } },
      )
      break
    case 'sticky-found':
      routes.push(
        { match: '/merge_requests/7/notes', json: [
          { id: 900, body: `${stickyMarker(ctx.marker)}\n\nprev`, author: { id: Number(ctx.botId) } },
        ] },
      )
      break
    case 'sticky-forged':
      routes.push(
        { match: '/merge_requests/7/notes', json: [
          { id: 901, body: `${stickyMarker(ctx.marker)}\n\nforged`, author: { id: 1234 } },
          { id: 902, body: 'plain note', author: { id: Number(ctx.botId) } },
        ] },
      )
      break
    case 'actor':
      routes.push(
        { match: '/users?username=conformance-actor', json: [{ id: 44 }] },
        { match: '/members/44', json: { access_level: 40 } },
        { match: '/user', json: { id: 77, username: 'dsh-reviewer' } },
        { match: '/merge_requests/7', json: { source_project_id: 200, target_project_id: 100 } },
      )
      break
    case 'checks':
      routes.push(
        { match: '/pipelines?sha=', json: [{ id: 10, status: 'failed' }] },
        { match: '/pipelines/10/jobs', json: [
          { id: 1, name: 'build', status: 'failed' },
          { id: 2, name: 'lint', status: 'success' },
        ] },
      )
      break
    case 'log':
      routes.push({ match: '/jobs/123/trace', text: 'log line' })
      break
    case 'mutation':
      routes.push(
        { match: '/repository/files/src%2Fapp.ts/raw', status: 404, text: 'Not Found' },
        { match: '/repository/commits', method: 'POST', json: { id: 'e'.repeat(40) } },
        { match: '/merge_requests', method: 'POST', json: { web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/12' } },
        { match: '/projects/acme%2Fwidgets', json: { default_branch: 'main' } },
      )
      break
    default:
      throw new Error(`unexpected scenario ${ctx.scenario}`)
  }

  return createGitLabGateway(config(), stubFetch(routes))
}

describe('forge conformance', () => {
  const cases = runForgeConformance(conformanceFactory, {
    capabilities: CAPABILITIES,
    target: TARGET,
    botId: BOT_ID,
    marker: 'summary',
  })

  for (const testCase of cases) {
    it(`${testCase.group} · ${testCase.name}`, testCase.run)
  }
})
